/**
 * The sidebar's list arithmetic, kept out of the component so it can be tested:
 * how many Needs you and Orbit rows are drawn, the order of Recent (pinned
 * chats first), and which pinned projects are unfolded.
 */

/**
 * NEEDS YOU HOLDS THREE ROWS AT REST. Every ask used to be a row, so an
 * account with eight things waiting drew eight rows above Orbit, the pins and
 * Recent, and the reader's own chats went a screen down the column. Past
 * three, the first three stay and one quiet row says how many more there are
 * and opens them in place. One extra ask is drawn rather than summarised: a
 * "1 more" row takes the same height as the row it would hide.
 */
export const NEEDS_YOU_ROWS = 3;

export function needsYouSlice(total: number, expanded: boolean): { shown: number; more: number } {
  if (expanded || total <= NEEDS_YOU_ROWS + 1) return { shown: total, more: 0 };
  return { shown: NEEDS_YOU_ROWS, more: total - NEEDS_YOU_ROWS };
}

/**
 * ORBIT LISTS AT MOST THREE AGENTS, AND TWO ON A SHORT WINDOW. S8 caps the
 * busy-agents list at three. On a laptop-height window (a 1280×800, 1536×864
 * or 1440×900 viewport) a day with three asks, four agents at work, two
 * pinned projects and two pinned chats filled the column to its last pixel,
 * and Recent opened off screen with nothing to say the list went on. There
 * the third agent gives its row to the lists under it: the heading already
 * carries the total ("Orbit · 4") and opens the roster, so the cap still
 * never hides an agent quietly, and a blocked agent is never the one behind
 * the count (`orbitRows`). Needs you is never shortened for this: an ask
 * outranks a chat.
 */
export const ORBIT_ROWS = 3;
export const ORBIT_ROWS_SHORT = 2;
/** A viewport this short or shorter is "short": 57.5rem (920px) takes in the
 *  900px-tall laptop viewports and leaves 1000px and up at three. */
export const SHORT_WINDOW_QUERY = "(max-height: 57.5rem)";

export function orbitRowLimit(shortWindow: boolean): number {
  return shortWindow ? ORBIT_ROWS_SHORT : ORBIT_ROWS;
}

/**
 * THE CAP NEVER HIDES AN AGENT THAT NEEDS LOOKING AT. Rows used to keep the
 * roster's own order, so on a short window, where the cap is two, two agents
 * merely at work took both rows and a blocked one (its last run failed or was
 * stopped) fell behind the "Orbit · 4" count, though it was the one row worth
 * acting on. An agent in an attention state now leads, then the ones at work,
 * then the just-finished; within each group the order given is kept. (An agent
 * asking the reader is not a candidate at all: its ask is a Needs you row.)
 */
export const ORBIT_ATTENTION_STATES: ReadonlySet<string> = new Set(["blocked"]);

export function orbitRows<T extends { state: string }>(
  atWork: readonly T[],
  finished: readonly T[],
  limit: number
): { rows: T[]; count: number } {
  const attention = atWork.filter((a) => ORBIT_ATTENTION_STATES.has(a.state));
  const rest = atWork.filter((a) => !ORBIT_ATTENTION_STATES.has(a.state));
  const all = [...attention, ...rest, ...finished];
  return { rows: all.slice(0, Math.max(0, limit)), count: all.length };
}

/**
 * PINNED CHATS LEAD RECENT (owner decision, 2026-10-26; INTERACTION_SPEC S11).
 * "Pinned chats" was a section of its own between Pinned projects and Recent:
 * one more heading in the busiest part of the column, and on a laptop-height
 * window it kept Recent's first row off the first screen. The pinned chats
 * now head the Recent list, each keeping its pin mark, newest first among
 * themselves; every other chat follows, newest first.
 *
 * BY DATE, NOT BY WHERE THE ROW SAT. The server sends the pinned chats
 * first, so a chat unpinned in place still sat at the head of the array and a
 * partition alone left it above chats a month newer. Both halves are sorted
 * by `lastMessageAt` (newest first; ties, and a date that does not parse,
 * keep the order given), so unpinning drops a row into its place by date and
 * pinning lifts it into the head at its own date. The Mac and the iPhone and
 * iPad build the same list (`DesktopChatSidebarContent.recent`,
 * `JunoMobileSidebarDrawer.recentChats`), both from lists sorted by
 * `lastMessageAt`.
 */
export function pinnedFirst<T extends { pinned?: boolean | null; lastMessageAt?: string | null }>(chats: readonly T[]): T[] {
  const at = (chat: T) => {
    const time = Date.parse(chat.lastMessageAt ?? "");
    return Number.isFinite(time) ? time : -Infinity;
  };
  const byDate = (list: T[]) =>
    list
      .map((chat, index) => ({ chat, index, time: at(chat) }))
      // `||` falls through on 0 and on NaN (two undated rows): keep the order given.
      .sort((a, b) => b.time - a.time || a.index - b.index)
      .map(({ chat }) => chat);
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const chat of chats) (chat.pinned ? pinned : rest).push(chat);
  return [...byDate(pinned), ...byDate(rest)];
}

/**
 * Which pinned projects the reader has unfolded, remembered per browser the
 * way the section folds are (SECTION_KEYS in app-sidebar.tsx). Projects open
 * folded; a project the reader opened stays open across a reload instead of
 * folding itself again while Pinned and Recent remember their state.
 */
export const OPEN_PROJECTS_KEY = "juno:sidebar:projects:open";

/** The stored list, or none: anything that is not an array of ids is ignored. */
export function parseOpenProjects(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The list with `id` opened or folded. Only ids in `known` are kept, when it
 * is given, so a deleted or unpinned project does not stay in storage.
 */
export function withProjectOpen(list: readonly string[], id: string, open: boolean, known?: readonly string[]): string[] {
  const keep = known ? new Set(known) : null;
  const next = list.filter((v) => v !== id && (!keep || keep.has(v)));
  if (open) next.push(id);
  return next;
}
