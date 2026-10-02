import "server-only";
/**
 * What a run produced becomes ordinary attachments (design §6.7).
 *
 * Every file a run created or changed under /work (the host lists them, with a
 * digest) is downloaded one at a time, put through the SAME rules an upload
 * goes through (`planAttachmentUpload`: refused types, magic-byte sniffing for
 * images, a neutral stored content type, an attachment disposition, so a
 * model-written .html can never be served inline), counted against the
 * Library quota, stored, and recorded as an `Attachment` with
 * origin "tool_output". In chat it is linked to the conversation at once (the
 * route links it to the assistant message when that is persisted, like the
 * user's own files); in a Work run it also gets a WorkRunIO output row.
 *
 * The full stdout/stderr, when longer than what the row keeps, goes to object
 * storage under one prefix (`ToolRun.logKey`), readable through check_run by
 * the conversation's owner only.
 */
import { prisma } from "@/lib/prisma";
import { buildObjectKey, deleteObject, putObject } from "@/lib/storage";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import { getUserPlan } from "@/lib/usage";
import { libraryCapacity, lockedLibraryCapacity, assertLibraryCapacity, LibraryQuotaExceededError } from "@/lib/library";
import { EXEC_LIMITS } from "@/lib/exec/config";
import type { HostFileEntry, HostRunSnapshot, JunoExecClient } from "@/lib/exec/client";
import type { ExecImage, ExecOutputFile, ExecSurface } from "@/lib/exec/types";

const MAX_FILE_MB = 25;

/** Width and height from a PNG, GIF, JPEG or WebP header; null when unknown. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.length >= 24 && view.readUInt32BE(0) === 0x89504e47) {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  if (view.length >= 10 && view.toString("ascii", 0, 3) === "GIF") {
    return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
  }
  if (view.length >= 30 && view.toString("ascii", 0, 4) === "RIFF" && view.toString("ascii", 8, 12) === "WEBP") {
    const chunk = view.toString("ascii", 12, 16);
    if (chunk === "VP8X") return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const bits = view.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (view.length >= 4 && view[0] === 0xff && view[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < view.length) {
      if (view[offset] !== 0xff) return null;
      const marker = view[offset + 1];
      const length = view.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/** A display name for a produced path: the base name, prefixed by its folder when two collide. */
