import {
  S3Client,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function r2(): { s3: S3Client; bucket: string } {
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2_* env vars are not configured");
  }
  return {
    s3: new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } }),
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
