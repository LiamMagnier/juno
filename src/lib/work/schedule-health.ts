/**
 * Whether a routine is working, in words a person can act on.
 *
 * A routine's row used to say "last ran 2 hours ago" whatever that run did, and
 * nothing at all about its trigger. So a routine whose email trigger had been
 * failing for a week on an expired iCloud password, or whose last three runs
 * failed, or whose run was parked waiting for an approval nobody would see,
 * looked exactly as healthy as one that worked. The poller always recorded why
 * it could not read a source (`WorkTrigger.lastPollError`) and the runs always
 * recorded how they ended; nothing put the two in front of the person.
 *
 * This module decides, from those rows, ONE state per routine, the words for
 * it, and the one fix the row offers (reconnect the app, answer the run, see
 * what happened). It also decides when a trigger failure is worth a
 * notification: once, on the first failure after a success, never on every
 * retry.
 *
 * Pure and client-safe: rows in, a decision out, its clock an argument.
 */

import { PRODUCT_NAME } from "@/lib/brand/names";
import { workStatusForCodeTask } from "@/lib/work/code-routine";
import { isTerminalStatus } from "@/lib/work/domain";

/** How long an unattended routine run may stay parked for an answer (store.ts `PARKED_ROUTINE_RUN_TTL_MS`). */
export const PARKED_RUN_TTL_MS = 24 * 60 * 60 * 1000;

/** The sentence `expireParkedRoutineRuns` ends a parked run with, matched by its opening words. */
const PARKED_EXPIRY_PREFIX = "Stopped after waiting 24 hours";

/** How many recent runs are read to count a streak of failures. */
export const HEALTH_RUN_WINDOW = 5;

export const SCHEDULE_HEALTH_STATES = [
  "healthy",
  "never_run",
  "running",
  "waiting",
  "failing",
  /** The last fire never ran: the budget was spent, or its Mac was offline. */
  "skipped",
  "source_error",
  "paused",
] as const;
export type ScheduleHealthState = (typeof SCHEDULE_HEALTH_STATES)[number];

/** How a dot is coloured: calm, live, needs you, broken. */
export type ScheduleHealthTone = "ok" | "live" | "attention" | "error" | "quiet";

export type ScheduleHealthAction =
  /** Opens the connector so its credentials can be renewed. */
  | { kind: "reconnect"; href: string; label: string }
  /** Opens the routine's task, where the run's question or approval waits. */
  | { kind: "answer"; href: string; label: string }
  /** Opens the routine's task at the run that went wrong. */
  | { kind: "open_run"; href: string; label: string }
  /** Opens the routine's editor: a trigger this build cannot serve, a Mac that is never on. */
  | { kind: "edit"; href: string; label: string }
  /** Opens Plan & usage, for a fire skipped because the budget was spent. */
  | { kind: "usage"; href: string; label: string };

export interface ClientScheduleHealth {
  state: ScheduleHealthState;
  tone: ScheduleHealthTone;
  /** Two or three words for the row: "Healthy", "Can’t read mail", "Last run failed". */
  label: string;
  /** One sentence: what happened and what it means. Null when the label says it all. */
  detail: string | null;
  action: ScheduleHealthAction | null;
  lastRun: {
    id: string;
    status: string;
    terminalReason: string | null;
    finishedAt: string | null;
  } | null;
  /** Unbroken failures, newest first, within the last `HEALTH_RUN_WINDOW` runs. */
  consecutiveFailures: number;
  /** When a parked run waiting on the person is ended unanswered, if one is. */
  waitingExpiresAt: string | null;
}

/** The run columns a health decision reads. */
export interface HealthRunRow {
  id: string;
  status: string;
  terminalReason: string | null;
  terminalDetail: string | null;
  pauseReason: string | null;
  origin: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  /**
   * When an executor picked it up. Null on the scheduler's record of a fire
   * that never ran (scripts/work-scheduler.ts `recordMarkerRun`), which is how
   * "skipped" is told from "failed". Absent when the reader did not select it.
   */
  startedAt?: Date | null;
  /** Where this run opens, when not the routine's own task (a Code routine's runs). */
  href?: string | null;
}

