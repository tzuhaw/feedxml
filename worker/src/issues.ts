import type { Pool } from "pg";
import type { SkippedRecord } from "@feedxml/shared";
import type { DuplicateRecord } from "./pipeline.js";
import type { Breach } from "./validate.js";

/**
 * One Issue entity, three scopes (CONTEXT.md: Issue). Record and Product
 * Issues auto-resolve when the product ingests cleanly in a later Run;
 * Run Issues resolve only by verdict (Approve / Reject / Superseded).
 */

/** Record Issues for this Run's Skipped and duplicate records (evidence samples). */
export async function writeRecordIssues(
  pool: Pool,
  runId: string,
  supplierId: string,
  skipped: SkippedRecord[],
  duplicates: DuplicateRecord[],
): Promise<void> {
  for (let i = 0; i < skipped.length; i += 200) {
    const batch = skipped.slice(i, i + 200);
    await pool.query(
      `insert into issues (scope, run_id, supplier_id, product_code, reason, evidence)
       select 'record', $1, $2, x.product_code, x.reason,
              jsonb_build_object('raw_fragment', x.raw_fragment)
       from jsonb_to_recordset($3::jsonb)
         as x(product_code text, reason text, raw_fragment text)`,
      [
        runId,
        supplierId,
        JSON.stringify(
          batch.map((s) => ({
            product_code: s.productCode,
            reason: s.reason,
            raw_fragment: s.rawFragment,
          })),
        ),
      ],
    );
  }
  if (duplicates.length > 0) {
    await pool.query(
      `insert into issues (scope, run_id, supplier_id, product_code, reason)
       select 'record', $1, $2, unnest($3::text[]),
              'duplicate Product Code within one Snapshot (last occurrence wins)'`,
      [runId, supplierId, [...new Set(duplicates.map((d) => d.productCode))]],
    );
  }
}

/** The single feed-level Issue raised when a Run halts on threshold breaches. */
export async function openRunIssue(
  pool: Pool,
  runId: string,
  supplierId: string,
  breaches: Breach[],
  counts: Record<string, unknown>,
): Promise<void> {
  const reason = breaches
    .map((b) => `${b.rule}: ${b.observed} exceeds limit ${b.limit}`)
    .join("; ");
  await pool.query(
    `insert into issues (scope, run_id, supplier_id, reason, evidence)
     values ('run', $1, $2, $3, $4)`,
    [runId, supplierId, `snapshot looks wrong — ${reason}`, JSON.stringify({ breaches, counts })],
  );
}

/**
 * Increment skip streaks for products Skipped this Run and raise a Product
 * Issue for any that reach the per-Feed limit (unless one is already open).
 * Only known products streak — a never-ingested product has no row and
 * surfaces through its Record Issues instead.
 */
export async function bumpSkipStreaks(
  pool: Pool,
  runId: string,
  supplierId: string,
  skipStreakLimit: number,
): Promise<void> {
  await pool.query(
    `update products p set skip_streak = p.skip_streak + 1, updated_at = now()
     where p.supplier_id = $2
       and exists (select 1 from staging_skipped k
                   where k.run_id = $1 and k.product_code = p.product_code)`,
    [runId, supplierId],
  );
  await pool.query(
    `insert into issues (scope, run_id, supplier_id, product_code, reason)
     select 'product', $1, $2, p.product_code,
            'skipped ' || p.skip_streak || ' consecutive runs — review the source data'
     from products p
     where p.supplier_id = $2
       and p.skip_streak >= $3
       and exists (select 1 from staging_skipped k
                   where k.run_id = $1 and k.product_code = p.product_code)
       and not exists (select 1 from issues i
                       where i.status = 'open' and i.scope = 'product'
                         and i.supplier_id = $2 and i.product_code = p.product_code)`,
    [runId, supplierId, skipStreakLimit],
  );
}

/**
 * Auto-resolution (CONTEXT.md): Record and Product Issues close themselves
 * when the same product ingests cleanly in a later Run. Issues raised by THIS
 * Run are excluded — a duplicate logged today shouldn't vanish today.
 */
export async function autoResolveIssues(
  pool: Pool,
  runId: string,
  supplierId: string,
): Promise<number> {
  const res = await pool.query(
    `update issues i
     set status = 'resolved', resolution = 'resolved by run ' || $1, resolved_at = now()
     where i.status = 'open'
       and i.scope in ('record', 'product')
       and i.supplier_id = $2
       and i.run_id is distinct from $1
       and i.product_code in
         (select s.product_code from staging_products s where s.run_id = $1)`,
    [runId, supplierId],
  );
  return res.rowCount ?? 0;
}

/** Resolve this Run's feed-level Issue with a verdict (approved / rejected / superseded). */
export async function resolveRunIssue(
  pool: Pool,
  runId: string,
  resolution: "approved" | "rejected" | "superseded",
): Promise<void> {
  await pool.query(
    `update issues set status = 'resolved', resolution = $2, resolved_at = now()
     where scope = 'run' and run_id = $1 and status = 'open'`,
    [runId, resolution],
  );
}
