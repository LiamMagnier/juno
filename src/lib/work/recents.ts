/**
 * One list of everything the user has been doing, across all three products.
 *
 * Juno has three kinds of thing with a timeline — a chat, a Work session, and a
 * Code session — and until now each had its own list with its own sort, its own
 * idea of "recent", and its own filters. The cost of that is not aesthetic. A
 * user who remembers doing something last Tuesday and cannot remember whether
 * they did it in Chat or in Work has to look in two places, and the one that
 * needs their attention right now is exactly the one they are least likely to
 * be looking at.
 *
 * The merge is a projection, not a table. Nothing is denormalised into a
 * `Recent` row, because a fourth copy of a title is a fourth place for it to go
 * stale, and the ordering key each source already maintains is indexed. What
 * this module owns is the shape they are projected into and the rules for
 * combining them.
 *
 * Free of `server-only` and Prisma: the projection and the filter predicate are
 * the parts with behaviour, and they are worth testing without a database.
 */

import { statusNeedsAttention, isTerminalStatus, isLiveStatus } from "@/lib/work/domain";

export const RECENT_KINDS = ["chat", "work", "code", "project"] as const;
export type RecentKind = (typeof RECENT_KINDS)[number];

/**
 * The filters the UI offers.
 *
 * Deliberately a flat list rather than two dimensions (kind × state), because
 * the user's question is flat: "what needs me", "what is running", "where is
 * that Work task". Modelling it as a matrix produces cells nobody wants —
 * "failed projects" is not a thing — and forces the UI to hide them.
 */
export const RECENT_FILTERS = [
  "all",
  "chat",
  "work",
  "code",
  "projects",
  "pinned",
  "running",
  "needs_attention",
  "completed",
  "failed",
] as const;
export type RecentFilter = (typeof RECENT_FILTERS)[number];

export function isRecentFilter(value: string): value is RecentFilter {
  return (RECENT_FILTERS as readonly string[]).includes(value);
}

/**
 * One row, whatever it came from.
 *
 * `status` is optional because a chat does not have one and a project does not
 * either. That absence is meaningful and is why the state filters below treat a
 * missing status as "not running, not failed, not needing attention" rather
 * than guessing.
 */
export interface RecentItem {
  id: string;
  kind: RecentKind;
  title: string;
  /** The single ordering key. ISO-8601, so the sort is lexicographic-safe. */
  updatedAt: string;
  pinned: boolean;
  /** A Work or Code status, when the row has one. */
  status?: string;
  /** Set for a Work session that cannot progress without the user. */
  needsAttention?: boolean;
  /** The project this belongs to, for grouping. */
  projectId?: string | null;
  /** Where clicking it goes. */
  href: string;
  /** One line of context, already display-safe. Never a filesystem path. */
  subtitle?: string;
}

/**
 * Whether a row belongs under a filter.
 *
 * Written as one function rather than a predicate per filter so the whole
 * behaviour is readable at once — including the part that is easy to get wrong,
 * which is that `running` and `needs_attention` are not the same set and must
 * not overlap. A run waiting for an approval is not running; it is stopped,
 * waiting for a person, and showing it under "running" is how a user watches a
 * spinner for something that is actually waiting for them.
 */
export function matchesFilter(item: RecentItem, filter: RecentFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "chat":
      return item.kind === "chat";
    case "work":
      return item.kind === "work";
    case "code":
      return item.kind === "code";
    case "projects":
      return item.kind === "project";
    case "pinned":
      return item.pinned;
    case "needs_attention":
      return item.needsAttention === true || (!!item.status && statusNeedsAttention(item.status));
    case "running":
      // Live but not blocked. The exclusion is the point.
      return (
        !!item.status &&
        isLiveStatus(item.status) &&
        !statusNeedsAttention(item.status) &&
        item.needsAttention !== true &&
        item.status !== "draft" &&
        item.status !== "paused"
      );
    case "completed":
      return item.status === "completed";
    case "failed":
      // Everything that ended without doing the job, not only the status
      // literally named "failed". A user looking for what went wrong does not
      // distinguish a crash from a budget stop, and putting the budget stop
      // under "completed" would be actively misleading.
      return (
        !!item.status &&
        isTerminalStatus(item.status) &&
        item.status !== "completed" &&
        item.status !== "cancelled"
      );
  }
}

/**
 * Merges several already-sorted sources into one ordered list.
 *
 * Pinned first, then most recent. Pinned-first is not decoration: a pinned item
 * that falls off the end of a clamped page is a pin that did not work, and the
 * whole reason to pin something is that it should not fall off.
 *
 * Ties are broken by id so the order is stable across requests. Two rows
 * written in the same millisecond are common — a session and its first run are
 * created together — and an unstable sort makes them swap places on every
 * refresh, which reads as the list flickering.
 */
export function mergeRecents(sources: readonly (readonly RecentItem[])[], limit: number): RecentItem[] {
  const merged = sources.flat();
  merged.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return merged.slice(0, Math.max(0, limit));
}

/**
 * How many of each source to fetch when the caller wants `limit` merged rows.
 *
 * Each source must be asked for the full limit, not for a share of it. Asking
 * four sources for a quarter each and merging produces a list that is missing
 * the five most recent chats whenever the user has been chatting all morning
 * and touched nothing else — and the bug is invisible, because the list is
 * full and looks right.
 */
export function perSourceLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), 200);
}

/** The counts a filter bar shows. Computed from the merged set, before slicing. */
export function countByFilter(items: readonly RecentItem[]): Record<RecentFilter, number> {
  const counts = Object.fromEntries(RECENT_FILTERS.map((f) => [f, 0])) as Record<
    RecentFilter,
    number
  >;
  for (const item of items) {
    for (const filter of RECENT_FILTERS) {
      if (matchesFilter(item, filter)) counts[filter] += 1;
    }
  }
  return counts;
}
