/**
 * Deciding when to interrupt someone about a Work task, and when not to.
 *
 * A Work run outlives the tab that started it, so the user is usually not
 * looking. That makes notification a correctness feature rather than a
 * courtesy: a run that stops to ask a question and never says so is a run that
 * sits in `waiting_input` until its approval expires, and from the user's side
 * it simply never finished.
 *
 * It also makes over-notification a real cost. A scheduled task that fires
 * hourly and reports every completion trains its owner to ignore the channel,
 * and the one message that mattered — an approval, a host that went away
 * mid-batch — arrives in a stream they have already stopped reading. So the
 * decision is explicit, per transition, and defaults to silence for anything
 * that does not need a person.
 *
 * The dispatch half is deliberately thin. Juno already has an email sender with
 * its own opt-in flags, and the native clients already have a wakeup channel
 * (the account change feed at /api/v1/changes/stream). This module decides
 * WHETHER and WHAT; it does not invent a fourth delivery mechanism.
 *
 * Free of `server-only` and Prisma so the decision table can be tested on its
 * own, which is the only part with any behaviour worth pinning.
 */

import {
  statusNeedsAttention,
  type WorkStatus,
  type WorkTerminalReason,
} from "@/lib/work/domain";

/** What a schedule (or a session) asks for. Mirrors WorkSchedule.notifyPolicy. */
export const WORK_NOTIFY_POLICIES = ["none", "on_finish", "on_attention", "all"] as const;
export type WorkNotifyPolicy = (typeof WORK_NOTIFY_POLICIES)[number];

/**
 * How loudly one notification should arrive.
 *
 * Separate from the policy because they answer different questions: the policy
 * is what the user asked for, and the urgency is what actually happened. A
 * blocked run and a finished one can both be permitted by `all` and still
 * deserve different treatment on a lock screen.
 */
export const WORK_NOTIFY_URGENCIES = ["blocking", "informational"] as const;
export type WorkNotifyUrgency = (typeof WORK_NOTIFY_URGENCIES)[number];

export interface WorkNotifyTransition {
  status: WorkStatus;
  terminalReason?: WorkTerminalReason | null;
  policy: WorkNotifyPolicy;
  /** True when the run was started by a person who may still be watching. */
  attended: boolean;
  /**
   * Whether this exact thing has already been notified.
   *
   * Passed in rather than looked up so the decision stays pure. The caller
   * derives it from the audit log; see `notificationKey` for the shape that
   * makes "this exact thing" precise.
   */
  alreadyNotified: boolean;
}

export type WorkNotifyDecision =
  | { notify: false; reason: string }
  | { notify: true; urgency: WorkNotifyUrgency; reason: string };

/**
 * Whether a transition is worth telling the user about.
 *
 * Ordered so the strongest reason wins. Attention beats policy: a run that is
 * blocked on a person cannot progress without them, and a `notifyPolicy` of
 * `none` is a preference about noise, not an instruction to let a task hang
 * silently for ever. That is the one place this function deliberately overrides
 * what the user asked for, and it is worth being explicit that it does.
 */
export function decideNotification(input: WorkNotifyTransition): WorkNotifyDecision {
  if (input.alreadyNotified) {
    return { notify: false, reason: "This has already been notified." };
  }

  // A superseded run lands in `cancelled`, and nobody cancelled it — a newer
  // attempt for the same session took over. Left to the table below, `on_finish`
  // would send "your task was stopped" about a task that is still running, which
  // is not merely noise but the opposite of what happened. This is the one place
  // `terminalReason` carries information `status` cannot: the two ways into
  // `cancelled` need different treatment and the status column cannot tell them
  // apart.
  if (input.terminalReason === "superseded") {
    return { notify: false, reason: "A newer attempt took this over; the task is still going." };
  }

  const blocking = statusNeedsAttention(input.status);

  if (blocking) {
    // `none` is honoured for everything except this. A user who silenced a
    // schedule still needs to know it is waiting for them, or the schedule
    // simply stops working and nothing says why.
    if (input.policy === "none") {
      return {
        notify: true,
        urgency: "blocking",
        reason: "The task cannot continue without you, which no notification preference silences.",
      };
    }
    return {
      notify: true,
      urgency: "blocking",
      reason: "The task is waiting for you.",
    };
  }

  switch (input.policy) {
    case "none":
      return { notify: false, reason: "Notifications are off for this task." };
    case "on_attention":
      return {
        notify: false,
        reason: "This task only notifies when it needs you, and it does not.",
      };
    case "on_finish":
      if (isFinished(input.status)) {
        return { notify: true, urgency: "informational", reason: "The task finished." };
      }
      return { notify: false, reason: "This task only notifies when it finishes." };
    case "all":
      // An attended run is one the user is plausibly looking at right now, and
      // a notification for something already on their screen is noise.
      if (input.attended && !isFinished(input.status)) {
        return { notify: false, reason: "You are watching this task." };
      }
      return { notify: true, urgency: "informational", reason: "This task notifies on every change." };
  }
}

function isFinished(status: WorkStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "host_offline" ||
    status === "budget_exceeded" ||
    status === "timed_out"
  );
}

