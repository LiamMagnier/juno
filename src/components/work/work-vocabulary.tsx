"use client";

import * as React from "react";
import { AlertTriangle, Ban, Cloud, Info, Laptop, ShieldAlert } from "lucide-react";
import { describeCapability, type WorkCapability, type WorkDegradation, type WorkRiskLevel, type WorkStatus } from "@/lib/work/domain";
import { humanize } from "@/components/work/work-payload";
import { cn } from "@/lib/utils";

/*
 * How Work says things.
 *
 * One module for the words and marks every Work surface shares, so the home
 * page, the thread and the sidebar cannot end up calling the same status three
 * things. The rule the file follows is the one the domain sets: a status is
 * never rendered as a bare identifier, and a state that blocks the user always
 * arrives with the sentence that explains it.
 *
 * Coral (--primary) appears here only for live state — a run that is actually
 * going. It is not used to decorate a heading or a chip border, because on this
 * page "the accent colour" has to keep meaning "this is happening now".
 */

type StatusTone = "neutral" | "live" | "attention" | "good" | "bad";

interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Sentence form, for empty states and stream stalls. Never a fragment. */
  sentence: string;
}

const STATUS_META: Record<WorkStatus, StatusMeta> = {
  draft: {
    label: "Draft",
    tone: "neutral",
    sentence: "This task has been written but never started, so nothing is running and nothing is queued.",
  },
  // "Executor" is Juno's word for the thing that claims a run, and it was in
  // this sentence for years. Nobody outside this repository knows what one is,
  // and the reader does not need to: the fact they are being told is that
  // nothing has started yet. A resumed run comes back through here too — the
  // control route puts it back to `queued` with the lease released — so the
  // sentence has to be true of a second start as well as a first, which is why
  // it says nothing about this being the beginning.
  queued: {
    label: "Queued",
    tone: "neutral",
    sentence: "Waiting to be picked up. Nothing is running yet.",
  },
  preparing: {
    label: "Preparing",
    tone: "live",
    sentence: "Fetching inputs, resolving permissions and starting up.",
  },
  running: { label: "Running", tone: "live", sentence: "Juno is working on this now." },
  waiting_input: {
    label: "Needs an answer",
    tone: "attention",
    sentence: "Juno has asked you something and cannot continue until you answer.",
  },
  waiting_approval: {
    label: "Needs approval",
    tone: "attention",
    sentence: "Juno is waiting for you to allow or refuse an action.",
  },
  paused: { label: "Paused", tone: "neutral", sentence: "You stopped this. It can be resumed." },
  completed: { label: "Done", tone: "good", sentence: "This finished." },
  // Deliberately does not say who decided. The old sentence was "The run itself
  // reported that it could not finish", which distinguished `failed` from
  // `interrupted` and `cancelled` usefully — and was flatly untrue for the most
  // common cause of it. A run killed by a provider rate limit reported nothing;
  // it was refused. Telling a user their run gave up, when a lab turned it away,
  // sends them to re-read a task that was never the problem. The specific cause
  // is carried by `terminalDetail` beside this, and since the executor started
  // classifying provider failures that detail is a sentence rather than an HTTP
  // status.
  failed: { label: "Failed", tone: "bad", sentence: "This stopped before it finished." },
  // The same correction as `failed`, one status along, and for the same reason:
  // the old sentence — "This was cancelled before it finished" — named a decision
  // that in several cases nobody made.
  //
  // `statusForTerminalReason` maps BOTH `cancelled` and `superseded` here, and
  // `superseded` is written by `recordMarkerRun` in scripts/work-scheduler.ts for
  // a scheduled fire the user's own missed-run policy told the schedule to drop.
  // That run never started, so there was nothing to cancel; the marker run is
  // also the newest attempt on its session, which is precisely the case where
  // `finishRun` does denormalise the status onto the session — so this is the
  // sentence the reader gets. Deleting a session or a schedule cancels the runs
  // under it too, which is a third actor again.
  //
  // So it says what is true of all of them — something outside the work stopped
  // it — and adds the one fact the reader acts on: `isResumableTerminalReason`
  // returns false for both reasons, so the checkpoint is dropped and a retry
  // starts from the goal rather than from where this got to.
  cancelled: {
    label: "Cancelled",
    tone: "neutral",
    sentence: "This was stopped rather than finished, and it will not be picked up where it left off.",
  },
  interrupted: {
    label: "Interrupted",
    tone: "attention",
    sentence:
      "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.",
  },
  // Two untrue clauses, both removed.
  //
  // "Went away mid-run" describes a run that was under way and lost its machine.
  // Nothing produces that. Every `host_offline` ending in the codebase comes from
  // `recordMarkerRun` — in scripts/work-scheduler.ts and scripts/work-trigger-poller.ts
  // — which creates a run and finishes it in the same breath with
  // `effectiveTarget: null` and the comment "nothing ran anywhere". The Mac was
  // unreachable when the fire came due, so the work never started at all. Telling
  // somebody their run was cut off half way sends them to check what it managed to
  // change first, which is the wrong first move for a task that did nothing.
  //
  // "Or move the task to the cloud" named a control the browser does not have. The
  // composer always requests `automatic` and Retry on the task page re-dispatches
  // without a target, so there is no per-task switch to move; the target that CAN
  // be changed belongs to the schedule, and its own editor is where that is said.
  // The sentence now offers the move that exists here.
  host_offline: {
    label: "Mac unreachable",
    tone: "attention",
    sentence: "This had to run on a Mac and none was reachable, so it did not start. Wake the Mac and run it again.",
  },
  budget_exceeded: {
    label: "Hit its limit",
    tone: "attention",
    sentence: "This stopped because it reached the ceiling set for it.",
  },
  timed_out: {
    label: "Timed out",
    tone: "attention",
    sentence: "This ran for longer than its time limit allowed and was stopped.",
  },
};

