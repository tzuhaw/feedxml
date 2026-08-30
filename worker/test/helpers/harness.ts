import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { DEFAULT_THRESHOLDS, type FeedThresholds } from "@feedxml/shared";
import { executeRun, type RunContext } from "../../src/run.js";
import { registerTransform } from "../../src/registry.js";
import { acmeTransform } from "../../src/transforms/acme.js";
import { connectDisposable, migrateDisposable } from "../../src/testdb.js";
import type { StageResult } from "../../src/pipeline.js";

export function testDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL;
}

export function connect(): Pool {
  return connectDisposable(testDatabaseUrl());
}

/** Wipe and rebuild the schema from the real migration files. */
export async function migrate(pool: Pool): Promise<void> {
  await migrateDisposable(pool);
}

// ---- Snapshot builders -----------------------------------------------------

export interface FixtureProduct {
  code?: string;
  title?: string;
  brand?: string;
  variants?: Array<{ sku: string; price?: string; gtin?: string }>;
}

export function snapshotXml(products: FixtureProduct[]): string {
  const body = products
    .map((p) => {
      const parts: string[] = [];
      if (p.title !== undefined) parts.push(`<title>${p.title}</title>`);
      if (p.brand !== undefined) parts.push(`<brand>${p.brand}</brand>`);
      if (p.variants) {
        const vs = p.variants
          .map(
            (v) =>
              `<variant sku="${v.sku}"${v.gtin ? ` gtin="${v.gtin}"` : ""}>` +
              (v.price !== undefined ? `<price>${v.price}</price>` : "") +
              `</variant>`,
          )
          .join("");
        parts.push(`<variants>${vs}</variants>`);
      }
      const codeAttr = p.code !== undefined ? ` code="${p.code}"` : "";
      return `<product${codeAttr}>${parts.join("")}</product>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<catalog>\n${body}\n</catalog>\n`;
}

const snapshotDir = mkdtempSync(join(tmpdir(), "feedxml-snapshots-"));
let snapshotSeq = 0;

export function writeSnapshot(xml: string): string {
  const path = join(snapshotDir, `snapshot-${++snapshotSeq}.xml`);
  writeFileSync(path, xml, "utf8");
  return `file:${path}`;
}

// ---- Feed + run orchestration ----------------------------------------------

export interface TestFeed {
  supplierId: string;
  supplierName: string;
  feedId: string;
  thresholds: FeedThresholds;
  skipStreakLimit: number;
}

export const LOOSE: FeedThresholds = { maxCountDrop: 0.99, maxMissingSet: 0.99, maxErrorRate: 0.99 };

export async function seedFeed(
  pool: Pool,
  supplierName: string,
  // Partial on purpose: executeRun normalizes against DEFAULT_THRESHOLDS,
  // and tests cover exactly that fallback.
  thresholds: Partial<FeedThresholds> = DEFAULT_THRESHOLDS,
  skipStreakLimit = 3,
): Promise<TestFeed> {
  registerTransform(supplierName, acmeTransform);
  const supplier = await pool.query(
    `insert into suppliers (name) values ($1) returning id`,
    [supplierName],
  );
  const feed = await pool.query(
    `insert into feeds (supplier_id, channel, format, thresholds, skip_streak_limit)
     values ($1, 'push', 'xml', $2, $3) returning id`,
    [supplier.rows[0].id, JSON.stringify(thresholds), skipStreakLimit],
  );
  return {
    supplierId: supplier.rows[0].id,
    supplierName,
    feedId: feed.rows[0].id,
    thresholds: thresholds as FeedThresholds,
    skipStreakLimit,
  };
}

export async function runSnapshot(
  pool: Pool,
  feed: TestFeed,
  products: FixtureProduct[],
): Promise<{
  runId: string;
  result: StageResult | null;
  halted: boolean;
  superseded: boolean;
  ctx: RunContext;
}> {
  const objectKey = writeSnapshot(snapshotXml(products));
  const run = await pool.query(
    `insert into feed_runs (feed_id, object_key) values ($1, $2) returning id`,
    [feed.feedId, objectKey],
  );
  const runId: string = run.rows[0].id;
  const ctx: RunContext = {
    runId,
    objectKey,
    supplierId: feed.supplierId,
    supplierName: feed.supplierName,
    feedId: feed.feedId,
    thresholds: feed.thresholds,
    skipStreakLimit: feed.skipStreakLimit,
    channel: "push",
    format: "xml",
    sourceUrl: null,
  };
  const { result, halted, superseded } = await executeRun(pool, ctx);
  return { runId, result, halted, superseded, ctx };
}

export async function product(
  pool: Pool,
  feed: TestFeed,
  code: string,
): Promise<{ status: string; pinned: boolean; title: string; skip_streak: number } | undefined> {
  const res = await pool.query(
    `select status, pinned, title, skip_streak from products
     where supplier_id = $1 and product_code = $2`,
    [feed.supplierId, code],
  );
  return res.rows[0];
}
