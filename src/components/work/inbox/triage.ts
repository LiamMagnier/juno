import { isTerminalStatus, statusNeedsAttention, type WorkStatus } from "@/lib/work/domain";
import { matchesFilter, type RecentItem } from "@/lib/work/recents";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * Work's list, modelled as an inbox rather than as a history.
 *
 * The surface this replaces grouped every task into four always-visible
 * sections — Needs you / Under way / Parked / Finished — and its own header
 * comment argued the case: "a workspace does not make you pick a slice to see
 * what you have". That argument is right about a *history* and wrong about
 * this. The thing a person does with finished agent work is not read it, it is
 * TRIAGE it: decide whether the deliverable is good, whether the failure needs
 * re-running, whether the question still matters. Four open sections show
 * everything at once and therefore prioritise nothing, and the section that
 * grows without bound — Finished — pushes the two that need a human off the
 * fold on any account older than a week.
 *
 * So the model here is mail. One list, one selected state, a count on every
 * state so the shape of the whole is legible without switching, and a per-row
 * sentence saying what that row is waiting for. The difference between this and
 * the grouped list is not the pills; it is that a row now carries its own
 * status string, so the list answers "what is happening" per task instead of
 * only "which pile is it in".
 *
 * WHY THE PREDICATES STILL COME FROM recents.ts. `matchesFilter` is the single
 * definition of "running" and "needs attention" in the codebase, and the
 * app-wide Recents list renders from it. Restating either here would let the
 * sidebar and this page disagree about a task the reader can see in both at
 * once — specifically about the case that definition went to the trouble of
 * writing down, that a task waiting on an approval is NOT running.
 */

/**
 * The states, in the order the pills are rendered.
 *
 * `needs_you` is first because it is the only one with a deadline attached to a
 * person, and `all` is last because it is the escape hatch rather than the
 * default view. `unread` sits between the live states and the archive: it is the
 * only pill that is about the READER's history with the row rather than about
 * the row, which is why it is not simply another status bucket.
 *
 * `scheduled` is a state no other product's task list has, and it is here
 * because Juno's schedules point at a session rather than spawning orphans —
 * see `scheduleFor`. A recurring task is a live thing between its runs, not a
 * finished one, and filing it under "Done" because its last attempt completed
 * is how somebody deletes work that was going to run again on Monday.
 */
export const WORK_TRIAGE_STATES = [
  "needs_you",
  "in_progress",
  "scheduled",
  "unread",
  "done",
  "all",
] as const;

export type WorkTriageState = (typeof WORK_TRIAGE_STATES)[number];

export function isWorkTriageState(value: string): value is WorkTriageState {
  return (WORK_TRIAGE_STATES as readonly string[]).includes(value);
}

export const TRIAGE_LABEL: Record<WorkTriageState, string> = {
  needs_you: "Needs you",
  in_progress: "In progress",
  scheduled: "Scheduled",
  unread: "Unread",
  done: "Done",
  all: "All",
};

/**
 * The sentence under the pill row, per state.
 *
 * One per state and never omitted, because a filtered list that turns up empty
 * is ambiguous between "nothing matches" and "the load failed", and the caption
 * is what makes the empty case readable without a second empty-state component
 * per pill.
 */
export const TRIAGE_CAPTION: Record<WorkTriageState, string> = {
  needs_you: "Stopped, and cannot move until you decide something.",
  in_progress: "Juno is working on these. Nothing here is waiting on you.",
  scheduled: "Recurring work. Each one keeps its history across runs.",
  unread: "Something changed on these since you last opened them.",
  done: "Finished, for better or worse. Check the deliverable, then archive.",
  all: "Everything that has not been archived.",
};

/**
 * A session projected into the shape `matchesFilter` reads.
 *
 * Lifted verbatim from the grouping module this replaces. `href` and `title`
 * are filled honestly rather than stubbed, because a stub is what somebody
 * later reads as permission to widen this function's use.
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
 * The schedule that drives a session, if one does.
 *
 * `WorkSchedule.sessionId` is a real column and it is the single most
 * under-used fact in the Work data model: a schedule in Juno updates ONE
 * session over and over, carrying its transcript and its deliverables forward,
 * rather than spawning a fresh orphan run per fire. Every other product in this
 * category spawns the orphans. Nothing in the old UI said so — schedules lived
 * on their own page and the task list showed their sessions as ordinary
 * one-shot tasks — so a capability that is genuinely rare read as a missing
 * feature.
 */
