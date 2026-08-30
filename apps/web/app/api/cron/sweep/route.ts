import { NextResponse } from "next/server";
import { buildObjectKey, parseObjectKey } from "@feedxml/shared";
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
 * independent — one failing must not stop the rest — but any failure is
 * logged AND turns the response into a 500 so the schedulers alert.
 *
 *   1. discover  — bucket objects nobody registered → register + launch
 *   2. relaunch  — pending runs whose launch was missed
 *   3. pull      — schedule pull-channel feeds that are due
 *   4. stuck     — flag runs frozen mid-flight (> max(30m, 2×p95)) as Issues
 *   5. retention — resolved Issues > 90d; unresolved-evidence-safe staging purge
 */
export async function GET(req: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get("authorization");
  if (!secret || !secretsMatch(header, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  const summary: Record<string, unknown> = {};
  let failed = false;
  const fail = (step: string, err: unknown): void => {
    failed = true;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sweep] ${step} failed:`, err);
    summary[step] = `error: ${message}`;
  };

  // 1. Discover unregistered bucket objects (covers supplier-direct uploads
  // whose `complete` call never came, and any missed self-report). Newest
  // first, so unresolvable stragglers can never starve fresh uploads.
  try {
    const keys = await listFeedObjectKeys();
    let registered = 0;
    if (keys.length > 0) {
      const known = await pool.query(
        `select object_key from feed_runs where object_key = any($1::text[])`,
        [keys],
      );
      const knownSet = new Set(known.rows.map((r) => r.object_key));
      const candidates = keys
        .filter((k) => !knownSet.has(k))
        .map((k) => ({ key: k, parsed: parseObjectKey(k) }))
        .filter((c): c is { key: string; parsed: NonNullable<ReturnType<typeof parseObjectKey>> } =>
          c.parsed !== null,
        )
        .sort((a, b) => b.parsed.timestamp - a.parsed.timestamp)
        .slice(0, 20);
      for (const { key } of candidates) {
        const feed = await resolveFeedForKey(pool, key);
        if (feed) {
          await registerAndLaunch(pool, feed.feedId, key);
          registered += 1;
        }
      }
    }
    summary.discovered = registered;
  } catch (err) {
    fail("discovered", err);
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
    fail("relaunched", err);
  }

  // 3. Pull-channel scheduling. Rules that keep it live and idempotent:
  // - runs actively executing block (no concurrent double-pull);
  // - a done run blocks for one schedule window;
  // - a failed run backs off only briefly (min(schedule/4, 30m) floor) so a
  //   recovered supplier doesn't wait a whole cycle;
  // - awaiting_review and superseded do NOT block — a halted run must not
  //   stop the very snapshot that would supersede it;
  // - the object key is the SCHEDULE SLOT, not wall-clock, so overlapping
  //   sweeps (GH Actions + Vercel cron) mint the same key and dedupe.
  try {
    const due = await pool.query(
      `select f.id, f.format, f.schedule_minutes, s.name
       from feeds f join suppliers s on s.id = f.supplier_id
       where f.active and f.channel = 'pull'
         and f.source_url is not null and f.schedule_minutes is not null
         and not exists (select 1 from feed_runs r
                         where r.feed_id = f.id
                           and r.state in ('pending','downloading','staging','validating','merging'))
         and not exists (select 1 from feed_runs r
                         where r.feed_id = f.id and r.state = 'done'
                           and r.created_at > now() - make_interval(mins => f.schedule_minutes))
         and not exists (select 1 from feed_runs r
                         where r.feed_id = f.id and r.state = 'failed'
                           and r.created_at > now() - greatest(
                                 make_interval(mins => f.schedule_minutes / 4),
                                 interval '30 minutes'))`,
    );
    for (const feed of due.rows) {
      const intervalMs = feed.schedule_minutes * 60_000;
      const slot = Math.floor(Date.now() / intervalMs) * intervalMs;
      await registerAndLaunch(pool, feed.id, buildObjectKey(feed.name, slot, feed.format));
    }
    summary.pullScheduled = due.rowCount;
  } catch (err) {
    fail("pullScheduled", err);
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
       returning run_id`,
    );
    summary.stuckFlagged = stuck.rowCount;
  } catch (err) {
    fail("stuckFlagged", err);
  }

  // 5. Retention (DESIGN.md decision 16). Last-successful staging retention
  // happens in the worker at completion; these are the time-based purges.
  // Evidence rule: staging with an OPEN issue is never purged.
  try {
    const issues = await pool.query(
      `delete from issues where status = 'resolved' and resolved_at < now() - interval '90 days'`,
    );
    const staleStaging = await pool.query(
      `delete from staging_products sp using feed_runs r
       where sp.run_id = r.id and r.state = 'failed'
         and r.updated_at < now() - interval '90 days'
         and not exists (select 1 from issues i where i.run_id = r.id and i.status = 'open')`,
    );
    await pool.query(
      `delete from staging_skipped sk using feed_runs r
       where sk.run_id = r.id and r.state = 'failed'
         and r.updated_at < now() - interval '90 days'
         and not exists (select 1 from issues i where i.run_id = r.id and i.status = 'open')`,
    );
    summary.purgedIssues = issues.rowCount;
    summary.purgedStaging = staleStaging.rowCount;
  } catch (err) {
    fail("retention", err);
  }

  return NextResponse.json(summary, { status: failed ? 500 : 200 });
}
