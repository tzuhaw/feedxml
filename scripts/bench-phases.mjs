import { createReadStream, statSync } from "node:fs";
import { Pool } from "pg";
import { stageSnapshot } from "./worker/dist/pipeline.js";
import {
  MemoryStagingWriter,
  MemorySkippedWriter,
  PgStagingWriter,
  PgSkippedWriter,
} from "./worker/dist/staging.js";
import { transformFor } from "./worker/dist/registry.js";
import { applyRun } from "@feedxml/domain";

/*
 * Phase breakdown for the fan-out question: how much of a run is PARALLELISABLE
 * (parse + transform + staging writes, which shard cleanly) versus SERIAL
 * (the staging -> products merge, one set-based statement, one writer).
 *
 *   node worker/dist/genfeed.js 50000 /tmp/f50k.xml 0
 *   BENCH_DB=postgres://... REPS=3 node scripts/bench-phases.mjs /tmp/f50k.xml
 *
 * This is what found BUG-10. Before the ANALYZE fix in packages/domain/apply.ts
 * the numbers were not merely slow, they were bimodal and got WORSE with size:
 *
 *   10k  1,274 rec/s   merge 6.3s     19% of the run parallelisable
 *   25k    579 rec/s   merge 1.4-41s  10%
 *   50k    292 rec/s   merge 3-312s    5%
 *
 * after:
 *
 *   10k  4,117 rec/s   merge 0.8s     67%
 *   25k  4,207 rec/s   merge 1.9-3.0s 63%
 *   50k  4,344 rec/s   merge 2.7-3.0s 75%
 *
 * Throughput going from falling-with-size to flat is the whole point: the first
 * shape cannot be rescued by adding workers, the second can.
 *
 * Each size is measured against the SAME starting state — an empty catalog for
 * this benchmark's own supplier — because a merge into the debris of the
 * previous run measures the debris.
 */
const pool = new Pool({ connectionString: process.env.BENCH_DB, max: 4 });
const REPS = Number(process.env.REPS ?? 3);
const ms = (a, b) => Number(b - a) / 1e6;
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const sup = (
  await pool.query(
    `insert into suppliers (name) values ('bench')
     on conflict (name) do update set name = excluded.name returning id`,
  )
).rows[0].id;
const feed = (
  await pool.query(
    `insert into feeds (supplier_id, channel, format) values ($1, 'pull', 'xml')
     on conflict (supplier_id, channel) do update set format = excluded.format
     returning id, skip_streak_limit`,
    [sup],
  )
).rows[0];

async function reset() {
  await pool.query(`delete from products where supplier_id = $1`, [sup]);
  await pool.query(`delete from issues where supplier_id = $1`, [sup]);
  await pool.query(`update feed_runs set superseded_by = null where feed_id = $1`, [feed.id]);
  await pool.query(`delete from feed_runs where feed_id = $1`, [feed.id]);
  await pool.query(`vacuum analyze products, staging_products, staging_skipped`);
}

const rows = [];
for (const file of process.argv.slice(2)) {
  const bytes = statSync(file).size;
  const P = [], D = [], M = [];
  let records = 0;

  for (let rep = 0; rep < REPS; rep++) {
    await reset();

    // 1. Parse + transform only. No database in the path at all.
    let t = process.hrtime.bigint();
    const mem = await stageSnapshot(
      createReadStream(file), transformFor("acme"),
      new MemoryStagingWriter(), new MemorySkippedWriter(), "xml",
    );
    const tParse = ms(t, process.hrtime.bigint());
    records = mem.records;

    // 2. Same work, writing to Postgres.
    const runId = (
      await pool.query(
        `insert into feed_runs (feed_id, object_key) values ($1, $2) returning id`,
        [feed.id, `bench:${bytes}:${rep}:${process.hrtime.bigint()}`],
      )
    ).rows[0].id;
    t = process.hrtime.bigint();
    await stageSnapshot(
      createReadStream(file), transformFor("acme"),
      new PgStagingWriter(pool, runId), new PgSkippedWriter(pool, runId), "xml",
    );
    const tStage = ms(t, process.hrtime.bigint());

    // 3. The merge. Set-based, single writer, NOT shardable.
    t = process.hrtime.bigint();
    const applied = await applyRun(pool, runId, sup, feed.skip_streak_limit);
    const tMerge = ms(t, process.hrtime.bigint());

    P.push(tParse); D.push(tStage - tParse); M.push(tMerge);
    console.log(
      `  rep${rep + 1}  ${String(records).padStart(6)} rec   parse ${tParse.toFixed(0).padStart(5)}ms   +db ${(tStage - tParse).toFixed(0).padStart(5)}ms   merge ${tMerge.toFixed(0).padStart(6)}ms   (creates ${applied.creates})`,
    );
  }

  const tParse = med(P), dbWrite = med(D), tMerge = med(M);
  rows.push({
    records, bytes, tParse, dbWrite, tMerge,
    total: tParse + dbWrite + tMerge,
    mSpread: `${Math.min(...M).toFixed(0)}–${Math.max(...M).toFixed(0)}`,
  });
}

console.log("\n| records | MB | parse ms | db-write ms | merge ms | merge range | total ms | rec/s | parallelisable | serial |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const par = r.tParse + r.dbWrite;
  console.log(
    `| ${r.records.toLocaleString()} | ${(r.bytes / 1e6).toFixed(0)} | ${r.tParse.toFixed(0)} | ${r.dbWrite.toFixed(0)} | ${r.tMerge.toFixed(0)} | ${r.mSpread} | ${r.total.toFixed(0)} | ${(r.records / (r.total / 1000)).toFixed(0)} | ${((100 * par) / r.total).toFixed(0)}% | ${((100 * r.tMerge) / r.total).toFixed(0)}% |`,
  );
}
await reset();
await pool.end();
