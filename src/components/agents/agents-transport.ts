"use client";

/**
 * Every request the web makes about agents, in one file.
 *
 * The same outcome shape everywhere — a value, or the server's own sentence —
 * because every screen that talks to an agent has to put one of the two in
 * front of a person, and a caller that has to know which of three error
 * shapes a route used is a caller that eventually shows `[object Object]`.
 *
 * `confirm` is its own outcome rather than an error: the cost preflight said a
 * person should say yes first, and that is a question for the page to ask, not
 * a failure for it to report.
 */

import type { AgentAvatar } from "@/lib/agents/avatar";
import type {
  AgentGoalCadence,
  AgentGoalStatus,
  AgentNotifyLevel,
  AgentRoutineCadence,
  AgentStatus,
  AgentStyle,
} from "@/lib/agents/domain";
import type {
  ClientAgent,
  ClientAgentActivity,
  ClientAgentComputer,
  ClientAgentDetail,
  ClientAgentGoal,
  ClientAgentIdea,
  ClientAgentNote,
  ClientAgentRoutine,
} from "@/lib/agents/types";
import type { WorkPermissionPolicy } from "@/lib/work/domain";
import { PRODUCT_NAME } from "@/lib/brand/names";

export type AgentOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "confirm"; estimatedCostMicroUsd: number; message: string }
  | { kind: "failed"; status: number; error: string; message: string };

/** Fired after anything that changes an agent, so the sidebar and every open page refresh together. */
export const AGENTS_CHANGED_EVENT = "juno:agents-changed";

export function announceAgentsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AGENTS_CHANGED_EVENT));
    window.dispatchEvent(new CustomEvent("juno:agent-updated"));
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function call<T>(
  url: string,
  init: { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown },
  pick: (data: Record<string, unknown>) => T
): Promise<AgentOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      ...(init.body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
    });
  } catch {
    return { kind: "failed", status: 0, error: "offline", message: `${PRODUCT_NAME} could not be reached. Check your connection and try again.` };
  }
  const data = await json(res);
  if (res.ok) return { kind: "ok", value: pick(data) };
  const error = typeof data.error === "string" ? data.error : "failed";
  const message =
    typeof data.message === "string" && data.message.trim()
      ? data.message
      : res.status === 401
        ? "You have been signed out. Sign in again to continue."
        : res.status === 404
          ? "That no longer exists."
          : `Something went wrong on ${PRODUCT_NAME}'s side. Try again in a moment.`;
  if (res.status === 409 && error === "confirm_expensive") {
    const estimate = typeof data.estimatedCostMicroUsd === "number" ? data.estimatedCostMicroUsd : 0;
    return { kind: "confirm", estimatedCostMicroUsd: estimate, message };
  }
  return { kind: "failed", status: res.status, error, message };
}

const base = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

/**
 * The roster read. A body without an `agents` array is a failure, not an empty
 * roster: coercing it to `[]` is how a broken response paints "Hire your first
 * agent" over a person who already has Nova.
 */
export function fetchAgents(): Promise<AgentOutcome<ClientAgent[]>> {
  return call("/api/agents", {}, (d) => d).then((outcome) => {
    if (outcome.kind !== "ok") return outcome;
    const agents = (outcome.value as Record<string, unknown>).agents;
    if (!Array.isArray(agents)) {
      return {
        kind: "failed",
        status: 0,
        error: "malformed",
        message: `${PRODUCT_NAME} could not read your agents. Try again in a moment.`,
      } as const;
    }
    return { kind: "ok", value: agents as ClientAgent[] } as const;
  });
}

export function fetchAgentDetail(id: string): Promise<AgentOutcome<ClientAgentDetail>> {
  return call(base(id), {}, (d) => d as unknown as ClientAgentDetail);
}

