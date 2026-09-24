import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { detachOnDeleteEnabled } from "@/lib/artifact-flags";
import {
  ANCHOR_KIND,
  ANCHOR_TITLE,
  anchorConversationId,
  visibleConversationSql,
  visibleConversationWhere,
} from "@/lib/conversation-visibility";

/**
 * Deleting a chat keeps what Juno made in it (04-MERGE-PLAN §3.5).
 *
 * Before R1 an artifact lived and died with its conversation: `Artifact` is
 * `onDelete: Cascade` on `conversationId`, so deleting a chat deleted every
 * artifact in it, every version, every hand edit and every public link, and
 * "Delete all chats" in Settings deleted the whole Artifacts library with it.
 * Nobody asking to clear their chat history was asking for that.
 *
 * The cascade stays (the schema is untouched and account deletion still relies
 * on it). What changes is that every conversation delete goes through
 * `deleteConversationsKeepingArtifacts`, which first moves the chat's artifacts
 * into the account's hidden anchor conversation, so the cascade finds nothing
 * of theirs left to take. tests/conversation-delete-keeps-artifacts.test.ts
 * reads the source and fails any `conversation.delete`/`deleteMany` outside
 * this file that does not say, with a `detach-safe:` comment, why it can never
 * hold an artifact.
 *
 * Why an anchor rather than a nullable `conversationId`: every installed Mac
 * and iPhone build decodes an artifact's `conversationId` as required, so an
 * artifact with no chat still needs a conversation to point at. The anchor is
 * that conversation and nothing else: never listed, synced or written to by a
 * chat route (src/lib/conversation-visibility.ts).
 */

/**
 * The client inside `prisma.$transaction(async (tx) => …)` on the guarded
 * client (the web routes), or on `prismaUnguarded` (the native mutation route,
 * which runs every operation inside its own Serializable transaction and must
 * keep doing so, so its idempotency receipt and the delete commit together).
 */
type GuardedTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
export type ArtifactHomeTransaction = GuardedTransaction | Prisma.TransactionClient;

/**
 * Both clients answer the handful of calls made here identically; they differ
 * only in how TypeScript spells their generic signatures, which is enough to
 * make a method call on the union ambiguous. This names the one shape they
 * share, so the rest of the file reads as ordinary Prisma.
 */
function asClient(tx: ArtifactHomeTransaction): Prisma.TransactionClient {
  return tx as Prisma.TransactionClient;
}

/**
 * How many conversations one bulk-delete transaction takes. Each chunk moves
 * artifacts, scans their versions for file references and deletes messages by
 * cascade, all under the transaction's row locks; fifty keeps one chunk well
 * inside its timeout even for long chats, and a failure part-way through
 * leaves whole chunks either done or untouched, so "Delete all" can simply be
 * pressed again.
 */
const BULK_DELETE_CHUNK = 50;

/** Room for a long chat's cascade; Prisma's interactive default is 5 seconds. */
export const DELETE_TRANSACTION_TIMEOUT_MS = 20_000;

/**
 * The identifier an artifact carries once it sits in the anchor:
 * `<identifier>~<full id>`.
 *
 * `(conversationId, identifier)` is unique, and two deleted chats can easily
 * both have made a `landing-page`. The full id makes the anchored identifier
 * unique by construction, with no lookup and no retry. It also retires the
 * handle: nothing can re-emit into an anchored artifact, because no chat route
 * writes to the anchor. Kept in step with the SQL in
 * `deleteConversationsKeepingArtifacts`, which builds the same string.
 */
export function anchoredIdentifier(identifier: string, id: string): string {
  return `${identifier}~${id}`;
}

/**
 * Make sure the account's anchor exists, inside the caller's transaction, and
 * return its id.
 *
 * INSERT … ON CONFLICT DO NOTHING on the fixed id `anchor_<userId>`, so two
 * deletes racing to create it leave one row and neither fails (under the
 * native route's Serializable isolation the loser gets a serialization error
 * instead, which that route already answers as a retryable 5xx).
 *
 * Raw SQL rather than `conversation.upsert`, because an upsert that found the
 * row would UPDATE it, and an update is a write the anchor must never see.
 * `updatedAt` is supplied because `@updatedAt` is filled in by Prisma, not by
 * a column default. No change-feed row is written: the conversation trigger
 * skips `kind = 'anchor'` (migration 20260925120000_artifact_lifecycle_r1).
 *
 * The re-read is the check that the id really is this account's anchor. The
 * id is derived from the user id, so a mismatch can only mean a row made by
 * hand, and moving someone's artifacts into it would be far worse than
 * failing the delete.
 */
