import "server-only";
import type { Attachment, Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { buildObjectKey, deleteObject, putObject } from "@/lib/storage";
import { scheduleIngest } from "@/lib/knowledge";
import type { AttachmentUploadPlan } from "@/lib/attachment-upload";
import {
  assertLibraryCapacity,
  libraryCapacity,
  lockedLibraryCapacity,
  LibraryQuotaExceededError,
} from "@/lib/library";

/**
 * Storing bytes that `planAttachmentUpload` has already judged: the object,
 * then the attachment and its first version inside the library quota lock.
 *
 * This is `/api/upload`'s persistence step, step for step — the quota read
 * before the object is written, the same check repeated under the account's
 * row lock so two concurrent writes cannot both fit, the object deleted again
 * when the rows do not land, and `scheduleIngest` deciding (by the project,
 * nothing else) whether the file is indexed. A file imported from a cloud
 * drive goes through it, so it is one more upload to everything downstream:
 * the Library lists it, previews and extraction run on demand, and the quota
 * counts it.
 *
 * Throws LibraryQuotaExceededError when the file does not fit.
 */
export async function persistAttachment(input: {
  userId: string;
  plan: Plan;
  bytes: Uint8Array;
  planned: AttachmentUploadPlan;
  conversationId: string | null;
  projectId?: string | null;
  origin: string;
}): Promise<Attachment> {
  const { userId, plan, bytes, planned, conversationId, origin } = input;
  const projectId = input.projectId ?? null;
  const size = bytes.byteLength;
  const capacity = await libraryCapacity(userId, plan, size);
  if (!capacity.allowed) throw new LibraryQuotaExceededError(capacity);

  const { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText } = planned;
  const key = buildObjectKey(userId, fileName);
  let attachment: Attachment;
  try {
    await putObject(key, bytes, storedContentType, contentDisposition);
    attachment = await prisma.$transaction(async (tx) => {
      const lockedCapacity = await lockedLibraryCapacity(tx, userId, plan, size);
      assertLibraryCapacity(lockedCapacity);
      const created = await tx.attachment.create({
        data: {
          userId,
          conversationId,
          projectId,
          kind,
          fileName,
          mimeType: storedMime,
          size,
          storageKey: key,
          extractedText,
          origin,
          parserState: "queued",
        },
      });
      await tx.attachmentVersion.create({
        data: {
          attachmentId: created.id,
          version: created.version,
          origin,
          kind,
          fileName,
          mimeType: storedMime,
          size,
          storageKey: key,
          extractedText,
          parserState: "queued",
        },
      });
      return created;
    });
  } catch (error) {
    // The upload or its rows failed: the stored object belongs to nothing.
    await deleteObject(key).catch(() => undefined);
    throw error;
  }

  // A chat attachment is read when a question needs it; a project file is
  // indexed. The rule lives in scheduleIngest, so no path can get it wrong.
  scheduleIngest({ userId, attachmentId: attachment.id, projectId, fileName, mimeType: storedMime, bytes });
  return attachment;
}
