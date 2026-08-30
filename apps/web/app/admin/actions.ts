"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { SESSION_COOKIE, readSession } from "@/lib/session";
import { approveRun, previewApply, rejectRun, reverseDeactivation } from "@feedxml/domain";
import { getPool } from "@/lib/db";
import { registerAndLaunch, tryLaunch } from "@/lib/runs";

/**
 * Every panel mutation. All of them delegate to @feedxml/domain, so a verdict
 * clicked here runs exactly the code the worker runs — the panel adds no
 * catalog rules of its own.
 *
 * Server actions are public HTTP endpoints; the /admin middleware covers them
 * because actions POST to the page URL they were rendered on.
 */

/**
 * Defense in depth. Server actions are public endpoints whose only protection
 * today is that this module is imported solely by /admin pages, which the
 * middleware matcher covers. The day someone imports it from an unprotected
 * route, these actions would become anonymously invokable — and one of them
 * deactivates catalogs. So each action re-checks the session, here, at the
 * point of use.
 */
async function assertAdmin(): Promise<string> {
  const user = await readSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user) throw new Error("Your session has expired — sign in again.");
  return `admin:${user}`;
}

/** The authenticated admin, for audit rows. */
async function actor(): Promise<string> {
  return assertAdmin();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(formData: FormData, field: string): string {
  const value = String(formData.get(field) ?? "");
  if (!UUID.test(value)) throw new Error(`invalid ${field}`);
  return value;
}

/**
 * Approve, bound to the preview the reviewer actually saw: if the catalog
 * moved underneath an open tab, the deactivation count no longer matches and
 * the approval is refused rather than silently applying a different action
 * from the one that was authorised (DESIGN.md decision 20).
 */
export async function approveRunAction(formData: FormData): Promise<void> {
  const approvedBy = await assertAdmin();
  const runId = requireId(formData, "runId");
  const shown = Number(formData.get("previewedDeactivations"));
  const pool = getPool();

  const run = await pool.query(
    `select f.supplier_id from feed_runs r join feeds f on f.id = r.feed_id where r.id = $1`,
    [runId],
  );
  if (run.rowCount === 0) throw new Error(`run ${runId} not found`);
  const current = await previewApply(pool, runId, run.rows[0].supplier_id);
  if (Number.isFinite(shown) && current.deactivations !== shown) {
    throw new Error(
      `the catalog changed since this preview was rendered: it now deactivates ${current.deactivations.toLocaleString()} products, not ${shown.toLocaleString()}. Reload the run and review the new numbers.`,
    );
  }

  await approveRun(pool, runId, approvedBy);
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

export async function rejectRunAction(formData: FormData): Promise<void> {
  const runId = requireId(formData, "runId");
  await rejectRun(getPool(), runId, await actor());
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

/**
 * Retry a failed run: restart-everything re-execution of the same run row.
 * Atomic claim — never a read-then-write — and 'rejected' is a distinct state,
 * so a snapshot a human discarded can never be resurrected here.
 */
export async function retryRunAction(formData: FormData): Promise<void> {
  // Authenticate BEFORE mutating: this action writes run state and closes
  // Issues, and an auth failure after the fact would leave those writes with
  // no audit row.
  const who = await assertAdmin();
  const runId = requireId(formData, "runId");
  const pool = getPool();
  // Retryable: a failed run, or one abandoned mid-flight — the worker
  // heartbeats every 60s, so 10 minutes without a heartbeat means the process
  // is genuinely gone, not merely slow.
  //
  // 'merging' is deliberately NOT retryable: decision 11 is that a merge in
  // flight always finishes. Restarting one would wipe the staging rows it is
  // reading, and its Deactivation Sweep would then find every product Missing.
  // (Even so, `attempt` fences the worker: it is bumped here, never reset, and
  // the worker asserts it before applying anything.)
  const claim = await pool.query(
    `update feed_runs
     set state = 'pending', error = null, failure_notified = false,
         attempt = attempt + 1, updated_at = now()
     where id = $1
       and (state = 'failed'
            or (state in ('downloading', 'staging', 'validating')
                and updated_at < now() - interval '10 minutes'))
     returning id`,
    [runId],
  );
  if (claim.rowCount === 0) {
    const run = await pool.query(`select state from feed_runs where id = $1`, [runId]);
    throw new Error(
      run.rowCount === 0
        ? `run ${runId} not found`
        : run.rows[0].state === "merging"
          ? "a merge in flight always finishes — wait for it, or re-ingest the file once it has"
          : `cannot retry a run that is ${run.rows[0].state} (an in-flight run becomes retryable after 10 minutes without a heartbeat)`,
    );
  }
  // A stuck-run Issue is scope 'run' and so cannot be hand-resolved; retrying
  // is the action that answers it, so it closes here. Matched on the evidence
  // tag the sweep writes, not on its prose.
  await pool.query(
    `update issues set status = 'resolved', resolution = 'retried by admin', resolved_at = now()
     where run_id = $1 and scope = 'run' and status = 'open' and evidence->>'kind' = 'stuck'`,
    [runId],
  );
  await pool.query(`insert into audit_log (actor, action, subject) values ($1, 'retry_run', $2)`, [
    who,
    JSON.stringify({ run_id: runId }),
  ]);
  await tryLaunch(runId);
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

/**
 * Manual re-ingest: replay a retained Snapshot as a NEW run, through the same
 * registration path as every other trigger — so it supersedes older pending
 * and halted runs instead of deadlocking their verdicts.
 */
export async function reingestAction(formData: FormData): Promise<void> {
  const sourceRunId = requireId(formData, "runId");
  const pool = getPool();
  const source = await pool.query(
    `select feed_id, object_key from feed_runs where id = $1`,
    [sourceRunId],
  );
  if (source.rowCount === 0) throw new Error(`run ${sourceRunId} not found`);
  const { feed_id, object_key } = source.rows[0];
  const run = await registerAndLaunch(pool, feed_id, object_key, { manualReingest: true });
  await pool.query(
    `insert into audit_log (actor, action, subject) values ($1, 'manual_reingest', $2)`,
    [await actor(), JSON.stringify({ run_id: run.runId, replays: sourceRunId, object_key })],
  );
  revalidatePath("/admin/runs");
}

/** Reverse an auto-deactivation — pins the product until it reappears. */
export async function reverseDeactivationAction(formData: FormData): Promise<void> {
  const supplierId = requireId(formData, "supplierId");
  const productCode = String(formData.get("productCode") ?? "");
  if (!productCode) throw new Error("invalid productCode");
  await reverseDeactivation(getPool(), supplierId, productCode, await actor());
  revalidatePath("/admin/products");
}

/**
 * Hand-resolve a Record or Product Issue that auto-resolution can't close.
 * Run Issues are deliberately excluded: they resolve ONLY by verdict, or a
 * halted run would vanish from the inbox while still blocking its feed.
 */
export async function resolveIssueAction(formData: FormData): Promise<void> {
  const issueId = requireId(formData, "issueId");
  const res = await getPool().query(
    `update issues set status = 'resolved', resolution = $2, resolved_at = now()
     where id = $1 and status = 'open' and scope in ('record', 'product')`,
    [issueId, `resolved by ${await actor()}`],
  );
  if (res.rowCount === 0) {
    throw new Error(
      "only open Record and Product issues can be resolved by hand — a Run issue closes when you approve or reject its run",
    );
  }
  revalidatePath("/admin/issues");
}