function displayNames(entries: readonly HostFileEntry[]): string[] {
  const bases = entries.map((entry) => entry.path.split("/").pop() || entry.path);
  return entries.map((entry, index) => {
    const base = bases[index];
    return bases.filter((candidate) => candidate === base).length > 1 ? entry.path.replace(/\//g, "_") : base;
  });
}

export interface CaptureInput {
  client: JunoExecClient;
  run: HostRunSnapshot;
  toolRunId: string;
  userId: string;
  surface: ExecSurface;
  conversationId: string | null;
  workRunId: string | null;
  vision: boolean;
  signal?: AbortSignal;
}

export interface CaptureResult {
  files: ExecOutputFile[];
  skipped: Array<{ name: string; bytes: number; reason: string }>;
  images: ExecImage[];
}

export async function captureOutputs(input: CaptureInput): Promise<CaptureResult> {
  const files: ExecOutputFile[] = [];
  const skipped: CaptureResult["skipped"] = (input.run.skippedFiles ?? []).map((entry) => ({
    name: entry.path,
    bytes: entry.bytes,
    reason: entry.reason,
  }));
  const images: ExecImage[] = [];
  const entries = input.run.files ?? [];
  if (entries.length === 0) return { files, skipped, images };
  const plan = await getUserPlan(input.userId);
  const names = displayNames(entries);

  for (const [index, entry] of entries.entries()) {
    const name = names[index];
    let bytes: Uint8Array;
    try {
      bytes = await input.client.downloadFile(input.run.id, entry, input.signal);
    } catch (error) {
      skipped.push({ name, bytes: entry.bytes, reason: error instanceof Error ? error.message : "download failed" });
      continue;
    }
    const planned = planAttachmentUpload({
      declaredMime: entry.mime,
      fileName: name,
      size: bytes.byteLength,
      bytes,
      maxUploadMb: MAX_FILE_MB,
    });
    if (!planned.ok) {
      skipped.push({ name, bytes: entry.bytes, reason: planned.error.message });
      continue;
    }
    const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } = planned.plan;
    const capacity = await libraryCapacity(input.userId, plan, bytes.byteLength);
    if (!capacity.allowed) {
      skipped.push({ name, bytes: entry.bytes, reason: "the Library storage limit is reached" });
      continue;
    }
    const key = buildObjectKey(input.userId, fileName);
    const dimensions = kind === "IMAGE" ? imageDimensions(bytes) : null;
    let attachmentId: string;
    try {
      await putObject(key, bytes, storedContentType, contentDisposition);
      attachmentId = await prisma.$transaction(async (tx) => {
        assertLibraryCapacity(await lockedLibraryCapacity(tx, input.userId, plan, bytes.byteLength));
        const created = await tx.attachment.create({
          data: {
            userId: input.userId,
            conversationId: input.conversationId,
            kind,
            fileName,
            mimeType: storedMime,
            size: bytes.byteLength,
            storageKey: key,
            extractedText,
            width: dimensions?.width ?? null,
            height: dimensions?.height ?? null,
            origin: "tool_output",
            parserState: "queued",
          },
        });
        await tx.attachmentVersion.create({
          data: {
            attachmentId: created.id,
            version: created.version,
            origin: "tool_output",
            kind,
            fileName,
            mimeType: storedMime,
            size: bytes.byteLength,
            storageKey: key,
            extractedText,
            parserState: "queued",
          },
        });
        if (input.workRunId) {
          await tx.workRunIO.create({
            data: {
              runId: input.workRunId,
              direction: "output",
              refKind: "attachment",
              refId: created.id,
              label: fileName,
              detail: { byteSize: bytes.byteLength, mime: storedMime, origin: "tool_output", toolRunId: input.toolRunId },
            },
          });
        }
        return created.id;
      });
    } catch (error) {
      await deleteObject(key).catch(() => undefined);
      if (error instanceof LibraryQuotaExceededError) {
        skipped.push({ name, bytes: entry.bytes, reason: "the Library storage limit is reached" });
        continue;
      }
      throw error;
    }
    files.push({ attachmentId, name: fileName, mime: storedMime, bytes: bytes.byteLength, kind });
    if (
      input.vision &&
      kind === "IMAGE" &&
      images.length < EXEC_LIMITS.maxImages &&
      bytes.byteLength <= EXEC_LIMITS.maxImageBytes &&
      /^image\/(png|jpeg|gif|webp)$/.test(storedMime)
    ) {
      images.push({ mimeType: storedMime, base64: Buffer.from(bytes).toString("base64"), label: fileName });
    }
  }
  return { files, skipped, images };
}

/** Images of earlier outputs, re-read for a replayed outcome (vision only). */
export async function reloadImages(attachmentIds: readonly string[], userId: string): Promise<ExecImage[]> {
  if (attachmentIds.length === 0) return [];
  const { getObjectBytes } = await import("@/lib/storage");
  const rows = await prisma.attachment.findMany({
    where: { id: { in: [...attachmentIds] }, userId, kind: "IMAGE", deletedAt: null },
    select: { id: true, fileName: true, mimeType: true, storageKey: true, size: true },
  });
  const images: ExecImage[] = [];
  for (const row of rows) {
    if (images.length >= EXEC_LIMITS.maxImages || row.size > EXEC_LIMITS.maxImageBytes) continue;
    try {
      const { bytes } = await getObjectBytes(row.storageKey);
      images.push({ mimeType: row.mimeType, base64: Buffer.from(bytes).toString("base64"), label: row.fileName });
    } catch {
      // A missing object is one image fewer, not a failed replay.
    }
  }
  return images;
}

/** Full logs to object storage when longer than the kept head and tail. */
export async function storeFullLogs(input: {
  client: JunoExecClient;
  run: HostRunSnapshot;
  userId: string;
  toolRunId: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const prefix = `tool-runs/${input.userId}/${input.toolRunId}/`;
  let stored = false;
  for (const stream of ["stdout", "stderr"] as const) {
    const slice = input.run[stream];
    if (!slice || !slice.tail) continue;
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const limit = Math.min(slice.storedBytes, EXEC_LIMITS.maxLogBytes);
    while (offset < limit) {
      const page = await input.client.output(input.run.id, stream, offset, Math.min(1024 * 1024, limit - offset), input.signal);
      if (page.bytes.byteLength === 0) break;
      chunks.push(page.bytes);
      offset += page.bytes.byteLength;
    }
    await putObject(`${prefix}${stream}.log`, Buffer.concat(chunks), "text/plain; charset=utf-8", `attachment; filename="${stream}.log"`);
    stored = true;
  }
  return stored ? prefix : null;
}
