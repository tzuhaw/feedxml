import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { secretsMatch } from "@/lib/auth";
import { listFeedObjectKeys } from "@/lib/r2";
import { registerAndLaunch, resolveFeedForKey, tryLaunch } from "@/lib/runs";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * The safety-net sweep (DESIGN.md decision 7): idempotent housekeeping that
 * makes every other mechanism rescueable. Runs every ~5 minutes (GitHub
 * Actions schedule) plus daily via Vercel cron as backup. Each step is
 * independent — one failing must not stop the rest.
 *
 *   1. discover  — bucket objects nobody registered → register + launch
 *   2. relaunch  — pending runs whose launch was missed
 *   3. pull      — schedule pull-channel feeds that are due
 *   4. stuck     — flag runs frozen mid-flight (> max(30m, 2×p95)) as Issues
 *   5. retention — resolved Issues > 90d; failed runs' staging > 90d
 */
export async function GET(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !secretsMatch(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const summary: Record<string, unknown> = {};

  // 1. Discover unregistered bucket objects (covers supplier-direct uploads
  // whose `complete` call never came, and any missed self-report).
  try {
    const keys = await listFeedObjectKeys();
    let registered = 0;
    if (keys.length > 0) {
      const known = await pool.query(
        `select object_key from feed_runs where object_key = any($1::text[])`,
        [keys],
      );
      const knownSet = new Set(known.rows.map((r) => r.object_key));
      for (const key of keys.filter((k) => !knownSet.has(k)).slice(0, 20)) {
        const feed = await resolveFeedForKey(pool, key);
        if (feed) {
          await registerAndLaunch(pool, feed.feedId, key);
          registered += 1;
        }
      }
    }
    summary.discovered = registered;
  } catch (err) {
    summary.discovered = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Relaunch pending runs whose launch was missed.
  try {
    const pending = await pool.query(
      `select id from feed_runs
       where state = 'pending' and created_at < now() - interval '3 minutes'
       order by created_at limit 10`,
    );
    let relaunched = 0;
    for (const row of pending.rows) {
      if (await tryLaunch(row.id)) relaunched += 1;
    }
    summary.relaunched = `${relaunched}/${pending.rowCount}`;
  } catch (err) {
    summary.relaunched = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 3. Pull-channel scheduling: due feeds get a run registered; the worker
  // downloads supplier → bucket → normal pipeline.
  try {
    const due = await pool.query(
      `select f.id, f.format, s.name
       from feeds f join suppliers s on s.id = f.supplier_id
       where f.active and f.channel = 'pull'
         and f.source_url is not null and f.schedule_minutes is not null
         and not exists (select 1 from feed_runs r
                         where r.feed_id = f.id
                           and (r.state in ('pending','downloading','staging','validating','merging','awaiting_review')
                                or r.created_at > now() - make_interval(mins => f.schedule_minutes)))`,
    );
    for (const feed of due.rows) {
      const objectKey = `feeds/${feed.name}/${Date.now()}.${feed.format}`;
      await registerAndLaunch(pool, feed.id, objectKey);
    }
    summary.pullScheduled = due.rowCount;
  } catch (err) {
    summary.pullScheduled = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 4. Stuck-run detector: flag, never touch state (a human decides).
  try {
    const stuck = await pool.query(
      `with p95 as (
         select coalesce(percentile_cont(0.95) within group
                  (order by extract(epoch from updated_at - created_at)), 0) as secs
         from (select updated_at, created_at from feed_runs
               where state = 'done' order by updated_at desc limit 50) recent
       )
       insert into issues (scope, run_id, supplier_id, reason)
       select 'run', r.id, f.supplier_id,
              'run appears stuck in ' || r.state || ' since ' || r.updated_at::text
       from feed_runs r
       join feeds f on f.id = r.feed_id, p95
       where r.state in ('downloading', 'staging', 'validating', 'merging')
         and r.updated_at < now() - greatest(interval '30 minutes', make_interval(secs => 2 * p95.secs))
         and not exists (select 1 from issues i
                         where i.run_id = r.id and i.scope = 'run' and i.status = 'open')
       returning r.id`,
    );
    summary.stuckFlagged = stuck.rowCount;
  } catch (err) {
    summary.stuckFlagged = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 5. Retention (DESIGN.md decision 16). Last-successful staging retention
  // happens in the worker at completion; these are the time-based purges.
  try {
    const issues = await pool.query(
      `delete from issues where status = 'resolved' and resolved_at < now() - interval '90 days'`,
    );
    const staleStaging = await pool.query(
      `delete from staging_products sp using feed_runs r
       where sp.run_id = r.id and r.state = 'failed' and r.updated_at < now() - interval '90 days'`,
    );
    await pool.query(
      `delete from staging_skipped sk using feed_runs r
       where sk.run_id = r.id and r.state = 'failed' and r.updated_at < now() - interval '90 days'`,
    );
    summary.purgedIssues = issues.rowCount;
    summary.purgedStaging = staleStaging.rowCount;
  } catch (err) {
    summary.retention = `error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return NextResponse.json(summary);
}
