import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stageSnapshot } from "../src/pipeline.js";
import { MemorySkippedWriter, MemoryStagingWriter } from "../src/staging.js";
import { acmeTransform } from "../src/transforms/acme.js";

const here = dirname(fileURLToPath(import.meta.url));
const xmlFixture = resolve(here, "../../fixtures/acme-small.xml");

async function stage(stream: Readable, format: "xml" | "ndjson") {
  const writer = new MemoryStagingWriter();
  const skipped = new MemorySkippedWriter();
  const result = await stageSnapshot(stream, acmeTransform, writer, skipped, format);
  return { writer, skipped, result };
}

/**
 * The design's promise: one pipeline, one transform per supplier, whichever
 * format their channel delivers. These tests hold that promise honest.
 */
describe("NDJSON front-end", () => {
  it("produces the same normalized product an equivalent XML record does", async () => {
    const { writer: fromXml } = await stage(createReadStream(xmlFixture), "xml");
    const xmlShoe = fromXml.rows.find((r) => r.productCode === "ACME-001");

    const ndjson = JSON.stringify({
      code: "ACME-001",
      title: "Trail Running Shoe",
      description: "Lightweight trail shoe with rock plate tech.",
      brand: "Acme Athletics",
      variants: [
        { sku: "ACME-001-42-BLU", gtin: "4006381333931", price: "89.95", currency: "EUR", stock: "14" },
        { sku: "ACME-001-43-BLU", gtin: "4006381333948", price: "89.95", currency: "EUR", stock: "0" },
      ],
      images: [
        { url: "https://cdn.acme.example/img/acme-001-a.jpg" },
        { url: "https://cdn.acme.example/img/acme-001-b.jpg" },
      ],
      attributes: [
        { name: "color", value: "blue" },
        { name: "terrain", value: "trail" },
      ],
    });
    const { writer: fromJson } = await stage(Readable.from([`${ndjson}\n`]), "ndjson");
    const jsonShoe = fromJson.rows[0];

    // Compare the WHOLE normalized product, not a chosen few fields — a
    // partial assertion here previously hid attribute values coming through
    // blank, which the merge would have written over the live catalog.
    expect(jsonShoe).toEqual(xmlShoe);
  });

  it("Skips a malformed line as a record defect instead of failing the Run", async () => {
    const lines = [
      JSON.stringify({ code: "A", title: "Fine" }),
      "{ this is not json",
      JSON.stringify({ code: "B", title: "Also fine" }),
      "",
    ].join("\n");
    const { result, writer } = await stage(Readable.from([lines]), "ndjson");

    expect(result.records).toBe(3); // blank lines are not records
    expect(result.staged).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped[0]?.rawFragment).toContain("this is not json");
    expect(writer.rows.map((r) => r.productCode)).toEqual(["A", "B"]);
  });

  it("gives NDJSON products the implicit default Variant too", async () => {
    const line = JSON.stringify({ code: "SOLO", title: "No variants here", gtin: "4006381339997" });
    const { writer } = await stage(Readable.from([`${line}\n`]), "ndjson");
    expect(writer.rows[0]?.variants).toHaveLength(1);
    expect(writer.rows[0]?.variants[0]).toMatchObject({ sku: "SOLO", isDefault: true });
  });
});
