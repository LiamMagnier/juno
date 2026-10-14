/**
 * How a paged transcript grows on the client (see lib/chat/history-page.ts for
 * the server half). The client always holds a contiguous run of the
 * conversation that ends at its newest message; these keep it that way.
 *
 * Pure and tested (tests/chat-history-merge.test.ts).
 */
import type { ConversationHistory } from "@/types/chat";

type Row = { id: string; createdAt: string };

/** No older history: a conversation that arrived whole, or a new one. */
export const COMPLETE_HISTORY: ConversationHistory = { hasOlder: false, olderCursor: null };

function before(a: Row, b: Row): boolean {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) < Date.parse(b.createdAt);
  return a.id < b.id;
}

/** An older page lands above what is loaded. Rows already held win. */
export function prependOlder<T extends Row>(current: readonly T[], older: readonly T[]): T[] {
  if (!older.length) return current as T[];
  const held = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => !held.has(m.id));
  return fresh.length ? [...fresh, ...current] : (current as T[]);
}

/**
 * The server sent its newest page again (router.refresh, a sync). The page is
 * the truth for everything it covers; history the reader already scrolled back
 * through, older than the page's first row, is kept rather than thrown away.
 *
 * Returns the merged list (rows of `current` kept as they are, the rest the
 * page's) and how many older rows were kept, which decides whose cursor the
 * history state continues from.
 */
export function reconcileNewestPage<T extends Row>(
  current: readonly T[],
  page: readonly T[],
  pageHistory: ConversationHistory,
): { messages: T[]; keptOlder: number } {
  if (!pageHistory.hasOlder || !page.length) return { messages: page as T[], keptOlder: 0 };
  const first = page[0];
  const overlap = current.findIndex((m) => m.id === first.id);
  if (overlap <= 0) return { messages: page as T[], keptOlder: 0 };
  const ids = new Set(page.map((m) => m.id));
  const kept = current.slice(0, overlap).filter((m) => !ids.has(m.id) && before(m, first));
  return { messages: kept.length ? [...kept, ...page] : (page as T[]), keptOlder: kept.length };
}

/** The history state after a newest-page reconcile. */
export function reconciledHistory(
  current: ConversationHistory,
  page: ConversationHistory,
  keptOlder: number,
): ConversationHistory {
  return keptOlder > 0 ? current : page;
}
