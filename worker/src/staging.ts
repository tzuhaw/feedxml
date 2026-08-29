import type { NormalizedProduct } from "@feedxml/shared";
import type { Pool } from "pg";

/** Sink for normalized products during the staging phase of a Run. */
export interface StagingWriter {
  write(product: NormalizedProduct): Promise<void>;
  /** Flush any buffered rows. Must be called once after the stream ends. */
  flush(): Promise<void>;
}

/** Test double: collects rows in memory. */
export class MemoryStagingWriter implements StagingWriter {
  rows: NormalizedProduct[] = [];
  async write(product: NormalizedProduct): Promise<void> {
    this.rows.push(product);
  }
  async flush(): Promise<void> {}
}

const BATCH_SIZE = 500;

/**
 * Batched inserts into staging_products, scoped by run_id.
 * Duplicate Product Code within one Snapshot: last occurrence wins (DESIGN.md);
 * the ON CONFLICT UPDATE implements exactly that.
 */
export class PgStagingWriter implements StagingWriter {
  private buffer: NormalizedProduct[] = [];

  constructor(
    private pool: Pool,
    private runId: string,
  ) {}

  async write(product: NormalizedProduct): Promise<void> {
    this.buffer.push(product);
    if (this.buffer.length >= BATCH_SIZE) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const cols = 9;
    const values: unknown[] = [];
    const placeholders = batch.map((p, i) => {
      values.push(
        this.runId,
        p.productCode,
        p.title,
        p.description,
        p.brand,
        p.gtin,
        JSON.stringify(p.variants),
        JSON.stringify(p.images),
        JSON.stringify(p.attributes),
      );
      const base = i * cols;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });

    await this.pool.query(
      `insert into staging_products
         (run_id, product_code, title, description, brand, gtin, variants, images, attributes)
       values ${placeholders.join(", ")}
       on conflict (run_id, product_code) do update set
         title = excluded.title,
         description = excluded.description,
         brand = excluded.brand,
         gtin = excluded.gtin,
         variants = excluded.variants,
         images = excluded.images,
         attributes = excluded.attributes`,
      values,
    );
  }
}