/**
 * What to say when the number of tasks waiting on the reader goes UP.
 *
 * ── Why a rise, and not a count ─────────────────────────────────────────────
 *
 * The web app has always had the number — a dot on the switch, a pill in the
 * inbox, an unread ledger — and a number that is quietly two instead of one is
 * a notification nobody receives. It has to be the change that speaks, because
 * the change is the new information; the count is already on screen.
 *
 * Only upwards, and never on the first reading. A count that FALLS is the
 * reader answering something, which needs no announcement, and the first
 * reading has no previous value to have risen from — announcing it would
 * greet every page load with "a task needs you" about tasks that have been
 * waiting since yesterday.
 *
 * ── Why it does not consult the decision table above ────────────────────────
 *
 * `decideNotification` answers a different question with different evidence: it
 * is given one run's transition, that run's policy and whether it has already
 * been told, and it decides whether to interrupt somebody who is elsewhere.
 * This is a reader who is demonstrably here, looking at the app, and the
 * question is only whether to say out loud what the interface has just started
 * showing. Running a per-run policy over a per-account count would be answering
 * with evidence it does not have — and `none` means "do not email me", not "do
 * not update the screen I am looking at".
 */
export function describeNeedsYouRise(previous: number | null, next: number | null): string | null {
  if (previous === null || next === null) return null;
  if (next <= previous) return null;
  const added = next - previous;
  const what = added === 1 ? "A task needs you" : `${added} tasks need you`;
  return next === added ? what : `${what} — ${next} in total`;
}

/**
 * The identity of "this exact thing", for deduplication.
 *
 * Keyed on the run and the specific event rather than on the session, because a
 * session legitimately blocks several times — one approval, then a question,
 * then another approval — and a session-level key would notify once and then go
 * quiet for the rest of the task. Keyed on the approval or question id rather
 * than on the status, because a run can re-enter `waiting_approval` for a
 * genuinely different action and that is a new thing to say.
 */
export function notificationKey(runId: string, subject: string): string {
  return `${runId}:${subject}`;
}

export interface WorkNotifyMessage {
  subject: string;
  /** One sentence, written for a lock screen. */
  summary: string;
  /** What the user can do about it, when there is something. */
  action: string | null;
}

/**
 * The words.
 *
 * Written per state rather than assembled from a template, because a sentence
 * built by concatenation is how a user ends up reading "Your task Organise
 * Downloads is host_offline". The states are few and each deserves its own
 * plain sentence.
 */
export function describeNotification(input: {
  title: string;
  status: WorkStatus;
  terminalReason?: WorkTerminalReason | null;
  hostName?: string | null;
  question?: string | null;
  approvalSummary?: string | null;
}): WorkNotifyMessage {
  const title = input.title.trim() || "Your Juno task";

  switch (input.status) {
    case "waiting_input":
      return {
        subject: `${title} has a question`,
        summary: input.question?.trim() || "Juno needs an answer before it can carry on.",
        action: "Answer to continue",
      };
    case "waiting_approval":
      return {
        subject: `${title} needs your approval`,
        summary:
          input.approvalSummary?.trim() || "Juno is waiting for you to approve one action.",
        action: "Review and decide",
      };
    case "host_offline":
      return {
        subject: `${title} stopped: ${input.hostName ?? "your Mac"} is not reachable`,
        summary:
          `Juno could not finish because it needs ${input.hostName ?? "your Mac"}, ` +
          "and the parts that need it did not run.",
        action: "Wake the Mac and retry, or move the task to the cloud",
      };
    case "completed":
      return {
        subject: `${title} is done`,
        summary: "Juno finished the task and the result is ready.",
        action: "Open the result",
      };
    case "failed":
      return {
        subject: `${title} did not finish`,
        summary: "Juno stopped because something went wrong. Nothing further was attempted.",
        action: "See what happened",
      };
    case "budget_exceeded":
      return {
        subject: `${title} reached its limit`,
        summary: "Juno stopped at the ceiling set for this task rather than spending past it.",
        action: "Raise the limit and retry, or leave it",
      };
    case "timed_out":
      return {
        subject: `${title} ran out of time`,
        summary: "Juno stopped at the runtime limit set for this task.",
        action: "Raise the limit and retry, or leave it",
      };
    case "interrupted":
      return {
        subject: `${title} was interrupted`,
        summary:
          "The machine running this task stopped reporting. Juno did not restart it on its own, " +
          "because it may already have changed something.",
        action: "Review what it did, then retry if you want to",
      };
    case "cancelled":
      return {
        subject: `${title} was stopped`,
        summary: "This task was stopped before it finished.",
        action: null,
      };
    default:
      return {
        subject: `${title} is ${readableStatus(input.status)}`,
        summary: "Juno is working on this task.",
        action: null,
      };
  }
}

/** A status a person can read, for the fallback branch above. */
function readableStatus(status: WorkStatus): string {
  switch (status) {
    case "draft":
      return "a draft";
    case "queued":
      return "waiting to start";
    case "preparing":
      return "getting ready";
    case "running":
      return "running";
    case "paused":
      return "paused";
    default:
      return status.replace(/_/g, " ");
  }
}
