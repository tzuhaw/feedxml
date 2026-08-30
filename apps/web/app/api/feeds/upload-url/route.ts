import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateSupplier } from "@/lib/auth";
import { completeMultipartUpload, initMultipartUpload, signPartUrl } from "@/lib/r2";
import { registerAndLaunch, resolveFeedForKey } from "@/lib/runs";

export const runtime = "nodejs";

/**
 * Push channel (DESIGN.md §1, channel A). Supplier authenticates with
 * x-supplier-id + x-api-key and drives a three-step multipart upload:
 *
 *   {action:"init", format:"xml"|"ndjson"}      → {objectKey, uploadId}
 *   {action:"sign-part", objectKey, uploadId, partNumber} → {url}
 *   {action:"complete", objectKey, uploadId, parts:[{PartNumber,ETag}]}
 *                                               → run registered + launched
 *
 * The object key is SERVER-controlled (feeds/{supplier}/{timestamp}.{format})
 * and every action re-checks that the key sits inside the caller's own
 * prefix, so one supplier can never write into another's namespace.
 * Completing the upload doubles as the self-report trigger — the "done"
 * moment the design wanted from channel A.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const pool = getPool();
  const supplier = await authenticateSupplier(pool, req);
  if (!supplier) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const ownPrefix = `feeds/${supplier.name}/`;
  const keyOk = (k: unknown): k is string =>
    typeof k === "string" && k.startsWith(ownPrefix) && /\.(xml|ndjson)$/.test(k);
  const uploadIdOk = (u: unknown): u is string =>
    typeof u === "string" && u.length > 0 && u.length < 4096;

  switch (body.action) {
    case "init": {
      const format = body.format === "ndjson" ? "ndjson" : "xml";
      const objectKey = `${ownPrefix}${Date.now()}.${format}`;
      const uploadId = await initMultipartUpload(objectKey);
      await pool.query(
        `insert into audit_log (actor, action, subject) values ($1, 'upload_init', $2)`,
        [`supplier:${supplier.name}`, JSON.stringify({ supplier_id: supplier.id, object_key: objectKey })],
      );
      return NextResponse.json({ objectKey, uploadId, partSizeHint: 100 * 1024 * 1024 });
    }

    case "sign-part": {
      const { objectKey, uploadId, partNumber } = body;
      if (!keyOk(objectKey) || !uploadIdOk(uploadId)) {
        return NextResponse.json({ error: "invalid objectKey or uploadId" }, { status: 400 });
      }
      const n = Number(partNumber);
      if (!Number.isInteger(n) || n < 1 || n > 10000) {
        return NextResponse.json({ error: "partNumber must be 1..10000" }, { status: 400 });
      }
      return NextResponse.json({ url: await signPartUrl(objectKey, uploadId, n) });
    }

    case "complete": {
      const { objectKey, uploadId, parts } = body;
      if (!keyOk(objectKey) || !uploadIdOk(uploadId) || !Array.isArray(parts)) {
        return NextResponse.json({ error: "invalid completion payload" }, { status: 400 });
      }
      let cleanParts: Array<{ PartNumber: number; ETag: string }>;
      try {
        cleanParts = parts.map((p: unknown) => {
          const part = p as { PartNumber?: unknown; ETag?: unknown };
          const num = Number(part.PartNumber);
          if (!Number.isInteger(num) || num < 1 || num > 10000 || typeof part.ETag !== "string") {
            throw new Error("bad part");
          }
          return { PartNumber: num, ETag: part.ETag };
        });
      } catch {
        return NextResponse.json({ error: "invalid parts list" }, { status: 400 });
      }
      try {
        await completeMultipartUpload(objectKey, uploadId, cleanParts);
      } catch {
        return NextResponse.json({ error: "multipart completion failed" }, { status: 400 });
      }
      const feed = await resolveFeedForKey(pool, objectKey);
      if (!feed) {
        return NextResponse.json(
          { error: "upload stored, but no active feed matches this format" },
          { status: 409 },
        );
      }
      const run = await registerAndLaunch(pool, feed.feedId, objectKey);
      return NextResponse.json(run, { status: 201 });
    }

    default:
      return NextResponse.json(
        { error: "action must be init | sign-part | complete" },
        { status: 400 },
      );
  }
}
