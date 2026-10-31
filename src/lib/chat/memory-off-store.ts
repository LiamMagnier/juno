import type { Prisma } from "@prisma/client";
import { EXTRACTOR_VERSION } from "@/lib/memory-extraction";

/*
 * The database half of "Memory off for this chat" (src/lib/chat/memory-off.ts).
 * One writer, so the web's toggle (/api/conversations/[id]/memory) and the
 * apps' sync mutation (`conversation.update` in /api/v1/mutations) cannot
 * disagree about what turning memory back on means.
 *
 * Takes the client it writes through rather than importing one: the route
 * passes the guarded `prisma`, the sync mutation its transaction, and the
 * tests a fixture.
 */

export type MemoryOffDb = Pick<Prisma.TransactionClient, "conversation" | "conversationMemory">;

/**
 * Save the chat's switch. Owner-scoped: a chat that is not this person's (or,
 * with `kind`, not that kind) is `null`, and nothing is written.
 *
 * Off → on covers the chat as read up to its last message, in the same
 * motion. Without that, the next turn's extraction (or tonight's backfill)
 * would start from the old high-water mark and read every message said while
 * memory was off — the one thing the switch promised it would not. The row is
 * also stamped with the current reader's version, so a re-read
 * (`queueRereads`, which rewinds chats an older reader distilled) never
 * rewinds into that stretch either. What that costs is a re-read of whatever
 * an older reader saw before memory went off, and anything from then not yet
 * read (the reader runs after every turn, so normally nothing): the switch's
 * promise wins.
 *
 * The transition is a conditional update (`memoryOff: !off`), so two devices
 * flipping it at once cover the chat once, and a repeat of the same value is
 * a read and nothing more.
 */
export async function setConversationMemoryOff(
  db: MemoryOffDb,
  input: { userId: string; conversationId: string; off: boolean; kind?: "chat" | "code" }
): Promise<{ memoryOff: boolean } | null> {
  const where = { id: input.conversationId, userId: input.userId, ...(input.kind ? { kind: input.kind } : {}) };
  const row = await db.conversation.findFirst({ where, select: { memoryOff: true, lastMessageAt: true } });
  if (!row) return null;
  if (row.memoryOff === input.off) return { memoryOff: row.memoryOff };
  const changed = await db.conversation.updateMany({ where: { ...where, memoryOff: !input.off }, data: { memoryOff: input.off } });
  if (changed.count > 0 && !input.off) {
    await db.conversationMemory.upsert({
      // Scoped, as every ConversationMemory write is: the ownership guard
      // refuses one without the owner column.
      where: { conversationId: input.conversationId, userId: input.userId },
      create: {
        userId: input.userId,
        conversationId: input.conversationId,
        processedAt: row.lastMessageAt,
        extractorVersion: EXTRACTOR_VERSION,
      },
      update: { processedAt: row.lastMessageAt, extractorVersion: EXTRACTOR_VERSION },
    });
  }
  return { memoryOff: input.off };
}