export function scheduleFor(
  session: ClientWorkSession,
  schedules: readonly ClientWorkSchedule[]
): ClientWorkSchedule | null {
  return schedules.find((schedule) => schedule.sessionId === session.id) ?? null;
}

/**
 * Whether a row belongs under a state.
 *
 * `unread` takes the ledger rather than reading it, because this function is
 * called once per row per pill on every poll and a localStorage read in that
 * loop would be a synchronous disk hit sixty times a render.
 */
export function matchesTriage(
  session: ClientWorkSession,
  state: WorkTriageState,
  context: { scheduled: boolean; unread: boolean }
): boolean {
  const item = asRecentItem(session);
  switch (state) {
    case "all":
      return true;
    case "needs_you":
      return matchesFilter(item, "needs_attention");
    case "in_progress":
      return matchesFilter(item, "running");
    case "scheduled":
      return context.scheduled;
    case "unread":
      return context.unread;
    case "done":
      // Terminal AND not needing anybody. `host_offline` is terminal and is a
      // decision waiting on a person, which is exactly why `matchesFilter`
      // treats it as attention — a decision filed under Done is a decision
      // nobody makes.
      return isTerminalStatus(session.status) && !matchesFilter(item, "needs_attention");
  }
}

// ---------------------------------------------------------------------------
// What a row says about itself
// ---------------------------------------------------------------------------

/**
 * The persistent per-row status string.
 *
 * This is the borrowed idea the list is built around. A recents list shows a
 * title, a time and a coloured pill, which tells the reader which pile a task
 * is in and nothing about what it is waiting for; the products that do this
 * well put a literal sentence on the row — "Awaiting instructions", "PR
 * created" — so the list can be triaged without opening anything.
 *
 * Three rules, and they are what keep it from becoming decoration:
 *
 *   1. It never restates the pill. The pill says `Needs approval`; this says
 *      what the approval is holding up and for how long.
 *   2. It is an observation, never a diagnosis. Juno does not know a quiet run
 *      is stuck, so the row reports the silence and leaves the conclusion to
 *      the reader — the same rule `statusActivity` follows.
 *   3. It is written for somebody who does not work here. No status token, no
 *      terminal reason spelled as an identifier, no "executor".
 *
 * `tone` is carried separately so the row can mark urgency without the string
 * having to shout, and so nothing is encoded in colour alone: every tone has a
 * mark and a word beside it in `InboxRow`.
 */
export type RowTone = "neutral" | "live" | "attention" | "good" | "bad";

export interface RowStatus {
  line: string;
  tone: RowTone;
}

/**
 * How long a task that claims to be executing may record nothing before the row
 * mentions it.
 *
 * Ten minutes, matching `WORK_QUIET_AFTER_MS` in the vocabulary module — and it
 * imports rather than restates, because two numbers for "how long is too quiet"
 * would let the list and the task page disagree about the same run.
 */
export { WORK_QUIET_AFTER_MS } from "@/components/work/work-vocabulary";

/**
 * Plain-language failure, which is the thing nobody in this category ships.
 *
 * Every product tells a non-developer that a run "failed" and hands them a
 * stack trace or nothing at all. The one sentence that would actually help —
 * what broke, and the single next move — is what this table is for. The
 * mapping is on `terminalReason` because that is the authoritative field
 * recorded once when the run ends, rather than inferred from whatever the run
 * happened to be emitting when it died.
 *
 * Every entry names a NEXT MOVE, not just a cause. A reason with no move is a
 * apology, and the reader is left where they started.
 */
const FAILURE_LINE: Record<string, string> = {
  budget_exceeded: "Stopped at its spending limit. Raise the limit and run it again.",
  timed_out: "Ran past its time limit and was stopped. Narrow the task or raise the limit.",
  host_offline: "No Mac was awake to run it. Wake the Mac, then run it again.",
  interrupted: "The machine running it stopped reporting. Check what it changed before retrying.",
  superseded: "Replaced by a newer run of the same task.",
  cancelled: "Stopped rather than finished.",
};

