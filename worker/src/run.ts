import type { Pool } from "pg";
import {
  DEFAULT_THRESHOLDS,
  type Channel,
  type FeedThresholds,
  type SnapshotFormat,
} from "@feedxml/shared";
import { objectExists, openSnapshot, pullToBucket } from "./source.js";
import { transformFor } from "./registry.js";
import { stageSnapshot, type StageResult } from "./pipeline.js";
import { PgSkippedWriter, PgStagingWriter } from "./staging.js";
import {
  completeRun,
  evaluateThresholds,
  notInSnapshotSql,
  openRunIssue,
  setState,
  writeRecordIssues,
  type Breach,
  type RunCounts,
} from "@feedxml/domain";
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
  format: SnapshotFormat;
  sourceUrl: string | null;
}

export interface RunOutcome {
  result: StageResult | null;
  halted: boolean;
  /** The run was superseded by a newer Snapshot — abandoned at a safe point. */
  superseded: boolean;
}

const parsedMax = Number.parseInt(process.env.MAX_ATTEMPTS ?? "", 10);
const MAX_ATTEMPTS = Number.isInteger(parsedMax) && parsedMax > 0 ? parsedMax : 3;

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

  // Atomic execution claim: one statement bumps the attempt AND refuses dead
  // or halted runs, closing the read-then-write gap (a supersession landing
  // between two statements) and preventing a relaunch race from re-executing
  // an awaiting_review run (which would wipe its Issue and re-email ops).
  const claim = await pool.query(
    `update feed_runs
     set attempt = attempt + 1, counts = null, error = null,
         started_at = now(), updated_at = now()
     where id = $1 and state not in ('superseded', 'done', 'awaiting_review')
     returning attempt`,
    [ctx.runId],
  );
  if (claim.rowCount === 0) {
    const current = await pool.query(`select state from feed_runs where id = $1`, [ctx.runId]);
    if (current.rowCount === 0) throw new Error(`run ${ctx.runId} not found`);
    return { result: null, halted: false, superseded: current.rows[0].state === "superseded" };
  }
  // THE fencing token. Monotonic, so if anything replaces this execution (a
  // retry, another worker) our attempt is no longer current and every
  // destructive step below refuses. Elapsed time never proves a process is
  // dead; a bumped attempt proves this one has been replaced.
  const attempt: number = claim.rows[0].attempt;

  // Heartbeat: without it, `updated_at` only moves at phase boundaries, so a
  // long healthy merge looks identical to a dead worker.
  const heartbeat = setInterval(() => {
    void pool
      .query(
        `update feed_runs set updated_at = now() where id = $1 and attempt = $2`,
        [ctx.runId, attempt],
      )
      .catch(() => {
        /* a failed heartbeat must never fail the run */
      });
  }, 60_000);
  heartbeat.unref?.();
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
      ctx.format,
    );
    await writeRecordIssues(pool, ctx.runId, ctx.supplierId, result.skipped, result.duplicates);

    await setState(pool, ctx.runId, "validating");
    const counts = await computeCounts(pool, ctx, result);
    const breaches = evaluateThresholds(counts, thresholds);

    if (breaches.length > 0) {
      // Halt before applying anything — via CAS, so a run superseded
      // mid-staging cannot resurrect itself into the review queue (the Issue
      // and the ops email only happen if the claim wins).
      const haltClaim = await pool.query(
        `update feed_runs
         set state = 'awaiting_review',
             counts = coalesce(counts, '{}'::jsonb) || $2::jsonb,
             updated_at = now()
         where id = $1 and state = 'validating' and attempt = $3 returning id`,
        [ctx.runId, JSON.stringify({ ...counts, breaches }), attempt],
      );
      if (haltClaim.rowCount === 0) {
        return { result, halted: false, superseded: true };
      }
      await openRunIssue(pool, ctx.runId, ctx.supplierId, breaches, { ...counts });
      await notifyOps(
        `[feedxml] ${ctx.supplierName}: snapshot needs review`,
        `Run ${ctx.runId} halted: ${breaches
          .map((b: Breach) => `${b.rule} ${b.observed} > ${b.limit}`)
          .join(", ")}.\n` +
          `Counts: ${JSON.stringify(counts)}\nApprove or reject it in the admin panel.`,
      );
      return { result, halted: true, superseded: false };
    }

    // Decision 11 ordering: an older run mid-merge finishes first — wait for
    // it rather than merging concurrently out of order.
    for (let i = 0; i < 120; i++) {
      const olderMerging = await pool.query(
        `select 1 from feed_runs
         where feed_id = $1 and state = 'merging'
           and created_at < (select created_at from feed_runs where id = $2)
         limit 1`,
        [ctx.feedId, ctx.runId],
      );
      if (olderMerging.rowCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // THE safe point: claim the merge atomically. The claim loses if this
    // execution has been fenced (attempt bumped), if a newer Snapshot
    // superseded this run mid-flight, or if a newer run has already
    // begun/finished its merge — an old snapshot must never apply over a
    // newer one that beat it to the catalog.
    const claim = await pool.query(
      `update feed_runs r set state = 'merging', updated_at = now()
       where r.id = $1 and r.state = 'validating' and r.attempt = $3
         and not exists (select 1 from feed_runs n
                         where n.feed_id = $2 and n.created_at > r.created_at
                           and n.state in ('merging', 'done'))
       returning r.id`,
      [ctx.runId, ctx.feedId, attempt],
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
    // Never let a failure envelope overwrite a supersession, or a newer
    // execution that has already fenced this one.
    await pool.query(
      `update feed_runs set state = 'failed', error = $2, updated_at = now()
       where id = $1 and state <> 'superseded' and attempt = $3`,
      [ctx.runId, message, attempt],
    );
    // Exactly one email per exhausted run, re-armed by a retry — claimed
    // atomically so concurrent attempts can't both send it.
    const alert = await pool.query(
      `update feed_runs set failure_notified = true
       where id = $1 and attempt >= $2 and not failure_notified and attempt = $3
       returning id`,
      [ctx.runId, MAX_ATTEMPTS, attempt],
    );
    if (alert.rowCount === 1) {
      await notifyOps(
        `[feedxml] ${ctx.supplierName}: run failed after ${attempt} attempts`,
        `Run ${ctx.runId} (${ctx.objectKey}) failed: ${message}\nIt will not retry again — investigate and retry from the admin panel.`,
      );
    }
    throw err;
  } finally {
    clearInterval(heartbeat);
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
