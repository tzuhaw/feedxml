import { NextResponse } from "next/server";
import { buildObjectKey, parseObjectKey } from "@feedxml/shared";
import { getPool } from "@/lib/db";
import { currentAdmin } from "@/lib/guard";
import { headObjectSize, r2Configured, signPutUrl } from "@/lib/r2";
import { executeRun } from "@feedxml/worker/run";
import { registerAndLaunch, resolveFeedForKey } from "@/lib/runs";
import { MAX_UPLOAD_BYTES } from "@/lib/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The inline execution below streams and merges a capped snapshot. Seconds in
// practice; this is headroom, not an expectation.
export const maxDuration = 300;

/**
 * Operator upload (admin panel → /admin/upload).
 *
 *   {action:"init", feedId, size}  → {objectKey, url}
 *   {action:"complete", objectKey} → run registered + launched
 *
 * The bytes go browser → bucket directly on a presigned URL; they never pass
 * through this function. That keeps a large body off the serverless request
 * path, and it means the file lands in exactly the same place, under exactly
 * the same server-controlled key shape, as a supplier push — so from the
 * worker's point of view an operator upload is not a special case at all.
 *
 * Everything that decides what happens is server-side: the key is built here
 * from the feed's own supplier, the size cap is bound into the signature, and
 * the stored object is re-measured before any run is registered.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const admin = await currentAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (!r2Configured()) {
    return NextResponse.json(
      { error: "Object storage is not configured (R2_* env vars)." },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const pool = getPool();

  switch (body.action) {
    case "init": {
      const feedId = body.feedId;
      if (typeof feedId !== "string" || !UUID.test(feedId)) {
        return NextResponse.json({ error: "feedId must be a uuid" }, { status: 400 });
      }
      const size = Number(body.size);
      if (!Number.isInteger(size) || size <= 0) {
        return NextResponse.json({ error: "size must be a positive integer" }, { status: 400 });
      }
      if (size > MAX_UPLOAD_BYTES) {
        return NextResponse.json(
          { error: `File is larger than the ${MAX_UPLOAD_BYTES} byte limit for this page.` },
          { status: 413 },
        );
      }

      // The supplier comes from the feed, never from the client — that is what
      // stops one upload landing in another supplier's prefix.
      const feed = await pool.query(
        `select s.name as supplier, f.format, f.active
         from feeds f join suppliers s on s.id = f.supplier_id
         where f.id = $1`,
        [feedId],
      );
      if (feed.rowCount === 0) {
        return NextResponse.json({ error: "no such feed" }, { status: 404 });
      }
      if (!feed.rows[0].active) {
        return NextResponse.json({ error: "that feed is paused" }, { status: 409 });
      }
      if (feed.rows[0].format !== "xml") {
        return NextResponse.json(
          { error: "this page uploads XML; that feed expects " + feed.rows[0].format },
          { status: 409 },
        );
      }

      const objectKey = buildObjectKey(feed.rows[0].supplier, Date.now(), "xml");
      const url = await signPutUrl(objectKey, size);
      await pool.query(
        `insert into audit_log (actor, action, subject) values ($1, 'upload_init', $2)`,
        [`admin:${admin}`, JSON.stringify({ feed_id: feedId, object_key: objectKey, size })],
      );
      return NextResponse.json({ objectKey, url });
    }

    case "complete": {
      const objectKey = body.objectKey;
      if (typeof objectKey !== "string" || parseObjectKey(objectKey) === null) {
        return NextResponse.json({ error: "malformed objectKey" }, { status: 400 });
      }

      // Re-measure rather than trust the browser: the signature already binds
      // the length, but a run is expensive and a truncated upload is cheap to
      // catch here.
      const stored = await headObjectSize(objectKey);
      if (stored === null) {
        return NextResponse.json(
          { error: "that object is not in the bucket — the upload did not finish" },
          { status: 409 },
        );
      }
      if (stored > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "stored object exceeds the limit" }, { status: 413 });
      }

      const feed = await resolveFeedForKey(pool, objectKey);
      if (!feed) {
        return NextResponse.json(
          { error: "upload stored, but no active feed matches this format" },
          { status: 409 },
        );
      }
      const run = await registerAndLaunch(pool, feed.feedId, objectKey);
      await pool.query(
        `insert into audit_log (actor, action, subject) values ($1, 'upload_complete', $2)`,
        [
          `admin:${admin}`,
          JSON.stringify({ object_key: objectKey, run_id: run.runId, bytes: stored }),
        ],
      );

      /*
       * Run it now rather than leaving it pending.
       *
       * registerAndLaunch already tried the Cloud Run Job; `launched` is false
       * when CLOUD_RUN_JOB_URL is not configured, and without an executor the
       * run would sit in `pending` forever — the sweep only re-launches, it
       * does not ingest. An operator who just uploaded a file and is told
       * "pending" with nothing ever moving is being lied to.
       *
       * Executing inside the request is safe HERE and nowhere else: this path
       * is capped at MAX_UPLOAD_BYTES, so the work is seconds and bounded. It
       * is not a general ingestion path and must not become one — DESIGN.md's
       * whole argument is that a multi-gigabyte parse cannot live in a
       * serverless function. A configured worker still wins: if the launch
       * succeeded we do not duplicate it, and executeRun's attempt-based
       * fencing makes a double execution safe even if we raced.
       */
      let executed: "worker" | "inline" | "inline-failed" | null = run.launched ? "worker" : null;
      if (!run.launched && run.created) {
        try {
          const ctx = await pool.query(
            `select f.id as feed_id, f.thresholds, f.skip_streak_limit, f.channel, f.format,
                    f.source_url, s.id as supplier_id, s.name as supplier_name
             from feeds f join suppliers s on s.id = f.supplier_id
             where f.id = $1`,
            [feed.feedId],
          );
          const c = ctx.rows[0];
          const outcome = await executeRun(pool, {
            runId: run.runId,
            objectKey,
            supplierId: c.supplier_id,
            supplierName: c.supplier_name,
            feedId: c.feed_id,
            thresholds: c.thresholds,
            skipStreakLimit: c.skip_streak_limit,
            channel: c.channel,
            format: c.format,
            sourceUrl: c.source_url,
          });
          executed = "inline";
          return NextResponse.json(
            { ...run, executed, halted: outcome.halted, counts: outcome.result ?? null },
            { status: 201 },
          );
        } catch (err) {
          // The run is registered and its own error is recorded by executeRun.
          // Report it rather than returning a success the panel will contradict.
          console.error(`[upload] inline execution failed for run ${run.runId}:`, err);
          executed = "inline-failed";
        }
      }
      return NextResponse.json({ ...run, executed }, { status: run.created ? 201 : 200 });
    }

    default:
      return NextResponse.json({ error: "action must be init | complete" }, { status: 400 });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
