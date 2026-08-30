import { notifyReady, runScrape, type ScrapeAdapter } from "./scrape.js";
import { exampleAdapter } from "./scrapers/example.js";

/**
 * Scrape entrypoint, run on the same Cloud Run image as the ingest worker:
 *   SCRAPE_ADAPTER=example node dist/scrape-cli.js
 * Exits non-zero on an incomplete crawl so the scheduler surfaces it — no
 * Snapshot is published in that case, by design.
 */
const adapters: Record<string, ScrapeAdapter> = {
  example: exampleAdapter,
};

async function main(): Promise<void> {
  const name = process.env.SCRAPE_ADAPTER;
  const adapter = name ? adapters[name] : undefined;
  if (!adapter) {
    throw new Error(
      `SCRAPE_ADAPTER must be one of: ${Object.keys(adapters).join(", ") || "(none registered)"}`,
    );
  }
  const result = await runScrape(adapter);
  console.log(JSON.stringify(result));
  await notifyReady(result.objectKey);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
