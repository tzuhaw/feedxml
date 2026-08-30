import { NextResponse } from "next/server";
import { parseObjectKey } from "@feedxml/shared";
import { getPool } from "@/lib/db";
import { secretsMatch } from "@/lib/auth";
import { registerAndLaunch, resolveFeedForKey } from "@/lib/runs";

export const runtime = "nodejs";

/**
 * Self-report trigger: channels we control call this after completing an
 * upload; the safety-net cron covers anything missed. All trigger paths share
 * lib/runs.ts — idempotent via feed_runs.object_key uniqueness (DESIGN.md,
 * decision 7).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!secret || !secretsMatch(req.headers.get("x-internal-secret"), secret)) {
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
  // 400 = the key itself violates the contract (client bug, don't retry);
  // 404 = well-formed key but no active feed (provisioning gap).
  if (typeof objectKey !== "string" || parseObjectKey(objectKey) === null) {
    return NextResponse.json(
      { error: "objectKey must match feeds/{supplier}/{timestamp}.{xml|ndjson}" },
      { status: 400 },
    );
  }

  const pool = getPool();
  const feed = await resolveFeedForKey(pool, objectKey);
  if (!feed) {
    return NextResponse.json(
      { error: "no active feed matches this objectKey" },
      { status: 404 },
    );
  }

  const run = await registerAndLaunch(pool, feed.feedId, objectKey);
  return NextResponse.json(run, { status: run.created ? 201 : 200 });
}
