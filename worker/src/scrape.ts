import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObjectKey } from "@feedxml/shared";
import { uploadSnapshot } from "./source.js";

/**
 * The scrape channel is a feed PRODUCER, not a second ingestion path
 * (CONTEXT.md: Channel; DESIGN.md decision 1b). It crawls a supplier's site,
 * accumulates a COMPLETE catalog, and writes one NDJSON Snapshot to the
 * bucket. Nothing here touches the catalog database — the ordinary pipeline
 * picks the file up like any other Snapshot.
 *
 * Completeness is the contract: a crawl that fails partway must NOT produce a
 * Snapshot, because a partial file looks exactly like a supplier who
 * discontinued half their catalog, and the Deactivation Sweep would believe it.
 */

export interface ScrapeAdapter {
  /** Supplier this adapter scrapes; must match the suppliers.name key. */
  supplierName: string;
  /** Yields every product URL in the catalog. Throwing aborts the crawl. */
  listProductUrls(ctx: ScrapeContext): AsyncIterable<string>;
  /**
   * Parses one product page into a plain JSON record. The NDJSON front-end
   * converts it to the same node shape an XML feed produces, so the supplier's
   * transform is written once and serves both.
   * Return null for "this page is not a product" (silently skipped, counted).
   */
  parseProduct(html: string, url: string, ctx: ScrapeContext): unknown | null;
  /** Minimum gap between requests, ms. Politeness is not optional. */
  requestDelayMs?: number;
  /** Expected catalog size, used as the completeness floor (see below). */
  minimumProducts?: number;
}

export interface ScrapeContext {
  fetchText(url: string): Promise<string>;
  log(message: string): void;
}

export interface ScrapeResult {
  objectKey: string;
  products: number;
  pagesFetched: number;
  failures: number;
}

const MAX_CONSECUTIVE_FAILURES = 10;

export async function runScrape(adapter: ScrapeAdapter): Promise<ScrapeResult> {
  const delay = adapter.requestDelayMs ?? 1000;
  let pagesFetched = 0;
  let failures = 0;
  let consecutiveFailures = 0;
  let lastRequestAt = 0;

  const ctx: ScrapeContext = {
    log: (message) => console.log(`[scrape:${adapter.supplierName}] ${message}`),
    async fetchText(url: string): Promise<string> {
      const wait = lastRequestAt + delay - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastRequestAt = Date.now();
      pagesFetched += 1;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: { "user-agent": process.env.SCRAPE_USER_AGENT ?? "feedxml-scraper/1.0" },
      });
      if (!res.ok) throw new Error(`${res.status} from ${url}`);
      return res.text();
    },
  };

  // Buffer to a temp file: a Snapshot must be complete before it is published,
  // and a full catalog does not belong in memory.
  const dir = mkdtempSync(join(tmpdir(), "feedxml-scrape-"));
  const path = join(dir, "snapshot.ndjson");
  const out = createWriteStream(path);
  let products = 0;

  for await (const url of adapter.listProductUrls(ctx)) {
    let html: string;
    try {
      html = await ctx.fetchText(url);
      consecutiveFailures = 0;
    } catch (err) {
      failures += 1;
      consecutiveFailures += 1;
      ctx.log(`fetch failed (${consecutiveFailures} in a row): ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        out.destroy();
        throw new Error(
          `aborting crawl after ${consecutiveFailures} consecutive fetch failures — a partial catalog must never be published`,
        );
      }
      continue;
    }

    const record = adapter.parseProduct(html, url, ctx);
    if (record === null || record === undefined) continue;
    if (!out.write(`${JSON.stringify(record)}\n`)) await once(out, "drain");
    products += 1;
  }

  out.end();
  await once(out, "finish");

  // Completeness floor: publishing a Snapshot asserts "this is the whole
  // catalog". If the crawl found implausibly little, refuse — the ingest
  // thresholds would catch it, but a halted run is a worse outcome than a
  // crawl that declines to publish.
  const floor = adapter.minimumProducts ?? 1;
  if (products < floor) {
    throw new Error(
      `crawl produced ${products} products, below the completeness floor of ${floor} — not publishing`,
    );
  }

  const objectKey = buildObjectKey(adapter.supplierName, Date.now(), "ndjson");
  await uploadSnapshot(path, objectKey);
  ctx.log(`published ${products} products to ${objectKey}`);
  return { objectKey, products, pagesFetched, failures };
}

/**
 * Tells the app a Snapshot has landed. The safety-net sweep would discover it
 * within ~5 minutes anyway; this just removes the wait.
 */
export async function notifyReady(objectKey: string): Promise<void> {
  const url = process.env.TRIGGER_URL;
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!url || !secret) {
    console.log(`[scrape] TRIGGER_URL not configured; the sweep will discover ${objectKey}`);
    return;
  }
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json", "x-internal-secret": secret },
    body: JSON.stringify({ objectKey }),
  });
  if (!res.ok) {
    console.error(`[scrape] trigger failed: ${res.status} ${await res.text()}`);
  }
}
