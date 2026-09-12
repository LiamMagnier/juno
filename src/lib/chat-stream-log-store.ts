import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe, encryptMessageText } from "@/lib/message-crypto";
import type { StreamLogRow } from "@/lib/chat/stream-log";
import type { ReplayEventRow } from "@/lib/chat/stream-replay";

/**
 * The Prisma side of the resumable-stream log (`chat/stream-log.ts` writes,
 * `chat/stream-replay.ts` reads; both are pure and take this as their port).
 *
 * Payloads are encrypted with the message keyring on the way in and decrypted
 * on the way out: a logged `delta` is transcript text and a logged `done`
 * carries the whole persisted message, so the log gets exactly the at-rest
 * treatment `Message.content` does. `kind` stays in the clear — it is the
 * frame type, and the sweep below needs to find terminal frames by it.
 *
 * `ChatStreamEvent` carries no userId, so the ownership guard does not apply;
 * ownership is proven by the resume route through the receipt or the logged
 * meta frame's conversation before any row is read back.
 *
 * Not `server-only`: `scripts/prune-sync.ts` runs the sweep under plain tsx.
 */

/** How long a finished generation's frames stay replayable. */
export const STREAM_LOG_TERMINAL_RETENTION_MS = 10 * 60_000;
/**
 * Frames of a generation that never wrote a terminal frame — the process died,
 * or the log was disabled mid-way — are dead weight after this.
 */
export const STREAM_LOG_ABANDONED_RETENTION_MS = 24 * 60 * 60_000;

export async function appendChatStreamEvents(rows: StreamLogRow[]): Promise<void> {
  if (rows.length === 0) return;
  await prisma.chatStreamEvent.createMany({
    data: rows.map((row) => ({
      generationId: row.generationId,
      seq: row.seq,
      kind: row.kind,
      payload: encryptMessageText(row.payload),
    })),
  });
}

export async function readChatStreamEvents(
  generationId: string,
  after: number,
  limit: number
): Promise<ReplayEventRow[]> {
  const rows = await prisma.chatStreamEvent.findMany({
    where: { generationId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit,
    select: { seq: true, kind: true, payload: true },
  });
  const out: ReplayEventRow[] = [];
  for (const row of rows) {
    // A row this keyring cannot open (a rotated key, a corrupt write) is
    // skipped rather than replayed as garbage; the client's sequencer sees
    // the gap in ids and the terminal frame still ends the tail.
    const payload = decryptMessageTextSafe(row.payload);
    if (payload) out.push({ seq: row.seq, kind: row.kind, payload });
  }
  return out;
}

/** The logged `meta` frame's conversation — the ownership anchor when there is no receipt. */
export async function findChatStreamMeta(
  generationId: string
): Promise<{ conversationId: string; userMessageId: string | null } | null> {
  const row = await prisma.chatStreamEvent.findFirst({
    where: { generationId, kind: "meta" },
    orderBy: { seq: "asc" },
    select: { payload: true },
  });
  if (!row) return null;
  const payload = decryptMessageTextSafe(row.payload);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { conversationId?: unknown; userMessageId?: unknown };
    if (typeof parsed.conversationId !== "string") return null;
    return {
      conversationId: parsed.conversationId,
      userMessageId: typeof parsed.userMessageId === "string" ? parsed.userMessageId : null,
    };
  } catch {
    return null;
  }
}

export async function deleteChatStreamEvents(generationId: string): Promise<number> {
  const deleted = await prisma.chatStreamEvent.deleteMany({ where: { generationId } });
  return deleted.count;
}

/**
 * Drop logs that have served their purpose: generations whose terminal frame
 * is older than the retention window, plus generations that never got one
 * and have been silent for a day. Bounded per call; safe to run from a turn's
 * `after()` and from the prune job alike.
 */
export async function sweepChatStreamEvents(
  options: { now?: Date; limit?: number; dryRun?: boolean } = {}
): Promise<{ generations: number; events: number }> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 1_000);

  const finished = await prisma.chatStreamEvent.findMany({
    where: {
      kind: { in: ["done", "error"] },
      createdAt: { lt: new Date(now.getTime() - STREAM_LOG_TERMINAL_RETENTION_MS) },
    },
    distinct: ["generationId"],
    select: { generationId: true },
    take: limit,
  });
  const abandoned = await prisma.chatStreamEvent.groupBy({
    by: ["generationId"],
    _max: { createdAt: true },
    having: {
      createdAt: { _max: { lt: new Date(now.getTime() - STREAM_LOG_ABANDONED_RETENTION_MS) } },
    },
    take: limit,
  });

  const generationIds = [
    ...new Set([...finished.map((row) => row.generationId), ...abandoned.map((row) => row.generationId)]),
  ];
  if (generationIds.length === 0) return { generations: 0, events: 0 };
  if (options.dryRun) {
    const events = await prisma.chatStreamEvent.count({ where: { generationId: { in: generationIds } } });
    return { generations: generationIds.length, events };
  }
  const deleted = await prisma.chatStreamEvent.deleteMany({ where: { generationId: { in: generationIds } } });
  return { generations: generationIds.length, events: deleted.count };
}
