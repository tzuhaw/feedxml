import { createWriteStream } from "node:fs";
import { once } from "node:events";

/**
 * Synthetic Snapshot generator for load tests:
 *   node dist/genfeed.js <productCount> <outPath> [badEveryN]
 * Records average ~4-5KB (nested variants, images, padded description) so
 * 1M products ≈ the 5GB target. Every badEveryN-th record (default 5000) is
 * malformed to exercise the Skip path.
 */
async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 100000);
  const outPath = process.argv[3] ?? "synthetic-feed.xml";
  const badEveryN = Number(process.argv[4] ?? 5000);
  const out = createWriteStream(outPath);
  const pad = "Durable, weather-resistant construction with reinforced seams. ".repeat(40);

  const write = async (chunk: string): Promise<void> => {
    if (!out.write(chunk)) await once(out, "drain");
  };

  await write(`<?xml version="1.0" encoding="UTF-8"?>\n<catalog>\n`);
  const started = Date.now();
  for (let i = 0; i < count; i++) {
    const code = `LOAD-${String(i).padStart(7, "0")}`;
    if (badEveryN > 0 && i % badEveryN === badEveryN - 1) {
      await write(`<product code="${code}"><brand>NoTitle</brand></product>\n`);
      continue;
    }
    const variants = Array.from({ length: 3 }, (_, v) =>
      `<variant sku="${code}-V${v}" gtin="40063813${String(i % 100000).padStart(5, "0")}${v}">` +
      `<price>${(9 + (i % 90)).toFixed(2)}</price><currency>EUR</currency><stock>${i % 50}</stock></variant>`,
    ).join("");
    const images = Array.from({ length: 3 }, (_, m) =>
      `<image url="https://cdn.example.com/p/${code}-${m}.jpg"/>`,
    ).join("");
    await write(
      `<product code="${code}"><title>Load Product ${i}</title>` +
        `<description>${pad}</description><brand>LoadBrand ${i % 200}</brand>` +
        `<variants>${variants}</variants><images>${images}</images>` +
        `<attributes><attribute name="color">c${i % 12}</attribute><attribute name="size">s${i % 8}</attribute></attributes>` +
        `</product>\n`,
    );
  }
  await write(`</catalog>\n`);
  out.end();
  await once(out, "finish");
  console.log(`wrote ${count} products to ${outPath} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
