"use client";

import * as React from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  CircleDashed,
  FileText,
  Link2,
  Loader2,
  MessageSquare,
  Minus,
  PauseCircle,
  PlayCircle,
  ShieldAlert,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { ClientWorkEvent } from "@/lib/work/serializers";
import type { WorkEventKind } from "@/lib/work/domain";
import {
  bool,
  count,
  humanize,
  num,
  prose,
  readEvent,
  str,
  type Payload,
} from "@/components/work/work-payload";
import { formatDuration } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * The plan, the activity, and the thing Juno is doing right now.
 *
 * Everything here is derived from the event stream rather than from a second
 * server-side projection, so the feed and the resume cursor can never disagree
 * about what has happened. Payloads are read through work-payload.ts, which is
 * where the two executors' shapes are reconciled and where the reason they
 * differ is written down.
 *
 * The feed is the point of the surface. A status word tells the user that
 * something is happening; it does not tell them what, and a task that has said
 * "Running" for four minutes is indistinguishable from one that has hung. So
 * every tool call is paired — started with finished, on its call id — and each
 * row says what the call was for, where its data came from, whether it
 * succeeded and how long it took. A call still in flight ticks.
 *
 * What is deliberately NOT here is a reasoning trace. No event kind carries
 * one: `WorkReport` in the runtime rules it out in as many words, and a
 * collapsed panel with nothing behind it would be a control that does nothing.
 * The per-row disclosure below shows the facts that do exist — tool, intent,
 * tier, source, trust, duration, injection verdict.
 *
 * The surface stays flat — hairline rail, no cards, no shadows — because it is
 * a reading surface, and the depth kit is for chrome and controls.
 */

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export type PlanStepState = "pending" | "active" | "done" | "skipped" | "failed";

export interface PlanStep {
  id: string;
  title: string;
  state: PlanStepState;
}

const STEP_STATES = new Set<string>(["pending", "active", "done", "skipped", "failed"]);

function stepState(value: string | null, fallback: PlanStepState): PlanStepState {
  return value !== null && STEP_STATES.has(value) ? (value as PlanStepState) : fallback;
}

/**
 * The current plan, rebuilt from the newest `plan_created`/`plan_updated` and
 * then advanced by the step events that followed it.
 *
 * Rebuilt from the newest plan event rather than patched into the previous one:
 * a re-plan can drop, reorder or rename steps, and merging the two versions
 * produces a list that was never anybody's plan.
 */
export function derivePlan(events: readonly ClientWorkEvent[]): PlanStep[] {
  let steps: PlanStep[] = [];
  let planSeq = -1;

  for (const event of events) {
    if (event.kind !== "plan_created" && event.kind !== "plan_updated") continue;
    const raw = readEvent(event).steps;
    if (!Array.isArray(raw)) continue;
    planSeq = event.seq;
    steps = raw.flatMap((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
      const step = entry as Payload;
      const title = str(step, "title", "label", "summary");
      if (title === null) return [];
      return [
        {
          id: str(step, "id", "stepId") ?? `${index}`,
          title,
          state: stepState(str(step, "status", "state"), "pending"),
        },
      ];
    });
  }

  if (steps.length === 0) return steps;

  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const event of events) {
    if (event.seq <= planSeq) continue;
    const payload = readEvent(event);
    const id = str(payload, "stepId", "id");
    const step = id === null ? undefined : byId.get(id);
    if (!step) continue;
    if (event.kind === "step_started") step.state = "active";
    if (event.kind === "step_finished") {
      step.state = stepState(str(payload, "status", "state"), "done");
    }
  }
  return steps;
}

const STEP_ICON: Record<PlanStepState, React.ComponentType<{ className?: string }>> = {
  pending: CircleDashed,
  active: Loader2,
  done: Check,
  skipped: Minus,
  failed: X,
};

const STEP_CLASS: Record<PlanStepState, string> = {
  pending: "text-muted-foreground/60",
  active: "text-primary",
  done: "text-success-ink",
  skipped: "text-muted-foreground/60",
  failed: "text-destructive",
};

