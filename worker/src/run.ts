import type { Pool } from "pg";
import { DEFAULT_THRESHOLDS, type Channel, type FeedThresholds } from "@feedxml/shared";
import { objectExists, openSnapshot, pullToBucket } from "./source.js";
import { transformFor } from "./registry.js";
import { stageSnapshot, type StageResult } from "./pipeline.js";
import { PgSkippedWriter, PgStagingWriter } from "./staging.js";
import { applyRun, notInSnapshotSql, type ApplyResult } from "./apply.js";
import { evaluateThresholds, type RunCounts } from "./validate.js";
import { openRunIssue, writeRecordIssues } from "./issues.js";
import { notifyOps } from "./notify.js";

export interface RunContext {
  runId: string;
  objectKey: string;
  supplierId: string;
  supplierName: string;
  feedId: string;
  thresholds: FeedThresholds;
  skipStreakLimit: number;
  channel: Channel;
  sourceUrl: string | null;
}

export interface RunOutcome {
  result: StageResult | null;
  halted: boolean;
  /** The run was superseded by a newer Snapshot — abandoned at a safe point. */
  superseded: boolean;
}

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? 3);

/**
 * One place for every feed_runs state transition.
 * `counts` MERGES into the stored jsonb (halt counts survive the approve
 * path's later additions); `error` is SET verbatim — omitting it clears any
 * stale message, so a successfully retried run never reads as failed.
 */
export async function setState(
  pool: Pool,
  runId: string,
  state: string,
  extra?: { counts?: Record<string, unknown>; error?: string },
): Promise<void> {
  await pool.query(
    `update feed_runs
     set state = $2::run_state,
         counts = case when $3::jsonb is null then counts
                       else coalesce(counts, '{}'::jsonb) || $3::jsonb end,
         error = $4,
         updated_at = now()
     where id = $1`,
    [runId, state, extra?.counts ? JSON.stringify(extra.counts) : null, extra?.error ?? null],
  );
}

/**
 * The shared apply tail: merge + sweep + streaks + auto-resolution, then the
 * transition to done with counts merged. Both the validated happy path and a
 * human Approve go through here — the two paths must never drift.
 * Retention rides along: once this Run succeeds, older successful Runs of the
 * same Feed drop their staging rows (keep exactly the last successful run's
 * staging — DESIGN.md decision 16).
 */
export async function completeRun(
  pool: Pool,
  runId: string,
  feedId: string,
  supplierId: string,
  skipStreakLimit: number,
  extraCounts: Record<string, unknown> = {},
): Promise<ApplyResult> {
  const applied = await applyRun(pool, runId, supplierId, skipStreakLimit);
  await setState(pool, runId, "done", { counts: { ...extraCounts, ...applied } });
  await pool.query(
    `delete from staging_products sp using feed_runs r
     where sp.run_id = r.id and r.feed_id = $1 and r.id <> $2 and r.state = 'done'`,
    [feedId, runId],
  );
  await pool.query(
    `delete from staging_skipped sk using feed_runs r
     where sk.run_id = r.id and r.feed_id = $1 and r.id <> $2 and r.state = 'done'`,
    [feedId, runId],
  );
  return applied;
}

/**
 * A newer Snapshot makes older pre-merge Runs of the same Feed obsolete —
 * including Halted ones, whose open Run Issue closes itself as "superseded"
 * (DESIGN.md decision 21). Once a run is merging it finishes; we never
 * cancel a merge in flight (decision 11).
 */
async function supersedeOlderRuns(pool: Pool, feedId: string, runId: string): Promise<void> {
  await pool.query(
    `with old as (
       update feed_runs o
       set state = 'superseded', superseded_by = $2, updated_at = now()
       where o.feed_id = $1 and o.id <> $2
         and o.created_at < (select created_at from feed_runs where id = $2)
         and o.state in ('pending', 'downloading', 'staging', 'validating', 'awaiting_review')
       returning o.id
     )
     update issues set status = 'resolved', resolution = 'superseded', resolved_at = now()
     where scope = 'run' and status = 'open' and run_id in (select id from old)`,
    [feedId, runId],
  );
}

/**
 * Execute one Run: stage the whole Snapshot, validate against per-Feed
 * thresholds, then either halt for human review or apply.
 * Restart-everything semantics: this run's artifacts (staging rows, skipped
 * codes, its own issues, counts) are wiped on entry, so a Cloud Run retry
 * starts idempotently from zero (DESIGN.md, decision 12).
 */
