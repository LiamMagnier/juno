/**
 * Cursor paging over a conversation's messages (Workstream I,
 * docs/rework/program/PERFORMANCE.md "Paged history").
 *
 * A conversation used to arrive whole: /chat/[id] decrypted and serialised
 * every message into the route payload, 1.9 MB for the 2,000-message fixture,
 * before the reader saw the newest line. The page now carries the newest
 * turns, and older ones arrive a page at a time as the reader scrolls toward
 * them (GET /api/conversations/[id]/messages).
 *
 * Order is (createdAt, id) ascending everywhere. createdAt alone is not a
 * total order — a native batch can stamp two turns with the same millisecond —
 * and a cursor on a partial order skips or repeats the rows that tie.
 *
 * A page never starts on a reply. It is widened back to the question that
 * reply answers, so a turn is never split across two loads: the run cards
 * placed after a turn, and the context receipt a question reads from the
 * reply after it, always find both halves.
 *
 * Pure apart from the query callback, so the rules are tested without a
 * database (tests/chat-history.test.ts). Server-side only (Buffer); the
 * client treats the cursor as an opaque string.
 */
import type { ConversationHistory } from "@/types/chat";

/** The newest messages a conversation opens with. ~30 turns: several screens. */
export const FIRST_PAGE_MESSAGES = 60;
/** Each older page fetched while scrolling up. */
export const OLDER_PAGE_MESSAGES = 120;
/** The most an explicit `limit` may ask for in one request. */
export const MAX_PAGE_MESSAGES = 500;
/** Rows read past the limit to find the question a page-opening reply belongs to. */
const TURN_ALIGN_SLACK = 8;
/** Context kept above a deep-linked message, so it does not open at the very top. */
const FOCUS_CONTEXT = 10;

export interface HistoryCursor {
  createdAt: Date;
  id: string;
}

/** `hasOlder`: older messages exist than the oldest returned; `olderCursor` fetches them. */
export type HistoryState = ConversationHistory;

export function encodeHistoryCursor(row: HistoryCursor): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeHistoryCursor(raw: string | null | undefined): HistoryCursor | null {
  if (!raw || raw.length > 200) return null;
  let text: string;
  try {
    text = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const bar = text.indexOf("|");
  if (bar <= 0) return null;
  const createdAt = new Date(text.slice(0, bar));
  const id = text.slice(bar + 1);
  if (Number.isNaN(createdAt.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { createdAt, id };
}

/** Prisma `where` for rows strictly older than `cursor` in (createdAt, id) order. */
export function olderThan(cursor: HistoryCursor) {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

/** Prisma `where` for rows at or newer than `cursor` in (createdAt, id) order. */
export function atOrNewerThan(cursor: HistoryCursor) {
  return {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gte: cursor.id } },
    ],
  };
}

export const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];
export const OLDEST_FIRST = [{ createdAt: "asc" as const }, { id: "asc" as const }];

/**
 * Cut a newest-first read down to a page: `limit` rows, widened back to the
 * question the oldest one answers. `newestFirst` is a read of up to
 * `limit + slack` rows; `exhausted` says that read reached the conversation's
 * first message. Returns the page oldest-first.
 */
export function cutPage<T extends { role: string; createdAt: Date; id: string }>(
  newestFirst: readonly T[],
  limit: number,
  exhausted: boolean,
): { rows: T[]; history: HistoryState } {
  let end = Math.min(limit, newestFirst.length); // exclusive
  while (end > 0 && end < newestFirst.length && newestFirst[end - 1].role !== "USER") end++;
  const rows = newestFirst.slice(0, end).reverse();
  // Rows left over are older ones. None left over is only the start of the
  // conversation when the read itself ran out; otherwise the alignment used up
  // the slack and something older may still be there.
  const hasOlder = rows.length > 0 && (end < newestFirst.length || !exhausted);
  return { rows, history: { hasOlder, olderCursor: hasOlder ? encodeHistoryCursor(rows[0]) : null } };
}

export interface PageRequest {
  /** Only rows older than this cursor. Absent: from the newest message. */
  before?: HistoryCursor | null;
  /** Rows wanted (clamped to 1…MAX_PAGE_MESSAGES). */
  limit: number;
  /**
   * Widen the page so it reaches back to this message (and a little context
   * above it): a deep link or a jump to a row that is not loaded yet. Ignored
   * when the id is not in this conversation or not older than `before`.
   */
  throughMessageId?: string | null;
  /** Everything older than `before`. Find in chat and the full-transcript switch. */
  all?: boolean;
}

/** The two reads a page needs, supplied by the caller (Prisma in production). */
export interface PageReader<T> {
  /** Newest-first rows in the conversation matching `where`, at most `take` of them. */
  newestFirst(where: object, take: number | undefined): Promise<T[]>;
  /** The (createdAt, id) of a message in this conversation, or null. */
  locate(messageId: string): Promise<HistoryCursor | null>;
  /** How many rows in the conversation match `where`. */
  count(where: object): Promise<number>;
}

export async function readHistoryPage<T extends { role: string; createdAt: Date; id: string }>(
  reader: PageReader<T>,
  request: PageRequest,
): Promise<{ rows: T[]; history: HistoryState }> {
  const bound = request.before ? olderThan(request.before) : {};
  if (request.all) {
    const rows = await reader.newestFirst(bound, undefined);
    return { rows: rows.reverse(), history: { hasOlder: false, olderCursor: null } };
  }
  let limit = Math.max(1, Math.min(MAX_PAGE_MESSAGES, Math.floor(request.limit) || 1));
  if (request.throughMessageId) {
    const target = await reader.locate(request.throughMessageId);
    const older = target && (!request.before || compareCursor(target, request.before) < 0);
    if (target && older) {
      // Not clamped: reaching the message is the request. Bounded by the
      // conversation, which is what every load was before paging.
      const span = await reader.count({ AND: [bound, atOrNewerThan(target)] });
      limit = Math.max(limit, span + FOCUS_CONTEXT);
    }
  }
  const take = limit + TURN_ALIGN_SLACK;
  const rows = await reader.newestFirst(bound, take);
  return cutPage(rows, limit, rows.length < take);
}

export function compareCursor(a: HistoryCursor, b: HistoryCursor): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
