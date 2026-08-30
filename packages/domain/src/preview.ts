import type { Pool } from "pg";
import { notInSnapshotSql } from "./apply.js";

export interface ConsequencePreview {
  creates: number;
  updates: number;
  reactivations: number;
  unpins: number;
  deactivations: number;
  /** Products kept alive by an admin Pin that would otherwise be swept. */
  pinnedProtected: number;
  /** Products present but invalid this Run — kept on last known good state. */
  skipped: number;
}

/**
 * What applying this Run would do to the catalog, computed read-only from
 * staging. Mandatory before an Approve (DESIGN.md decision 20): a reviewer
 * must see "this deactivates 400k products" BEFORE clicking, not after.
 *
 * Every clause here mirrors applyRun's — same Missing predicate, same pinned
 * exemption — so the preview cannot drift from the action it describes.
 */
export async function previewApply(
  pool: Pool,
  runId: string,
  supplierId: string,
): Promise<ConsequencePreview> {
  const res = await pool.query(
    `select
       (select count(*)::int from staging_products s
        where s.run_id = $1
          and not exists (select 1 from products p
                          where p.supplier_id = $2 and p.product_code = s.product_code)
       ) as creates,
       (select count(*)::int from staging_products s
        join products p on p.supplier_id = $2 and p.product_code = s.product_code
        where s.run_id = $1
       ) as updates,
       (select count(*)::int from products p
        where p.supplier_id = $2 and p.status = 'inactive'
          and exists (select 1 from staging_products s
                      where s.run_id = $1 and s.product_code = p.product_code)
       ) as reactivations,
       (select count(*)::int from products p
        where p.supplier_id = $2 and p.pinned
          and exists (select 1 from staging_products s
                      where s.run_id = $1 and s.product_code = p.product_code)
       ) as unpins,
       (select count(*)::int from products p
        where p.supplier_id = $2 and p.status = 'active' and not p.pinned
          and ${notInSnapshotSql("p")}
       ) as deactivations,
       (select count(*)::int from products p
        where p.supplier_id = $2 and p.status = 'active' and p.pinned
          and ${notInSnapshotSql("p")}
       ) as pinned_protected,
       (select count(*)::int from staging_skipped k where k.run_id = $1) as skipped`,
    [runId, supplierId],
  );
  const r = res.rows[0];
  return {
    creates: r.creates,
    updates: r.updates,
    reactivations: r.reactivations,
    unpins: r.unpins,
    deactivations: r.deactivations,
    pinnedProtected: r.pinned_protected,
    skipped: r.skipped,
  };
}
