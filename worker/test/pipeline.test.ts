import { describe, it, expect } from "vitest";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stageSnapshot } from "../src/pipeline.js";
import { MemorySkippedWriter, MemoryStagingWriter } from "../src/staging.js";
import { acmeTransform } from "../src/transforms/acme.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../../fixtures/acme-small.xml");

async function stageFixture() {
  const writer = new MemoryStagingWriter();
  const skippedWriter = new MemorySkippedWriter();
  const result = await stageSnapshot(
    createReadStream(fixture),
    acmeTransform,
    writer,
    skippedWriter,
    "xml",
  );
  return { writer, skippedWriter, result };
}

describe("walking skeleton: fixture Snapshot through the streaming core", () => {
  it("counts every record; staged counts UNIQUE Product Codes", async () => {
    const { result } = await stageFixture();
    expect(result.records).toBe(5);
    expect(result.staged).toBe(2); // ACME-001, ACME-002 — the dup is not a new catalog entry
    expect(result.duplicateCount).toBe(1); // second ACME-002
    expect(result.duplicates[0]).toBe("ACME-002");
  });

  it("records Skipped codes durably so Skipped is never Missing", async () => {
    const { skippedWriter } = await stageFixture();
    expect(skippedWriter.codes).toEqual(["ACME-003"]); // the no-code record has nothing to protect
  });

  it("Skips (never drops silently) records that fail validation, with evidence", async () => {
    const { result } = await stageFixture();
    expect(result.skipped).toHaveLength(2);

    const noCode = result.skipped.find((s) => s.productCode === null);
    expect(noCode?.reason).toBe("missing product code");
    expect(noCode?.rawFragment).toContain("Mystery item");

    const badPrice = result.skipped.find((s) => s.productCode === "ACME-003");
    expect(badPrice?.reason).toContain("CALL US");
  });

  it("normalizes nested variants with per-variant GTIN (SKU belongs to the Variant)", async () => {
    const { writer } = await stageFixture();
    const shoe = writer.rows.find((r) => r.productCode === "ACME-001");
    expect(shoe?.variants).toHaveLength(2);
    expect(shoe?.variants[0]).toMatchObject({
      sku: "ACME-001-42-BLU",
      gtin: "4006381333931",
      price: "89.95",
      stock: 14,
    });
    expect(shoe?.attributes).toEqual({ color: "blue", terrain: "trail" });
  });

  it("keeps inline-element text in mixed content (no silently dropped words)", async () => {
    const { writer } = await stageFixture();
    const shoe = writer.rows.find((r) => r.productCode === "ACME-001");
    expect(shoe?.description).toBe("Lightweight trail shoe with rock plate tech.");
  });

  it("gives variant-less products one implicit default Variant", async () => {
    const { writer } = await stageFixture();
    const bottle = writer.rows.find((r) => r.productCode === "ACME-002");
    expect(bottle?.variants).toHaveLength(1);
    expect(bottle?.variants[0]).toMatchObject({
      sku: "ACME-002",
      isDefault: true,
      gtin: "4006381339997", // product-level GTIN falls through to the default Variant
    });
  });

  it("captures image URLs as structured objects ready for the future rehost pipeline", async () => {
    const { writer } = await stageFixture();
    const shoe = writer.rows.find((r) => r.productCode === "ACME-001");
    expect(shoe?.images).toEqual([
      { source_url: "https://cdn.acme.example/img/acme-001-a.jpg", cdn_url: null, fetched_at: null },
      { source_url: "https://cdn.acme.example/img/acme-001-b.jpg", cdn_url: null, fetched_at: null },
    ]);
  });

  it("duplicate Product Code within one Snapshot: both occurrences staged, last wins at the DB layer", async () => {
    const { writer } = await stageFixture();
    const bottles = writer.rows.filter((r) => r.productCode === "ACME-002");
    // The memory writer sees both; PgStagingWriter's ON CONFLICT applies last-wins.
    expect(bottles).toHaveLength(2);
    expect(bottles[1]?.title).toContain("updated");
  });
});
