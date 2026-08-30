import type { Pool } from "pg";
import { DEFAULT_THRESHOLDS, type FeedThresholds } from "@feedxml/shared";
import { openSnapshot } from "./source.js";
import { transformFor } from "./registry.js";
import { stageSnapshot, type StageResult } from "./pipeline.js";
import { PgSkippedWriter, PgStagingWriter } from "./staging.js";
import { applyRun, notInSnapshotSql, type ApplyResult } from "./apply.js";
import { evaluateThresholds, type RunCounts } from "./validate.js";
import { openRunIssue, writeRecordIssues } from "./issues.js";

export interface RunContext {
  runId: string;
  objectKey: string;
  supplierId: string;
  supplierName: string;
  feedId: string;
  thresholds: FeedThresholds;
  skipStreakLimit: number;
}

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
 */
export async function completeRun(
  pool: Pool,
  runId: string,
  supplierId: string,
  skipStreakLimit: number,
  extraCounts: Record<string, unknown> = {},
): Promise<ApplyResult> {
  const applied = await applyRun(pool, runId, supplierId, skipStreakLimit);
  await setState(pool, runId, "done", { counts: { ...extraCounts, ...applied } });
  return applied;
}

/**
 * Execute one Run: stage the whole Snapshot, validate against per-Feed
 * thresholds, then either halt for human review or apply.
 * Restart-everything semantics: this run's artifacts (staging rows, skipped
 * codes, its own issues, counts) are wiped on entry, so a Cloud Run retry
 * starts idempotently from zero (DESIGN.md, decision 12).
 */
export async function executeRun(
  pool: Pool,
  ctx: RunContext,
): Promise<{ result: StageResult; halted: boolean }> {
  // Partial per-feed config must never silently disable a rule: normalize
  // against the defaults at the single entry seam.
  const thresholds: FeedThresholds = { ...DEFAULT_THRESHOLDS, ...ctx.thresholds };

  await pool.query(
    `update feed_runs
     set attempt = attempt + 1, counts = null, error = null, updated_at = now()
     where id = $1`,
    [ctx.runId],
  );
  await pool.query(`delete from staging_products where run_id = $1`, [ctx.runId]);
  await pool.query(`delete from staging_skipped where run_id = $1`, [ctx.runId]);
  await pool.query(`delete from issues where run_id = $1`, [ctx.runId]);

  try {
    await setState(pool, ctx.runId, "downloading");
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
      await setState(pool, ctx.runId, "awaiting_review", {
        counts: { ...counts, breaches },
      });
      return { result, halted: true };
    }

    await setState(pool, ctx.runId, "merging");
    await completeRun(pool, ctx.runId, ctx.supplierId, ctx.skipStreakLimit, { ...counts });
    return { result, halted: false };
  } catch (err) {
    await setState(pool, ctx.runId, "failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
