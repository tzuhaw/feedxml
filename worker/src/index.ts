import { Pool } from "pg";
import { executeRun } from "./run.js";

/**
 * Cloud Run Job entrypoint. The trigger (apps/web) creates the feed_runs row
 * and passes its id; this process claims it, executes, and exits non-zero on
 * failure so Cloud Run's built-in retries (max 3 — DESIGN.md) apply.
 */
async function main(): Promise<void> {
  const runId = process.env.RUN_ID;
  const databaseUrl = process.env.DATABASE_URL;
  if (!runId || !databaseUrl) {
    throw new Error("RUN_ID and DATABASE_URL are required");
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const row = await pool.query(
      `select r.object_key, s.id as supplier_id, s.name as supplier_name
       from feed_runs r
       join feeds f on f.id = r.feed_id
       join suppliers s on s.id = f.supplier_id
       where r.id = $1`,
      [runId],
    );
    if (row.rowCount === 0) throw new Error(`run ${runId} not found`);
    const { object_key, supplier_id, supplier_name } = row.rows[0];

    const result = await executeRun(pool, {
      runId,
      objectKey: object_key,
      supplierId: supplier_id,
      supplierName: supplier_name,
    });
    console.log(
      `run ${runId}: ${result.staged} staged, ${result.skippedCount} skipped of ${result.records} records`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
