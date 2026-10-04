/**
 * The wire shapes of Agents: what `/api/agents/**` returns and what every
 * client — the web, the Mac, the iPhone — decodes.
 *
 * Client-safe (types only, plus the serializers that turn a Prisma row into
 * one of these), so a component can import the shape without pulling a server
 * module into the bundle. Dates are ISO strings on the wire, like Work's.
 */

import type { Agent, AgentEvent, AgentGoal, AgentIdea, AgentNote } from "@prisma/client";
import { normalizeAgentAvatar, type AgentAvatar } from "@/lib/agents/avatar";
import { agentMemoryAccessOf, type AgentMemoryAccess } from "@/lib/memory-scope";
import {
  agentApprovalMode,
  agentNotifyLevel,
  agentStyle,
  type AgentGoalCadence,
  type AgentGoalStatus,
  type AgentIdeaStatus,
  type AgentNoteSource,
  type AgentNotifyLevel,
  type AgentState,
  type AgentStatus,
  type AgentStyle,
} from "@/lib/agents/domain";
import type { WorkPermissionPolicy } from "@/lib/work/domain";

export interface ClientAgentTask {
  sessionId: string;
  title: string;
  status: string;
  needsAttention: boolean;
  lastActivityAt: string;
  conversationId: string | null;
}

export interface ClientAgentRoutineGlance {
  scheduleId: string;
  name: string;
  nextRunAt: string;
}

export interface ClientAgentComputerGlance {
  enabled: boolean;
  status: string;
}

export interface ClientAgent {
  id: string;
  name: string;
  role: string;
  avatar: AgentAvatar;
  style: AgentStyle;
  instructions: string;
  model: string | null;
  reasoningEffort: string | null;
  approvalMode: WorkPermissionPolicy;
  connectorIds: string[];
  projectId: string | null;
  conversationId: string | null;
  status: AgentStatus;
  proactive: boolean;
  notify?: AgentNotifyLevel;
  pinnedAt?: string | null;
  template: string | null;
  lastReflectedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Derived on read; never stored. `thinking` and `listening` are client-only. */
  state: AgentState;
  stateSentence: string;
  /**
   * The task its state is about: the one waiting on the person, else the one
   * working, else its newest (see `aggregateAgentState`).
   */
  task: ClientAgentTask | null;
  /** How many of its tasks are waiting on the person. */
  needsYou: number;
  nextRoutine: ClientAgentRoutineGlance | null;
  /** Ideas it raised that nobody has started or dismissed. */
  newIdeas: number;
  /** Present when agent computers are configured; null otherwise. */
  computer?: ClientAgentComputerGlance | null;
  /**
   * Its own spending cap inside the account's weekly window, in micro-USD, or
   * null for none (src/lib/agents/budget.ts). Optional for clients written
   * before it; the server always sends it.
   */
  budgetMicroUsd?: number | null;
  /**
   * How much of the person's own memory it reads (src/lib/memory-scope.ts).
   * Optional for clients written before it; the server always sends it.
   */
  memoryAccess?: AgentMemoryAccess;
}