export async function executeRun(pool: Pool, ctx: RunContext): Promise<RunOutcome> {
  // Partial per-feed config must never silently disable a rule: normalize
  // against the defaults at the single entry seam.
  const thresholds: FeedThresholds = { ...DEFAULT_THRESHOLDS, ...ctx.thresholds };

  // A run that was superseded before we started is dead — don't resurrect it.
  const current = await pool.query(`select state, attempt from feed_runs where id = $1`, [
    ctx.runId,
  ]);
  if (current.rowCount === 0) throw new Error(`run ${ctx.runId} not found`);
  if (["superseded", "done"].includes(current.rows[0].state)) {
    return { result: null, halted: false, superseded: current.rows[0].state === "superseded" };
  }

  const attempt: number = current.rows[0].attempt + 1;
  await pool.query(
    `update feed_runs
     set attempt = attempt + 1, counts = null, error = null, updated_at = now()
     where id = $1`,
    [ctx.runId],
  );
  await supersedeOlderRuns(pool, ctx.feedId, ctx.runId);
  await pool.query(`delete from staging_products where run_id = $1`, [ctx.runId]);
  await pool.query(`delete from staging_skipped where run_id = $1`, [ctx.runId]);
  await pool.query(`delete from issues where run_id = $1`, [ctx.runId]);

  try {
    await setState(pool, ctx.runId, "downloading");
    if (ctx.channel === "pull" && ctx.sourceUrl && !(await objectExists(ctx.objectKey))) {
      await pullToBucket(ctx.sourceUrl, ctx.objectKey);
    }
    const stream = await openSnapshot(ctx.objectKey);

    await setState(pool, ctx.runId, "staging");
    const result = await stageSnapshot(
      stream,
      transformFor(ctx.supplierName),
      new PgStagingWriter(pool, ctx.runId),
      new PgSkippedWriter(pool, ctx.runId),
    );
    await writeRecordIssues(pool, ctx.runId, ctx.supplierId, result.skipped, result.duplicates);

    await setState(pool, ctx.runId, "validating");
    const counts = await computeCounts(pool, ctx, result);
    const breaches = evaluateThresholds(counts, thresholds);

    if (breaches.length > 0) {
      // Halt before applying anything: a human approves or rejects (CONTEXT.md: Halted).
      await openRunIssue(pool, ctx.runId, ctx.supplierId, breaches, { ...counts });
      await setState(pool, ctx.runId, "awaiting_review", { counts: { ...counts, breaches } });
      await notifyOps(
        `[feedxml] ${ctx.supplierName}: snapshot needs review`,
        `Run ${ctx.runId} halted: ${breaches.map((b) => `${b.rule} ${b.observed} > ${b.limit}`).join(", ")}.\n` +
          `Counts: ${JSON.stringify(counts)}\nApprove or reject it in the admin panel.`,
      );
      return { result, halted: true, superseded: false };
    }

    // THE safe point: claim the merge atomically. If a newer Snapshot
    // superseded this run mid-flight, the claim fails and we abandon quietly —
    // nothing has been applied.
    const claim = await pool.query(
      `update feed_runs set state = 'merging', updated_at = now()
       where id = $1 and state = 'validating' returning id`,
      [ctx.runId],
    );
    if (claim.rowCount === 0) {
      return { result, halted: false, superseded: true };
    }

    await completeRun(pool, ctx.runId, ctx.feedId, ctx.supplierId, ctx.skipStreakLimit, {
      ...counts,
    });
    return { result, halted: false, superseded: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never let a failure envelope overwrite a supersession that happened mid-flight.
    await pool.query(
      `update feed_runs set state = 'failed', error = $2, updated_at = now()
       where id = $1 and state <> 'superseded'`,
      [ctx.runId, message],
    );
    if (attempt >= MAX_ATTEMPTS) {
      await notifyOps(
        `[feedxml] ${ctx.supplierName}: run failed after ${attempt} attempts`,
        `Run ${ctx.runId} (${ctx.objectKey}) failed: ${message}\nIt will not retry again — investigate and retry from the admin panel.`,
      );
    }
    throw err;
  }
}

async function computeCounts(
  pool: Pool,
  ctx: RunContext,
  result: StageResult,
): Promise<RunCounts> {
  const activeBefore = await pool.query(
    `select count(*)::int as n from products where supplier_id = $1 and status = 'active'`,
    [ctx.supplierId],
  );
  const previous = await pool.query(
    `select (counts->>'staged')::int as n from feed_runs
     where feed_id = $1 and state = 'done' and counts ? 'staged'
     order by updated_at desc limit 1`,
    [ctx.feedId],
  );
  const missing = await pool.query(
    `select count(*)::int as n from products p
     where p.supplier_id = $2 and p.status = 'active'
       and ${notInSnapshotSql("p")}`,
    [ctx.runId, ctx.supplierId],
  );
  return {
    records: result.records,
    staged: result.staged,
    skipped: result.skippedCount,
    duplicates: result.duplicateCount,
    activeBefore: activeBefore.rows[0].n,
    previousStaged: previous.rowCount === 0 ? null : previous.rows[0].n,
    missing: missing.rows[0].n,
  };
}
