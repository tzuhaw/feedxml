import type { Pool } from "pg";
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
  const match = /^feeds\/([^/]+)\/[^/]+\.(xml|ndjson)$/.exec(objectKey);
  if (!match) return null;
  const [, supplierName, extension] = match;
  const feed = await pool.query(
    `select f.id from feeds f
     join suppliers s on s.id = f.supplier_id
     where s.name = $1 and f.active and f.format = $2::snapshot_format
     order by f.created_at limit 1`,
    [supplierName, extension],
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
