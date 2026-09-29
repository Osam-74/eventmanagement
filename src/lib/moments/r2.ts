import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Cloudflare R2 access for guest "moments" uploads.
 *
 * DELIBERATELY SEPARATE from lib/firebase/admin.ts: the invitation cards
 * live in Firebase Storage (Blaze) and that must never be touched by this
 * feature. Guest photos/videos go to their own R2 bucket, and the browser
 * uploads DIRECTLY to R2 with short-lived presigned URLs, so the bytes never
 * pass through a Vercel function (which caps request bodies at ~4.5 MB).
 *
 * R2 is S3-compatible: endpoint https://<account>.r2.cloudflarestorage.com,
 * region "auto".
 */

/** Names of every env var this module needs — used for the setup check. */
export const R2_ENV_VARS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

export function r2MissingEnv(): string[] {
  return R2_ENV_VARS.filter((k) => !process.env[k]);
}
export function r2Configured(): boolean {
  return r2MissingEnv().length === 0;
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (_client) return _client;
  const missing = r2MissingEnv();
  if (missing.length) throw new Error(`R2 is not configured. Missing: ${missing.join(', ')}`);
  _client = new S3Client({
    region: 'auto',
    // R2_ENDPOINT is optional and only for tests / other S3-compatible hosts;
    // production leaves it unset and uses the account's R2 endpoint.
    endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(process.env.R2_ENDPOINT),
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
    // R2 does not support the newer default checksum trailers; without this
    // the SDK adds them to presigned PUTs and R2 rejects the upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return _client;
}
const bucketName = () => process.env.R2_BUCKET!;

/** Presigned links are short-lived: long enough for a slow phone upload. */
export const PRESIGN_PUT_TTL_SECONDS = 60 * 60; // 1h (big video on weak signal)
export const PRESIGN_GET_TTL_SECONDS = 60 * 10; // 10 min (thumbnails / view)

/** One part of a multipart upload. R2 requires every part except the last to be >= 5 MiB. */
export const MULTIPART_PART_SIZE = 8 * 1024 * 1024; // 8 MiB
/** Files up to this size go up as a single PUT; larger ones use multipart. */
export const SINGLE_PUT_MAX = 16 * 1024 * 1024; // 16 MiB

export async function presignPut(key: string, contentType: string): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: bucketName(), Key: key, ContentType: contentType }),
    { expiresIn: PRESIGN_PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
  );
}

export async function presignGet(key: string, opts: { download?: string; contentType?: string } = {}): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({
      Bucket: bucketName(),
      Key: key,
      ResponseContentDisposition: opts.download ? `attachment; filename="${opts.download.replace(/[^\w.\- ]/g, '_')}"` : undefined,
      ResponseContentType: opts.contentType,
    }),
    { expiresIn: PRESIGN_GET_TTL_SECONDS }
  );
}

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const out = await client().send(new CreateMultipartUploadCommand({ Bucket: bucketName(), Key: key, ContentType: contentType }));
  if (!out.UploadId) throw new Error('R2 did not return an upload id');
  return out.UploadId;
}

export async function presignPart(key: string, uploadId: string, partNumber: number): Promise<string> {
  return getSignedUrl(
    client(),
    new UploadPartCommand({ Bucket: bucketName(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: PRESIGN_PUT_TTL_SECONDS }
  );
}

export async function completeMultipart(key: string, uploadId: string, parts: { PartNumber: number; ETag: string }[]): Promise<void> {
  const sorted = [...parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await client().send(
    new CompleteMultipartUploadCommand({ Bucket: bucketName(), Key: key, UploadId: uploadId, MultipartUpload: { Parts: sorted } })
  );
}

export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  await client().send(new AbortMultipartUploadCommand({ Bucket: bucketName(), Key: key, UploadId: uploadId })).catch(() => undefined);
}

/** Size + type of an object as R2 actually stored it, or null if it is not there. */
export async function headObject(key: string): Promise<{ size: number; contentType: string | null } | null> {
  try {
    const out = await client().send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
    return { size: out.ContentLength ?? 0, contentType: out.ContentType ?? null };
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}

/** Streams an object's bytes (used by the zip export so memory stays flat for big videos). */
export async function getObjectStream(key: string): Promise<NodeJS.ReadableStream> {
  const out = await client().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  if (!out.Body) throw new Error('empty object body');
  return out.Body as unknown as NodeJS.ReadableStream;
}
