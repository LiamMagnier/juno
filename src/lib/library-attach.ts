import "server-only";
import type { Attachment } from "@prisma/client";
import type { prisma } from "@/lib/prisma";
import { libraryViewWhere } from "@/lib/library-removal-policy";

/**
 * Attaching Library files to a message: the one mechanism, shared by
 * "Add from library" (POST /api/library/attach) and a file token in a chat
 * message (src/lib/chat/context-resolution.ts).
 *
 * Each selected file is cloned into a fresh row that reuses the SAME stored
 * object — no re-upload, no byte duplication — so the message that first
 * carried it keeps its own attachment intact, and the clone flows through the
 * ordinary attachment pipeline (parser state, extracted text, versions).
 *
 * Only the account's own files still in its Library are cloned: a file taken
 * out of the Library is live in the chat that kept it, but nothing offers it
 * any more, so nothing attaches it either. The sources are read inside the
 * caller's transaction, so a file removed between the lookup and the send is
 * simply not cloned — the caller learns which ones were from the result.
 */

/** The guarded client's transaction, as `prisma.$transaction(async (tx) => …)` hands it over. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = Pick<Tx, "attachment" | "attachmentVersion">;

export interface LibraryCloneLink {
  /** Claimed by this message at once, so a clone is never left unlinked in the Library. */
  messageId: string;
  conversationId: string;
  /**
   * Skip a source whose stored object this message already carries. A
   * regenerate that re-sends its file tokens must not attach the same file to
   * the same message twice.
   */
  skipExistingOnMessage?: boolean;
}

export interface LibraryCloneResult {
  clones: Attachment[];
  /** Source id → the clone made from it (or the attachment the message already had). */
  bySource: Map<string, string>;
}

export async function cloneLibraryAttachments(
  db: Db,
  userId: string,
  sourceIds: readonly string[],
  link?: LibraryCloneLink
): Promise<LibraryCloneResult> {
  const uniqueIds = [...new Set(sourceIds)];
  const bySource = new Map<string, string>();
  if (uniqueIds.length === 0) return { clones: [], bySource };

  const sources = await db.attachment.findMany({
    where: { id: { in: uniqueIds }, userId, ...libraryViewWhere("library") },
  });
  const byId = new Map(sources.map((row) => [row.id, row]));

  const existing = new Map<string, string>();
  if (link?.skipExistingOnMessage) {
    const already = await db.attachment.findMany({
      where: { userId, messageId: link.messageId, deletedAt: null },
      select: { id: true, storageKey: true },
    });
    for (const row of already) existing.set(row.storageKey, row.id);
  }

  const clones: Attachment[] = [];
  // In order, one at a time: a transaction client runs its queries serially
  // anyway, and the order is the order the person named the files in.
  for (const id of uniqueIds) {
    const src = byId.get(id);
    if (!src) continue;
    const kept = existing.get(src.storageKey);
    if (kept) {
      bySource.set(id, kept);
      continue;
    }
    const clone = await db.attachment.create({
      data: {
        userId,
        kind: src.kind,
        fileName: src.fileName,
        mimeType: src.mimeType,
        size: src.size,
        storageKey: src.storageKey,
        extractedText: src.extractedText,
        width: src.width,
        height: src.height,
        origin: "library_clone",
        parserState: src.parserState,
        parserVersion: src.parserVersion,
        ...(link ? { messageId: link.messageId, conversationId: link.conversationId } : {}),
      },
    });
    clones.push(clone);
    bySource.set(id, clone.id);
  }

  if (clones.length > 0) {
    await db.attachmentVersion.createMany({
      data: clones.map((clone) => ({
        attachmentId: clone.id,
        version: clone.version,
        origin: "library_clone",
        kind: clone.kind,
        fileName: clone.fileName,
        mimeType: clone.mimeType,
        size: clone.size,
        storageKey: clone.storageKey,
        extractedText: clone.extractedText,
        parserState: clone.parserState,
        parserVersion: clone.parserVersion,
      })),
    });
  }
  return { clones, bySource };
}
