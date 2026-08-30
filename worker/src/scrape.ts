import { createWriteStream, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildObjectKey } from "@feedxml/shared";
import { uploadSnapshot } from "./source.js";
import { transformFor } from "./registry.js";

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
  /**
   * Completeness floor: the smallest product count that could plausibly be
   * this supplier's whole catalog. REQUIRED and deliberately un-defaulted —
   * a default of 1 would only catch an empty crawl, which is the one failure
   * that can't pass silently anyway. Set it from the real catalog size (say
   * half of it); a crawl that ends early on a pagination change then declines
   * to publish instead of asserting a 2%-sized catalog is complete.
   */
  minimumProducts: number;
  /**
   * Hosts the crawl may fetch, beyond the origin of each requested URL.
   * Redirects off-origin are refused unless listed: a supplier's server can
   * otherwise redirect our crawler anywhere.
   */
  allowedHosts?: string[];
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
  // Fail before spending hours crawling: a Snapshot this supplier has no
  // transform for would burn the whole crawl and then fail every ingest
  // attempt. (The Feed row is checked by the trigger, which happens fast.)
  transformFor(adapter.supplierName);

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
      // Redirects are followed MANUALLY and only to permitted hosts: a
      // supplier's server must not be able to point our crawler at arbitrary
      // infrastructure and have the response land in a Snapshot.
      let target = url;
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetch(target, {
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: { "user-agent": process.env.SCRAPE_USER_AGENT ?? "feedxml-scraper/1.0" },
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) throw new Error(`${res.status} without Location from ${target}`);
          const next = new URL(location, target);
          const permitted =
            next.host === new URL(url).host || (adapter.allowedHosts ?? []).includes(next.host);
          if (!permitted) {
            throw new Error(`refusing redirect to disallowed host ${next.host}`);
          }
          target = next.toString();
          continue;
        }
        if (!res.ok) throw new Error(`${res.status} from ${target}`);
        return res.text();
      }
      throw new Error(`too many redirects from ${url}`);
    },
  };

  // Buffer to a temp file: a Snapshot must be complete before it is published.
  // NOTE for large catalogs: on Cloud Run, os.tmpdir() is a memory-backed
  // tmpfs, so the buffered Snapshot counts against the job's memory limit —
  // size the job accordingly (roughly 1KB per product) or mount real storage.
  const dir = mkdtempSync(join(tmpdir(), "feedxml-scrape-"));
  const path = join(dir, "snapshot.ndjson");
  const out = createWriteStream(path);
  // Without this, an async write failure (tmpfs full) is an unhandled 'error'
  // event and takes the process down with no diagnosis.
  const writeFailed = new Promise<never>((_, reject) => {
    out.on("error", (err) => reject(new Error(`snapshot write failed: ${err.message}`)));
  });
  void writeFailed.catch(() => {
    /* surfaced by the races below */
  });
  let products = 0;

  try {
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
          throw new Error(
            `aborting crawl after ${consecutiveFailures} consecutive fetch failures — a partial catalog must never be published`,
          );
        }
        continue;
      }

      const record = adapter.parseProduct(html, url, ctx);
      if (record === null || record === undefined) continue;
      if (!out.write(`${JSON.stringify(record)}\n`)) {
        await Promise.race([once(out, "drain"), writeFailed]);
      }
      products += 1;
    }

    out.end();
    await Promise.race([once(out, "finish"), writeFailed]);

    // Completeness floor: publishing a Snapshot asserts "this is the whole
    // catalog". If the crawl found implausibly little, refuse — the ingest
    // thresholds would catch it, but a halted run is a worse outcome than a
    // crawl that declines to publish.
    if (products < adapter.minimumProducts) {
      throw new Error(
        `crawl produced ${products} products, below the completeness floor of ${adapter.minimumProducts} — not publishing`,
      );
    }

    const objectKey = buildObjectKey(adapter.supplierName, Date.now(), "ndjson");
    await uploadSnapshot(path, objectKey);
    ctx.log(`published ${products} products to ${objectKey}`);
    return { objectKey, products, pagesFetched, failures };
  } finally {
    out.destroy();
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best effort; the job is ending anyway */
    });
  }
}

/**
 * Tells the app a Snapshot has landed. The safety-net sweep would discover it
 * within ~5 minutes anyway; this just removes the wait.
 */
export type NotifyOutcome =
  /** Ingestion started, or the sweep will start it within ~5 minutes. */
  | { ok: true }
  /** The Snapshot is published but nothing will ever ingest it without a human. */
  | { ok: false; needsHuman: true; reason: string };

export async function notifyReady(objectKey: string): Promise<NotifyOutcome> {
  const url = process.env.TRIGGER_URL;
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!url || !secret) {
    console.log(`[scrape] TRIGGER_URL not configured; the sweep will discover ${objectKey}`);
    return { ok: true };
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ objectKey }),
    });
    if (res.ok) return { ok: true };
    const body = await res.text();
    // 404 means no active feed matches this Snapshot — a provisioning gap the
    // safety-net sweep cannot fix either, so it must reach a human.
    if (res.status === 404) {
      return {
        ok: false,
        needsHuman: true,
        reason: `no active feed accepts ${objectKey} (${body}) — the Snapshot is published but will never ingest`,
      };
    }
    console.error(`[scrape] trigger failed: ${res.status} ${body}; the sweep will retry discovery`);
    return { ok: true };
  } catch (err) {
    // The Snapshot IS published; discovery is the sweep's job from here.
    console.error(`[scrape] trigger unreachable (${String(err)}); the sweep will discover it`);
    return { ok: true };
  }
}
