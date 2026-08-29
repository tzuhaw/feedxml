import { Pool } from "pg";
import { openSnapshot } from "./source.js";
import { transformFor } from "./registry.js";
import { stageSnapshot, type StageResult } from "./pipeline.js";
import { PgStagingWriter } from "./staging.js";
import { mergeRun } from "./merge.js";

export interface RunContext {
  runId: string;
  objectKey: string;
  supplierId: string;
  supplierName: string;
}

async function setState(pool: Pool, runId: string, state: string): Promise<void> {
  await pool.query(
    `update feed_runs set state = $2::run_state, updated_at = now() where id = $1`,
    [runId, state],
  );
}

/**
 * Execute one Run, happy path (Sprint 1): stage the whole Snapshot, then merge.
 * Restart-everything semantics: staging rows for this run are wiped on entry,
 * so a Cloud Run retry starts idempotently from zero (DESIGN.md, decision 12).
 * Validation thresholds, halting and the Deactivation Sweep arrive in Sprint 2.
 */
export async function executeRun(pool: Pool, ctx: RunContext): Promise<StageResult> {
  await pool.query(
    `update feed_runs set attempt = attempt + 1, updated_at = now() where id = $1`,
    [ctx.runId],
  );
  await pool.query(`delete from staging_products where run_id = $1`, [ctx.runId]);

  try {
    await setState(pool, ctx.runId, "downloading");
    const stream = await openSnapshot(ctx.objectKey);

    await setState(pool, ctx.runId, "staging");
    const writer = new PgStagingWriter(pool, ctx.runId);
    const result = await stageSnapshot(stream, transformFor(ctx.supplierName), writer);

    await setState(pool, ctx.runId, "merging");
    const merged = await mergeRun(pool, ctx.runId, ctx.supplierId);

    await pool.query(
      `update feed_runs set state = 'done', counts = $2, updated_at = now() where id = $1`,
      [
        ctx.runId,
        JSON.stringify({
          records: result.records,
          staged: result.staged,
          skipped: result.skippedCount,
          applied: merged.applied,
        }),
      ],
    );
    return result;
  } catch (err) {
    await pool.query(
      `update feed_runs set state = 'failed', error = $2, updated_at = now() where id = $1`,
      [ctx.runId, err instanceof Error ? err.message : String(err)],
    );
    throw err;
  }
}