export function WorkPlan({ steps }: { steps: readonly PlanStep[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Juno hasn’t written a plan for this yet. One appears here as soon as it has decided how to
        approach the task.
      </p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {steps.map((step) => {
        const Icon = STEP_ICON[step.state];
        return (
          <li key={step.id} className="flex items-start gap-2.5 text-[13px] leading-relaxed">
            <Icon
              className={cn(
                "mt-[3px] h-3.5 w-3.5 shrink-0",
                STEP_CLASS[step.state],
                step.state === "active" && "motion-safe:animate-spin"
              )}
              aria-hidden="true"
            />
            <span
              className={cn(
                "min-w-0",
                step.state === "done" && "text-muted-foreground",
                step.state === "skipped" && "text-muted-foreground/70 line-through",
                step.state === "active" && "font-medium text-foreground"
              )}
            >
              {step.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// What is happening right now
// ---------------------------------------------------------------------------

export interface CurrentAction {
  title: string;
  detail: string | null;
  /** When it began, so the banner can say how long it has been going. */
  since: string;
}

/**
 * The action in flight, or null when nothing is.
 *
 * Two layers, not one. A tool call is the specific thing — "Searching your
 * mail" — and a plan step is the general one, and a run that has just finished
 * a call is still doing the step it finished it under. Collapsing them made the
 * banner blink out of existence between every pair of tool calls, roughly once
 * a second, which reads as a stall rather than as progress. So a finished call
 * falls back to its step; only the step's own end, or the run's, clears both.
 *
 * Everything terminal clears both layers, because the failure this guards
 * against is the banner that keeps saying "Reading your Downloads folder" long
 * after the run died — the endless spinner in a different costume.
 */
export function deriveCurrentAction(events: readonly ClientWorkEvent[]): CurrentAction | null {
  let tool: CurrentAction | null = null;
  let step: CurrentAction | null = null;

  for (const event of events) {
    const payload = readEvent(event);
    switch (event.kind) {
      case "tool_started":
        tool = {
          title: str(payload, "summary", "title") ?? humanize(str(payload, "tool", "name") ?? "Tool"),
          detail: toolPurpose(payload),
          since: event.createdAt,
        };
        break;
      case "step_started": {
        const title = str(payload, "title", "label");
        if (title !== null) {
          step = { title, detail: null, since: event.createdAt };
          break;
        }
        // A step event with no title is not a step. The Mac emits one for each
        // progress line a running tool reports — `["tool": …, "text": …]` — and
        // that text is the most specific sentence anybody has about what is
        // happening, so it replaces the tool line rather than the step line.
        const progress = prose(payload, "text", "message");
        if (progress !== null) {
          tool = {
            title: progress,
            detail: humanizeOrNull(str(payload, "tool", "name")),
            since: event.createdAt,
          };
        }
        break;
      }
      case "tool_finished":
      case "tool_denied":
        tool = null;
        break;
      case "step_finished":
      case "run_finished":
      case "paused":
      case "error":
      case "question_asked":
      case "approval_requested":
        tool = null;
        step = null;
        break;
      default:
        break;
    }
  }
  return tool ?? step;
}

/** What a tool call was for, in the plainest terms the payload allows. */
function toolPurpose(payload: Payload): string | null {
  const intent = humanizeOrNull(str(payload, "intent"));
  const source = prose(payload, "source");
  if (intent !== null && source !== null) return `${intent} · ${source}`;
  return intent ?? source;
}

function humanizeOrNull(identifier: string | null): string | null {
  return identifier === null ? null : humanize(identifier);
}

export function WorkCurrentAction({ action }: { action: CurrentAction | null }) {
  if (action === null) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.07] px-3.5 py-2.5">
      <Loader2
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary motion-safe:animate-spin"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        {/* Announced politely rather than assertively: this line changes several
            times a minute, and a screen reader that interrupts on each one makes
            the page unusable for exactly the person who most needs telling what
            is happening. */}
        <p className="truncate text-[13px] font-medium text-foreground" aria-live="polite">
          {action.title}
        </p>
        <p className="mt-0.5 flex items-baseline gap-1.5 font-mono text-[10px] text-muted-foreground">
          {action.detail !== null && <span className="min-w-0 truncate">{action.detail}</span>}
          <LiveDuration since={action.since} className="shrink-0 tabular-nums" />
        </p>
      </div>
    </div>
  );
}

/**
 * How long something has been going, ticking.
 *
 * `Date.now()` is read in an effect and never during render, because a duration
 * computed on the server and again on the client is guaranteed to differ and is
 * exactly the hydration mismatch this codebase warns about. The first paint is
 * therefore blank and one second later it is a number, which is honest: before
 * the first tick this component genuinely does not know.
 */
function LiveDuration({ since, className }: { since: string; className?: string }) {
  const [elapsed, setElapsed] = React.useState<number | null>(null);

  React.useEffect(() => {
    const started = Date.parse(since);
    if (Number.isNaN(started)) return;
    const tick = () => setElapsed(Math.max(0, Date.now() - started));
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, [since]);

  if (elapsed === null) return null;
  return <span className={className}>{formatDuration(elapsed)}</span>;
}

// ---------------------------------------------------------------------------
// The activity feed
// ---------------------------------------------------------------------------

type EntryTone = "quiet" | "normal" | "warning" | "bad" | "good";

/**
 * Where a tool call got to. Null on a row that is not a tool call.
 *
 * `unreported` is the one that earns its keep. A run can end — or be paused, or
 * throw — with a call still open, and the alternative to naming that state is a
 * spinner on a row of a task that finished an hour ago. It says the call was
 * started and never reported back, which is all anybody knows.
 */
export type ActivityState = "running" | "done" | "failed" | "refused" | "unreported";

export interface ActivityFact {
  label: string;
  value: string;
}

export interface ActivityEntry {
  id: string;
  seq: number;
  /**
   * The executor's own identifiers for this call, kept so a finish can find its
   * start. Not rendered — the tool name reaches the reader through `facts`.
   */
  callId: string | null;
  tool: string | null;
  /** The plan step this fell under, when the executor named one. */
  step: string | null;
  title: string;
  detail: string | null;
  tone: EntryTone;
  icon: React.ComponentType<{ className?: string }>;
  state: ActivityState | null;
  /** Set once a call has finished. Null while it is still going. */
  durationMs: number | null;
  /** ISO start, so a running row can tick. */
  at: string;
  /** The per-row disclosure. Empty means there is nothing more to show. */
  facts: ActivityFact[];
  /** The injection scan's verdict on this call's output, when it reached one. */
  warning: string | null;
}

/** Kinds whose whole content is already shown by a dedicated panel. */
const RENDERED_ELSEWHERE = new Set<WorkEventKind>(["plan_created", "plan_updated"]);

/**
 * The run as a list of things that happened, with tool calls paired.
 *
 * The pairing is on the call id and nothing else. Pairing by position looks
 * right until two calls overlap — a sub-agent and the root agent both working —
 * and then every duration in the feed is wrong by however long the other call
 * took, which is worse than showing no duration at all.
 *
 * A `tool_finished` with no start in the list is still rendered. It is the
 * normal case at the top of a resumed transcript, where the cursor replays from
 * the middle of a call, and dropping it would silently shorten the record.
 */
export function deriveActivity(events: readonly ClientWorkEvent[]): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  const open: ActivityEntry[] = [];

  /**
   * The start this ending belongs to.
   *
   * By call id where there is one. Where there is not — the Mac writes
   * `tool_denied` as `["tool": …, "reason": …]` and no id at all — the newest
   * open call for that tool name is taken instead. Without the fallback a
   * refused local tool leaves its row spinning for the rest of the run, which
   * is the exact failure this feed exists to end, produced by the feed itself.
   */
  const takeOpen = (callId: string | null, tool: string | null): ActivityEntry | undefined => {
    // Backwards, and by hand: `findLastIndex` is ES2023 and this project's lib
    // is ES2022. Newest first because a repeated tool call is far likelier to
    // be ending its most recent invocation than an older one still in flight.
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const entry = open[index];
      const matches =
        callId !== null ? entry.callId === callId : tool === null || entry.tool === tool;
      if (!matches) continue;
      open.splice(index, 1);
      return entry;
    }
    return undefined;
  };

  let step: string | null = null;

  for (const event of events) {
    if (event.visibility !== "user") continue;
    if (RENDERED_ELSEWHERE.has(event.kind)) continue;
    const payload = readEvent(event);
    const callId = str(payload, "callId", "toolCallId");

    // A titled step opens a group, and the group's heading IS the row: emitting
    // "Do the work" underneath a heading that already says "Do the work" is the
    // kind of duplication that makes a long feed unreadable.
    if (event.kind === "step_started") {
      const title = str(payload, "title", "label");
      if (title !== null) {
        step = title;
        continue;
      }
    }

    if (event.kind === "tool_started") {
      const entry: ActivityEntry = {
        id: event.id,
        seq: event.seq,
        callId,
        tool: str(payload, "tool", "name"),
        step,
        title: str(payload, "summary", "title") ?? humanize(str(payload, "tool", "name") ?? "Tool"),
        detail: toolPurpose(payload),
        tone: "normal",
        icon: Wrench,
        state: "running",
        durationMs: null,
        at: event.createdAt,
        facts: toolFacts(payload),
        warning: null,
      };
      entries.push(entry);
      open.push(entry);
      continue;
    }

    if (event.kind === "tool_finished" || event.kind === "tool_denied") {
      const refused = event.kind === "tool_denied";
      const failed = refused || bool(payload, "isError") === true;
      const state: ActivityState = refused ? "refused" : failed ? "failed" : "done";
      const tone: EntryTone = refused ? "warning" : failed ? "bad" : "quiet";
      const icon = refused ? Ban : failed ? AlertTriangle : Check;
      const started = takeOpen(callId, str(payload, "tool", "name"));
      if (started !== undefined) {
        started.state = state;
        started.tone = tone;
        started.icon = icon;
        // The executor's own measurement wins. The gap between the two rows'
        // timestamps is a second-best that also counts however long the events
        // took to be written and read back, so it is used only when the
        // executor did not say.
        started.durationMs =
          num(payload, "durationMs", "elapsedMs") ?? elapsedBetween(started.at, event.createdAt);
        started.detail = toolOutcome(payload, event.kind) ?? started.detail;
        started.facts = [...started.facts, ...resultFacts(payload)];
        started.warning = injectionWarning(payload);
        continue;
      }
      const described = describeEvent(event, payload);
      entries.push({
        id: event.id,
        seq: event.seq,
        callId,
        tool: str(payload, "tool", "name"),
        step,
        title: described.title,
        detail: toolOutcome(payload, event.kind) ?? described.detail,
        tone,
        icon,
        state,
        durationMs: num(payload, "durationMs", "elapsedMs"),
        at: event.createdAt,
        facts: [...toolFacts(payload), ...resultFacts(payload)],
        warning: injectionWarning(payload),
      });
      continue;
    }

    // The run stopped with calls still open. Every one of them is marked as
    // never having reported back, rather than left spinning on the record of a
    // task that ended — a spinner that outlives its run is the single thing this
    // whole surface was built to remove.
    if (event.kind === "run_finished" || event.kind === "error" || event.kind === "paused") {
      for (const stranded of open.splice(0)) {
        stranded.state = "unreported";
        stranded.tone = "warning";
        stranded.icon = CircleDashed;
        stranded.durationMs = elapsedBetween(stranded.at, event.createdAt);
      }
    }

    // A step that simply completed needs no row — the heading above it and the
    // tick in the Plan panel both already say so. A step that was skipped or
    // failed does, because the reason it gives is the only place that fact is
    // ever written down. It is emitted while the group is still open, so it
    // reads underneath the step it belongs to rather than after it.
    if (event.kind === "step_finished") {
      const status = str(payload, "status", "state");
      const closing = step;
      step = null;
      if (status === "done" || status === null) continue;
      const described = describeEvent(event, payload);
      entries.push({
        id: event.id,
        seq: event.seq,
        callId: null,
        tool: null,
        step: closing,
        title: `${status === "skipped" ? "Skipped" : "Could not finish"}: ${described.title}`,
        detail: described.detail,
        tone: status === "failed" ? "bad" : "warning",
        icon: status === "failed" ? X : Minus,
        state: null,
        durationMs: null,
        at: event.createdAt,
        facts: [],
        warning: null,
      });
      continue;
    }

    const described = describeEvent(event, payload);
    entries.push({
      id: event.id,
      seq: event.seq,
      callId: null,
      tool: null,
      step,
      title: described.title,
      detail: described.detail,
      // What is left of `step_started` here is a Mac progress line — a note
      // about the call in flight rather than an event in its own right — so it
      // is drawn quietly and with a marker that does not claim anything began.
      tone: event.kind === "step_started" ? "quiet" : described.tone,
      icon: event.kind === "step_started" ? CircleDashed : described.icon,
      state: null,
      durationMs: null,
      at: event.createdAt,
      facts: [],
      warning: null,
    });
  }

  return entries;
}

function elapsedBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return end - start;
}

/**
 * What a finished call reported back.
 *
 * The cloud runner sends no summary of a tool's output — `tool_finished` is
 * `{ callId, tool, isError, durationMs, provenance }` and nothing more — so
 * most of the time the honest answer is the outcome and the duration, which the
 * row states in its own right. The Mac sends a free-form `detail` bag, and only
 * the keys whose author meant them as prose are read out of it, through the
 * path guard: a tool's detail bag is exactly where an absolute path turns up,
 * and a path on screen is a path in a support ticket.
 */
function toolOutcome(payload: Payload, kind: WorkEventKind): string | null {
  if (kind === "tool_denied") return str(payload, "reason", "explanation");
  const detail = payload.detail;
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    return prose(detail as Payload, "summary", "message", "text", "result");
  }
  return prose(payload, "summary", "result");
}

/** The provenance and permission facts a tool call carries before it runs. */
function toolFacts(payload: Payload): ActivityFact[] {
  const facts: ActivityFact[] = [];
  const tool = str(payload, "tool", "name");
  if (tool !== null) facts.push({ label: "Tool", value: tool });
  const intent = str(payload, "intent");
  if (intent !== null) facts.push({ label: "Intent", value: intent });
  const tier = str(payload, "tier");
  if (tier !== null) facts.push({ label: "Through", value: humanize(tier) });
  const source = prose(payload, "source");
  if (source !== null) facts.push({ label: "Source", value: source });
  const risk = str(payload, "risk");
  if (risk !== null) facts.push({ label: "Risk", value: humanize(risk) });
  const trust = str(payload, "trust");
  // Spelled out rather than shown as the raw enum, because "untrusted" on its
  // own reads as an accusation against the user rather than as a description of
  // text nobody in this conversation wrote.
  if (trust !== null) {
    facts.push({
      label: "Output",
      value:
        trust === "untrusted" ? "Text Juno did not write — treated as data" : "From Juno’s own work",
    });
  }
  return facts;
}

function resultFacts(payload: Payload): ActivityFact[] {
  const action = str(payload, "action");
  return action === null ? [] : [{ label: "Action", value: action }];
}

/**
 * The injection scan's verdict, as a sentence, and never the text it matched.
 *
 * `WorkInjectionSummary` carries counts and signal names instead of the spans it
 * found, deliberately: publishing attacker-authored text to every client
 * attached to the run is the delivery mechanism the scan exists to interrupt.
 * This renders what is there and does not go looking for more.
 */
function injectionWarning(payload: Payload): string | null {
  const injection = payload.injection;
  if (injection === null || typeof injection !== "object" || Array.isArray(injection)) return null;
  const summary = injection as Payload;
  if (bool(summary, "detected") !== true) return null;
  const what =
    str(summary, "severity") === "hostile"
      ? "instructions aimed at Juno"
      : "something shaped like an instruction";
  return `This result contained ${what}. Juno read it as data, not as a request.`;
}

const TONE_CLASS: Record<EntryTone, string> = {
  quiet: "text-muted-foreground",
  normal: "text-foreground",
  warning: "text-warning-foreground",
  bad: "text-destructive",
  good: "text-success-ink",
};

/**
 * Which state an EMPTY feed is in.
 *
 * Three rather than "empty or not", because an empty feed means three different
 * things and only one of them is worth waiting through: a task nobody has
 * started, a run that has not spoken yet, and a run that ended having recorded
 * nothing at all — which is a fault, not a state, and needs saying so.
 */
export type ActivityPhase = "not-started" | "live" | "settled";

export function WorkActivity({
  entries,
  phase,
}: {
  entries: readonly ActivityEntry[];
  phase: ActivityPhase;
}) {
  if (entries.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {phase === "not-started"
          ? "Nothing has run yet. Once you start this, every step Juno takes appears here as it takes it."
          : phase === "settled"
            ? "This attempt ended without recording a single step, so there is nothing to read back. Starting it again is safe."
            : "Waiting for the first step. This fills in the moment Juno starts working."}
      </p>
    );
  }

  // Consecutive rows under the same plan step are drawn under one heading. The
  // grouping happens here rather than in the derivation because it is purely a
  // matter of how the list reads — each entry carries its own step, so nothing
  // is lost if this presentation ever changes.
  const groups: { step: string | null; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.step === entry.step) last.entries.push(entry);
    else groups.push({ step: entry.step, entries: [entry] });
  }

  return (
    <div className="space-y-4">
      {groups.map((group, index) => (
        <div key={`${group.step ?? "loose"}-${index}`}>
          {group.step !== null && (
            <p className="mb-1.5 font-mono text-[10px] text-muted-foreground/70">{group.step}</p>
          )}
          <ol className="relative space-y-2.5 border-l border-border/60 pl-4">
            {group.entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} phase={phase} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function ActivityRow({ entry, phase }: { entry: ActivityEntry; phase: ActivityPhase }) {
  const [open, setOpen] = React.useState(false);
  const Icon = entry.icon;
  // A run can end without a `run_finished` event — an expired lease is exactly
  // that, and it is why `interrupted` exists as a status. So the phase gets the
  // last word: a call left open on a task that is over did not report back, no
  // matter what the transcript failed to say.
  const stranded = entry.state === "unreported" || (entry.state === "running" && phase === "settled");
  const running = entry.state === "running" && !stranded;

  return (
    <li className="relative">
      <span
        className="absolute -left-[21px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background"
        aria-hidden="true"
      >
        <Icon
          className={cn(
            "h-3 w-3",
            running
              ? "text-primary motion-safe:animate-spin"
              : stranded
                ? TONE_CLASS.warning
                : TONE_CLASS[entry.tone]
          )}
        />
      </span>

      <div className="flex items-baseline gap-2">
        <p
          className={cn(
            "min-w-0 flex-1 text-[13px] leading-relaxed",
            running ? "font-medium text-foreground" : TONE_CLASS[entry.tone]
          )}
        >
          {entry.title}
        </p>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/80">
          {running ? (
            <LiveDuration since={entry.at} />
          ) : entry.durationMs === null ? null : (
            formatDuration(entry.durationMs)
          )}
        </span>
      </div>

      {entry.detail !== null && (
        <p className="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-muted-foreground/80">
          {entry.detail}
        </p>
      )}

      {stranded && (
        <p className="mt-0.5 text-[12px] leading-relaxed text-warning-foreground">
          Started, and never reported back. Whether it finished is not recorded.
        </p>
      )}

      {entry.warning !== null && (
        <p className="mt-1 flex items-start gap-1.5 text-[12px] leading-relaxed text-warning-foreground">
          <ShieldAlert className="mt-[3px] h-3 w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{entry.warning}</span>
        </p>
      )}

      {/* The toggle exists only when there is something behind it. A disclosure
          that opens onto nothing is the same broken promise as a spinner that
          never resolves, made smaller. */}
      {entry.facts.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-label={open ? `Hide detail: ${entry.title}` : `Show detail: ${entry.title}`}
            className="mt-1 inline-flex items-center gap-1 rounded font-mono text-[10px] text-muted-foreground/70 transition-colors duration-base hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn(
                "h-2.5 w-2.5 transition-transform duration-base ease-out-soft",
                open && "rotate-90"
              )}
              aria-hidden="true"
            />
            {open ? "Hide detail" : "Detail"}
          </button>
          {open && (
            <dl className="mt-1 space-y-0.5 border-l border-border/50 pl-2.5">
              {entry.facts.map((fact) => (
                <div
                  key={`${fact.label}-${fact.value}`}
                  className="flex gap-2 font-mono text-[10px]"
                >
                  <dt className="shrink-0 text-muted-foreground/60">{fact.label}</dt>
                  <dd className="min-w-0 break-all text-muted-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// What was actually done
// ---------------------------------------------------------------------------

export interface PerformedAction {
  id: string;
  summary: string;
  at: string;
  /** True for the ones the user personally authorised. */
  approved: boolean;
}

export interface PerformedActions {
  actions: PerformedAction[];
  /**
   * Tool calls that finished without saying whether they changed anything.
   *
   * Counted rather than assumed either way. The Mac emits neither a risk level
   * nor a mutating flag, so on a local run this is every tool call the run made
   * — and a panel that answered "nothing was changed" on that evidence would be
   * stating something it cannot know, about the one question where being wrong
   * costs the most.
   */
  unclassified: number;
}

/**
 * The subset of the run that changed something outside Juno.
 *
 * A separate list from the feed rather than a filter applied to it, because the
 * questions differ: the feed answers "what happened", this answers "what would I
 * have to undo". Reading a file, citing a page and thinking are all absent for
 * that reason — none of them left a mark.
 *
 * A tool call counts when it said so. `mutating: true` is taken at face value;
 * otherwise the risk level the executor assigned decides, since `safe` is
 * precisely the word for a call that left nothing behind. The risk arrives on
 * the START event and the outcome on the FINISH event, so the two are joined on
 * the call id — reading the risk off the finish event instead is how this list
 * silently stays empty.
 */
export function derivePerformedActions(events: readonly ClientWorkEvent[]): PerformedActions {
  // Which action each approval was ABOUT is stated once, on the request. The
  // resolution carries the approval id and the decision and nothing else — the
  // route that records a web decision writes exactly `{ approvalId, decision,
  // decidedVia }` — so the two have to be joined on that id. Reading the action
  // name off the resolution instead is how this set silently stays empty and
  // every action the user personally authorised loses its mark.
  const actionByApproval = new Map<string, string>();
  const approvedActions = new Set<string>();
  for (const event of events) {
    const payload = readEvent(event);
    const approvalId = str(payload, "approvalId", "requestId", "id");
    if (approvalId === null) continue;
    if (event.kind === "approval_requested") {
      const action = str(payload, "action");
      if (action !== null) actionByApproval.set(approvalId, action);
      continue;
    }
    if (event.kind !== "approval_resolved") continue;
    const decision = str(payload, "decision");
    const action = str(payload, "action") ?? actionByApproval.get(approvalId) ?? null;
    if (action !== null && decision !== null && decision.startsWith("allowed")) {
      approvedActions.add(action);
    }
  }

  interface StartedCall {
    title: string;
    /** Null when the executor said nothing either way about what it changes. */
    mutating: boolean | null;
    action: string | null;
  }
  const started = new Map<string, StartedCall>();

  const actions: PerformedAction[] = [];
  let unclassified = 0;

  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = readEvent(event);
    switch (event.kind) {
      case "tool_started": {
        const callId = str(payload, "callId", "toolCallId");
        if (callId === null) break;
        const risk = str(payload, "risk");
        started.set(callId, {
          title: str(payload, "summary") ?? humanize(str(payload, "tool", "name") ?? "Tool"),
          mutating: bool(payload, "mutating") ?? (risk === null ? null : risk !== "safe"),
          action: str(payload, "action"),
        });
        break;
      }
      case "files_changed":
      case "batch_applied":
      case "batch_undone":
      case "artifact_created":
      case "artifact_updated":
        actions.push({
          id: event.id,
          summary: describeEvent(event, payload).title,
          at: event.createdAt,
          approved: false,
        });
        break;
      case "tool_finished": {
        // A call that failed changed nothing worth undoing, and listing it here
        // would send the user hunting for a change that was never made.
        if (bool(payload, "isError") === true) break;
        const callId = str(payload, "callId", "toolCallId");
        const start = callId === null ? undefined : started.get(callId);
        const mutating = bool(payload, "mutating") ?? start?.mutating ?? null;
        if (mutating === null) {
          unclassified += 1;
          break;
        }
        if (!mutating) break;
        const action = str(payload, "action") ?? start?.action ?? null;
        actions.push({
          id: event.id,
          summary:
            str(payload, "summary") ??
            start?.title ??
            humanize(str(payload, "tool", "name") ?? "Tool"),
          at: event.createdAt,
          approved: action !== null && approvedActions.has(action),
        });
        break;
      }
      default:
        break;
    }
  }
  return { actions, unclassified };
}

// ---------------------------------------------------------------------------
// One event as a sentence
// ---------------------------------------------------------------------------

interface EventDescription {
  title: string;
  detail: string | null;
  tone: EntryTone;
  icon: React.ComponentType<{ className?: string }>;
}

/**
 * One event as a sentence a person can read.
 *
 * An exhaustive switch, not a lookup with a fallback. `noFallthroughCasesInSwitch`
 * plus the `WorkEventKind` union means adding a kind to the domain and
 * forgetting it here is a compile error rather than a blank row in somebody's
 * feed.
 *
 * The kinds whose prose belongs to the conversation column — what Juno said,
 * what it asked, what the user typed — are marked here rather than reproduced,
 * and carry only their opening line. The feed's job is to prove the turn
 * happened and place it in time; reading it is done on the left, where there is
 * room.
 */
function describeEvent(event: ClientWorkEvent, payload: Payload): EventDescription {
  switch (event.kind) {
    case "run_started":
      return {
        title: "Started",
        detail: str(payload, "target", "executor", "model"),
        tone: "quiet",
        icon: PlayCircle,
      };
    case "plan_created":
      return { title: "Wrote a plan", detail: null, tone: "quiet", icon: Sparkles };
    case "plan_updated":
      return {
        title: "Revised the plan",
        detail: str(payload, "reason"),
        tone: "quiet",
        icon: Sparkles,
      };
    case "step_started":
      return {
        title: str(payload, "title", "label") ?? prose(payload, "text", "message") ?? "Started a step",
        detail: null,
        tone: "normal",
        icon: PlayCircle,
      };
    case "step_finished":
      return {
        title: str(payload, "title", "label") ?? "Finished a step",
        detail: str(payload, "summary", "reason"),
        tone: "quiet",
        icon: Check,
      };
    case "assistant_message":
      return {
        title: "Replied",
        detail: firstLine(str(payload, "text", "message")),
        tone: "normal",
        icon: MessageSquare,
      };
    case "tool_started":
      return {
        title: str(payload, "summary") ?? humanize(str(payload, "tool", "name") ?? "Tool"),
        detail: toolPurpose(payload),
        tone: "normal",
        icon: Wrench,
      };
    case "tool_finished":
      return {
        title: str(payload, "summary") ?? humanize(str(payload, "tool", "name") ?? "Tool"),
        detail: null,
        tone: bool(payload, "isError") === true ? "bad" : "quiet",
        icon: bool(payload, "isError") === true ? AlertTriangle : Check,
      };
    case "tool_denied":
      return {
        title: `Refused: ${humanize(str(payload, "tool", "name") ?? "a tool")}`,
        detail: str(payload, "reason", "explanation"),
        tone: "warning",
        icon: Ban,
      };
    case "question_asked":
      return {
        title: "Asked you a question",
        detail: firstLine(str(payload, "question", "text")),
        tone: "warning",
        icon: MessageSquare,
      };
    case "question_answered":
      return {
        // This kind is answers now, but it was both for as long as the shared
        // vocabulary had no user-message kind, and the rows written under it are
        // still in the log. The marker is read rather than assumed, so an old
        // instruction is not relabelled "You answered" — a small lie the reader
        // would notice — the day it is scrolled back to.
        title: payload.steering === true ? "You added an instruction" : "You answered",
        detail: firstLine(str(payload, "text", "answer")),
        tone: "quiet",
        icon: MessageSquare,
      };
    case "user_message":
      return {
        title: "You added an instruction",
        detail: firstLine(str(payload, "text")),
        tone: "quiet",
        icon: MessageSquare,
      };
    case "approval_requested":
      return {
        title: str(payload, "summary") ?? "Asked for approval",
        detail: str(payload, "action"),
        tone: "warning",
        icon: ShieldAlert,
      };
    case "approval_resolved":
      return {
        title:
          str(payload, "decision") === "denied" ? "You refused an action" : "You allowed an action",
        detail: str(payload, "summary", "action"),
        tone: "quiet",
        icon: ShieldAlert,
      };
    case "artifact_created":
      return {
        title: `Created ${str(payload, "title") ?? "a file"}`,
        detail: str(payload, "kind"),
        tone: "good",
        icon: FileText,
      };
    case "artifact_updated":
      return {
        title: `Updated ${str(payload, "title") ?? "a file"}`,
        detail: str(payload, "kind"),
        tone: "quiet",
        icon: FileText,
      };
    case "source_cited":
      return {
        title: str(payload, "title", "label") ?? "Cited a source",
        detail: str(payload, "source", "url", "href"),
        tone: "quiet",
        icon: Link2,
      };
    case "files_changed": {
      const changed = count(payload, "files", "count");
      return {
        title:
          changed === null ? "Changed files" : `Changed ${changed} file${changed === 1 ? "" : "s"}`,
        detail: str(payload, "summary"),
        tone: "normal",
        icon: FileText,
      };
    }
    case "batch_preview": {
      const size = count(payload, "items", "count");
      return {
        title: size === null ? "Prepared a batch of changes" : `Prepared ${size} changes for review`,
        detail: str(payload, "summary"),
        tone: "normal",
        icon: FileText,
      };
    }
    case "batch_applied": {
      const size = count(payload, "items", "count");
      return {
        title: size === null ? "Applied a batch of changes" : `Applied ${size} changes`,
        detail: str(payload, "summary"),
        tone: "good",
        icon: Check,
      };
    }
    case "batch_undone": {
      const size = count(payload, "reversedCount", "count");
      return {
        title: size === null ? "Undid a batch of changes" : `Undid ${size} changes`,
        detail: str(payload, "summary"),
        tone: "quiet",
        icon: Minus,
      };
    }
    case "subagent_update":
      return {
        title: str(payload, "title", "agentId") ?? "A sub-agent reported in",
        detail: str(payload, "status", "summary"),
        tone: "quiet",
        icon: Sparkles,
      };
    case "degraded":
      return {
        title: "Ran with less than you asked for",
        detail: str(payload, "explanation"),
        tone: "warning",
        icon: AlertTriangle,
      };
    case "budget_warning":
      return {
        title: "Approaching a limit",
        detail: str(payload, "detail", "explanation"),
        tone: "warning",
        icon: AlertTriangle,
      };
    case "host_disconnected":
      return {
        title: `${str(payload, "hostName") ?? "The Mac"} disconnected`,
        detail: str(payload, "detail"),
        tone: "warning",
        icon: AlertTriangle,
      };
    case "host_reconnected":
      return {
        title: `${str(payload, "hostName") ?? "The Mac"} reconnected`,
        detail: null,
        tone: "good",
        icon: Check,
      };
    case "paused":
      return { title: "Paused", detail: str(payload, "reason"), tone: "quiet", icon: PauseCircle };
    case "resumed":
      return { title: "Resumed", detail: null, tone: "quiet", icon: PlayCircle };
    case "validation_result": {
      // `satisfied` is the runtime's word and `ok` is the shorter one a host
      // might write. Neither being present means the check ran and said nothing
      // this build can read, which is not the same as failing.
      const passed = bool(payload, "satisfied", "ok");
      const unmet = count(payload, "unmet");
      return {
        title: passed === false ? "A check did not pass" : "Checked its own work",
        detail:
          str(payload, "detail", "summary") ??
          (unmet !== null && unmet > 0 ? `${unmet} unmet` : null),
        tone: passed === false ? "warning" : "quiet",
        icon: passed === false ? AlertTriangle : Check,
      };
    }
    case "run_finished": {
      const reason = str(payload, "terminalReason", "reason");
      return {
        title: `Finished — ${reason ?? "no reason recorded"}`,
        detail: str(payload, "detail"),
        tone: reason === "completed" ? "good" : "warning",
        icon: Check,
      };
    }
    case "error":
      return {
        title: "Something went wrong",
        detail: str(payload, "message", "detail"),
        tone: "bad",
        icon: AlertTriangle,
      };
  }
}

/** The opening of a message, for a feed row that has one line to spend on it. */
function firstLine(text: string | null, max = 110): string | null {
  if (text === null) return null;
  const line = text.split("\n").find((entry) => entry.trim().length > 0)?.trim();
  if (line === undefined) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}
