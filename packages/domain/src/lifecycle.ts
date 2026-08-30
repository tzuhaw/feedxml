import type { Pool } from "pg";
import { applyRun, type ApplyResult } from "./apply.js";

/**
 * One place for every feed_runs state transition.
 * `counts` MERGES into the stored jsonb (halt counts survive the approve
 * path's later additions); `error` is SET verbatim — omitting it clears any
 * stale message, so a successfully retried run never reads as failed.
 * Supersession is STICKY: no transition may ever overwrite 'superseded' —
 * a superseded run's own in-flight process must not resurrect it.
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
     where id = $1 and state <> 'superseded'`,
    [runId, state, extra?.counts ? JSON.stringify(extra.counts) : null, extra?.error ?? null],
  );
}

/**
 * The shared apply tail: merge + sweep + streaks + auto-resolution, then the
 * transition to done with counts merged. Both the validated happy path and a
 * human Approve go through here — the two paths must never drift.
 * Retention rides along: once this Run succeeds, strictly older runs of the
 * same Feed drop their staging rows (keep exactly the last successful run's
 * staging — DESIGN.md decision 16 — and never orphan superseded staging).
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
  const victims = await pool.query(
    `select id from feed_runs
     where feed_id = $1 and id <> $2 and state in ('done', 'superseded')
       and created_at < (select created_at from feed_runs where id = $2)`,
    [feedId, runId],
  );
  if ((victims.rowCount ?? 0) > 0) {
    const ids = victims.rows.map((r) => r.id);
    await pool.query(`delete from staging_products where run_id = any($1::uuid[])`, [ids]);
    await pool.query(`delete from staging_skipped where run_id = any($1::uuid[])`, [ids]);
  }
  return applied;
}
