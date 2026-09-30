import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ArtifactFollowDb = Pick<Prisma.TransactionClient, "artifact" | "attachment" | "artifactVersion" | "conversation">;
type Db = ArtifactFollowDb;

/*
 * What happens to a chat's artifacts when the chat changes: they follow it
 * into another project, and they outlive it when it is deleted.
 */

/**
 * The chat moved from project `from` to `to`: its artifacts that were in
 * `from` move with it. One the owner put somewhere else on its own stays.
 * Plain `updatedAt` stamping is fine here: a move is a change the Library
 * should show.
 */
export async function artifactsFollowConversationProject(
  db: Db,
  userId: string,
  conversationId: string,
  from: string | null,
  to: string | null
): Promise<number> {
  if (from === to) return 0;
  const moved = await db.artifact.updateMany({
    where: { userId, conversationId, projectId: from },
    data: { projectId: to },
  });
  return moved.count;
}

/**
 * Before chats are deleted: keep the files their artifacts still use.
 *
 * Deleting a chat detaches its artifacts (the foreign key is SET NULL,
 * PRODUCT_REFOUNDATION §10) but cascades its attachments. An artifact whose
 * body quotes one of those files (`/api/files/<storageKey>` in an HTML page or
 * a Markdown image) would lose it with the chat, so those attachments are
 * detached from the chat first: they stay the owner's, still served by
 * /api/files, now belonging to no chat. Taken from artifacts/r1-lifecycle.
 */
export async function keepArtifactAttachments(db: Db, userId: string, conversationIds: readonly string[]): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const attachments = await db.attachment.findMany({
    where: { userId, conversationId: { in: [...conversationIds] }, deletedAt: null },
    select: { id: true, storageKey: true },
  });
  if (attachments.length === 0) return 0;
  const artifacts = await db.artifact.findMany({
    where: { userId, conversationId: { in: [...conversationIds] } },
    select: { id: true },
  });
  if (artifacts.length === 0) return 0;
  const keep: string[] = [];
  for (const attachment of attachments) {
    const quoted = await db.artifactVersion.findFirst({
      where: {
        artifactId: { in: artifacts.map((a) => a.id) },
        content: { contains: `/api/files/${attachment.storageKey}` },
      },
      select: { id: true },
    });
    if (quoted) keep.push(attachment.id);
  }
  if (keep.length === 0) return 0;
  const detached = await db.attachment.updateMany({
    where: { id: { in: keep }, userId },
    data: { conversationId: null, messageId: null },
  });
  return detached.count;
}

/**
 * Delete the user's conversations, keeping what their artifacts need. The
 * artifacts themselves detach through the foreign key.
 */
export async function deleteConversationsKeepingArtifacts(userId: string, conversationIds: readonly string[]): Promise<number> {
  if (conversationIds.length === 0) return 0;
  return prisma.$transaction(
    async (tx) => {
      await keepArtifactAttachments(tx as unknown as Db, userId, conversationIds);
      const deleted = await tx.conversation.deleteMany({ where: { userId, id: { in: [...conversationIds] } } });
      return deleted.count;
    },
    { timeout: 30_000 }
  );
}

/** How many live artifacts deleting these chats keeps (for the confirmation copy). */
export async function countArtifactsKeptOnDelete(userId: string, conversationId?: string): Promise<number> {
  return prisma.artifact.count({
    where: { userId, deletedAt: null, ...(conversationId ? { conversationId } : { conversationId: { not: null } }) },
  });
}