export function statusLabel(status: WorkStatus): string {
  return STATUS_META[status].label;
}

export function statusSentence(status: WorkStatus): string {
  return STATUS_META[status].sentence;
}

/**
 * How long a task that is supposed to be executing may record nothing before a
 * row says so out loud.
 *
 * `appendEvents` bumps `WorkSession.lastActivityAt` on every batch it writes, so
 * for a run in `preparing` or `running` that column is a genuine heartbeat of the
 * transcript rather than a timestamp of the last status change. Silence on it is
 * therefore real silence — but it is not by itself a fault, which is what the
 * number has to respect. A single tool call can legitimately take minutes: a
 * large fetch, a long shell command, a model thinking hard at high effort. Ten
 * minutes is well past all of those and still well short of the point where
 * somebody would have given up and reloaded the page.
 *
 * Deliberately unrelated to `RUN_LEASE_MS`. The lease is renewed on a timer by
 * the executor and says only that a process is alive; this says whether the work
 * is producing anything. A run can hold its lease perfectly while stuck.
 */
export const WORK_QUIET_AFTER_MS = 10 * 60 * 1000;

/**
 * What a task is doing right now, for a row in a list.
 *
 * `statusSentence` on its own answers "what state is this in", which the pill
 * beside it has already said. The one thing a list row can add — from the
 * session columns a list response actually carries, and without asking the
 * server for anything more — is whether a task that claims to be executing has
 * recorded anything lately. A run that has been quiet for half an hour and one
 * that wrote an event four seconds ago render identically otherwise, and they
 * are the two cases a reader most needs told apart.
 *
 * Stated as an observation and not as a diagnosis. Juno does not know that a
 * quiet run is stuck — it may be inside one long tool call — so the row reports
 * the silence and leaves the conclusion to the reader, who can open the task and
 * see. Claiming a fault here would put a red flag on a run that is working.
 *
 * Reads the clock, like `workTimeAgo`, and is safe for the same reason: it is
 * only ever called from a row that exists because a fetch resolved, which is
 * always after mount, so no server render can disagree with it.
 */
