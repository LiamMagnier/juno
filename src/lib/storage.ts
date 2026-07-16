import "server-only";
import { promises as fs } from "fs";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, isStorageConfigured } from "@/lib/env";

/*
 * Storage works two ways from the same code:
 *  - Cloud (production / when S3 vars are set): any S3-compatible bucket
 *    (Cloudflare R2, AWS S3, Supabase Storage…).
 *  - Local disk (dev fallback when S3 isn't configured): files live under
 *    ./.uploads and are served by /api/files. Lets you test uploads with no
 *    cloud account; add the S3 vars and it switches to the bucket automatically.
 */

const LOCAL_DIR = path.join(process.cwd(), ".uploads");

function shouldUseLocal(): boolean {
  return !isStorageConfigured();
}

function localPath(key: string): string {
  const safe = key.replace(/\\/g, "/");
  if (safe.includes("..") || path.isAbsolute(safe)) throw new Error("Invalid storage key");
  return path.join(LOCAL_DIR, safe);
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!isStorageConfigured()) throw new Error("S3 storage is not configured.");
  if (!client) {
    client = new S3Client({
      region: env.s3.region,
      endpoint: env.s3.endpoint || undefined,
      forcePathStyle: env.s3.forcePathStyle,
      credentials: { accessKeyId: env.s3.accessKeyId!, secretAccessKey: env.s3.secretAccessKey! },
    });
  }
  return client;
}

export function buildObjectKey(userId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `uploads/${userId}/${crypto.randomUUID()}-${safe}`;
}

export async function putObject(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
  contentDisposition?: string
): Promise<void> {
  if (shouldUseLocal()) {
    const p = localPath(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
    return;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: env.s3.bucket!,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(contentDisposition ? { ContentDisposition: contentDisposition } : {}),
    })
  );
}

export async function getObjectBytes(key: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (shouldUseLocal()) {
    const bytes = new Uint8Array(await fs.readFile(localPath(key)));
    return { bytes, contentType: "application/octet-stream" };
  }
  const res = await s3().send(new GetObjectCommand({ Bucket: env.s3.bucket!, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return { bytes, contentType: res.ContentType ?? "application/octet-stream" };
}

export async function deleteObject(key: string): Promise<void> {
  if (shouldUseLocal()) {
    await fs.unlink(localPath(key)).catch(() => {});
    return;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket!, Key: key }));
}

/** URL the browser uses to view/download an object. */
export async function getViewUrl(key: string): Promise<string> {
  if (shouldUseLocal()) return `/api/files/${key}`;
  if (env.s3.publicUrl) return `${env.s3.publicUrl.replace(/\/$/, "")}/${key}`;
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: env.s3.bucket!, Key: key }), { expiresIn: 3600 });
}
