import {
  S3Client,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** Whether object storage is wired up at all, so surfaces can say so plainly. */
export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

function r2(): { s3: S3Client; bucket: string } {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_* env vars are not configured");
  }
  return {
    s3: new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
      // R2's S3 endpoint serves the bucket in the PATH
      // (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>). The SDK
      // defaults to virtual-host addressing, which would aim requests at
      // <bucket>.<account>.r2.cloudflarestorage.com — a host that does not
      // resolve. Presigning fails silently in that case: a URL comes back
      // fine and only the eventual PUT fails, so it is worth pinning here.
      // It is also what lets the MinIO stand-in work locally.
      forcePathStyle: true,
    }),
    bucket,
  };
}

/** Every Snapshot object key in the canonical prefix (paginated fully). */
export async function listFeedObjectKeys(): Promise<string[]> {
  const { s3, bucket } = r2();
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "feeds/",
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * A presigned single PUT for an operator upload.
 *
 * `content-length` is a SIGNED header, which is what actually enforces the size
 * cap: the signature only validates for a body of exactly `size` bytes, so a
 * client that lies in `init` and then sends more gets a 403 from R2 rather than
 * a stored oversized object. The server re-checks the stored size on completion
 * anyway — belt and braces, since the cap protects the worker's memory budget.
 */
export async function signPutUrl(objectKey: string, size: number): Promise<string> {
  const { s3, bucket } = r2();
  return getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: objectKey, ContentLength: size }),
    { expiresIn: 900, signableHeaders: new Set(["content-length"]) },
  );
}

/** Stored size in bytes, or null if the object is not there. */
export async function headObjectSize(objectKey: string): Promise<number | null> {
  const { s3, bucket } = r2();
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function initMultipartUpload(objectKey: string): Promise<string> {
  const { s3, bucket } = r2();
  const res = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (!res.UploadId) throw new Error("multipart init returned no uploadId");
  return res.UploadId;
}

export async function signPartUrl(
  objectKey: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const { s3, bucket } = r2();
  return getSignedUrl(
    s3,
    new UploadPartCommand({
      Bucket: bucket,
      Key: objectKey,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: 3600 },
  );
}

export async function completeMultipartUpload(
  objectKey: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>,
): Promise<void> {
  const { s3, bucket } = r2();
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );
}
