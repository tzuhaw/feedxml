import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { executeRun } from "./run.js";

/**
 * Walking-skeleton demo: seeds the fixture supplier+feed, registers a Run for
 * the local fixture Snapshot, executes it, and prints what landed.
 * Requires DATABASE_URL with the 0001 migration applied.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the demo");
  process.env.ALLOW_FILE_SOURCE = "1"; // local demo reads the fixture from disk

  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = resolve(here, "../../fixtures/acme-small.xml");
  const objectKey = `file:${fixture}`;

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const supplier = await pool.query(
      `insert into suppliers (name) values ('acme')
       on conflict (name) do update set name = excluded.name
       returning id`,
    );
    const supplierId: string = supplier.rows[0].id;

    const feed = await pool.query(
      `insert into feeds (supplier_id, channel, format) values ($1, 'push', 'xml')
       on conflict (supplier_id, channel) do update set format = excluded.format
       returning id, thresholds, skip_streak_limit`,
      [supplierId],
    );
    const feedId: string = feed.rows[0].id;

    // Idempotent run registration, same shape as the trigger endpoint.
    await pool.query(
      `insert into feed_runs (feed_id, object_key) values ($1, $2)
       on conflict (object_key) where not manual_reingest do nothing`,
      [feedId, objectKey],
    );
    const run = await pool.query(
      `select id from feed_runs where object_key = $1`,
      [objectKey],
    );
    const runId: string = run.rows[0].id;

    const { result, halted } = await executeRun(pool, {
      runId,
      objectKey,
      supplierId,
      supplierName: "acme",
      feedId,
      thresholds: feed.rows[0].thresholds,
      skipStreakLimit: feed.rows[0].skip_streak_limit,
      channel: "push",
      sourceUrl: null,
    });
    if (!result) throw new Error("demo run was superseded — unexpected");

    const products = await pool.query(
      `select product_code, status, title, jsonb_array_length(variants) as variant_count
       from products where supplier_id = $1 order by product_code`,
      [supplierId],
    );
    console.log(
      `staged ${result.staged} unique, skipped ${result.skippedCount}, duplicates ${result.duplicateCount}` +
        (halted ? " — HALTED awaiting review" : ""),
    );
    console.table(products.rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
