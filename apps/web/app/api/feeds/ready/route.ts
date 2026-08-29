import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { launchWorker } from "@/lib/launcher";

export const runtime = "nodejs";

/**
 * Self-report trigger: channels we control call this after completing an
 * upload; the safety-net cron (Sprint 3) calls the same logic. Idempotency
 * lives in the feed_runs.object_key uniqueness — whoever fires first inserts
 * the Run, later callers no-op (DESIGN.md, decision 7). A run that was
 * registered but never launched (launch failure, launcher unconfigured) is
 * re-launched on any later trigger for the same object key, so a transient
 * Cloud Run outage cannot permanently strand a pending run.
 *
 * Auth: internal secret for now. Supplier-facing key auth (bcrypt) arrives
 * with the push channel's upload-url route in Sprint 3.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!secret || req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const objectKey =
    typeof body === "object" && body !== null && "objectKey" in body
      ? (body as { objectKey: unknown }).objectKey
      : undefined;
  // Canonical bucket layout: feeds/{supplier}/{timestamp}.{xml|ndjson}
  const match =
    typeof objectKey === "string"
      ? /^feeds\/([^/]+)\/[^/]+\.(xml|ndjson)$/.exec(objectKey)
      : null;
  if (!match) {
    return NextResponse.json(
      { error: "objectKey must match feeds/{supplier}/{file}.{xml|ndjson}" },
      { status: 400 },
    );
  }
  const [, supplierName, extension] = match;

  // Resolve the Feed, not just the Supplier: the extension names the format,
  // which disambiguates a supplier with e.g. a push/xml and a scrape/ndjson
  // feed. Two active feeds with the SAME format for one supplier stay
  // ambiguous until per-feed prefixes arrive (Sprint 3).
  const pool = getPool();
  const feed = await pool.query(
    `select f.id from feeds f
     join suppliers s on s.id = f.supplier_id
     where s.name = $1 and f.active and f.format = $2::snapshot_format
     order by f.created_at limit 1`,
    [supplierName, extension],
  );
  if (feed.rowCount === 0) {
    return NextResponse.json(
      { error: `no active ${extension} feed for supplier "${supplierName}"` },
      { status: 404 },
    );
  }

  const inserted = await pool.query(
    `insert into feed_runs (feed_id, object_key) values ($1, $2)
     on conflict (object_key) do nothing
     returning id`,
    [feed.rows[0].id, objectKey],
  );

  if (inserted.rowCount === 0) {
    const existing = await pool.query(
      `select id, state from feed_runs where object_key = $1`,
      [objectKey],
    );
    const run = existing.rows[0];
    // Rescue path: a pending run whose launch was missed gets launched now.
    let launched = false;
    if (run.state === "pending") {
      launched = await tryLaunch(run.id);
    }
    return NextResponse.json({
      runId: run.id,
      state: run.state,
      created: false,
      launched,
    });
  }

  const runId: string = inserted.rows[0].id;
  const launched = await tryLaunch(runId);
  return NextResponse.json({ runId, created: true, launched }, { status: 201 });
}

async function tryLaunch(runId: string): Promise<boolean> {
  try {
    return await launchWorker(runId);
  } catch (err) {
    // Run stays 'pending'; a later trigger or the safety-net cron re-launches.
    console.error(`[trigger] launch failed for run ${runId}:`, err);
    return false;
  }
}
