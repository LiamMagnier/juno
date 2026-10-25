/** Scope-bound lifecycle changes that can invalidate an already-written summary. */
import type { Prisma } from "@prisma/client";

export interface MemorySummaryChanges {
  newestRetirementAt: Date | null;
  newestExpiryAt: Date | null;
}

export type MemorySummaryChangeReader = (args: {
  where: Prisma.MemoryEntryWhereInput;
  orderBy: Prisma.MemoryEntryOrderByWithRelationInput;
  select: { updatedAt?: true; expiresAt?: true };
}) => Promise<{ updatedAt?: Date; expiresAt?: Date | null } | null>;

/**
 * Retiring an old belief can leave the row count unchanged (moving back to a
 * previously remembered city reinstates its row). A summary still describes
 * the retired belief until rebuilt. Read only timestamps, in the summary's
 * exact account/project scope, and never load another person's fact content.
 * An elapsed expiry invalidates prose even before the asynchronous sweep runs.
 */
export async function readMemorySummaryChanges(
  input: { userId: string; projectId: string | null; now: Date },
  read: MemorySummaryChangeReader,
): Promise<MemorySummaryChanges> {
  const scope = { userId: input.userId, projectId: input.projectId, kind: "FACT" as const };
  const [retired, expired] = await Promise.all([
    read({
      where: { ...scope, status: { in: ["superseded", "suppressed", "expired"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
    read({
      where: { ...scope, expiresAt: { not: null, lte: input.now } },
      orderBy: { expiresAt: "desc" },
      select: { expiresAt: true },
    }),
  ]);
  return { newestRetirementAt: retired?.updatedAt ?? null, newestExpiryAt: expired?.expiresAt ?? null };
}

/**
 * The deletes that take a summary out of service because a fact it quotes was
 * deleted, rewritten or moved out of its scope.
 *
 * Those changes leave no row behind for `readMemorySummaryChanges` to see — a
 * deleted fact has no `updatedAt`, and a rewritten one's `updatedAt` cannot be
 * told apart from bookkeeping (`lastUsedAt`, vectors). So the summary was
 * injected, still quoting the old fact, until a best-effort rebuild landed;
 * when the rebuild failed or never ran (the native mutation path scheduled
 * none), indefinitely. Removing it in the same transaction as the change makes
 * the next turn read the facts themselves, and `maybeConsolidate` /
 * `maybeConsolidateProject` rebuild a missing summary on their own.
 *
 * Generic over the client so it works in an array `$transaction` (where each
 * call must stay a lazy PrismaPromise) and inside an interactive one alike.
 * `null` is the account's scope; a project id is that project's own.
 */
export function summaryInvalidations<P>(
  db: {
    memorySummary: { deleteMany(args: { where: { userId: string } }): P };
    projectMemorySummary: { deleteMany(args: { where: { userId: string; projectId: string } }): P };
  },
  userId: string,
  scopes: Iterable<string | null>,
): P[] {
  return [...new Set(scopes)].map((scope) =>
    scope === null
      ? db.memorySummary.deleteMany({ where: { userId } })
      : db.projectMemorySummary.deleteMany({ where: { userId, projectId: scope } }),
  );
}

/**
 * Take out of service the summaries a set of conversations' digests went into,
 * before those conversations are deleted.
 *
 * A chat's one-line digest (ConversationMemory.digest) is a source of the
 * summary of its scope — the account's for an unfiled chat, its project's for a
 * filed one (gatherMemorySources / consolidateProjectMemory). Deleting the chat
 * cascades the digest away and left the prose built from it: a deleted chat's
 * topic went on being injected, as "top of mind", into every conversation of
 * that scope until something unrelated forced a rebuild. Removing the summary
 * with the delete makes the next turn read the facts, and the next
 * consolidation rebuilds without the deleted chat.
 *
 * Facts learned in the chat are NOT deleted: they are the person's memory,
 * listed and deletable on their own, and their provenance says they came
 * from "a chat that's no longer available" (memory-provenance.ts). Only chats that were ever
 * digested invalidate anything, so deleting an unread chat costs no rebuild.
 *
 * Must run before the delete, in the same transaction: afterwards the digest
 * rows, and with them the scopes, are gone.
 */
export async function invalidateSummariesForDeletedConversations(
  db: {
    conversationMemory: {
      findMany(args: {
        where: { userId: string; conversationId: { in: string[] }; digest: { not: null } };
        select: { conversation: { select: { projectId: true } } };
      }): Promise<{ conversation: { projectId: string | null } }[]>;
    };
    memorySummary: { deleteMany(args: { where: { userId: string } }): Promise<unknown> };
    projectMemorySummary: { deleteMany(args: { where: { userId: string; projectId: string } }): Promise<unknown> };
  },
  userId: string,
  conversationIds: readonly string[],
): Promise<number> {
  if (conversationIds.length === 0) return 0;
  const digested = await db.conversationMemory.findMany({
    where: { userId, conversationId: { in: [...conversationIds] }, digest: { not: null } },
    select: { conversation: { select: { projectId: true } } },
  });
  const scopes = [...new Set(digested.map((row) => row.conversation.projectId ?? null))];
  await Promise.all(summaryInvalidations(db, userId, scopes));
  return scopes.length;
}
