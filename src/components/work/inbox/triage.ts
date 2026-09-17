import { isTerminalStatus, statusNeedsAttention } from "@/lib/work/domain";
import { chatPathForSession } from "@/lib/work-url-migration";
import { matchesFilter, type RecentItem } from "@/lib/work/recents";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * What is left of the inbox's triage, now that the inbox is a fold.
 *
 * This module used to be the model behind a seven-pill list page: the pill
 * order, the label and caption per pill, the per-row status sentence, the
 * "Run again" and "Run it in the cloud instead" predicates. That page and every
 * component that rendered those exports are gone (docs/design/TWO_PRODUCTS.md
 * §2.2) — "Needs you" survives as a fold at the top of the chat sidebar, which
 * is a press rather than a destination, and a task's own state is read in its
 * transcript rather than summarised on a row.
 *
 * The deletion pass that removed those components was file-level, so it left
 * this file whole and every export in it unreferenced. Two are kept, and both
 * earn it by being read somewhere live:
 *
 *   `needsYou` is the sidebar's definition of a conversation that has stopped
 *   for a person (`use-needs-you-count.ts`).
 *
 *   `matchesTriage` is the client-side statement of the same four buckets
 *   `GET /api/work/sessions/counts` tallies server-side, and
 *   tests/work-triage-counts.test.ts checks the two against each other cell by
 *   cell. The route is part of `/api/work/**` and still serves the native
 *   clients, so the cross-check is a live one even though no web page filters
 *   rows with it any more.
 *
 * WHY THE PREDICATES STILL COME FROM recents.ts. `matchesFilter` is the single
 * definition of "running" and "needs attention" in the codebase, and the
 * app-wide Recents list renders from it. Restating either here would let the
 * sidebar and the counts route disagree about a task the reader can see in
 * both at once — specifically about the case that definition went to the
 * trouble of writing down, that a task waiting on an approval is NOT running.
 */

/**
 * The buckets the session table can be asked about for a whole account.
 *
 * Four, not the inbox's seven. `scheduled` was a fact about the schedule list
 * and `unread` a fact about this browser's history with a row, and `archived`
 * was decided by which list had been loaded rather than by the row — none of
 * the three is something the session table knows, which is why
 * `WorkTriageCounts` in the protocol module has the same four members.
 */
export type WorkTriageState = "needs_you" | "in_progress" | "done" | "all";

/**
 * A session projected into the shape `matchesFilter` reads.
 *
 * `href` and `title` are filled honestly rather than stubbed, because a stub is
 * what somebody later reads as permission to widen this function's use. Honest
 * means the CONVERSATION: a task is read in the chat that asked for it, and a
 * session that never had one resolves to the chat index rather than to a page
 * that no longer exists.
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
    href: chatPathForSession(session.conversationId),
  };
}

/** Whether a row belongs in a bucket. The client half of `tallyTriageCounts`. */
export function matchesTriage(session: ClientWorkSession, state: WorkTriageState): boolean {
  const item = asRecentItem(session);
  switch (state) {
    case "all":
      return true;
    case "needs_you":
      return matchesFilter(item, "needs_attention");
    case "in_progress":
      return matchesFilter(item, "running");
    case "done":
      // Terminal AND not needing anybody. `host_offline` is terminal and is a
      // decision waiting on a person, which is exactly why `matchesFilter`
      // treats it as attention — a decision filed under Done is a decision
      // nobody makes.
      return isTerminalStatus(session.status) && !matchesFilter(item, "needs_attention");
  }
}

/**
 * Whether a session is blocked on a person right now.
 *
 * A named predicate rather than the expression inline: the sidebar's "Needs
 * you" fold (`useWorkNeedsYouCount`) and the `needsAttention=true` list are two
 * readers of the same rows, and one definition is what keeps the fold and the
 * list from disagreeing about how many things need you.
 */
export function needsYou(session: ClientWorkSession): boolean {
  return session.needsAttention || statusNeedsAttention(session.status);
}
