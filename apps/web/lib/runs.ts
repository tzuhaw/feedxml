import type { Pool } from "pg";
import { parseObjectKey } from "@feedxml/shared";
import { launchWorker } from "@/lib/launcher";

/**
 * Feed resolution + idempotent run registration — the single implementation
 * behind every trigger path (self-report, upload completion, safety-net cron,
 * pull scheduling). Idempotency lives in feed_runs.object_key uniqueness.
 */

export async function resolveFeedForKey(
  pool: Pool,
  objectKey: string,
): Promise<{ feedId: string } | null> {
  const parsed = parseObjectKey(objectKey);
  if (!parsed) return null;
  // Push-arrival keys prefer the push feed: a supplier may legitimately have
  // both a push and a pull feed of the same format (pull runs never resolve
  // by key — the sweep registers them with an explicit feed id).
  const feed = await pool.query(
    `select f.id from feeds f
     join suppliers s on s.id = f.supplier_id
     where s.name = $1 and f.active and f.format = $2::snapshot_format
     order by (f.channel = 'push') desc, f.created_at limit 1`,
    [parsed.supplierName, parsed.format],
  );
  return feed.rowCount === 0 ? null : { feedId: feed.rows[0].id };
}

export interface RegisteredRun {
  runId: string;
  state: string;
  created: boolean;
  launched: boolean;
}

export async function registerAndLaunch(
  pool: Pool,
  feedId: string,
  objectKey: string,
): Promise<RegisteredRun> {
  const inserted = await pool.query(
    `insert into feed_runs (feed_id, object_key) values ($1, $2)
     on conflict (object_key) do nothing
     returning id`,
    [feedId, objectKey],
  );
  if (inserted.rowCount === 0) {
    const existing = await pool.query(
      `select id, state from feed_runs where object_key = $1`,
      [objectKey],
    );
    const run = existing.rows[0];
    // Rescue path: a pending run whose launch was missed gets launched now.
    const launched = run.state === "pending" ? await tryLaunch(run.id) : false;
    return { runId: run.id, state: run.state, created: false, launched };
  }
  const runId: string = inserted.rows[0].id;

  // Registration-time supersession for runs that aren't executing (pending,
  // awaiting_review): a newer Snapshot makes them obsolete NOW, even if the
  // launcher is down — otherwise a stale Halted run deadlocks verdicts
  // ("newer run exists" refuses approve, yet nothing ever supersedes it).
  // Running states are left to the worker's own supersession pass.
  await pool.query(
    `with old as (
       update feed_runs o
       set state = 'superseded', superseded_by = $2, updated_at = now()
       where o.feed_id = $1 and o.id <> $2
         and o.created_at < (select created_at from feed_runs where id = $2)
         and o.state in ('pending', 'awaiting_review')
       returning o.id
     )
     update issues set status = 'resolved', resolution = 'superseded', resolved_at = now()
     where scope = 'run' and status = 'open' and run_id in (select id from old)`,
    [feedId, runId],
  );

  const launched = await tryLaunch(runId);
  return { runId, state: "pending", created: true, launched };
}

export async function tryLaunch(runId: string): Promise<boolean> {
  try {
    return await launchWorker(runId);
  } catch (err) {
    // Run stays 'pending'; a later trigger or the safety-net cron re-launches.
    console.error(`[trigger] launch failed for run ${runId}:`, err);
    return false;
  }
}