export interface ClientAgentGoal {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  status: AgentGoalStatus;
  cadence: AgentGoalCadence;
  lastCheckInAt: string | null;
  lastCheckInNote: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientAgentIdea {
  id: string;
  agentId: string;
  title: string;
  detail: string;
  prompt: string;
  status: AgentIdeaStatus;
  goalId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ClientAgentNote {
  id: string;
  agentId: string;
  content: string;
  source: AgentNoteSource;
  createdAt: string;
  updatedAt: string;
}

export interface ClientAgentRoutine {
  id: string;
  sessionId: string;
  name: string;
  instructions: string;
  enabled: boolean;
  timezone: string;
  /** The first time trigger, in words: "Every weekday at 09:00". */
  schedule: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

/** One line in the agent's log: its own events, its tasks and their approvals, merged and sorted newest first. */
export interface ClientAgentActivity {
  id: string;
  /** An `AgentEventKind`, `task_<status>` for a task, or `approval` for an answer one of its tasks was given. */
  kind: string;
  title: string;
  detail: string | null;
  at: string;
  sessionId: string | null;
  tone: "neutral" | "attention" | "success" | "danger";
}

export interface ClientAgentComputer {
  enabled: boolean;
  status: string;
  streamOn: boolean;
  lastActiveAt: string | null;
  activeSeconds: number;
  hasPoster: boolean;
  usingNow: { summary: string } | null;
  error: string | null;
  diskMb?: number | null;
  diskQuotaMb?: number;
}

export interface ClientAgentDetail {
  agent: ClientAgent;
  goals: ClientAgentGoal[];
  ideas: ClientAgentIdea[];
  notes: ClientAgentNote[];
  routines: ClientAgentRoutine[];
  tasks: ClientAgentTask[];
  computer?: ClientAgentComputer | null;
  computerConfigured?: boolean;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export interface AgentDerived {
  state: AgentState;
  stateSentence: string;
  task: ClientAgentTask | null;
  needsYou: number;
  nextRoutine: ClientAgentRoutineGlance | null;
  newIdeas: number;
  computer?: ClientAgentComputerGlance | null;
}

export function serializeAgent(agent: Agent, derived: AgentDerived): ClientAgent {
  const raw = agent as Agent & { notify?: string | null; pinnedAt?: Date | null };
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    avatar: normalizeAgentAvatar(agent.avatar, agent.id),
    style: agentStyle(agent.style),
    instructions: agent.instructions,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    approvalMode: agentApprovalMode(agent.approvalMode),
    connectorIds: agent.connectorIds,
    projectId: agent.projectId,
    conversationId: agent.conversationId,
    status: agent.status === "paused" ? "paused" : "active",
    proactive: agent.proactive,
    notify: agentNotifyLevel(raw.notify),
    pinnedAt: iso(raw.pinnedAt),
    template: agent.template,
    lastReflectedAt: iso(agent.lastReflectedAt),
    sortOrder: agent.sortOrder,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    state: derived.state,
    stateSentence: derived.stateSentence,
    task: derived.task,
    needsYou: derived.needsYou,
    nextRoutine: derived.nextRoutine,
    newIdeas: derived.newIdeas,
    computer: derived.computer ?? null,
    budgetMicroUsd: agent.budgetMicroUsd ?? null,
    memoryAccess: agentMemoryAccessOf((agent as Agent & { memoryAccess?: string }).memoryAccess),
  };
}

export function serializeGoal(goal: AgentGoal): ClientAgentGoal {
  return {
    id: goal.id,
    agentId: goal.agentId,
    title: goal.title,
    detail: goal.detail,
    status: goal.status as AgentGoalStatus,
    cadence: goal.cadence as AgentGoalCadence,
    lastCheckInAt: iso(goal.lastCheckInAt),
    lastCheckInNote: goal.lastCheckInNote,
    dueAt: iso(goal.dueAt),
    createdAt: goal.createdAt.toISOString(),
    updatedAt: goal.updatedAt.toISOString(),
  };
}

export function serializeIdea(idea: AgentIdea): ClientAgentIdea {
  return {
    id: idea.id,
    agentId: idea.agentId,
    title: idea.title,
    detail: idea.detail,
    prompt: idea.prompt,
    status: idea.status as AgentIdeaStatus,
    goalId: idea.goalId,
    createdAt: idea.createdAt.toISOString(),
    decidedAt: iso(idea.decidedAt),
  };
}

export function serializeNote(note: AgentNote): ClientAgentNote {
  return {
    id: note.id,
    agentId: note.agentId,
    content: note.content,
    source: note.source as AgentNoteSource,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export function serializeAgentEvent(event: AgentEvent): ClientAgentActivity {
  const detail =
    event.detail && typeof event.detail === "object" && !Array.isArray(event.detail)
      ? (event.detail as Record<string, unknown>)
      : {};
  const text = typeof detail.text === "string" && detail.text.trim() ? detail.text.trim() : null;
  return {
    id: event.id,
    kind: event.kind,
    title: event.title,
    detail: text,
    at: event.createdAt.toISOString(),
    sessionId: event.sessionId,
    tone: event.kind === "paused" ? "attention" : event.kind === "goal_updated" && detail.status === "achieved" ? "success" : "neutral",
  };
}
