import type { ScrapeAdapter, ScrapeContext } from "../scrape.js";

/**
 * Reference adapter — the shape a real supplier's scraper takes. Replace the
 * two selectors-and-regex bodies with real ones when onboarding a scrape
 * supplier; everything else (politeness, completeness, publishing) is handled
 * by runScrape.
 *
 * Note what parseProduct returns: plain JSON whose keys mirror the XML feed's
 * element names, so the SAME transform serves both channels for this supplier.
 */
/** A site that clamps ?page=N to its last page would otherwise loop forever. */
const MAX_LISTING_PAGES = 5000;

export const exampleAdapter: ScrapeAdapter = {
  supplierName: "example",
  requestDelayMs: 1500,
  // Set this from the supplier's real catalog size before going live — the
  // floor is what stops a truncated crawl from being published as complete.
  minimumProducts: 1,

  async *listProductUrls(ctx: ScrapeContext): AsyncIterable<string> {
    const base = process.env.SCRAPE_BASE_URL;
    if (!base) throw new Error("SCRAPE_BASE_URL is required for the example adapter");
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
      const html = await ctx.fetchText(`${base}/catalog?page=${page}`);
      const links = [...html.matchAll(/href="(\/product\/[^"]+)"/g)].map((m) => `${base}${m[1]}`);
      const fresh = links.filter((l) => !seen.has(l));
      // No links, or a page identical to one already crawled: end of catalog.
      if (fresh.length === 0) return;
      for (const link of fresh) seen.add(link);
      yield* fresh;
    }
    throw new Error(`listing exceeded ${MAX_LISTING_PAGES} pages — refusing to crawl further`);
  },

  parseProduct(html: string, url: string): unknown | null {
    const code = /data-product-code="([^"]+)"/.exec(html)?.[1];
    // No product code at all: this URL isn't a product page (a gift card, a
    // care guide). Benign — not a loss.
    if (!code) return null;
    // It IS a product page but we couldn't read it: the parser has broken, and
    // the product would silently deactivate. Throw so it counts as loss.
    const title = /<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1]?.trim();
    if (!title) throw new Error(`product ${code} has no readable title`);
    return {
      code,
      title,
      description: /<div class="description">([\s\S]*?)<\/div>/.exec(html)?.[1]?.trim() ?? null,
      variants: [...html.matchAll(/data-sku="([^"]+)"[^>]*data-price="([^"]+)"/g)].map((m) => ({
        sku: m[1],
        price: m[2],
        currency: "EUR",
      })),
      images: [...html.matchAll(/<img class="product"[^>]+src="([^"]+)"/g)].map((m) => ({
        url: m[1],
      })),
      sourceUrl: url,
    };
  },
};
