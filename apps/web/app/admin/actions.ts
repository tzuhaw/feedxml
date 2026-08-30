"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { approveRun, rejectRun, reverseDeactivation } from "@feedxml/domain";
import { getPool } from "@/lib/db";
import { tryLaunch } from "@/lib/runs";

/**
 * Every panel mutation. All of them delegate to @feedxml/domain, so a verdict
 * clicked here runs exactly the code the worker runs — the panel adds no
 * catalog rules of its own.
 */

async function actor(): Promise<string> {
  // Basic-auth user from the middleware-protected request.
  const header = (await headers()).get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const user = atob(header.slice("Basic ".length)).split(":")[0];
      if (user) return `admin:${user}`;
    } catch {
      /* fall through */
    }
  }
  return "admin:unknown";
}

export async function approveRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId"));
  await approveRun(getPool(), runId, await actor());
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

export async function rejectRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId"));
  await rejectRun(getPool(), runId, await actor());
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

/** Retry a failed run: restart-everything re-execution of the same run row. */
export async function retryRunAction(formData: FormData): Promise<void> {
  const runId = String(formData.get("runId"));
  const pool = getPool();
  const run = await pool.query(`select state from feed_runs where id = $1`, [runId]);
  if (run.rowCount === 0) throw new Error(`run ${runId} not found`);
  if (run.rows[0].state !== "failed") {
    throw new Error(`only failed runs can be retried (run is ${run.rows[0].state})`);
  }
  await pool.query(
    `update feed_runs set state = 'pending', error = null, updated_at = now() where id = $1`,
    [runId],
  );
  await pool.query(`insert into audit_log (actor, action, subject) values ($1, 'retry_run', $2)`, [
    await actor(),
    JSON.stringify({ run_id: runId }),
  ]);
  await tryLaunch(runId);
  revalidatePath("/admin/runs");
  revalidatePath(`/admin/runs/${runId}`);
}

/**
 * Manual re-ingest: replay a retained Snapshot as a NEW run. Marked
 * manual_reingest so it bypasses the object_key uniqueness that keeps
 * automatic triggers idempotent (migration 0007).
 */
export async function reingestAction(formData: FormData): Promise<void> {
  const sourceRunId = String(formData.get("runId"));
  const pool = getPool();
  const source = await pool.query(
    `select feed_id, object_key from feed_runs where id = $1`,
    [sourceRunId],
  );
  if (source.rowCount === 0) throw new Error(`run ${sourceRunId} not found`);
  const { feed_id, object_key } = source.rows[0];
  const created = await pool.query(
    `insert into feed_runs (feed_id, object_key, manual_reingest) values ($1, $2, true)
     returning id`,
    [feed_id, object_key],
  );
  const runId: string = created.rows[0].id;
  await pool.query(
    `insert into audit_log (actor, action, subject) values ($1, 'manual_reingest', $2)`,
    [await actor(), JSON.stringify({ run_id: runId, replays: sourceRunId, object_key })],
  );
  await tryLaunch(runId);
  revalidatePath("/admin/runs");
}

/** Reverse an auto-deactivation — pins the product until it reappears. */
export async function reverseDeactivationAction(formData: FormData): Promise<void> {
  const supplierId = String(formData.get("supplierId"));
  const productCode = String(formData.get("productCode"));
  await reverseDeactivation(getPool(), supplierId, productCode, await actor());
  revalidatePath("/admin/products");
}

/** Resolve an Issue by hand (the escape hatch for ones auto-resolution can't close). */
export async function resolveIssueAction(formData: FormData): Promise<void> {
  const issueId = String(formData.get("issueId"));
  await getPool().query(
    `update issues set status = 'resolved', resolution = $2, resolved_at = now()
     where id = $1 and status = 'open'`,
    [issueId, `resolved by ${await actor()}`],
  );
  revalidatePath("/admin/issues");
}
