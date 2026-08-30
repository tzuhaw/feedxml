import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { executeRun } from "./run.js";
import { DEFAULT_THRESHOLDS } from "@feedxml/shared";

/**
 * End-to-end load test against a disposable database:
 *   TEST_DATABASE_URL=... ALLOW_FILE_SOURCE=1 node dist/loadtest.js <feedPath>
 * Rebuilds the schema from the migration files, seeds one feed, executes one
 * Run over the given Snapshot, and reports wall-clock per phase, throughput,
 * and peak RSS. This validates the Sprint-3 SLA claim (5GB/1M in ~15-30 min)
 * and records the numbers that decide when fan-out becomes necessary.
 */
async function main(): Promise<void> {
  const feedPath = resolve(process.argv[2] ?? "synthetic-feed.xml");
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
  if (!/localhost|127\.0\.0\.1/.test(databaseUrl) && process.env.TEST_DATABASE_ALLOW_REMOTE !== "1") {
    throw new Error("refusing a non-local TEST_DATABASE_URL (this test drops schema public)");
  }
  process.env.ALLOW_FILE_SOURCE = "1";

  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  let peakRss = 0;
  const rssSampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 500);

  try {
    await pool.query("drop schema public cascade; create schema public;");
    const here = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = resolve(here, "../../supabase/migrations");
    for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(migrationsDir, f), "utf8"));
    }

    const supplier = await pool.query(
      `insert into suppliers (name) values ('acme') returning id`,
    );
    const feed = await pool.query(
      `insert into feeds (supplier_id, channel, format, thresholds) values ($1, 'push', 'xml', $2)
       returning id`,
      [supplier.rows[0].id, JSON.stringify({ maxCountDrop: 0.99, maxMissingSet: 0.99, maxErrorRate: 0.99 })],
    );
    const objectKey = `file:${feedPath}`;
    const run = await pool.query(
      `insert into feed_runs (feed_id, object_key) values ($1, $2) returning id`,
      [feed.rows[0].id, objectKey],
    );

    const sizeGb = statSync(feedPath).size / 1024 ** 3;
    console.log(`feed: ${feedPath} (${sizeGb.toFixed(2)} GB)`);
    const started = Date.now();
    const { result } = await executeRun(pool, {
      runId: run.rows[0].id,
      objectKey,
      supplierId: supplier.rows[0].id,
      supplierName: "acme",
      feedId: feed.rows[0].id,
      thresholds: DEFAULT_THRESHOLDS,
      skipStreakLimit: 3,
      channel: "push",
      sourceUrl: null,
    });
    const secs = (Date.now() - started) / 1000;

    const products = await pool.query(`select count(*)::int as n from products`);
    console.log(
      JSON.stringify(
        {
          durationSeconds: Math.round(secs),
          records: result?.records,
          staged: result?.staged,
          skipped: result?.skippedCount,
          productsInDb: products.rows[0].n,
          recordsPerSecond: result ? Math.round(result.records / secs) : null,
          mbPerSecond: Math.round((sizeGb * 1024) / secs),
          peakRssMb: Math.round(peakRss / 1024 ** 2),
          projected1M_minutes: result
            ? Math.round(((1_000_000 / result.records) * secs) / 60)
            : null,
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(rssSampler);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
