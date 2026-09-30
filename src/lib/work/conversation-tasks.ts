/**
 * Several tasks in one conversation, decided as pure functions.
 *
 * A conversation used to follow one task, the newest, and the server refused a
 * second live one because the chat could not draw it. That was a limit of the
 * client that had become a rule of the domain, and it was the wrong rule for a
 * crew: a routine firing in a member's thread replaced the person's own task
 * on screen and blocked `start_task` until it finished. The rule now is a cap
 * (`MAX_LIVE_TASKS_PER_CONVERSATION`) with a sentence that names what is
 * running, and every live task draws its own card.
 *
 * What lives here: the cap and its sentences, which tasks a conversation
 * draws, which of them the composer answers or steers, and the order the
 * cards stack in. `tests/work-conversation-tasks.test.ts` reads all of it.
 */

import { isTerminalStatus, WORK_LIVE_STATUSES } from "@/lib/work/domain";

/**
 * The most live tasks one conversation carries at once.
 *
 * Four, because four cards still fit beside a transcript somebody is reading,
 * and because the account's own concurrency cap (three runs executing at a
 * time) is lower: the fourth is a task waiting on the person or paused, which
 * is exactly the one a person would otherwise lose track of.
 */
export const MAX_LIVE_TASKS_PER_CONVERSATION = 4;

/**
 * The statuses a task counts as live in. `draft` is left out: it costs
 * nothing, holds no executor and is never drawn.
 */
export const CONVERSATION_LIVE_STATUSES: readonly string[] = WORK_LIVE_STATUSES.filter(
  (status) => status !== "draft"
);

/** "A", "A and B", "A, B and C", each quoted. */
export function quotedList(titles: readonly string[]): string {
  const quoted = titles.map((title) => `"${title.replace(/\s+/g, " ").trim()}"`);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The refusal for a conversation that is already at the cap. Names what is
 * running, because "too many tasks" is a sentence the person has to go and
 * look up.
 */
export function conversationAtCapMessage(liveTitles: readonly string[]): string {
  return `This conversation already has ${liveTitles.length} tasks going: ${quotedList(liveTitles)}. Let one finish or stop one before starting another. Nothing new was started.`;
}

/** The same refusal for a crew member's thread a hand-off would land in. */
export function memberAtCapMessage(name: string, liveTitles: readonly string[]): string {
  return `${name} already has ${liveTitles.length} tasks going: ${quotedList(liveTitles)}. Let one finish before handing ${name} more. Nothing was handed off.`;
}

/** The subset of a session the decisions below read. */
export interface ConversationTaskRow {
  id: string;
  status: string;
  needsAttention: boolean;
  createdAt: string;
  lastActivityAt: string;
}

/**
 * Which tasks a conversation draws: every live one, plus the newest finished
 * one when nothing newer replaced it, so a task that just finished keeps its
 * result card on screen after a reload exactly as before.
 *
 * Returned oldest first, which is the order the cards stack in: the newest
 * lands last, under the turn that asked for it.
 */
export function tasksToDraw<T extends ConversationTaskRow>(
  rows: readonly T[],
  options: { cap?: number } = {}
): T[] {
  const cap = options.cap ?? MAX_LIVE_TASKS_PER_CONVERSATION;
  const drawable = rows.filter((row) => row.status !== "draft");
  const live = drawable.filter((row) => !isTerminalStatus(row.status));
  const finished = drawable
    .filter((row) => isTerminalStatus(row.status))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  // More live rows than the cap can exist (tasks started before the cap, or a
  // routine that fired regardless): all of them are drawn, since hiding a live
  // task is the failure this exists to remove.
  const chosen = [...live];
  const newestFinished = finished[0];
  if (newestFinished && live.length < cap) chosen.push(newestFinished);
  return chosen.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Merges a discovery answer into what the conversation already draws.
 *
 * A task already on screen is never dropped by a later answer that no longer
 * lists it (it finished, and a newer one took the "newest finished" place):
 * the person may be reading its result. Only a change of conversation clears
 * the list, which the hook does itself. Rows the answer carries replace the
 * ones on screen, so a status change arrives; everything is kept in stack
 * order.
 */
export function mergeDiscoveredTasks<T extends ConversationTaskRow>(
  current: readonly T[],
  discovered: readonly T[]
): T[] {
  const byId = new Map<string, T>();
  for (const row of current) byId.set(row.id, row);
  for (const row of discovered) {
    if (row.status === "draft") continue;
    const existing = byId.get(row.id);
    // Keep the object identity when nothing about the row changed, so a poll
    // that finds the same tasks does not re-render every card.
    if (existing && existing.status === row.status && existing.lastActivityAt === row.lastActivityAt && existing.needsAttention === row.needsAttention) {
      continue;
    }
    byId.set(row.id, row);
  }
  const merged = [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const unchanged =
    merged.length === current.length && merged.every((row, index) => row === current[index]);
  return unchanged ? (current as T[]) : merged;
}

/**
 * The task the composer answers or steers when several are live.
 *
 * A task waiting on the person wins, the oldest first, because it is the one
 * that has stopped. Otherwise the newest live task, which is almost always the
 * one the person just asked for. Null when nothing is live.
 */
export function composerTaskId(
  reports: readonly { sessionId: string; createdAt: string; live: boolean; waiting: boolean }[]
): string | null {
  const live = reports.filter((report) => report.live);
  if (live.length === 0) return null;
  const waiting = live
    .filter((report) => report.waiting)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (waiting.length > 0) return waiting[0].sessionId;
  return [...live].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0].sessionId;
}

/** The statuses in which a task has stopped to wait on the person. */
export const CONVERSATION_WAITING_STATUSES = ["waiting_input", "waiting_approval"] as const;

/**
 * A conversation's own listing for a client that follows ONE task: the apps
 * that shipped before several tasks per conversation, which ask
 * `GET /api/work/sessions?conversationId=&limit=1` and draw the answer as "the
 * task on this chat", with the composer answering its question.
 *
 * While a conversation could hold one live task, the newest row was that task.
 * Now a newer task (a routine firing in a crew member's thread, a second
 * request) can be running while an older one waits on the person, and "newest
 * first" would hide the waiting one from those apps: its question could not be
 * answered from the chat at all. So a task waiting on the person comes first,
 * the same rule the web composer follows (`composerTaskId`), then the usual
 * order. `waiting` and `rest` are each already in their own order.
 */
export function waitingTasksFirst<T extends { id: string }>(
  waiting: readonly T[],
  rest: readonly T[],
  limit: number
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of [...waiting, ...rest]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
