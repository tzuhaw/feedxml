import type { Pool } from "pg";

export interface MergeResult {
  applied: number;
}

/**
 * Sprint 1 merge: batched set-based upsert from this Run's staging rows into
 * products. Reappearing products auto-reactivate (status forced to 'active' —
 * CONTEXT.md: Reactivation). The Deactivation Sweep, thresholds, and Issues
 * arrive in Sprint 2.
 */
export async function mergeRun(
  pool: Pool,
  runId: string,
  supplierId: string,
): Promise<MergeResult> {
  const res = await pool.query(
    `insert into products
       (supplier_id, product_code, status, title, description, brand, gtin,
        variants, images, attributes, first_seen_run, last_seen_run, updated_at)
     select $2, s.product_code, 'active', s.title, s.description, s.brand, s.gtin,
            s.variants, s.images, s.attributes, $1, $1, now()
     from staging_products s
     where s.run_id = $1
     on conflict (supplier_id, product_code) do update set
       status = 'active',
       -- Reappearance clears a Pin: supplier truth has resumed (CONTEXT.md: Pinned)
       pinned = false,
       title = excluded.title,
       description = excluded.description,
       brand = excluded.brand,
       gtin = excluded.gtin,
       variants = excluded.variants,
       images = excluded.images,
       attributes = excluded.attributes,
       last_seen_run = excluded.last_seen_run,
       skip_streak = 0,
       deactivated_at = null,
       updated_at = now()`,
    [runId, supplierId],
  );
  return { applied: res.rowCount ?? 0 };
}
