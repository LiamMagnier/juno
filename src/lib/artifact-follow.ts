import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type ArtifactFollowDb = Pick<
  Prisma.TransactionClient,
  "artifact" | "attachment" | "artifactVersion" | "conversation" | "$queryRaw"
>;
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
 *
 * "Its artifacts" are the ones made in these chats AND every Duplicate made
 * from them, however many copies deep (`derivedFromId`): a copy has no chat of
 * its own, carries the same body, and would otherwise lose its pictures when
 * its source's chat goes. Every version counts (a restore brings an old one
 * back), trashed artifacts count (Recently deleted brings them back), and so
 * does a design's unsealed draft.
 *
 * One statement, so the work stays in the database however many files and
 * versions there are: the bodies that quote any file at all are found once,
 * and each of the chats' files is looked for in those.
 */
export async function keepArtifactAttachments(db: Db, userId: string, conversationIds: readonly string[]): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const chats = Prisma.join([...conversationIds]);
  const quoted = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE lineage AS (
      SELECT a."id" FROM "Artifact" a
       WHERE a."userId" = ${userId} AND a."conversationId" IN (${chats})
      UNION
      SELECT c."id" FROM "Artifact" c
        JOIN lineage l ON c."derivedFromId" = l."id"
       WHERE c."userId" = ${userId}
    ),
    bodies AS MATERIALIZED (
      SELECT v."content" AS body FROM "ArtifactVersion" v
       WHERE v."artifactId" IN (SELECT "id" FROM lineage)
         AND strpos(v."content", '/api/files/') > 0
      UNION ALL
      SELECT d."content" FROM "ArtifactDraft" d
       WHERE d."userId" = ${userId}
         AND d."artifactId" IN (SELECT "id" FROM lineage)
         AND strpos(d."content", '/api/files/') > 0
    )
    SELECT att."id" FROM "Attachment" att
     WHERE att."userId" = ${userId}
       AND att."conversationId" IN (${chats})
       AND att."deletedAt" IS NULL
       AND EXISTS (SELECT 1 FROM bodies b WHERE strpos(b.body, '/api/files/' || att."storageKey") > 0)
  `);
  if (quoted.length === 0) return 0;
  const detached = await db.attachment.updateMany({
    where: { id: { in: quoted.map((row) => row.id) }, userId },
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
