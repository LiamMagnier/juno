import "server-only";
import { promises as fs, createReadStream } from "fs";
import { Readable } from "stream";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
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

function usesLocalDisk(): boolean {
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

/**
 * Namespaced object key for an in-flight account import. The import ledger owns
 * the lifecycle of this prefix, which lets recovery delete abandoned uploads
 * without guessing whether an ordinary library object is still referenced.
 */
export function buildImportObjectKey(userId: string, importRunId: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  return `uploads/${userId}/imports/${importRunId}/${crypto.randomUUID()}-${safe}`;
}

export async function putObject(
  key: string,
  body: Uint8Array | Buffer,
  contentType: string,
  contentDisposition?: string
): Promise<void> {
  if (usesLocalDisk()) {
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
  if (usesLocalDisk()) {
    const bytes = new Uint8Array(await fs.readFile(localPath(key)));
    return { bytes, contentType: "application/octet-stream" };
  }
  const res = await s3().send(new GetObjectCommand({ Bucket: env.s3.bucket!, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return { bytes, contentType: res.ContentType ?? "application/octet-stream" };
}

/** Total size plus the object's leading bytes, for MIME sniffing. */
export interface ObjectHead {
  size: number;
  /** First `prefixBytes` bytes (fewer if the object is smaller). */
  prefix: Uint8Array;
}

/** Parses the `total` out of an S3 `Content-Range: bytes 0-15/1234`. */
function totalFromContentRange(value: string | undefined, fallback: number): number {
  const slash = value?.lastIndexOf("/") ?? -1;
  if (slash < 0) return fallback;
  const parsed = Number(value!.slice(slash + 1));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Read an object's size and leading bytes without downloading it.
 *
 * `/api/files` sniffs the real MIME from magic bytes rather than trusting any
 * stored content type, so it needs the first few bytes before it can decide how
 * to serve the object — but it must never pull a 1 GB video into RSS to do it.
 *
 * On S3 this is one ranged GET: the response carries both the prefix and, via
 * `Content-Range`, the full size. A zero-byte object is the one case S3 answers
 * with `InvalidRange`, handled below.
 */
export async function headObject(key: string, prefixBytes: number): Promise<ObjectHead> {
  if (usesLocalDisk()) {
    const handle = await fs.open(localPath(key), "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return { size: 0, prefix: new Uint8Array(0) };
      const buffer = Buffer.alloc(Math.min(prefixBytes, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { size, prefix: new Uint8Array(buffer.subarray(0, bytesRead)) };
    } finally {
      await handle.close();
    }
  }

  try {
    const res = await s3().send(
      new GetObjectCommand({
        Bucket: env.s3.bucket!,
        Key: key,
        Range: `bytes=0-${Math.max(0, prefixBytes - 1)}`,
      })
    );
    const prefix = await res.Body!.transformToByteArray();
    return { size: totalFromContentRange(res.ContentRange, prefix.byteLength), prefix };
  } catch (err) {
    // A zero-length object cannot satisfy any range. Confirm it is empty rather
    // than assuming — anything else is a real error and must keep propagating.
    if (err instanceof Error && (err.name === "InvalidRange" || err.name === "InvalidArgument")) {
      const stat = await s3().send(new HeadObjectCommand({ Bucket: env.s3.bucket!, Key: key }));
      return { size: stat.ContentLength ?? 0, prefix: new Uint8Array(0) };
    }
    throw err;
  }
}

/**
 * Open a streaming read over an object, optionally over a byte range.
 *
 * The point of this function is that memory stays constant: serving a 100 MB
 * file must not grow RSS by 100 MB. PM2 restarts juno-backend at ~1400 MB
 * (deploy/ecosystem.config.js) and that restart kills every in-flight SSE
 * stream on the box, so buffering whole media objects was a way for one video
 * to end everyone's conversations.
 *
 * `range` offsets are inclusive, matching HTTP.
 */
export async function openObjectStream(
  key: string,
  range?: { start: number; end: number }
): Promise<ReadableStream<Uint8Array>> {
  if (usesLocalDisk()) {
    const stream = createReadStream(
      localPath(key),
      range ? { start: range.start, end: range.end } : undefined
    );
    // Readable.toWeb destroys the underlying fd when the web stream is
    // cancelled, so an aborted media request (Safari does this constantly)
    // releases the descriptor instead of leaking it.
    return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
  }

  const res = await s3().send(
    new GetObjectCommand({
      Bucket: env.s3.bucket!,
      Key: key,
      ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
    })
  );
  return res.Body!.transformToWebStream() as ReadableStream<Uint8Array>;
}

export async function deleteObject(key: string): Promise<void> {
  if (usesLocalDisk()) {
    await fs.unlink(localPath(key)).catch(() => {});
    return;
  }
  await s3().send(new DeleteObjectCommand({ Bucket: env.s3.bucket!, Key: key }));
}

/** URL the browser uses to view/download an object. */
export async function getViewUrl(key: string): Promise<string> {
  // Private uploads always traverse the authenticated, owner-aware route.
  // Neither a permanent CDN URL nor a presigned bearer URL is an authorization
  // boundary, and both outlive the session that was allowed to request them.
  return `/api/files/${key}`;
}
