"use client";

import * as React from "react";
import type { Prisma } from "@prisma/client";
import {
  AlertTriangle,
  Ban,
  Check,
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
import { cn } from "@/lib/utils";

/*
 * The plan, the progress and the thing Juno is doing right now.
 *
 * Everything here is derived from the event stream rather than from a second
 * server-side projection, so the timeline and the resume cursor can never
 * disagree about what has happened. That means every payload reader is
 * defensive: `WorkEvent.payload` is JSONB written by an executor that may be a
 * release ahead of this bundle, and a field that is missing or the wrong type
 * has to degrade to "no detail" rather than throw. One unreadable event must
 * cost one line of the timeline, never the whole page.
 *
 * The surface stays flat — hairline rail, no cards, no shadows — because it is
 * a reading surface, and the depth kit is for chrome and controls.
 */

// ---------------------------------------------------------------------------
// Reading payloads
// ---------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function payloadOf(value: Prisma.JsonValue): Payload {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function str(payload: Payload, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function count(payload: Payload, key: string): number | null {
  const value = payload[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Array.isArray(value) ? value.length : null;
}

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
    const raw = payloadOf(event.payload).steps;
    if (!Array.isArray(raw)) continue;
    planSeq = event.seq;
    steps = raw.flatMap((entry, index) => {
      const step = payloadOf(entry as Prisma.JsonValue);
      const title = str(step, "title", "label", "summary");
      if (!title) return [];
      const state = str(step, "state", "status");
      return [
        {
          id: str(step, "id", "stepId") ?? `${index}`,
          title,
          state: state !== null && STEP_STATES.has(state) ? (state as PlanStepState) : "pending",
        },
      ];
    });
  }

  if (steps.length === 0) return steps;

  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const event of events) {
    if (event.seq <= planSeq) continue;
    const payload = payloadOf(event.payload);
    const id = str(payload, "stepId", "id");
    const step = id === null ? undefined : byId.get(id);
    if (!step) continue;
    if (event.kind === "step_started") step.state = "active";
    if (event.kind === "step_finished") {
      const state = str(payload, "state", "status");
      step.state = state !== null && STEP_STATES.has(state) ? (state as PlanStepState) : "done";
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
                step.state === "active" && "animate-spin"
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
}

/**
 * The action in flight, or null when nothing is.
 *
 * Cleared by the matching finish event AND by any terminal event, because the
 * failure this guards against is the banner that keeps saying "Reading your
 * Downloads folder" long after the run died — which is exactly the endless
 * spinner in a different costume.
 */
export function deriveCurrentAction(events: readonly ClientWorkEvent[]): CurrentAction | null {
  let current: CurrentAction | null = null;
  for (const event of events) {
    const payload = payloadOf(event.payload);
    switch (event.kind) {
      case "tool_started":
        current = {
          title: str(payload, "summary", "title") ?? describeTool(str(payload, "tool", "name")),
          detail: str(payload, "detail", "target"),
        };
        break;
      case "step_started":
        current = { title: str(payload, "title", "label") ?? "Working", detail: null };
        break;
      case "tool_finished":
      case "tool_denied":
      case "step_finished":
      case "run_finished":
      case "paused":
      case "error":
      case "question_asked":
      case "approval_requested":
        current = null;
        break;
      default:
        break;
    }
  }
  return current;
}

function describeTool(tool: string | null): string {
  return tool === null ? "Working" : tool.replace(/[._]/g, " ");
}

export function WorkCurrentAction({ action }: { action: CurrentAction | null }) {
  if (action === null) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-primary/25 bg-primary/[0.07] px-3.5 py-2.5">
      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{action.title}</p>
        {action.detail && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{action.detail}</p>
        )}
      </div>
    </div>
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

/**
 * The subset of the timeline that changed something outside Juno.
 *
 * A separate list from the timeline rather than a filter applied to it, because
 * the questions differ: the timeline answers "what happened", this answers
 * "what would I have to undo". Reading a file, citing a page and thinking are
 * all absent for that reason — none of them left a mark.
 */
export function derivePerformedActions(events: readonly ClientWorkEvent[]): PerformedAction[] {
  // Which action each approval was ABOUT is stated once, on the request. The
  // resolution carries the approval id and the decision and nothing else — the
  // route that records a web decision writes exactly `{ approvalId, decision,
  // decidedVia }` — so the two have to be joined on that id. Reading the action
  // name off the resolution instead is how this set silently stays empty and
  // every action the user personally authorised loses its mark.
  const actionByApproval = new Map<string, string>();
  const approvedActions = new Set<string>();
  for (const event of events) {
    const payload = payloadOf(event.payload);
    const approvalId = str(payload, "approvalId", "id");
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

  const performed: PerformedAction[] = [];
  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = payloadOf(event.payload);
    switch (event.kind) {
      case "files_changed":
      case "batch_applied":
      case "batch_undone":
      case "artifact_created":
      case "artifact_updated": {
        const described = describeEvent(event);
        performed.push({
          id: event.id,
          summary: described.title,
          at: event.createdAt,
          approved: false,
        });
        break;
      }
      case "tool_finished": {
        // Only tools that reported a change of state. A read is not an action
        // anybody needs to undo, and listing it here would bury the ones that
        // are among a hundred that are not.
        if (payload.mutating !== true) break;
        const action = str(payload, "action");
        performed.push({
          id: event.id,
          summary: str(payload, "summary") ?? describeTool(str(payload, "tool", "name")),
          at: event.createdAt,
          approved: action !== null && approvedActions.has(action),
        });
        break;
      }
      default:
        break;
    }
  }
  return performed;
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

type EntryTone = "quiet" | "normal" | "warning" | "bad" | "good";

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
 * timeline.
 */
function describeEvent(event: ClientWorkEvent): EventDescription {
  const payload = payloadOf(event.payload);
  switch (event.kind) {
    case "run_started":
      return { title: "Started", detail: str(payload, "target"), tone: "quiet", icon: PlayCircle };
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
        title: str(payload, "title", "label") ?? "Started a step",
        detail: null,
        tone: "normal",
        icon: PlayCircle,
      };
    case "step_finished":
      return {
        title: str(payload, "title", "label") ?? "Finished a step",
        detail: str(payload, "summary"),
        tone: "quiet",
        icon: Check,
      };
    case "assistant_message":
      return {
        title: str(payload, "text", "message") ?? "Said something",
        detail: null,
        tone: "normal",
        icon: MessageSquare,
      };
    case "tool_started":
      return {
        title: str(payload, "summary") ?? describeTool(str(payload, "tool", "name")),
        detail: str(payload, "target", "detail"),
        tone: "normal",
        icon: Wrench,
      };
    case "tool_finished":
      return {
        title: str(payload, "summary") ?? describeTool(str(payload, "tool", "name")),
        detail: str(payload, "result", "detail"),
        tone: "quiet",
        icon: Check,
      };
    case "tool_denied":
      return {
        title: `Refused: ${describeTool(str(payload, "tool", "name"))}`,
        detail: str(payload, "reason", "explanation"),
        tone: "warning",
        icon: Ban,
      };
    case "question_asked":
      return {
        title: str(payload, "question", "text") ?? "Asked you a question",
        detail: null,
        tone: "warning",
        icon: MessageSquare,
      };
    case "question_answered":
      return {
        title: "You answered",
        detail: str(payload, "text", "answer"),
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
        title: str(payload, "title", "url") ?? "Cited a source",
        detail: str(payload, "url"),
        tone: "quiet",
        icon: Link2,
      };
    case "files_changed": {
      const changed = count(payload, "files") ?? count(payload, "count");
      return {
        title: changed === null ? "Changed files" : `Changed ${changed} file${changed === 1 ? "" : "s"}`,
        detail: str(payload, "summary"),
        tone: "normal",
        icon: FileText,
      };
    }
    case "batch_preview": {
      const size = count(payload, "items") ?? count(payload, "count");
      return {
        title: size === null ? "Prepared a batch of changes" : `Prepared ${size} changes for review`,
        detail: str(payload, "summary"),
        tone: "normal",
        icon: FileText,
      };
    }
    case "batch_applied": {
      const size = count(payload, "items") ?? count(payload, "count");
      return {
        title: size === null ? "Applied a batch of changes" : `Applied ${size} changes`,
        detail: str(payload, "summary"),
        tone: "good",
        icon: Check,
      };
    }
    case "batch_undone": {
      const size = count(payload, "reversedCount") ?? count(payload, "count");
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
    case "validation_result":
      return {
        title: payload.ok === false ? "A check did not pass" : "Checked its own work",
        detail: str(payload, "detail", "summary"),
        tone: payload.ok === false ? "warning" : "quiet",
        icon: payload.ok === false ? AlertTriangle : Check,
      };
    case "run_finished":
      return {
        title: `Finished — ${str(payload, "reason") ?? "no reason recorded"}`,
        detail: str(payload, "detail"),
        tone: str(payload, "reason") === "completed" ? "good" : "warning",
        icon: Check,
      };
    case "error":
      return {
        title: "Something went wrong",
        detail: str(payload, "message", "detail"),
        tone: "bad",
        icon: AlertTriangle,
      };
  }
}

const TONE_CLASS: Record<EntryTone, string> = {
  quiet: "text-muted-foreground",
  normal: "text-foreground",
  warning: "text-warning-foreground",
  bad: "text-destructive",
  good: "text-success-ink",
};

/** Kinds whose whole content is already shown by a dedicated panel. */
const RENDERED_ELSEWHERE = new Set<WorkEventKind>(["plan_created", "plan_updated"]);

export function WorkTimeline({ events }: { events: readonly ClientWorkEvent[] }) {
  // `visibility` is the server's own classification and the only correct filter
  // here — an `operator` or `internal` event is not withheld because it is
  // uninteresting but because it may carry a raw tool payload.
  const visible = React.useMemo(
    () => events.filter((event) => event.visibility === "user" && !RENDERED_ELSEWHERE.has(event.kind)),
    [events]
  );

  if (visible.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Nothing has happened yet. Every step Juno takes appears here as it takes it.
      </p>
    );
  }

  return (
    <ol className="relative space-y-3 border-l border-border/60 pl-4">
      {visible.map((event) => {
        const described = describeEvent(event);
        const Icon = described.icon;
        return (
          <li key={event.id} className="relative">
            <span
              className="absolute -left-[21px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background"
              aria-hidden="true"
            >
              <Icon className={cn("h-3 w-3", TONE_CLASS[described.tone])} />
            </span>
            <p className={cn("text-[13px] leading-relaxed", TONE_CLASS[described.tone])}>
              {described.title}
            </p>
            {described.detail && (
              <p className="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-muted-foreground/80">
                {described.detail}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
