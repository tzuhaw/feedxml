import type { Pool } from "pg";
import { applyRun } from "./apply.js";
import { resolveRunIssue } from "./issues.js";
import { setState } from "./run.js";

/**
 * Human verdicts on Halted Runs and the deactivation reversal. This is the
 * domain logic the Sprint-4 panel will call; it lives here so Sprint-2 tests
 * exercise the real rules, not a UI.
 */

/**
 * Approve = the Snapshot is true, apply EVERYTHING including the Deactivation
 * Sweep (CONTEXT.md: Approve). Never a partial apply.
 */
export async function approveRun(
  pool: Pool,
  runId: string,
  actor: string,
): Promise<void> {
  const run = await pool.query(
    `select r.state, f.supplier_id, f.skip_streak_limit
     from feed_runs r join feeds f on f.id = r.feed_id
     where r.id = $1`,
    [runId],
  );
  if (run.rowCount === 0) throw new Error(`run ${runId} not found`);
  if (run.rows[0].state !== "awaiting_review") {
    throw new Error(`run ${runId} is ${run.rows[0].state}, not awaiting_review`);
  }
  const { supplier_id, skip_streak_limit } = run.rows[0];

  await setState(pool, runId, "merging");
  const applied = await applyRun(pool, runId, supplier_id, skip_streak_limit);
  const existing = await pool.query(`select counts from feed_runs where id = $1`, [runId]);
  await setState(pool, runId, "done", {
    counts: { ...(existing.rows[0].counts ?? {}), ...applied, approvedBy: actor },
  });
  await resolveRunIssue(pool, runId, "approved");
  await audit(pool, actor, "approve_run", { run_id: runId });
}

/**
 * Reject = the Snapshot is wrong, discard the Run: nothing applied, staging
 * kept as evidence until retention cleans it up (CONTEXT.md: Reject).
 */
export async function rejectRun(pool: Pool, runId: string, actor: string): Promise<void> {
  const run = await pool.query(`select state from feed_runs where id = $1`, [runId]);
  if (run.rowCount === 0) throw new Error(`run ${runId} not found`);
  if (run.rows[0].state !== "awaiting_review") {
    throw new Error(`run ${runId} is ${run.rows[0].state}, not awaiting_review`);
  }
  await setState(pool, runId, "failed", { error: "rejected by admin" });
  await resolveRunIssue(pool, runId, "rejected");
  await audit(pool, actor, "reject_run", { run_id: runId });
}

/**
 * Reverse an auto-deactivation. The reversal PINS the product — exempt from
 * the Deactivation Sweep until it reappears in a Snapshot, at which point the
 * pin clears itself (CONTEXT.md: Pinned; pin exists only as this side effect).
 */
export async function reverseDeactivation(
  pool: Pool,
  supplierId: string,
  productCode: string,
  actor: string,
): Promise<void> {
  const res = await pool.query(
    `update products
     set status = 'active', pinned = true, deactivated_at = null, updated_at = now()
     where supplier_id = $1 and product_code = $2 and status = 'inactive'`,
    [supplierId, productCode],
  );
  if (res.rowCount === 0) {
    throw new Error(`no inactive product ${productCode} for supplier ${supplierId}`);
  }
  await audit(pool, actor, "pin", { supplier_id: supplierId, product_code: productCode });
}

async function audit(
  pool: Pool,
  actor: string,
  action: string,
  subject: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into audit_log (actor, action, subject) values ($1, $2, $3)`,
    [actor, action, JSON.stringify(subject)],
  );
}
