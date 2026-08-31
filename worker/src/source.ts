import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/**
 * Snapshot sources. Canonical: the object-storage bucket over the S3 API.
 *
 * The provider is a deployment choice, not a code one — **this deployment uses
 * Supabase Storage**; Cloudflare R2 and the MinIO stand-in work unchanged. The
 * env vars keep their `R2_*` names as the established contract (see
 * apps/web/lib/r2.ts for the full note); read them as "object storage".
 *
 * The zero-egress property that originally justified R2 does NOT hold on
 * Supabase Storage, and this function is exactly where it would have paid off:
 * the worker re-reads the whole snapshot on every run and every retry.
 * DESIGN.md decision 6 carries the trade-off.
 *
 * `file:` sources serve local demos and tests.
 */
export async function openSnapshot(objectKey: string): Promise<Readable> {
  if (objectKey.startsWith("file:")) {
    // Local-file reads are a demo/test convenience ONLY. In a deployed worker
    // an attacker-influenced object_key must never reach the filesystem.
    if (process.env.ALLOW_FILE_SOURCE !== "1") {
      throw new Error("file: sources are disabled outside local demos");
    }
    return createReadStream(objectKey.slice("file:".length));
  }
  const { s3, bucket } = r2();
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (!res.Body) throw new Error(`empty body for object ${objectKey}`);
  return res.Body as Readable;
}

function r2(): { s3: S3Client; bucket: string } {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_* env vars are required for bucket operations");
  }
  return {
    // Path-style addressing: R2 serves the bucket in the path, not as a
    // subdomain of the account endpoint. See apps/web/lib/r2.ts for the full
    // reasoning — the two clients must agree or the worker cannot read what
    // the app wrote.
    s3: new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    }),
    bucket,
  };
}

export async function objectExists(objectKey: string): Promise<boolean> {
  if (objectKey.startsWith("file:")) return true;
  const { s3, bucket } = r2();
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return true;
  } catch (err) {
    // ONLY a definitive 404 means absent. Any other failure (auth, throttle,
    // 5xx) must throw — treating it as "missing" would re-pull the supplier
    // and overwrite the canonical audit Snapshot with different content.
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (err as { name?: string }).name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") return false;
    throw err;
  }
}

/** Publish a locally-built Snapshot (the scrape channel's output) to the bucket. */
export async function uploadSnapshot(localPath: string, objectKey: string): Promise<void> {
  const { s3, bucket } = r2();
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: objectKey, Body: createReadStream(localPath) },
    queueSize: 3,
    partSize: 16 * 1024 * 1024,
  });
  await upload.done();
}

/**
 * Pull channel: stream the supplier-hosted feed into the canonical bucket.
 * The bucket copy is the replay source and audit trail — ingestion always
 * reads from the bucket, never directly from the supplier (DESIGN.md §1).
 */
export async function pullToBucket(sourceUrl: string, objectKey: string): Promise<void> {
  const { s3, bucket } = r2();
  const res = await fetch(sourceUrl);
  if (!res.ok || !res.body) {
    throw new Error(`pull failed: ${res.status} from supplier at ${sourceUrl}`);
  }
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: bucket,
      Key: objectKey,
      Body: Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
    },
    queueSize: 3,
    partSize: 16 * 1024 * 1024,
  });
  await upload.done();
}
