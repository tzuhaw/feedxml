import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { launchWorker } from "@/lib/launcher";

export const runtime = "nodejs";

/**
 * Self-report trigger: channels we control call this after completing an
 * upload; the safety-net cron (Sprint 3) calls the same logic. Idempotency
 * lives in the feed_runs.object_key uniqueness — whoever fires first inserts
 * the Run, later callers no-op (DESIGN.md, decision 7).
 *
 * Auth: internal secret for now. Supplier-facing key auth (bcrypt) arrives
 * with the push channel's upload-url route in Sprint 3.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!secret || req.headers.get("x-internal-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { objectKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const objectKey = body.objectKey;
  // Canonical bucket layout: feeds/{supplier}/{timestamp}.{xml|ndjson}
  const match = objectKey?.match(/^feeds\/([^/]+)\/[^/]+$/);
  if (!objectKey || !match) {
    return NextResponse.json(
      { error: "objectKey must match feeds/{supplier}/{file}" },
      { status: 400 },
    );
  }
  const supplierName = match[1];

  const pool = getPool();
  const feed = await pool.query(
    `select f.id from feeds f
     join suppliers s on s.id = f.supplier_id
     where s.name = $1 and f.active
     order by f.created_at limit 1`,
    [supplierName],
  );
  if (feed.rowCount === 0) {
    return NextResponse.json(
      { error: `no active feed for supplier "${supplierName}"` },
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
    return NextResponse.json({
      runId: existing.rows[0].id,
      state: existing.rows[0].state,
      created: false,
    });
  }

  const runId: string = inserted.rows[0].id;
  await launchWorker(runId);
  return NextResponse.json({ runId, created: true }, { status: 201 });
}