export async function ensureArtifactHome(tx: ArtifactHomeTransaction, userId: string): Promise<string> {
  const db = asClient(tx);
  const id = anchorConversationId(userId);
  await db.$executeRaw`
    INSERT INTO "Conversation" ("id", "userId", "title", "titleSource", "kind", "updatedAt")
    VALUES (${id}, ${userId}, ${ANCHOR_TITLE}, 'system', ${ANCHOR_KIND}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING
  `;
  // anchor-safe: reads the anchor itself, by its own id, to confirm it is one.
  const row = await db.conversation.findUnique({
    where: { id, userId },
    select: { id: true, userId: true, kind: true },
  });
  if (!row || row.userId !== userId || row.kind !== ANCHOR_KIND) {
    throw new Error(`The artifact home ${id} is not this account's anchor.`);
  }
  return row.id;
}

export interface KeptArtifactsResult {
  /** Conversations actually deleted: visible ones this account owns. */
  deleted: number;
  /**
   * Live artifacts that moved to the anchor and so stay in Artifacts. Ones
   * already in Recently deleted move too, and stay there; they are not
   * counted, because the person will not find them in Artifacts.
   */
  keptArtifacts: number;
}

/**
 * Delete conversations, keeping their artifacts. Every conversation delete
 * goes through here; run it inside a transaction so the move and the delete
 * commit together (a chat that is gone with its artifacts still in it is
 * exactly the loss this exists to prevent).
 *
 * 1. Resolve the targets: this account's, and never the anchor, so an anchor
 *    id in `ids` is silently not a target and a caller answering "nothing was
 *    deleted" with 404 gives no hint that it exists.
 * 2. When the detach flag is on and a target holds artifacts, move them into
 *    the anchor. `projectId` is taken from the chat, because the anchor has no
 *    project and the artifact should stay in its project's Sources. `updatedAt`
 *    is left alone, so the move does not reorder the Artifacts home, and
 *    `deletedAt` is left alone, so a trashed artifact stays trashed. ARTIFACT
 *    shares point at the artifact, not the chat, so public links survive;
 *    `messageId` clears itself through its SetNull when the messages go.
 * 3. Detach the files those artifacts show, so the cascade does not delete an
 *    image the artifact still embeds (see `detachReferencedFiles`).
 * 4. Delete. Messages, CHAT shares, memory, voice sessions, the files nothing
 *    kept and any pending suggestions go with the chat, as the person asked.
 *
 * With the flag off, step 2 and 3 are skipped and the cascade deletes the
 * artifacts, as it did before R1.
 */
export async function deleteConversationsKeepingArtifacts(
  tx: ArtifactHomeTransaction,
  userId: string,
  ids: readonly string[],
): Promise<KeptArtifactsResult> {
  const db = asClient(tx);
  const requested = [...new Set(ids)];
  if (requested.length === 0) return { deleted: 0, keptArtifacts: 0 };

  const targets = await db.conversation.findMany({
    where: visibleConversationWhere({ userId, id: { in: requested } }),
    select: { id: true },
  });
  if (targets.length === 0) return { deleted: 0, keptArtifacts: 0 };
  const targetIds = targets.map((target) => target.id);

  let keptArtifacts = 0;
  if (detachOnDeleteEnabled()) {
    // Most chats made nothing; they should not create an anchor on the way out.
    const holdsArtifacts = await db.artifact.findFirst({
      where: { conversationId: { in: targetIds } },
      select: { id: true },
    });
    if (holdsArtifacts) {
      const home = await ensureArtifactHome(tx, userId);
      // `c."kind"` is filtered again here although the targets already exclude
      // the anchor: this statement rewrites identifiers, and running it over
      // the anchor's own rows would suffix them a second time.
      const moved = await db.$queryRaw<Array<{ id: string; live: boolean }>>`
        UPDATE "Artifact" a
           SET "conversationId" = ${home},
               "projectId"      = COALESCE(a."projectId", c."projectId"),
               "identifier"     = a."identifier" || '~' || a."id"
          FROM "Conversation" c
         WHERE a."conversationId" = c."id"
           AND c."userId" = ${userId}
           AND ${visibleConversationSql("c")}
           AND c."id" IN (${Prisma.join(targetIds)})
        RETURNING a."id", (a."deletedAt" IS NULL) AS "live"
      `;
      keptArtifacts = moved.filter((row) => row.live).length;
      if (moved.length > 0) {
        await detachReferencedFiles(
          tx,
          userId,
          targetIds,
          moved.map((row) => row.id),
        );
      }
    }
  }

  const { count } = await db.conversation.deleteMany({
    where: visibleConversationWhere({ userId, id: { in: targetIds } }),
  });
  return { deleted: count, keptArtifacts };
}

