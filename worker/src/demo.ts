import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Pool } from "pg";
import { approveRun, previewApply } from "@feedxml/domain";
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
      format: "xml",
      sourceUrl: null,
    });
    if (!result) throw new Error("demo run was superseded — unexpected");

    console.log(
      `\n1. Staged ${result.staged} unique products, skipped ${result.skippedCount}, ` +
        `${result.duplicateCount} duplicate code` +
        (halted ? "\n   → HALTED: nothing applied, a human must decide." : ""),
    );

    const issues = await pool.query(
      `select scope, coalesce(product_code, '—') as product_code, reason
       from issues where run_id = $1 order by scope, reason`,
      [runId],
    );
    console.log("\n2. Issues raised (evidence is stored alongside each):");
    console.table(issues.rows);

    if (halted) {
      const preview = await previewApply(pool, runId, supplierId);
      console.log("\n3. Consequence Preview — exactly what approving would do:");
      console.table([preview]);

      console.log("\n4. Approving as an admin would…");
      await approveRun(pool, runId, "admin:demo");
    }

    const products = await pool.query(
      `select product_code, status, title, jsonb_array_length(variants) as variants,
              jsonb_array_length(images) as images
       from products where supplier_id = $1 order by product_code`,
      [supplierId],
    );
    console.log("\n5. The catalog now:");
    console.table(products.rows);

    const finalRun = await pool.query(`select state, counts from feed_runs where id = $1`, [runId]);
    console.log(`\n   run state: ${finalRun.rows[0].state}`);
    console.log(`   counts: ${JSON.stringify(finalRun.rows[0].counts)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