export function statusActivity(status: WorkStatus, lastActivityAt: string): string {
  const sentence = STATUS_META[status].sentence;
  if (status !== "preparing" && status !== "running") return sentence;
  const then = new Date(lastActivityAt).getTime();
  if (Number.isNaN(then)) return sentence;
  const quiet = Date.now() - then;
  if (quiet < WORK_QUIET_AFTER_MS) return sentence;
  return `${sentence} Nothing new has been recorded for ${quietFor(quiet)}.`;
}

/**
 * A silence, in the coarsest unit that still says something.
 *
 * Not `formatDuration`, which is built for how long a tool call took and renders
 * eleven minutes as "11m 4s". The seconds are meaningless at this scale and they
 * make the row look like a stopwatch on a task nobody is timing.
 */
function quietFor(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/**
 * The files a finished task left behind, counted.
 *
 * Only ever rendered for a count of one or more. There is no "no files" form on
 * purpose: the browser learns about deliverables from a list that is capped and
 * ordered by recency, so an absent count means "none were seen", which is not
 * the same claim as "none were made" — and a row is not the place to make the
 * stronger one. See `fetchWorkOutputCounts`.
 */
export function outputsLabel(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

const DOT_CLASS: Record<StatusTone, string> = {
  // Full muted-foreground, not /50. The dot is the only mark on WorkStatusDot, so
  // it is a meaningful graphical indicator and has to clear 3:1 — at 50% alpha on
  // a pure-black ground it lands near 2.6:1 and the neutral statuses lose their mark.
  neutral: "bg-muted-foreground",
  live: "bg-primary motion-safe:animate-pulse",
  attention: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

// `neutral` is `bg-secondary`, not `bg-background/50`. With --background at 0 0% 0%
// a half-alpha background fill is black over whatever it sits on, so the neutral
// pill punched a hole in its card instead of lifting off it. Secondary is the first
// rung above the ground on both themes, which is what a chip should read as.
const PILL_CLASS: Record<StatusTone, string> = {
  neutral: "border-border/70 bg-secondary text-muted-foreground",
  live: "border-primary/25 bg-primary/10 text-primary",
  attention: "border-warning/35 bg-warning/10 text-warning-foreground",
  good: "border-success/30 bg-success/10 text-success-ink",
  bad: "border-destructive/35 bg-destructive/10 text-destructive",
};

/** The status as a chip. Mono + colour, never a coloured rectangle alone. */
export function WorkStatusPill({ status, className }: { status: WorkStatus; className?: string }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-micro leading-none",
        PILL_CLASS[meta.tone],
        className
      )}
      title={meta.sentence}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[meta.tone])} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** The same fact at row density: a dot with the label only for screen readers. */