export interface HireAgentInput {
  creationKey?: string;
  starterMessage?: string;
  name?: string;
  role?: string;
  avatar?: AgentAvatar;
  style?: AgentStyle;
  instructions?: string;
  approvalMode?: WorkPermissionPolicy;
  notify?: AgentNotifyLevel;
  connectorIds?: string[];
  template?: string | null;
  firstGoal?: string;
}

export function hireAgent(input: HireAgentInput): Promise<AgentOutcome<ClientAgent>> {
  return call("/api/agents", { method: "POST", body: input }, (d) => d.agent).then(outcome => {
    if (outcome.kind !== "ok") return outcome;
    const agent = outcome.value;
    if (!agent || typeof agent !== "object" || !("id" in agent) || typeof agent.id !== "string") {
      return { kind: "failed", status: 0, error: "malformed", message: "Couldn’t read the new agent. Try again to reopen the same request." } as const;
    }
    return { kind: "ok", value: agent as ClientAgent } as const;
  });
}

export interface AgentPatch {
  name?: string;
  role?: string;
  avatar?: AgentAvatar;
  style?: AgentStyle;
  instructions?: string;
  approvalMode?: WorkPermissionPolicy;
  notify?: AgentNotifyLevel;
  pinned?: boolean;
  connectorIds?: string[];
  status?: AgentStatus;
  proactive?: boolean;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Its own weekly cap in micro-USD, or null for none (src/lib/agents/budget.ts). */
  budgetMicroUsd?: number | null;
}

export function updateAgent(id: string, patch: AgentPatch): Promise<AgentOutcome<ClientAgent>> {
  return call(base(id), { method: "PATCH", body: patch }, (d) => d.agent as ClientAgent);
}

export function duplicateAgent(id: string): Promise<AgentOutcome<ClientAgent>> {
  return call(`${base(id)}/duplicate`, { method: "POST", body: {} }, (d) => d.agent as ClientAgent);
}

export function undoAgentEvent(id: string, eventId?: string): Promise<AgentOutcome<{ undone: boolean; summary?: string }>> {
  return call(`${base(id)}/undo`, { method: "POST", body: eventId ? { eventId } : {} }, (d) => ({
    undone: Boolean(d.undone ?? d.ok),
    summary: typeof d.summary === "string" ? d.summary : undefined,
  }));
}

export function computerAction(
  id: string,
  action: "enable" | "disable" | "wake" | "sleep" | "reset"
): Promise<AgentOutcome<ClientAgentComputer | null>> {
  return call(`${base(id)}/computer`, { method: "POST", body: { action } }, (d) => (d.computer ?? null) as ClientAgentComputer | null);
}

