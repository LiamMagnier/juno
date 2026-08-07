import { isTerminalStatus } from "@/lib/work/domain";
import { matchesFilter, type RecentItem } from "@/lib/work/recents";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * The Work home's list, sorted into the four answers a person actually wants.
 *
 * The old home had two sections — "Needs you" and "Recent tasks" — and a
 * segmented control over the second offering All / In progress / Done. That put
 * the state question in two places at once: the section header answered part of
 * it, and a filter the reader had to operate answered the rest, one slice at a
 * time. A workspace does not make you pick a slice to see what you have; it
 * shows you the whole shape and lets you look at the part you came for. So the
 * filter is gone and the grouping does its job — every task is on the page, in
 * the group that says what it is waiting on.
 *
 * WHY THE PREDICATES COME FROM recents.ts. "Needs you" and "what is running" are
 * already defined, once, in `matchesFilter` — the same function that decides
 * what the app-wide Recents list shows under those names. Restating them here
 * would be a second definition of "running" in a codebase that already went to
 * the trouble of writing down that a task waiting for an approval is NOT
 * running, and the first thing to drift would be exactly that distinction: the
 * Recents list and the Work home would disagree about a task the reader can see
 * in both at once. A `ClientWorkSession` is projected into the shape that
 * function reads rather than the predicates being copied into the shape we have.
 *
 * The third group is the residue and is where the honesty is. Live, not needing
 * anybody, and not running leaves `draft` and those `paused` tasks the server has
 * not also flagged for attention: a task that was composed and never sent, and
 * one holding where the user stopped it. Neither is "in progress" and neither is
 * "done", and folding them into either — which is what a two-way live/terminal
 * split does — is how a draft somebody abandoned sits in a list of running work
 * for a fortnight.
 */

/**
 * The order is the order they are rendered in, and it is not arbitrary: it runs
 * from "you have to do something" through "Juno is doing something" to "nobody
 * is doing anything", so the page reads top-down as decreasing urgency and a
 * reader who stops halfway has not missed anything that needed them.
 */
export const WORK_GROUP_KEYS = ["attention", "running", "parked", "finished"] as const;

export type WorkGroupKey = (typeof WORK_GROUP_KEYS)[number];

export type WorkGroups = Readonly<Record<WorkGroupKey, ClientWorkSession[]>>;

/**
 * A session in the shape `matchesFilter` reads.
 *
 * Only the fields those two predicates touch carry meaning; `href` and `title`
 * are required by `RecentItem` and are filled honestly rather than stubbed,
 * because a stub is what somebody later reads as permission to widen this
 * function's use.
 */
function asRecentItem(session: ClientWorkSession): RecentItem {
  return {
    id: session.id,
    kind: "work",
    title: session.title,
    updatedAt: session.lastActivityAt,
    pinned: session.pinned,
    status: session.status,
    needsAttention: session.needsAttention,
    href: `/work/${session.id}`,
  };
}

/**
 * Which group one task belongs in. Exactly one, and the order of the tests is
 * the meaning.
 *
 * `attention` is asked first because two of its statuses are also something
 * else: `host_offline` is terminal, and a paused run is parked by `parkRun` with
 * `needsAttention` set. Both are decisions waiting on a person, and a decision
 * filed under "Finished" is a decision that never gets made.
 */
function groupOf(session: ClientWorkSession): WorkGroupKey {
  const item = asRecentItem(session);
  if (matchesFilter(item, "needs_attention")) return "attention";
  if (matchesFilter(item, "running")) return "running";
  // `isTerminalStatus` from the domain rather than a list written out again —
  // and its counterpart `isLiveStatus` is doing the same job one level down,
  // inside `matchesFilter`'s `running` case, which is exactly why that predicate
  // is borrowed rather than copied.
  //
  // Terminal is tested last so that a status this build has never heard of lands
  // in `parked` rather than in `finished`. Both are wrong for an unknown status;
  // only one of them tells the reader the task is over when it may not be.
  return isTerminalStatus(session.status) ? "finished" : "parked";
}

/**
 * Sorts the list into groups, keeping the order it arrived in within each.
 *
 * A single pass, and no sort of its own. `GET /api/work/sessions` already orders
 * by `pinned desc, lastActivityAt desc` — the order its indexes are built for
 * and the order its paging assumes — so recency within a group comes free, and
 * a pinned task is already at the top of whichever group it lands in. Re-sorting
 * here would be a second opinion that disagrees with the next page the moment
 * there are more than forty tasks.
 *
 * Archived tasks are dropped rather than grouped. The list route filters
 * `archived: false` already; this is the guard for the row that was archived
 * from this very page and folded back in locally before the next poll.
 */
export function groupWorkSessions(sessions: readonly ClientWorkSession[]): WorkGroups {
  const groups: Record<WorkGroupKey, ClientWorkSession[]> = {
    attention: [],
    running: [],
    parked: [],
    finished: [],
  };
  for (const session of sessions) {
    if (session.archived) continue;
    groups[groupOf(session)].push(session);
  }
  return groups;
}
