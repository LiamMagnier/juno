"use client";

import * as React from "react";
import { AlertTriangle, Ban, Cloud, Info, Laptop, ShieldAlert } from "lucide-react";
import { describeCapability, type WorkCapability, type WorkDegradation, type WorkRiskLevel, type WorkStatus } from "@/lib/work/domain";
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
  queued: {
    label: "Queued",
    tone: "neutral",
    sentence: "Waiting for an executor to pick this up.",
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
  failed: { label: "Failed", tone: "bad", sentence: "The run itself reported that it could not finish." },
  cancelled: { label: "Cancelled", tone: "neutral", sentence: "This was cancelled before it finished." },
  interrupted: {
    label: "Interrupted",
    tone: "attention",
    sentence:
      "The executor stopped reporting and its lease expired. Juno does not restart an interrupted run on its own, because it may already have changed something.",
  },
  host_offline: {
    label: "Mac unreachable",
    tone: "attention",
    sentence: "The Mac this needed went away mid-run. Wake it and retry, or move the task to the cloud.",
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

const DOT_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground/50",
  live: "bg-primary motion-safe:animate-pulse",
  attention: "bg-warning",
  good: "bg-success",
  bad: "bg-destructive",
};

const PILL_CLASS: Record<StatusTone, string> = {
  neutral: "border-border/70 bg-background/50 text-muted-foreground",
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
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
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
      <span className={cn("font-mono text-[10px] text-muted-foreground", className)}>Not placed yet</span>
    );
  }
  const Icon = target === "cloud" ? Cloud : Laptop;
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground", className)}>
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
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        available
          ? "border-border/70 bg-background/50 text-muted-foreground"
          : "border-warning/35 bg-warning/10 text-warning-foreground line-through decoration-warning/60"
      )}
      title={available ? undefined : `${describeCapability(capability)} is not available on this run.`}
    >
      {describeCapability(capability)}
    </span>
  );
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
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] leading-none",
        severe
          ? "border-destructive/35 bg-destructive/10 text-destructive"
          : "border-border/70 bg-background/50 text-muted-foreground"
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

const NOTE_CLASS: Record<NoteTone, string> = {
  info: "border-border/70 bg-muted/40 text-muted-foreground",
  warning: "border-warning/35 bg-warning/5 text-warning-foreground",
  blocked: "border-warning/40 bg-warning/10 text-warning-foreground",
  error: "border-destructive/40 bg-destructive/5 text-destructive",
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
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed",
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
        <li key={`${entry.kind}-${entry.subject ?? index}`} className="flex items-start gap-2 text-[13px] leading-relaxed text-warning-foreground">
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
