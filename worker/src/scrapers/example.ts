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
export const exampleAdapter: ScrapeAdapter = {
  supplierName: "example",
  requestDelayMs: 1500,
  minimumProducts: 1,

  async *listProductUrls(ctx: ScrapeContext): AsyncIterable<string> {
    const base = process.env.SCRAPE_BASE_URL;
    if (!base) throw new Error("SCRAPE_BASE_URL is required for the example adapter");
    let page = 1;
    for (;;) {
      const html = await ctx.fetchText(`${base}/catalog?page=${page}`);
      const links = [...html.matchAll(/href="(\/product\/[^"]+)"/g)].map((m) => `${base}${m[1]}`);
      if (links.length === 0) return;
      yield* links;
      page += 1;
    }
  },

  parseProduct(html: string, url: string): unknown | null {
    const code = /data-product-code="([^"]+)"/.exec(html)?.[1];
    const title = /<h1[^>]*>([^<]+)<\/h1>/.exec(html)?.[1]?.trim();
    if (!code || !title) return null;
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
