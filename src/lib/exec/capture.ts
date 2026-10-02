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
import { imageDimensions, sendableDimensions } from "@/lib/exec/image-size";

export { imageDimensions, sendableDimensions };

const MAX_FILE_MB = 25;

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
  /**
   * Called before each file: renews the caller's lease on the ToolRun and says
   * whether it still holds it. Capture stops when it does not, so a slow
   * collection cannot run on after another process (check_run, the sweep) has
   * taken the row over.
   */
  keepAlive?: () => Promise<boolean>;
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
  let imageBytes = 0;
  const entries = input.run.files ?? [];
  if (entries.length === 0) return { files, skipped, images };
  const plan = await getUserPlan(input.userId);
  const names = displayNames(entries);

  for (const [index, entry] of entries.entries()) {
    const name = names[index];
    if (input.keepAlive && !(await input.keepAlive())) break;
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
      imageBytes + bytes.byteLength <= EXEC_LIMITS.maxImagesTotalBytes &&
      /^image\/(png|jpeg|gif|webp)$/.test(storedMime) &&
      sendableDimensions(dimensions)
    ) {
      imageBytes += bytes.byteLength;
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
    select: { id: true, fileName: true, mimeType: true, storageKey: true, size: true, width: true, height: true },
  });
  const images: ExecImage[] = [];
  let imageBytes = 0;
  for (const row of rows) {
    if (images.length >= EXEC_LIMITS.maxImages || row.size > EXEC_LIMITS.maxImageBytes) continue;
    if (imageBytes + row.size > EXEC_LIMITS.maxImagesTotalBytes) continue;
    if (!sendableDimensions(row.width && row.height ? { width: row.width, height: row.height } : null)) continue;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(row.mimeType)) continue;
    try {
      const { bytes } = await getObjectBytes(row.storageKey);
      imageBytes += bytes.byteLength;
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
  /** Renews the caller's lease between pages (32 MB from the host can take a while). */
  keepAlive?: () => Promise<boolean>;
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
      if (input.keepAlive && !(await input.keepAlive())) throw new Error("the run was taken over while its logs were stored");
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
