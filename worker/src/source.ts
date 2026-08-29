import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

/**
 * Snapshot sources. Canonical: the R2 bucket via its S3-compatible API
 * (zero-egress reads). `file:` sources serve local demos and tests.
 */
export async function openSnapshot(objectKey: string): Promise<Readable> {
  if (objectKey.startsWith("file:")) {
    return createReadStream(objectKey.slice("file:".length));
  }
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET must be set for non-file sources",
    );
  }
  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (!res.Body) throw new Error(`empty body for object ${objectKey}`);
  return res.Body as Readable;
}
