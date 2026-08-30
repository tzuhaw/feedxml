import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

/**
 * Snapshot sources. Canonical: the R2 bucket via its S3-compatible API
 * (zero-egress reads). `file:` sources serve local demos and tests.
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
    s3: new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } }),
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