export interface ClientAgentComputerFile {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export function fetchComputerFiles(id: string): Promise<AgentOutcome<ClientAgentComputerFile[]>> {
  return call(`${base(id)}/computer/files`, {}, (d) =>
    Array.isArray(d.files) ? (d.files as ClientAgentComputerFile[]) : []
  );
}

export function updateRoutine(scheduleId: string, enabled: boolean): Promise<AgentOutcome<true>> {
  return call(`/api/work/schedules/${encodeURIComponent(scheduleId)}`, { method: "PATCH", body: { enabled } }, () => true as const);
}

export function deleteRoutine(scheduleId: string): Promise<AgentOutcome<true>> {
  return call(`/api/work/schedules/${encodeURIComponent(scheduleId)}`, { method: "DELETE" }, () => true as const);
}

export function retireAgent(id: string): Promise<AgentOutcome<true>> {
  return call(base(id), { method: "DELETE" }, () => true as const);
}

export function openAgentThread(id: string): Promise<AgentOutcome<string>> {
  return call(`${base(id)}/thread`, { method: "POST", body: {} }, (d) => String(d.conversationId ?? ""));
}

export function createGoal(
  id: string,
  input: { title: string; detail?: string; cadence?: AgentGoalCadence }
): Promise<AgentOutcome<ClientAgentGoal>> {
  return call(`${base(id)}/goals`, { method: "POST", body: input }, (d) => d.goal as ClientAgentGoal);
}

export function updateGoal(
  id: string,
  goalId: string,
  patch: { title?: string; detail?: string; cadence?: AgentGoalCadence; status?: AgentGoalStatus }
): Promise<AgentOutcome<ClientAgentGoal>> {
  return call(`${base(id)}/goals/${encodeURIComponent(goalId)}`, { method: "PATCH", body: patch }, (d) => d.goal as ClientAgentGoal);
}

export function deleteGoal(id: string, goalId: string): Promise<AgentOutcome<true>> {
  return call(`${base(id)}/goals/${encodeURIComponent(goalId)}`, { method: "DELETE" }, () => true as const);
}

export function createNote(id: string, content: string): Promise<AgentOutcome<ClientAgentNote>> {
  return call(`${base(id)}/notes`, { method: "POST", body: { content } }, (d) => d.note as ClientAgentNote);
}

export function updateNote(id: string, noteId: string, content: string): Promise<AgentOutcome<ClientAgentNote>> {
  return call(`${base(id)}/notes/${encodeURIComponent(noteId)}`, { method: "PATCH", body: { content } }, (d) => d.note as ClientAgentNote);
}

export function deleteNote(id: string, noteId: string): Promise<AgentOutcome<true>> {
  return call(`${base(id)}/notes/${encodeURIComponent(noteId)}`, { method: "DELETE" }, () => true as const);
}

export function decideIdea(
  id: string,
  ideaId: string,
  action: "start" | "dismiss",
  confirmExpensive = false
): Promise<AgentOutcome<{ idea: ClientAgentIdea; conversationId: string | null }>> {
  return call(
    `${base(id)}/ideas/${encodeURIComponent(ideaId)}`,
    { method: "PATCH", body: { action, ...(confirmExpensive ? { confirmExpensive: true } : {}) } },
    (d) => ({
      idea: d.idea as ClientAgentIdea,
      conversationId: typeof d.conversationId === "string" ? d.conversationId : null,
    })
  );
}

export interface RoutineInput {
  name: string;
  instructions: string;
  cadence: AgentRoutineCadence;
  hour: number;
  minute: number;
  weekday?: number;
  monthday?: number;
  timezone: string;
}

export function createRoutine(id: string, input: RoutineInput): Promise<AgentOutcome<ClientAgentRoutine>> {
  return call(`${base(id)}/routines`, { method: "POST", body: input }, (d) => d.routine as ClientAgentRoutine);
}

export function fetchActivity(id: string, limit = 80): Promise<AgentOutcome<ClientAgentActivity[]>> {
  return call(`${base(id)}/activity?limit=${limit}`, {}, (d) => (Array.isArray(d.activity) ? (d.activity as ClientAgentActivity[]) : []));
}

export function reflect(id: string, force = false): Promise<AgentOutcome<{ kind: string; reason?: string; ideas?: number }>> {
  return call(`${base(id)}/reflect`, { method: "POST", body: { force } }, (d) =>
    d.outcome && typeof d.outcome === "object" ? (d.outcome as { kind: string; reason?: string; ideas?: number }) : { kind: "skipped" }
  );
}

export function startAgentTask(
  id: string,
  input: { title: string; goal: string; idempotencyKey: string; confirmExpensive?: boolean }
): Promise<AgentOutcome<{ sessionId: string; conversationId: string }>> {
  return call(`${base(id)}/tasks`, { method: "POST", body: input }, (d) => ({
    sessionId: String(d.sessionId ?? ""),
    conversationId: String(d.conversationId ?? ""),
  }));
}

/** A key for one press, so a retried request lands on the task the first one made. */
export function pressKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** "$0.62", never "$0.6" — the way the task card already says it. */
export function formatEstimate(microUsd: number): string {
  return `$${(Math.max(0, microUsd) / 1_000_000).toFixed(2)}`;
}
