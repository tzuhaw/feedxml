import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { stageSnapshot } from "../worker/dist/pipeline.js";
import { PgStagingWriter, PgSkippedWriter } from "../worker/dist/staging.js";
import { transformFor } from "../worker/dist/registry.js";

/*
 * One shard of a sharded ingest. Reads a byte range that begins and ends on a
 * record boundary, wraps it in a synthetic root so it is well-formed XML on its
 * own, and runs the ordinary pipeline over it.
 *
 *   node scripts/shard-worker.mjs <file> <start> <end> <runId> <supplier>
 *
 * Separate process rather than a thread: parsing is CPU-bound and the point of
 * the experiment is genuine parallelism, not concurrency inside one event loop.
 */
const [file, start, end, runId, supplier] = process.argv.slice(2);

/** The synthetic root is what makes an arbitrary record range parseable. */
function shardStream(path, from, to) {
  async function* gen() {
    yield Buffer.from("<catalog>\n");
    for await (const chunk of createReadStream(path, { start: Number(from), end: Number(to) })) {
      yield chunk;
    }
    yield Buffer.from("\n</catalog>\n");
  }
  return Readable.from(gen());
}

const pool = new Pool({ connectionString: process.env.BENCH_DB, max: 2 });
const t0 = process.hrtime.bigint();
const result = await stageSnapshot(
  shardStream(file, start, end),
  transformFor(supplier),
  new PgStagingWriter(pool, runId),
  new PgSkippedWriter(pool, runId),
  "xml",
);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
await pool.end();

process.stdout.write(
  JSON.stringify({ records: result.records, staged: result.staged, skipped: result.skippedCount, ms }) + "\n",
);