/**
 * One line about what this task is waiting for.
 *
 * `outputCount` and `schedule` are optional and their absence is meaningful
 * rather than empty: the deliverable list is capped and ordered by recency, so
 * "no count" means "none were seen", which is not the claim "none were made".
 * A row never states the stronger one.
 */
export function rowStatus(
  session: ClientWorkSession,
  context: {
    outputCount?: number;
    schedule?: ClientWorkSchedule | null;
    /** The run's own terminal reason, when the list has been told one. */
    terminalReason?: string | null;
    now?: number;
  } = {}
): RowStatus {
  const { outputCount, schedule = null, terminalReason = null } = context;
  const status: WorkStatus = session.status;

  switch (status) {
    case "waiting_approval":
      return { line: "Waiting for you to allow or refuse an action.", tone: "attention" };
    case "waiting_input":
      return { line: "Juno asked you something and cannot go on until you answer.", tone: "attention" };
    case "host_offline":
      return { line: FAILURE_LINE.host_offline, tone: "attention" };
    case "draft":
      return { line: "Written but never started.", tone: "neutral" };
    case "queued":
      return { line: "Waiting to be picked up. Nothing is running yet.", tone: "neutral" };
    case "preparing":
      return { line: "Getting its inputs and permissions together.", tone: "live" };
    case "paused":
      return { line: "Paused by you. It will pick up where it stopped.", tone: "neutral" };
    case "running":
      return { line: "Working on it now.", tone: "live" };
    case "cancelled":
      return { line: FAILURE_LINE.cancelled, tone: "neutral" };
    case "interrupted":
      return { line: FAILURE_LINE.interrupted, tone: "bad" };
    case "budget_exceeded":
      return { line: FAILURE_LINE.budget_exceeded, tone: "bad" };
    case "timed_out":
      return { line: FAILURE_LINE.timed_out, tone: "bad" };
    case "failed":
      return {
        // `terminalDetail` is a sentence when the executor wrote one, and the
        // reason table is the fallback. Neither is a stack trace, and neither is
        // ever the bare word "failed" — which is the whole point.
        line:
          (terminalReason !== null ? FAILURE_LINE[terminalReason] : undefined) ??
          "Stopped before it finished. Open it to see how far it got.",
        tone: "bad",
      };
    case "completed": {
      if (schedule !== null && schedule.enabled) {
        return { line: "Finished this run. It will run again on its schedule.", tone: "good" };
      }
      if (outputCount !== undefined && outputCount > 0) {
        return {
          line: outputCount === 1 ? "Finished, with 1 file to check." : `Finished, with ${outputCount} files to check.`,
          tone: "good",
        };
      }
      return { line: "Finished.", tone: "good" };
    }
  }
}

/**
 * Whether the row's status string should be replaced by a silence report.
 *
 * Split out rather than folded into `rowStatus` because it needs the clock, and
 * a function that reads `Date.now()` cannot be called during a server render
 * without the first client render disagreeing with the HTML. The caller reads
 * the clock once per poll and passes the answer down.
 */
export function quietLine(quietMs: number): string {
  const minutes = Math.floor(quietMs / 60_000);
  if (minutes < 60) return `Nothing new recorded for ${minutes} minutes.`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "Nothing new recorded for an hour." : `Nothing new recorded for ${hours} hours.`;
}

/**
 * Whether this session can still be acted on from the list.
 *
 * Used to decide whether a row offers Run again. A live task already has
 * somewhere to go and a draft has never been dispatched, so neither takes the
 * control — offering "Run again" on something that never ran once is the kind
 * of small lie that makes a whole surface untrustworthy.
 */
export function canRunAgain(session: ClientWorkSession): boolean {
  return isTerminalStatus(session.status);
}

/**
 * Whether a session is blocked on a person right now.
 *
 * A named predicate rather than the expression inline, because it is asked in
 * four places — the pill count, the nav badge, the row mark, and the document
 * title — and four copies of it is four chances for the badge and the list to
 * disagree about how many things need you.
 */
export function needsYou(session: ClientWorkSession): boolean {
  return session.needsAttention || statusNeedsAttention(session.status);
}