export function WorkStatusDot({ status }: { status: WorkStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="flex shrink-0 items-center" title={meta.label}>
      <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[meta.tone])} aria-hidden="true" />
      <span className="sr-only">{meta.label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------

export function WorkTargetLabel({
  target,
  hostName,
  hostUnknown = false,
  className,
}: {
  target: "cloud" | "local" | null;
  hostName?: string | null;
  /**
   * True when the run is local but the host list has not loaded, so the label
   * says "a Mac" rather than naming one. Falling back to a stored display name
   * from somewhere else would risk naming the wrong machine on an account with
   * two of them, which is worse than declining to name it at all.
   */
  hostUnknown?: boolean;
  className?: string;
}) {
  // A run that has not been placed yet says so rather than guessing at cloud:
  // guessing is how a user reads "Cloud" on a task that is about to refuse to
  // run because it needs their Mac.
  if (target === null) {
    return (
      <span className={cn("font-mono text-micro text-muted-foreground", className)}>Not placed yet</span>
    );
  }
  const Icon = target === "cloud" ? Cloud : Laptop;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-micro text-muted-foreground", className)}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {target === "cloud" ? "Cloud" : hostUnknown ? "a Mac" : (hostName ?? "Your Mac")}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Capabilities and risk
// ---------------------------------------------------------------------------

/**
 * A capability chip, phrased for a person.
 *
 * `describeCapability` is the domain's own wording and is what the Mac and the
 * phone say too. Writing a second set of labels here is how the web app ends up
 * explaining a refusal in different words from the app that refused it.
 */
export function CapabilityChip({
  capability,
  available,
}: {
  capability: WorkCapability;
  /** False renders it struck through — asked for, and not on offer. */
  available: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-micro leading-none",
        available
          ? "border-border/70 bg-secondary text-muted-foreground"
          : "border-warning/35 bg-warning/10 text-warning-foreground line-through decoration-warning/60"
      )}
      title={available ? undefined : `${describeCapability(capability)} is not available on this run.`}
    >
      {describeCapability(capability)}
    </span>
  );
}

/*
 * What the executors' tools are called, in English.
 *
 * The names are the `WorkTool.name` values registered in `JunoWorkRuntime` —
 * the same strings the relay stores as an approval's `action` — and this table
 * is the mirror of `JunoWorkVocabulary` in `native/Packages/JunoNativeKit`.
 * Keep the two in step: a tool the Mac calls "Making changes to your files" and
 * the web calls "Apply changes" is one action with two names, which is the
 * drift this whole directory's shared-vocabulary rule exists to prevent.
 *
 * `humanize` in `work-payload.ts` remains the floor for a token no build knows
 * — it sentence-cases rather than printing a symbol — but a *named* tool should
 * never reach it.
 */
const TOOL_PRESENT: Record<string, string> = {
  list_folder: "Looking through a folder",
  read_file: "Reading a file",
  search_files: "Searching your files",
  file_details: "Checking a file",
  apply_changes: "Making changes to your files",
  permanently_delete: "Deleting files for good",
  browser_control: "Using your browser",
  app_control: "Using an app on your Mac",
  screen_control: "Working on your screen",
  web_search: "Searching the web",
  web_research: "Searching the web",
  fetch_page: "Reading a web page",
  read_page: "Reading a web page",
};

const TOOL_PAST: Record<string, string> = {
  list_folder: "Looked through a folder",
  read_file: "Read a file",
  search_files: "Searched your files",
  file_details: "Checked a file",
  apply_changes: "Changed your files",
  permanently_delete: "Deleted files for good",
  browser_control: "Used your browser",
  app_control: "Used an app on your Mac",
  screen_control: "Worked on your screen",
  web_search: "Searched the web",
  web_research: "Searched the web",
  fetch_page: "Read a web page",
  read_page: "Read a web page",
};

/** The name of the thing an approval would authorise. */
const ACTION_LABEL: Record<string, string> = {
  apply_changes: "Change files",
  permanently_delete: "Delete permanently",
  browser_control: "Use your browser",
  app_control: "Use an app",
  screen_control: "Control your screen",
};

/** What a tool call is doing, as a phrase completing "Juno is …". */
export function toolPresentLabel(name: string | null | undefined): string {
  if (!name) return "Working";
  return TOOL_PRESENT[name] ?? humanize(name);
}

/** The same tool as a completed act, for a past-tense log row. */
export function toolPastLabel(name: string | null | undefined): string {
  if (!name) return "Did something";
  return TOOL_PAST[name] ?? humanize(name);
}

/** What an approval would authorise, never the raw tool token. */
export function actionLabel(name: string | null | undefined): string {
  if (!name) return "An action";
  return ACTION_LABEL[name] ?? humanize(name);
}

const RISK_LABEL: Record<WorkRiskLevel, string> = {
  safe: "Safe",
  edit: "Edits a file",
  command: "Runs a command",
  sensitive: "Sensitive",
  irreversible: "Cannot be undone",
};

