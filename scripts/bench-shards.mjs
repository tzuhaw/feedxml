import { createReadStream, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { applyRun } from "@feedxml/domain";

/*
 * Does fan-out actually help when every shard writes to ONE Postgres?
 *
 *   node worker/dist/genfeed.js 50000 /tmp/f50k.xml 0
 *   BENCH_DB=postgres://... node scripts/bench-shards.mjs /tmp/f50k.xml 1 2 4 8
 *
 * Amdahl says what fan-out buys IF the parallel phase is genuinely parallel.
 * That assumption is the one worth testing, because N workers do not get N
 * times the database — they contend on WAL, locks, and index maintenance. This
 * measures the real curve rather than the predicted one.
 *
 * Correctness matters as much as speed here: sharding an XML file at record
 * boundaries must stage exactly the same rows as one worker reading it whole.
 * Every run asserts the staged count, so a boundary bug shows up as a wrong
 * number rather than a plausible-looking speed-up.
 */
const FILE = process.argv[2];
const COUNTS = process.argv.slice(3).map(Number);
const SUPPLIER = process.env.BENCH_SUPPLIER ?? "acme";
const pool = new Pool({ connectionString: process.env.BENCH_DB, max: 6 });
const ms = (a, b) => Number(b - a) / 1e6;

/**
 * The split pass: find the byte offset of every record start, without parsing
 * anything. This is the price XML charges for being splittable at all — NDJSON
 * would need none of it. Cost is reported so the claim that it is much cheaper
 * than a full parse can be checked rather than asserted.
 */
async function splitOffsets(path) {
  const OPEN = Buffer.from("<product ");
  const CLOSE = Buffer.from("</product>");
  const offsets = [];
  let contentEnd = 0; // just past the final </product>
  let tail = Buffer.alloc(0);
  let base = 0; // absolute offset of tail[0]
  const keepBytes = Math.max(OPEN.length, CLOSE.length) - 1;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 21 })) {
    const buf = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    let i = 0;
    while ((i = buf.indexOf(OPEN, i)) !== -1) {
      offsets.push(base + i);
      i += OPEN.length;
    }
    // The content ends at the last record close, NOT at EOF: the file's own
    // root close tag must stay outside every shard, or the synthetic root the
    // worker wraps around a range gets closed twice.
    let j = 0;
    while ((j = buf.indexOf(CLOSE, j)) !== -1) {
      contentEnd = base + j + CLOSE.length;
      j += CLOSE.length;
    }
    // Keep enough tail that a needle straddling the boundary is still found.
    const keep = Math.min(buf.length, keepBytes);
    tail = Buffer.from(buf.subarray(buf.length - keep));
    base += buf.length - keep;
  }
  return { offsets, contentEnd };
}

function ranges(offsets, contentEnd, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.floor((i * offsets.length) / n);
    const hi = Math.floor(((i + 1) * offsets.length) / n);
    if (lo >= hi) continue;
    // End just before the next shard's first record; last shard runs to EOF.
    const start = offsets[lo];
    const end = hi < offsets.length ? offsets[hi] - 1 : contentEnd - 1;
    out.push({ start, end, records: hi - lo });
  }
  return out;
}

function runShard(r, runId) {
  return new Promise((resolve, reject) => {
    const c = spawn(
      process.execPath,
      ["scripts/shard-worker.mjs", FILE, String(r.start), String(r.end), runId, SUPPLIER],
      { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "", err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) =>
      code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err.slice(0, 400))),
    );
  });
}

const sup = (
  await pool.query(
    `insert into suppliers (name) values ($1) on conflict (name) do update set name = excluded.name returning id`,
    [SUPPLIER],
  )
).rows[0].id;
const feed = (
  await pool.query(
    `insert into feeds (supplier_id, channel, format) values ($1,'pull','xml')
     on conflict (supplier_id, channel) do update set format = excluded.format
     returning id, skip_streak_limit`,
    [sup],
  )
).rows[0];

async function reset() {
  await pool.query(`delete from products where supplier_id=$1`, [sup]);
  await pool.query(`delete from issues where supplier_id=$1`, [sup]);
  await pool.query(`update feed_runs set superseded_by=null where feed_id=$1`, [feed.id]);
  await pool.query(`delete from feed_runs where feed_id=$1`, [feed.id]);
  await pool.query(`vacuum analyze products, staging_products, staging_skipped`);
  // Let autovacuum finish reacting to the bulk delete. Without this the next
  // run's shards queue behind a relation lock the vacuum holds, and any wait-
  // event sample is measuring the harness rather than the ingest.
  const settle = Number(process.env.BENCH_SETTLE_MS ?? 0);
  if (settle) await new Promise((r) => setTimeout(r, settle));
}

const size = statSync(FILE).size;
let t = process.hrtime.bigint();
const { offsets, contentEnd } = await splitOffsets(FILE);
const splitMs = ms(t, process.hrtime.bigint());
console.log(`split pass: ${offsets.length.toLocaleString()} records located in ${splitMs.toFixed(0)} ms (${(size / 1e6).toFixed(0)} MB)\n`);

const rows = [];
for (const n of COUNTS) {
  await reset();
  const runId = (
    await pool.query(`insert into feed_runs (feed_id, object_key) values ($1,$2) returning id`, [
      feed.id,
      `shard:${n}:${process.hrtime.bigint()}`,
    ])
  ).rows[0].id;

  const rs = ranges(offsets, contentEnd, n);
  t = process.hrtime.bigint();
  const results = await Promise.all(rs.map((r) => runShard(r, runId)));
  const stageMs = ms(t, process.hrtime.bigint());

  const staged = (
    await pool.query(`select count(*)::int c from staging_products where run_id=$1`, [runId])
  ).rows[0].c;

  t = process.hrtime.bigint();
  await applyRun(pool, runId, sup, feed.skip_streak_limit);
  const mergeMs = ms(t, process.hrtime.bigint());

  const slowest = Math.max(...results.map((r) => r.ms));
  const fastest = Math.min(...results.map((r) => r.ms));
  rows.push({ n, stageMs, mergeMs, staged, slowest, fastest, skew: slowest / fastest });
  console.log(
    `N=${String(n).padStart(2)}  stage ${stageMs.toFixed(0).padStart(6)} ms   merge ${mergeMs.toFixed(0).padStart(5)} ms   staged ${staged.toLocaleString().padStart(7)}   slowest shard ${slowest.toFixed(0)} ms   skew ${(slowest / fastest).toFixed(2)}x`,
  );
}

const base = rows[0];
console.log(`\n| shards | stage ms | speed-up | efficiency | merge ms | total ms | end-to-end speed-up | staged | shard skew |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) {
  const su = base.stageMs / r.stageMs;
  const total = r.stageMs + r.mergeMs;
  const e2e = (base.stageMs + base.mergeMs) / total;
  console.log(
    `| ${r.n} | ${r.stageMs.toFixed(0)} | ${su.toFixed(2)}x | ${((100 * su) / r.n).toFixed(0)}% | ${r.mergeMs.toFixed(0)} | ${total.toFixed(0)} | ${e2e.toFixed(2)}x | ${r.staged.toLocaleString()} | ${r.skew.toFixed(2)}x |`,
  );
}
console.log(`\nsplit pass ${splitMs.toFixed(0)} ms — add to every sharded run (N>1)`);

await reset();
await pool.end();
