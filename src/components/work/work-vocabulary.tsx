"use client";

import * as React from "react";
import { Ban, Cloud, Laptop, type IconComponent } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { describeCapability, type WorkCapability, type WorkDegradation, type WorkRiskLevel, type WorkStatus } from "@/lib/work/domain";
/*
 * The tone union is imported rather than declared here, because the sidebar
 * now draws this same mark for a Code run as well as for a Work session and
 * the two vocabularies had five identical meanings under ten different names.
 * The names below won; the file they live in is pure, so the join that picks a
 * tone can be tested without a DOM.
 */
import type { StatusTone } from "@/lib/conversation-status";
import { humanize } from "@/components/work/work-payload";
import { cn } from "@/lib/utils";
import { PhaseOrb } from "@/components/effects/phase-orb";

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
  // "the ceiling set for it" was true while a run carried a per-run ceiling of
  // its own. It does not any more: what stops a run is the account's rolling
  // usage window, which is a wait rather than a setting to go and change. The
  // run's own `terminalDetail` names which window and when it frees up; this
  // sentence is what a reader gets before they open it, so it has to point in
  // the right direction rather than at a ceiling nobody can find.
  //
  // It stays NEUTRAL about the cause for the same reason. "Run it again once
  // the usage limit frees up" is true only when the account's window was the
  // binding ceiling — a run stopped by a schedule's own figure, or by the
  // backstop an account with metering switched off gets, would show the same
  // sentence, and waiting would not help. The detail knows which; this does not.
  budget_exceeded: {
    label: "Out of budget",
    tone: "attention",
    sentence: "This stopped because it reached the budget it was running under. The detail on the attempt says which ceiling it was, and when it frees up.",
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

/**
 * `actor` names who is doing the work when it is not Juno in general — an
 * agent's name on its own page and in its thread (docs/design/AGENTS.md). Only
 * a sentence that OPENS with "Juno" is re-voiced; the others do not name an
 * actor at all.
 */
export function statusSentence(status: WorkStatus, actor?: string | null): string {
  const sentence = STATUS_META[status].sentence;
  return actor && sentence.startsWith("Juno ") ? `${actor}${sentence.slice("Juno".length)}` : sentence;
}

/**
 * The tone a status paints in, for a caller that draws its own mark — the
 * sidebar row, which puts the dot inside the `size-4` slot its hollow bullet
 * already occupies rather than beside it. Reading it from here is what keeps
 * one status from being coral in the transcript and amber in the panel.
 */
export function statusTone(status: WorkStatus): StatusTone {
  return STATUS_META[status].tone;
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

/*
 * STATUS AS WORDS (owner directive, 2026-09-26).
 *
 * Every Work status used to be a tinted, bordered pill with a leading dot, the
 * live one pulsing coral. On a status that is simply normal or under way that
 * is decoration shouting "look here", and the owner called it what it reads
 * as. So:
 *
 *  - neutral, live, good: muted words. A live status adds a Thinking orb on
 *    the text line, which says "under way" without a pinging pip.
 *  - attention, bad: the status's ink and a small mark, still no container.
 *
 * The mono voice stays, so a status still reads as a machine fact.
 */
const TEXT_CLASS: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  live: "text-muted-foreground",
  attention: "font-medium text-warning-foreground",
  good: "text-muted-foreground",
  bad: "font-medium text-destructive",
};

/**
 * The shape every Work status and tag shares: a run of words, no box.
 *
 * Hoisted because it was written out six times (the status, the risk, the
 * capability, the host state, and the inline "Paused" / "Off" / "Work off"
 * facts in the schedule, skill and host rows), and a row that sets two of
 * them side by side must not have them drift apart.
 */
const PILL_SHAPE = "inline-flex shrink-0 items-center gap-1.5 font-mono text-micro leading-none";

/** The mark in front of a status's words, or nothing for a quiet state. */
function StatusMark({ tone }: { tone: StatusTone }) {
  if (tone === "attention") return <StatusIcons.warning className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "bad") return <StatusIcons.error className="size-3 shrink-0" aria-hidden="true" />;
  if (tone === "live") return <PhaseOrb state="working" className="-my-1.5 -ml-1" />;
  return null;
}

