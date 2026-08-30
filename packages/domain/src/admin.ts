import type { Pool } from "pg";
import { resolveRunIssue } from "./issues.js";
import { completeRun, setState } from "./lifecycle.js";

/**
 * Human verdicts on Halted Runs and the deactivation reversal. This is the
 * domain logic the Sprint-4 panel will call; it lives here so Sprint-2 tests
 * exercise the real rules, not a UI.
 */

/**
 * Approve = the Snapshot is true, apply EVERYTHING including the Deactivation
 * Sweep (CONTEXT.md: Approve). Never a partial apply.
 *
 * Guards, all enforced atomically in the claim UPDATE:
 * - state must still be awaiting_review (two concurrent verdicts: one wins);
 * - no newer Run of the same Feed may exist in a non-dead state — approving a
 *   stale Halted snapshot would sweep away everything the newer one added.
 *   (Automatic supersession lands in Sprint 3; this refusal is its floor.)
 * On a mid-apply error the run reverts to awaiting_review with the error
 * recorded, so the verdict can simply be retried (applyRun is idempotent).
 */
export async function approveRun(pool: Pool, runId: string, actor: string): Promise<void> {
  const claim = await pool.query(
    `update feed_runs r
     set state = 'merging', updated_at = now()
     from feeds f
     where r.id = $1 and r.state = 'awaiting_review' and f.id = r.feed_id
       and not exists (select 1 from feed_runs n
                       where n.feed_id = r.feed_id and n.id <> r.id
                         and n.created_at > r.created_at
                         and n.state not in ('failed', 'rejected', 'superseded'))
     returning f.id as feed_id, f.supplier_id, f.skip_streak_limit`,
    [runId],
  );
  if (claim.rowCount === 0) {
    throw new Error(await diagnoseClaimFailure(pool, runId, "approve"));
  }
  const { feed_id, supplier_id, skip_streak_limit } = claim.rows[0];

  try {
    await completeRun(pool, runId, feed_id, supplier_id, skip_streak_limit, {
      approvedBy: actor,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setState(pool, runId, "awaiting_review", { error: `approve failed: ${message}` });
    throw err;
  }
  await resolveRunIssue(pool, runId, "approved");
  await audit(pool, actor, "approve_run", { run_id: runId, supplier_id });
}

/**
 * Reject = the Snapshot is wrong, discard the Run: nothing applied, staging
 * kept as evidence until retention cleans it up (CONTEXT.md: Reject).
 */
export async function rejectRun(pool: Pool, runId: string, actor: string): Promise<void> {
  const claim = await pool.query(
    `update feed_runs r
     set state = 'rejected', error = 'rejected by admin', updated_at = now()
     from feeds f
     where r.id = $1 and r.state = 'awaiting_review' and f.id = r.feed_id
     returning f.supplier_id`,
    [runId],
  );
  if (claim.rowCount === 0) {
    throw new Error(await diagnoseClaimFailure(pool, runId, "reject"));
  }
  await resolveRunIssue(pool, runId, "rejected");
  await audit(pool, actor, "reject_run", { run_id: runId, supplier_id: claim.rows[0].supplier_id });
}

async function diagnoseClaimFailure(
  pool: Pool,
  runId: string,
  verdict: string,
): Promise<string> {
  const run = await pool.query(`select state, feed_id, created_at from feed_runs where id = $1`, [
    runId,
  ]);
  if (run.rowCount === 0) return `run ${runId} not found`;
  const { state, feed_id, created_at } = run.rows[0];
  if (state !== "awaiting_review") {
    return `cannot ${verdict}: run ${runId} is ${state}, not awaiting_review`;
  }
  const newer = await pool.query(
    `select id from feed_runs
     where feed_id = $1 and id <> $2 and created_at > $3
       and state not in ('failed', 'rejected', 'superseded')
     order by created_at desc limit 1`,
    [feed_id, runId, created_at],
  );
  if (newer.rowCount && newer.rowCount > 0) {
    return `cannot ${verdict}: a newer snapshot exists for this feed (run ${newer.rows[0].id}) — this halted run is stale`;
  }
  return `cannot ${verdict}: run ${runId} claim failed (concurrent verdict?)`;
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

/** Single-row audit writer shared by verdicts and key issuance (apply.ts's set-based inserts stay separate). */
export async function audit(
  pool: Pool,
  actor: string,
  action: string,
  subject: Record<string, unknown>,
): Promise<void> {
  await pool.query(`insert into audit_log (actor, action, subject) values ($1, $2, $3)`, [
    actor,
    action,
    JSON.stringify(subject),
  ]);
}
