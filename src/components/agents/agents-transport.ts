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
import type { AgentMemoryAccess } from "@/lib/memory-scope";

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

/** What the agent may read of the person's memory. Person-only: the agent's own tools cannot reach this route. */
export function setAgentMemoryAccess(id: string, access: AgentMemoryAccess): Promise<AgentOutcome<AgentMemoryAccess>> {
  return call(`${base(id)}/memory-access`, { method: "PATCH", body: { access } }, (d) => d.memoryAccess as AgentMemoryAccess);
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

/** One entry in a folder on the agent's computer (`GET /api/agents/{id}/computer/files`). */
export interface ClientAgentComputerFile {
  name: string;
  /** Absolute, inside /home/agent: what a drill-in or a download asks for. */
  path: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
}

/** A folder as the route answers it: where it is, and what is in it. */
export interface ClientAgentComputerFolder {
  path: string;
  entries: ClientAgentComputerFile[];
}

/** The agent's work folder, where Files opens. */
export const COMPUTER_WORK_FOLDER = "/home/agent/work";

function readComputerEntry(raw: unknown): ClientAgentComputerFile | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.name !== "string" || typeof entry.path !== "string") return null;
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type === "directory" || entry.type === "dir" ? "directory" : "file",
    sizeBytes: typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : 0,
    modifiedAt: typeof entry.modifiedAt === "string" ? entry.modifiedAt : "",
  };
}

/**
 * A folder on the agent's computer. The route answers `{ path, entries }`
 * (it used to be read as `files`, so every folder looked empty), and a
 * sleeping computer answers 409 with its own sentence, which comes back as a
 * failure to show rather than as an empty folder. Folders first, then names.
 */
export function fetchComputerFiles(id: string, path?: string): Promise<AgentOutcome<ClientAgentComputerFolder>> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return call(`${base(id)}/computer/files${query}`, {}, (d) => {
    const entries = (Array.isArray(d.entries) ? d.entries : [])
      .map(readComputerEntry)
      .filter((entry): entry is ClientAgentComputerFile => entry !== null)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    return { path: typeof d.path === "string" && d.path ? d.path : path ?? COMPUTER_WORK_FOLDER, entries };
  });
}

/** Where a file on the agent's computer downloads from. There is no per-name route. */
export function computerFileDownloadUrl(id: string, path: string): string {
  return `${base(id)}/computer/files?path=${encodeURIComponent(path)}&download=1`;
}

/**
 * The folders between the work folder (or /home/agent) and `path`, for a
 * breadcrumb: each one a label and the path it opens.
 */
export function computerFolderCrumbs(path: string): { label: string; path: string }[] {
  const root = path === COMPUTER_WORK_FOLDER || path.startsWith(`${COMPUTER_WORK_FOLDER}/`) ? COMPUTER_WORK_FOLDER : "/home/agent";
  const crumbs = [{ label: root === COMPUTER_WORK_FOLDER ? "work" : "home", path: root }];
  const rest = path.slice(root.length).split("/").filter(Boolean);
  let at = root;
  for (const part of rest) {
    at = `${at}/${part}`;
    crumbs.push({ label: part, path: at });
  }
  return crumbs;
}

/** A heartbeat for an open viewer. A 409 (another device holds control) comes back with its sentence. */
export function sendComputerHeartbeat(
  id: string,
  body: { mode: "watch" | "control"; ended?: boolean; hidden?: boolean }
): Promise<AgentOutcome<ClientAgentComputer | null>> {
  return call(`${base(id)}/computer/heartbeat`, { method: "POST", body }, (d) => (d.computer ?? null) as ClientAgentComputer | null);
}

/**
 * Hand back from a page that is going away (`pagehide`): a beacon survives
 * the page being torn down where a fetch may not. Falls back to a keepalive
 * fetch. Ends the control session only; it answers no question.
 */
export function endComputerControlOnLeave(id: string): void {
  if (typeof window === "undefined") return;
  const url = `${base(id)}/computer/heartbeat`;
  const payload = JSON.stringify({ mode: "control", ended: true });
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }))) return;
    }
  } catch {
    // fall through to the keepalive fetch
  }
  void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true }).catch(() => {});
}

/** A one-time link to the computer for a new window (`/computer-view?c=…`). */
export function openComputerHandoff(id: string, mode: "watch" | "control"): Promise<AgentOutcome<string>> {
  return call(`${base(id)}/computer/view`, { method: "POST", body: { mode, handoff: true } }, (d) =>
    typeof d.url === "string" ? d.url : ""
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

/** "Keep working on it" / "Continue": the agent drives this goal one bounded step now. */
export function advanceGoal(id: string, goalId: string): Promise<AgentOutcome<{ goal: ClientAgentGoal | null; busy: boolean }>> {
  return call(
    `${base(id)}/goals/${encodeURIComponent(goalId)}/advance`,
    { method: "POST" },
    (d) => ({ goal: (d.goal as ClientAgentGoal | null) ?? null, busy: d.busy === true })
  );
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