/** The status as words. Mono and, only when it needs the reader, colour. */
export function WorkStatusPill({
  status,
  describe = true,
  className,
}: {
  status: WorkStatus;
  /**
   * Whether the status sentence rides along as the tooltip. On by default,
   * because in a list row these words are the only word about the state and
   * the sentence is worth a hover. The task header prints that same sentence
   * immediately after, so there the tooltip would cover the text it repeated,
   * and that call site turns it off.
   */
  describe?: boolean;
  className?: string;
}) {
  const meta = STATUS_META[status];
  return (
    <span className={cn(PILL_SHAPE, TEXT_CLASS[meta.tone], className)} title={describe ? meta.sentence : undefined}>
      <StatusMark tone={meta.tone} />
      {meta.label}
    </span>
  );
}

/**
 * A plain fact about a row, as a chip: "Paused", "Off", "Work off", "/slug".
 *
 * The three list rows each drew this by hand at exactly the same eleven classes,
 * which is the same neutral tone `WorkStatusPill` already had a name for. It is
 * deliberately toneless — a schedule that is paused and a skill that is switched
 * off are states the user chose, not warnings — so it never takes colour. A row
 * that needs to say something is WRONG reaches for the status pill or
 * `WorkStateNote`, both of which carry an argument for their hue.
 */
export function WorkTag({
  icon: Icon,
  className,
  children,
}: {
  icon?: IconComponent;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn(PILL_SHAPE, TEXT_CLASS.neutral, className)}>
      {/* `size-3`, the bottom rung of the ladder and the size `RiskPill` beside
          it already uses; at 12px the set draws its bold cut on its own.
          `motion="none"`: a tag's glyph is a label, and a tag often sits inside
          a row's link, so the glyph's own hover gesture would play every time
          the row is hovered (ICONS_AND_MOTION.md §1.3). */}
      {Icon && <Icon motion="none" className="size-3" aria-hidden="true" />}
      {children}
    </span>
  );
}

/**
 * A row's state for a screen reader, and nothing visible (it was a toned 6px
 * dot). The row-density mark.
 *
 * Exported by tone rather than by `WorkStatus` because the sidebar draws it for
 * a Code run too, and Code's states are not Work's. The tones, the classes and
 * the 3:1 argument above them are the same for both — which is the whole reason
 * the sidebar can be one component with a `product` prop rather than two.
 */
export function StatusDot({ tone: _tone, label, title }: { tone: StatusTone; label: string; title?: string }) {
  // NO VISIBLE PIP any more (owner directive, 2026-09-26): coloured dots
  // beside row titles read as decoration. A row that needs the reader is set
  // in full ink at medium weight by its caller; this keeps the one thing the
  // dot did that a title cannot, the words for a screen reader.
  return (
    <span className="sr-only" title={title}>
      {label}
    </span>
  );
}

/** The same fact at row density: a dot with the label only for screen readers. */
export function WorkStatusDot({ status }: { status: WorkStatus }) {
  const meta = STATUS_META[status];
  return <StatusDot tone={meta.tone} label={meta.label} title={meta.label} />;
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
      <Icon className="size-3" aria-hidden="true" />
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
        PILL_SHAPE,
        available
          ? TEXT_CLASS.neutral
          : "text-warning-foreground line-through decoration-warning/60"
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
  // `browser` is the cloud's own headless page; `browser_control` is the Mac
  // driving the browser you are signed into. Two capabilities, two sentences.
  browser: "Using a web page",
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
  browser: "Used a web page",
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
  browser: "Use a web page",
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
    <span className={cn(PILL_SHAPE, severe ? TEXT_CLASS.bad : TEXT_CLASS.neutral)}>
      {severe && <StatusIcons.security className="size-3" aria-hidden="true" />}
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

/*
 * A glyph per tone, and — since this change — four glyphs for four tones.
 *
 * `warning` and `error` were both the triangle, so the component whose entire
 * job is to make "something needs your attention" and "this failed" tell apart
 * distinguished them by a fill alpha and nothing else. The registry has drawn
 * the line for the whole product since it was written: a TRIANGLE is a warning,
 * a CIRCLE is a failure, and `CodeIcons.error` has used the circle since Juno
 * Code shipped. Work was the surface still using the triangle for both.
 */
const NOTE_ICON: Record<NoteTone, IconComponent> = {
  info: StatusIcons.info,
  warning: StatusIcons.warning,
  blocked: Ban,
  error: StatusIcons.error,
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
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
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
          <StatusIcons.warning className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
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