export function riskLabel(risk: WorkRiskLevel): string {
  return RISK_LABEL[risk];
}

export function RiskPill({ risk }: { risk: WorkRiskLevel }) {
  const severe = risk === "irreversible" || risk === "sensitive";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-micro leading-none",
        severe
          ? "border-destructive/35 bg-destructive/10 text-destructive"
          : "border-border/70 bg-secondary text-muted-foreground"
      )}
    >
      {severe && <ShieldAlert className="h-3 w-3" aria-hidden="true" />}
      {RISK_LABEL[risk]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Saying why something cannot happen
// ---------------------------------------------------------------------------

export type NoteTone = "info" | "warning" | "blocked" | "error";

// The four tones used to be separated by fill alpha alone — muted/40, warning/5,
// warning/10, destructive/5 — which over a pure-black ground all composited to
// roughly the same 3-to-5% wash, so the one component that distinguishes "a note"
// from "this failed" stopped distinguishing them. The fills are now spread far
// enough apart to survive on black; the border alphas were already carrying the hue.
const NOTE_CLASS: Record<NoteTone, string> = {
  info: "border-border/70 bg-secondary text-muted-foreground",
  warning: "border-warning/35 bg-warning/10 text-warning-foreground",
  blocked: "border-warning/40 bg-warning/20 text-warning-foreground",
  error: "border-destructive/40 bg-destructive/15 text-destructive",
};

const NOTE_ICON: Record<NoteTone, typeof Info> = {
  info: Info,
  warning: AlertTriangle,
  blocked: Ban,
  error: AlertTriangle,
};

/**
 * The standard way Work tells the user something is not available.
 *
 * Every control that can be unavailable renders one of these instead of simply
 * greying out, because a disabled button with no sentence beside it is
 * indistinguishable from a bug. `action` is for the one thing the user could do
 * about it, and is deliberately optional: several of these states — a Mac that
 * is asleep, a cloud that is not accepting work — have no button that helps,
 * and inventing one would be worse than admitting it.
 */
export function WorkStateNote({
  tone,
  children,
  action,
  className,
}: {
  tone: NoteTone;
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const Icon = NOTE_ICON[tone];
  return (
    <div
      role={tone === "error" || tone === "blocked" ? "alert" : undefined}
      className={cn(
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-field border px-3.5 py-2.5 text-ui leading-relaxed",
        NOTE_CLASS[tone],
        className
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Every degradation on a run, one sentence each.
 *
 * Rendered as a list even when there is one, because the plural case is the
 * common one — a Mac that went offline produces both a `host_offline` and a
 * `local_portion_skipped` entry, and they say different things.
 */
export function DegradationNotes({
  degradation,
  className,
}: {
  degradation: readonly WorkDegradation[];
  className?: string;
}) {
  if (degradation.length === 0) return null;
  return (
    <ul className={cn("space-y-1.5", className)}>
      {degradation.map((entry, index) => (
        <li key={`${entry.kind}-${entry.subject ?? index}`} className="flex items-start gap-2 text-ui leading-relaxed text-warning-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0">{entry.explanation}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Numbers and time
// ---------------------------------------------------------------------------

/**
 * Compact elapsed time.
 *
 * Only ever called from a row that exists because a fetch resolved, which is
 * always after mount — the clock is never read during the first render, so SSR
 * and hydration cannot disagree about it.
 */
export function workTimeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/** A duration in the units a person would use out loud. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  // Sub-second is a real answer here, not noise. Whole-second rounding renders a
  // 240ms tool call and a 900ms one identically as "0s", on the one surface
  // whose job is to say how long things took.
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Micro-USD, the unit every Work cost column is stored in. */
export function formatMicroUsd(microUsd: number): string {
  if (!Number.isFinite(microUsd) || microUsd <= 0) return "$0.00";
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}