/** The trigger columns a health decision reads. */
export interface HealthTriggerRow {
  kind: string;
  enabled: boolean;
  lastPolledAt: Date | null;
  lastPollError: string | null;
}

const LIVE_RUN = new Set(["queued", "preparing", "running"]);
const WAITING_RUN = new Set(["waiting_input", "waiting_approval"]);
const FAILED_REASONS = new Set(["failed", "interrupted", "timed_out", "budget_exceeded", "host_offline"]);

/** The connector a trigger reads, for the Reconnect link. Mirrors `TRIGGER_SOURCE_CONNECTORS`. */
const SOURCE_CONNECTOR: Record<string, string> = {
  email_filter: "apple-mail",
  calendar_window: "apple-calendar",
};

const SOURCE_LABEL: Record<string, string> = {
  email_filter: "Can’t read mail",
  calendar_window: "Can’t read your calendar",
  topic_monitor: "Can’t check the topic",
};

/** The connections page, scrolled to one connector (connector-directory.tsx `tileAnchor`). */
export function connectorHref(connectorId: string): string {
  return `/connections#connector-${connectorId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * A poll error as a reader may see it. The poller writes sentences for people,
 * but older ones still name the codename; the product name is what is shown.
 * Never longer than a sentence or two.
 */
export function pollErrorForClient(message: string | null | undefined): string | null {
  if (!message) return null;
  const cleaned = message.replace(/\bJuno\b/g, PRODUCT_NAME).replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > 280 ? `${cleaned.slice(0, 279).trimEnd()}…` : cleaned;
}

/** Whether this run ended because a parked run waited a day for an answer. */
export function isParkedExpiry(run: Pick<HealthRunRow, "terminalReason" | "terminalDetail">): boolean {
  return run.terminalReason === "interrupted" && (run.terminalDetail ?? "").startsWith(PARKED_EXPIRY_PREFIX);
}

function isFailure(run: HealthRunRow): boolean {
  return run.status !== "completed" && run.terminalReason !== null && FAILED_REASONS.has(run.terminalReason);
}

/**
 * A fire the scheduler wrote down as never having run: budget spent, or the
 * Mac it needs was offline. Not a failure of the work, and not fixed the same
 * way, so it is said differently.
 */
export function isSkippedFire(run: Pick<HealthRunRow, "terminalReason" | "startedAt">): boolean {
  return run.startedAt === null && (run.terminalReason === "budget_exceeded" || run.terminalReason === "host_offline");
}

function isUnattended(origin: string): boolean {
  return origin === "schedule" || origin === "trigger";
}

function failureWords(run: HealthRunRow): { label: string; detail: string } {
  if (isParkedExpiry(run)) {
    return {
      label: "Last run stopped unanswered",
      detail: "It waited 24 hours for an answer or approval that never came, so it was stopped and the next runs carry on.",
    };
  }
  switch (run.terminalReason) {
    case "budget_exceeded":
      return { label: "Last run hit its budget", detail: "It stopped at this routine’s spending limit before finishing." };
    case "timed_out":
      return { label: "Last run ran out of time", detail: "It stopped at its time limit before finishing." };
    case "host_offline":
      return { label: "Last run couldn’t reach the Mac", detail: "The Mac it runs on was offline." };
    case "interrupted":
      return { label: "Last run was interrupted", detail: "It stopped partway through and did not finish." };
    default:
      return { label: "Last run failed", detail: "It did not finish." };
  }
}

/** The scheduler's own sentence for a skipped fire, when it left one a person can read. */
function skipDetail(run: HealthRunRow, fallback: string): string {
  return pollErrorForClient(run.terminalDetail) ?? fallback;
}

/**
 * One routine's health. The order is the order a person needs things in:
 * something they must fix (a trigger that cannot read its source), something
 * waiting on them (a parked run, and when it will be given up on), runs that
 * are failing, then the calm states.
 */
export function scheduleHealth(input: {
  scheduleId: string;
  sessionId: string;
  enabled: boolean;
  triggers: readonly HealthTriggerRow[];
  /** Newest first, at most `HEALTH_RUN_WINDOW`. */
  runs: readonly HealthRunRow[];
  now: Date;
}): ClientScheduleHealth {
  const taskHref = `/work/${input.sessionId}`;
  const runHref = (run: HealthRunRow) => run.href ?? taskHref;
  const newest = input.runs[0] ?? null;
  let consecutiveFailures = 0;
  for (const run of input.runs) {
    if (LIVE_RUN.has(run.status) || WAITING_RUN.has(run.status) || run.status === "paused") continue;
    if (isFailure(run)) consecutiveFailures += 1;
    else break;
  }
  const lastRun = newest
    ? {
        id: newest.id,
        status: newest.status,
        terminalReason: newest.terminalReason,
        finishedAt: newest.finishedAt?.toISOString() ?? null,
      }
    : null;
  const base = { lastRun, consecutiveFailures, waitingExpiresAt: null as string | null };

  if (!input.enabled) {
    return { ...base, state: "paused", tone: "quiet", label: "Paused", detail: null, action: null };
  }

  const broken = input.triggers.find((trigger) => trigger.enabled && pollErrorForClient(trigger.lastPollError) !== null);
  if (broken) {
    const connector = SOURCE_CONNECTOR[broken.kind];
    const unservable = broken.kind === "connector_event" || broken.kind === "folder_change";
    if (isTransientPollError(broken.lastPollError)) {
      // A read the poller will retry by itself: said, but not as a broken app
      // with a Reconnect that would send the person to fix something that works.
      return {
        ...base,
        state: "source_error",
        tone: "attention",
        label: "Couldn’t check its trigger",
        detail: pollErrorForClient(broken.lastPollError),
        action: null,
      };
    }
    return {
      ...base,
      state: "source_error",
      tone: "error",
      label: SOURCE_LABEL[broken.kind] ?? "Can’t check its trigger",
      detail: pollErrorForClient(broken.lastPollError),
      action: connector
        ? { kind: "reconnect", href: connectorHref(connector), label: "Reconnect" }
        : unservable
          ? { kind: "edit", href: `/automations/${input.scheduleId}`, label: "Change trigger" }
          : null,
    };
  }

  const waiting = input.runs.find(
    (run) => WAITING_RUN.has(run.status) || (run.status === "paused" && run.pauseReason === "waiting")
  );
  if (waiting) {
    const parked = waiting.status === "paused" && isUnattended(waiting.origin);
    const expires = parked ? new Date(waiting.updatedAt.getTime() + PARKED_RUN_TTL_MS) : null;
    return {
      ...base,
      state: "waiting",
      tone: "attention",
      label: "Waiting for you",
      detail: parked
        ? "Its run stopped to ask you something. If nobody answers, it is stopped after a day so the next runs aren’t held up."
        : "Its run stopped to ask you something.",
      action: { kind: "answer", href: runHref(waiting), label: "Answer" },
      waitingExpiresAt: expires && expires.getTime() > input.now.getTime() ? expires.toISOString() : null,
    };
  }

  if (newest && LIVE_RUN.has(newest.status)) {
    return { ...base, state: "running", tone: "live", label: "Running now", detail: null, action: null };
  }
  if (newest && newest.status === "paused") {
    // Paused by a person, from a card or another device: it waits for them.
    return {
      ...base,
      state: "waiting",
      tone: "attention",
      label: "Run paused",
      detail: "Its run was paused and waits for you to resume or stop it.",
      action: { kind: "answer", href: runHref(newest), label: "Open" },
    };
  }

  if (newest && isFailure(newest) && isSkippedFire(newest)) {
    const streak = consecutiveFailures > 1 ? ` The last ${consecutiveFailures} didn’t run or finish.` : "";
    if (newest.terminalReason === "budget_exceeded") {
      return {
        ...base,
        state: "skipped",
        tone: "attention",
        label: "Last run skipped: budget used up",
        detail: `${skipDetail(newest, "It didn’t start because the budget available to it was used up.")}${streak}`,
        action: { kind: "usage", href: "/settings?section=billing", label: "See usage" },
      };
    }
    return {
      ...base,
      state: "skipped",
      tone: "attention",
      label: "Last run skipped: Mac offline",
      detail: `${skipDetail(newest, "The Mac it runs on was offline, so it didn’t start.")}${streak}`,
      action: { kind: "edit", href: `/automations/${input.scheduleId}`, label: "Change where it runs" },
    };
  }

  if (newest && isFailure(newest)) {
    const words = failureWords(newest);
    const streak = consecutiveFailures > 1 ? ` The last ${consecutiveFailures} runs didn’t finish.` : "";
    return {
      ...base,
      state: "failing",
      tone: "error",
      label: words.label,
      detail: `${words.detail}${streak}`,
      action: { kind: "open_run", href: runHref(newest), label: "See what happened" },
    };
  }

  if (!newest) {
    return { ...base, state: "never_run", tone: "quiet", label: "Not run yet", detail: null, action: null };
  }
  return { ...base, state: "healthy", tone: "ok", label: "Healthy", detail: null, action: null };
}

/**
 * A Code routine's run in the shape health reads, through the same status
 * translation the routine's history list uses (`workStatusForCodeTask`). It
 * opens in its own conversation, as that list links it.
 */
export function codeTaskAsHealthRun(task: {
  id: string;
  status: string;
  conversationId: string | null;
  runnerClaimedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): HealthRunRow {
  const status = workStatusForCodeTask(task.status);
  const finished = isTerminalStatus(status);
  return {
    id: task.id,
    status,
    terminalReason: finished ? status : null,
    terminalDetail: null,
    pauseReason: null,
    origin: "schedule",
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: finished ? task.updatedAt : null,
    // Never "skipped": a Code run that exists was started.
    startedAt: task.runnerClaimedAt ?? task.createdAt,
    href: task.conversationId ? `/chat/${task.conversationId}` : "/code",
  };
}

// ---------------------------------------------------------------------------
// Telling the person, once
// ---------------------------------------------------------------------------

/**
 * Whether a poll result is worth a notification: the first failure after the
 * trigger last read its source fine (or had never been polled). A trigger that
 * keeps failing is retried every few minutes, and a notification per retry
 * would teach its owner to ignore the one channel that tells them.
 */
export function shouldNotifyTriggerFailure(previousError: string | null, nextError: string | null): boolean {
  // A blip the poller retries on its own ("… It will try again shortly.") is
  // not worth a high-priority push telling somebody to reconnect an app that
  // is fine, and it must not use up the one notice either: a real failure
  // that follows a blip is still the first one worth saying.
  if (nextError === null || isTransientPollError(nextError)) return false;
  return previousError === null || isTransientPollError(previousError);
}

/**
 * The closing words of the poller's own sentences for a failure it expects to
 * clear by itself (scripts/work-trigger-poller.ts: an unexpected read error, a
 * tick that could not settle). Everything else it writes names a cause the
 * person can act on.
 */
const TRANSIENT_POLL_ERROR_SUFFIX = "It will try again shortly.";

export function isTransientPollError(message: string | null | undefined): boolean {
  return typeof message === "string" && message.trim().endsWith(TRANSIENT_POLL_ERROR_SUFFIX);
}

/** The notification for a trigger that has just started failing. */
export function triggerFailureNotice(input: {
  scheduleId: string;
  scheduleName: string;
  triggerKind: string;
  error: string;
}): { title: string; body: string; path: string; connectorId: string | null } {
  const name = input.scheduleName.trim() || "A routine";
  const what =
    input.triggerKind === "email_filter"
      ? "can’t read your mail"
      : input.triggerKind === "calendar_window"
        ? "can’t read your calendar"
        : "can’t check its trigger";
  const connectorId = SOURCE_CONNECTOR[input.triggerKind] ?? null;
  const reason = pollErrorForClient(input.error) ?? "";
  return {
    title: `“${name}” ${what}`,
    body: connectorId
      ? `${reason} It won’t start until it can read it again. Reconnect to keep it running.`.trim()
      : `${reason} It won’t start until this is fixed.`.trim(),
    path: `/automations/${input.scheduleId}`,
    connectorId,
  };
}
