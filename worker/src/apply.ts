import type { Pool } from "pg";
import { mergeRun } from "./merge.js";
import { autoResolveIssues, bumpSkipStreaks } from "./issues.js";

export interface ApplyResult {
  creates: number;
  updates: number;
  reactivated: number;
  unpinned: number;
  deactivated: number;
  issuesAutoResolved: number;
}

/**
 * Apply a validated (or human-approved) Run to the catalog:
 *   merge (auto-reactivation, pin clearing) → Deactivation Sweep → skip
 *   streaks → Issue auto-resolution.
 * Everything here is idempotent per run_id — a crash mid-apply is safe to
 * re-run (restart-everything, DESIGN.md decision 12). Batched, deliberately
 * not one giant transaction: seconds of mixed state are accepted (decision 4).
 */
export async function applyRun(
  pool: Pool,
  runId: string,
  supplierId: string,
  skipStreakLimit: number,
): Promise<ApplyResult> {
  // Pre-merge captures for audit rows — the upsert can't see old row values.
  const reactivating = await pool.query(
    `select p.product_code from products p
     where p.supplier_id = $2 and p.status = 'inactive'
       and exists (select 1 from staging_products s
                   where s.run_id = $1 and s.product_code = p.product_code)`,
    [runId, supplierId],
  );
  const unpinning = await pool.query(
    `select p.product_code from products p
     where p.supplier_id = $2 and p.pinned
       and exists (select 1 from staging_products s
                   where s.run_id = $1 and s.product_code = p.product_code)`,
    [runId, supplierId],
  );
  const creates = await pool.query(
    `select count(*)::int as n from staging_products s
     where s.run_id = $1
       and not exists (select 1 from products p
                       where p.supplier_id = $2 and p.product_code = s.product_code)`,
    [runId, supplierId],
  );

  const merged = await mergeRun(pool, runId, supplierId);

  await auditBatch(pool, "reactivate", runId, supplierId, reactivating.rows.map((r) => r.product_code));
  await auditBatch(pool, "unpin", runId, supplierId, unpinning.rows.map((r) => r.product_code));

  // Deactivation Sweep: Missing only — never Skipped, never Pinned (CONTEXT.md).
  const swept = await pool.query(
    `with swept as (
       update products p
       set status = 'inactive', deactivated_at = now(), updated_at = now()
       where p.supplier_id = $2
         and p.status = 'active'
         and not p.pinned
         and not exists (select 1 from staging_products s
                         where s.run_id = $1 and s.product_code = p.product_code)
         and not exists (select 1 from staging_skipped k
                         where k.run_id = $1 and k.product_code = p.product_code)
       returning p.product_code
     )
     insert into audit_log (actor, action, subject)
     select 'system', 'deactivate',
            jsonb_build_object('supplier_id', $2::text, 'product_code', product_code, 'run_id', $1::text)
     from swept`,
    [runId, supplierId],
  );

  await bumpSkipStreaks(pool, runId, supplierId, skipStreakLimit);
  const issuesAutoResolved = await autoResolveIssues(pool, runId, supplierId);

  return {
    creates: creates.rows[0].n,
    updates: merged.applied - creates.rows[0].n,
    reactivated: reactivating.rowCount ?? 0,
    unpinned: unpinning.rowCount ?? 0,
    deactivated: swept.rowCount ?? 0,
    issuesAutoResolved,
  };
}

async function auditBatch(
  pool: Pool,
  action: string,
  runId: string,
  supplierId: string,
  productCodes: string[],
): Promise<void> {
  if (productCodes.length === 0) return;
  await pool.query(
    `insert into audit_log (actor, action, subject)
     select 'system', $1,
            jsonb_build_object('supplier_id', $3::text, 'product_code', code, 'run_id', $2::text)
     from unnest($4::text[]) as code`,
    [action, runId, supplierId, productCodes],
  );
}