/**
 * Keep the uploads a moved artifact still shows.
 *
 * An attachment belongs to its conversation (`onDelete: Cascade`), so deleting
 * the chat deletes the file, and a model-written HTML or Markdown artifact
 * that embeds it as `/api/files/<storageKey>` would be left with a broken
 * image. Designs inline their images as data URLs and are not affected.
 *
 * There is no reference table yet (ArtifactFileRef is deferred), so this scans
 * the moved artifacts' versions, every version and not only the current one,
 * because an older version can be restored. It only ever looks at the
 * attachments of the chats being deleted. A file that survives is detached
 * rather than moved: it keeps its row and its bytes, stays in the Library if
 * it was there, and belongs to no chat, which is the truth once the chat is
 * gone.
 *
 * Known gap, not a regression: an artifact that embeds a file uploaded in a
 * different chat loses it when that other chat is deleted later. Before R1
 * the same image broke the same way, and the artifact did not survive at all.
 */
async function detachReferencedFiles(
  tx: ArtifactHomeTransaction,
  userId: string,
  conversationIds: readonly string[],
  movedArtifactIds: readonly string[],
): Promise<void> {
  await asClient(tx).$executeRaw`
    UPDATE "Attachment" f
       SET "conversationId" = NULL, "messageId" = NULL
     WHERE f."userId" = ${userId}
       AND f."conversationId" IN (${Prisma.join(conversationIds)})
       AND f."deletedAt" IS NULL
       AND EXISTS (
             SELECT 1 FROM "ArtifactVersion" v
              WHERE v."artifactId" IN (${Prisma.join(movedArtifactIds)})
                AND strpos(v."content", '/api/files/' || f."storageKey") > 0
           )
  `;
}

/**
 * "Delete all chats": every visible conversation, chat and code alike, in
 * chunks of fifty, each chunk its own transaction.
 *
 * One transaction for everything would hold row locks on the whole account
 * for as long as the slowest cascade takes, and could not finish inside any
 * reasonable timeout for a long history. The ids are listed once, up front:
 * a chat started while this runs is not deleted, which is what the person
 * saw when they pressed the button. The anchor is never listed, so a second
 * "Delete all" leaves it, and everything kept in it, alone.
 */
export async function deleteAllConversationsKeepingArtifacts(userId: string): Promise<KeptArtifactsResult> {
  const rows = await prisma.conversation.findMany({
    where: visibleConversationWhere({ userId }),
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const total: KeptArtifactsResult = { deleted: 0, keptArtifacts: 0 };
  for (let start = 0; start < rows.length; start += BULK_DELETE_CHUNK) {
    const chunk = rows.slice(start, start + BULK_DELETE_CHUNK).map((row) => row.id);
    const result = await prisma.$transaction(
      (tx) => deleteConversationsKeepingArtifacts(tx, userId, chunk),
      { timeout: DELETE_TRANSACTION_TIMEOUT_MS },
    );
    total.deleted += result.deleted;
    total.keptArtifacts += result.keptArtifacts;
  }
  return total;
}

/**
 * How many live artifacts a delete would keep: in one conversation, or with
 * no id in every visible one (the Settings "Delete all" dialog). What the
 * delete dialogs quote as "{N} artifacts stay in Artifacts".
 *
 * Trashed artifacts are left out, as in `keptArtifacts`: they move too, but
 * into Recently deleted, not Artifacts. Artifacts already in the anchor are
 * never counted, because the anchor is not a conversation anyone can delete.
 */
export function countKeptArtifacts(userId: string, conversationId?: string): Promise<number> {
  return prisma.artifact.count({
    where: {
      deletedAt: null,
      conversation: visibleConversationWhere({ userId, ...(conversationId ? { id: conversationId } : {}) }),
    },
  });
}
