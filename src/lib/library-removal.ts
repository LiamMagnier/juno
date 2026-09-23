import "server-only";

import { prisma } from "@/lib/prisma";
import {
  removeFromLibraryWith,
  settleLibraryRemovalsWith,
  type LibraryRemoval,
  type LibraryRemovalStore,
  type LibraryUseRow,
  type SentAttachmentRow,
} from "@/lib/library-removal-policy";

export { libraryUse, planLibraryRemoval, type LibraryRemoval, type LibraryUse } from "@/lib/library-removal-policy";

/**
 * The database half of taking a file out of the Library. The decisions, and
 * why a Library delete no longer reaches into chats, are in
 * src/lib/library-removal-policy.ts.
 */

/** The client inside `prisma.$transaction(async (tx) => …)` on the guarded client. */
type LibraryTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Delete one attachment: the recoverable tombstone `DELETE /api/attachments/[id]`
 * has always written, moved here so the Library's own delete can share it.
 * Run it inside a transaction.
 *
 * That route is still a real delete, whoever uses the file: the project page
 * and the native project client remove project files and covers through it.
 * The Library goes through `removeFromLibrary`, which only comes here for a
 * file nothing else uses.
 */
export async function tombstoneAttachment(
  tx: LibraryTransaction,
  userId: string,
  attachment: { id: string },
): Promise<void> {
  // Tombstone the knowledge graph in the same transaction as the attachment
  // delete. The block/chunk ids remain answerable as deleted citations, while
  // their text and embeddings are redacted and retrieval can never use them.
  const deletedAt = new Date();
  const documents = await tx.knowledgeDocument.findMany({
    where: { userId, attachmentId: attachment.id, deletedAt: null },
    select: { id: true },
  });
  const documentIds = documents.map((document) => document.id);
  if (documentIds.length > 0) {
    await tx.knowledgeDocument.updateMany({
      where: { userId, id: { in: documentIds } },
      data: {
        state: "tombstoned",
        error: "This document was deleted from the library; its indexed content is no longer available.",
        deletedAt,
      },
    });
    await tx.knowledgeBlock.updateMany({
      where: { userId, documentId: { in: documentIds }, deletedAt: null },
      data: {
        text: "[Document content deleted]",
        heading: [],
        bbox: [],
        deletedAt,
      },
    });
    await tx.knowledgeChunk.updateMany({
      where: { userId, documentId: { in: documentIds }, deletedAt: null },
      data: {
        text: "[Document content deleted]",
        embedding: [],
        embeddingModel: null,
        deletedAt,
      },
    });
    await tx.knowledgeIndexJob.updateMany({
      where: { userId, documentId: { in: documentIds }, deletedAt: null },
      data: {
        state: "tombstoned",
        error: "The source attachment was deleted.",
        deletedAt,
        finishedAt: deletedAt,
      },
    });
  }

  // Keep the row and every immutable version. A library delete is a
  // recoverable tombstone, not a destructive object-store operation; restore
  // can therefore put the exact bytes back without pretending they can be
  // reconstructed from a redacted knowledge block.
  await tx.attachment.update({
    where: { id: attachment.id, userId },
    data: { deletedAt, parserState: "deleted" },
  });
}

function transactionStore(tx: LibraryTransaction): LibraryRemovalStore {
  return {
    async lockLibraryRow(userId, id) {
      // FOR UPDATE, so the row cannot be claimed by a message between the
      // question "does anything use this?" and the answer being written.
      const rows = await tx.$queryRaw<Array<LibraryUseRow & { id: string }>>`
        SELECT "id", "messageId", "projectId"
          FROM "Attachment"
         WHERE "id" = ${id}
           AND "userId" = ${userId}
           AND "deletedAt" IS NULL
           AND "libraryRemovedAt" IS NULL
           FOR UPDATE`;
      return rows[0] ?? null;
    },
    async hide(userId, id, at) {
      await tx.attachment.update({ where: { id, userId }, data: { libraryRemovedAt: at } });
    },
    async tombstone(userId, id) {
      await tombstoneAttachment(tx, userId, { id });
    },
  };
}

/**
 * Take one file out of the reader's Library: hidden when a chat or project
 * still uses it, deleted when nothing does. Null when the reader has no such
 * file in their Library.
 */
export function removeFromLibrary(userId: string, id: string): Promise<LibraryRemoval | null> {
  return prisma.$transaction((tx) => removeFromLibraryWith(transactionStore(tx), userId, id));
}

/**
 * Before an edit deletes the messages after `editedMessageId`, finish the
 * Library delete of every file sent with them that the reader had taken out of
 * the Library and that nothing will use once they are gone (see
 * `orphanedByMessageDelete`). Run it inside the transaction that deletes the
 * messages, before the delete: the rows are locked here, so a Library removal
 * racing the edit either lands first and is seen, or waits and then finds the
 * row with no message and deletes it itself.
 *
 * The rows are the ones the edit's `deleteMany` takes, stated the same way:
 * every message in the edited message's conversation created after it.
 */
export function settleLibraryRemovalsBeforeTruncation(
  tx: LibraryTransaction,
  userId: string,
  editedMessageId: string,
): Promise<string[]> {
  return settleLibraryRemovalsWith({
    async lockSentAttachments() {
      return tx.$queryRaw<SentAttachmentRow[]>`
        SELECT a."id", a."projectId", a."libraryRemovedAt"
          FROM "Attachment" a
          JOIN "Message" later ON later."id" = a."messageId"
          JOIN "Message" edited ON edited."id" = ${editedMessageId}
         WHERE later."conversationId" = edited."conversationId"
           AND later."createdAt" > edited."createdAt"
           AND a."userId" = ${userId}
           AND a."deletedAt" IS NULL
           FOR UPDATE OF a`;
    },
    async tombstone(id) {
      await tombstoneAttachment(tx, userId, { id });
    },
  });
}
