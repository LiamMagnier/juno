import "server-only";

/**
 * Agents, on the server.
 *
 * Everything here is an identity layer over Work (docs/design/AGENTS.md §3):
 * an agent's thread is a `Conversation` with `agentId`, its tasks are
 * `WorkSession`s with `agentId`, and its routines are `WorkSchedule`s on those
 * sessions. So this file creates and reads agents, goals, ideas and notes, and
 * for everything that RUNS it goes through the Work implementations the Work
 * routes use — `createWorkSessionForUser`, `startWorkRunForUser` — so an agent
 * meets the plan gate, the usage windows, the rate limit, the concurrency cap
 * and the cost preflight exactly as a person pressing a button does.
 *
 * Every query carries the account's id (src/lib/db.ts guards all five models).
 */

import type { Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { DEFAULT_MODEL } from "@/lib/models";
import { canUseModel } from "@/lib/plans";
import { getUserPlan } from "@/lib/usage";
import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import {
  AGENT_ROUTINE_CADENCE_LABEL,
  MAX_AGENTS_PER_ACCOUNT,
  MAX_AGENT_GOALS,
  MAX_AGENT_NOTES,
  agentApprovalMode,
  agentStateSentence,
  agentTaskKeys,
  deriveAgentState,
  routineTrigger,
  type AgentEventKind,
  type AgentTaskGlance,
  type CreateAgentInput,
  type CreateRoutineInput,
  type PatchAgentInput,
} from "@/lib/agents/domain";
import {
  serializeAgent,
  serializeAgentEvent,
  serializeGoal,
  serializeIdea,
  serializeNote,
  type AgentDerived,
  type ClientAgent,
  type ClientAgentActivity,
  type ClientAgentDetail,
  type ClientAgentRoutine,
  type ClientAgentTask,
} from "@/lib/agents/types";
import { AGENT_PROMPT_TEAMMATES, buildAgentPromptBlock } from "@/lib/agents/prompt";

export interface AgentActor {
  id: string;
  email?: string | null;
  name?: string | null;
}

/** A route's answer: the status and the JSON body, the shape Work's dispatch uses. */
export interface AgentResult<T = unknown> {
  status: number;
  body: Record<string, unknown>;
  value?: T;
}

/** A refusal carries no value, so it fits whatever result the caller promised. */
const refusal = (status: number, error: string, message: string): AgentResult<never> => ({
  status,
  body: { error, message },
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const TASK_SELECT = {
  id: true,
  title: true,
  status: true,
  needsAttention: true,
  lastActivityAt: true,
  conversationId: true,
} as const;

function toTask(row: {
  id: string;
  title: string;
  status: string;
  needsAttention: boolean;
  lastActivityAt: Date;
  conversationId: string | null;
}): ClientAgentTask {
  return {
    sessionId: row.id,
    title: row.title,
    status: row.status,
    needsAttention: row.needsAttention,
    lastActivityAt: row.lastActivityAt.toISOString(),
    conversationId: row.conversationId,
  };
}

/**
 * What every screen that draws an agent needs beside its row: its newest task,
 * how many of its tasks wait on the person, its next routine and its new ideas.
 *
 * Four reads for the whole roster, not four per agent, except the newest task,
 * which is one indexed `findFirst` per agent on (userId, agentId,
 * lastActivityAt). Prisma's `distinct` would read every task each agent ever
 * had and discard all but one in memory, and an agent with an hourly routine
 * has a great many.
 */
async function deriveForAgents(userId: string, agents: readonly Agent[], now: Date): Promise<Map<string, AgentDerived>> {
  const ids = agents.map((agent) => agent.id);
  const result = new Map<string, AgentDerived>();
  if (ids.length === 0) return result;

  const [newest, attention, schedules, ideas] = await Promise.all([
    Promise.all(
      ids.map((agentId) =>
        prisma.workSession.findFirst({
          where: { userId, agentId, deletedAt: null },
          orderBy: { lastActivityAt: "desc" },
          select: TASK_SELECT,
        })
      )
    ),
    prisma.workSession.groupBy({
      by: ["agentId"],
      where: { userId, agentId: { in: ids }, needsAttention: true, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.workSchedule.findMany({
      where: {
        userId,
        enabled: true,
        nextRunAt: { not: null },
        session: { userId, agentId: { in: ids }, deletedAt: null },
      },
      orderBy: { nextRunAt: "asc" },
      select: { id: true, name: true, nextRunAt: true, session: { select: { agentId: true } } },
      take: 200,
    }),
    prisma.agentIdea.groupBy({
      by: ["agentId"],
      where: { userId, agentId: { in: ids }, status: "new" },
      _count: { _all: true },
    }),
  ]);

  const attentionBy = new Map(attention.map((row) => [row.agentId, row._count._all]));
  const ideasBy = new Map(ideas.map((row) => [row.agentId, row._count._all]));
  const nextBy = new Map<string, { scheduleId: string; name: string; nextRunAt: Date }>();
  for (const schedule of schedules) {
    const agentId = schedule.session.agentId;
    if (!agentId || nextBy.has(agentId) || !schedule.nextRunAt) continue;
    nextBy.set(agentId, { scheduleId: schedule.id, name: schedule.name, nextRunAt: schedule.nextRunAt });
  }

  agents.forEach((agent, index) => {
    const row = newest[index];
    const glance: AgentTaskGlance | null = row
      ? {
          sessionId: row.id,
          title: row.title,
          status: row.status,
          needsAttention: row.needsAttention,
          lastActivityAt: row.lastActivityAt,
        }
      : null;
    const state = deriveAgentState({ status: agent.status, task: glance, now });
    const next = nextBy.get(agent.id) ?? null;
    result.set(agent.id, {
      state,
      stateSentence: agentStateSentence({ state, task: glance, nextRoutine: next, now }),
      task: row ? toTask(row) : null,
      needsYou: attentionBy.get(agent.id) ?? 0,
      nextRoutine: next
        ? { scheduleId: next.scheduleId, name: next.name, nextRunAt: next.nextRunAt.toISOString() }
        : null,
      newIdeas: ideasBy.get(agent.id) ?? 0,
    });
  });
  return result;
}

/**
 * A note as it is read: decrypted. `AgentNote.content` is encrypted at rest
 * with the field keyring (src/lib/field-crypto.ts) — it is the agent's memory
 * of a person, the kind of text MemorySummary is encrypted for, and unlike
 * MemoryEntry nothing searches it inside Postgres. Read-both, so a row written
 * before a key existed still reads.
 */
function readNote<T extends { content: string }>(note: T): T {
  return { ...note, content: decryptField(note.content) };
}

const NO_DERIVED: AgentDerived = {
  state: "idle",
  stateSentence: "Ready for something new",
  task: null,
  needsYou: 0,
  nextRoutine: null,
  newIdeas: 0,
};

export async function serializeAgents(userId: string, agents: readonly Agent[], now = new Date()): Promise<ClientAgent[]> {
  const derived = await deriveForAgents(userId, agents, now);
  return agents.map((agent) => serializeAgent(agent, derived.get(agent.id) ?? NO_DERIVED));
}

export async function listAgentsForUser(userId: string, now = new Date()): Promise<ClientAgent[]> {
  const agents = await prisma.agent.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return serializeAgents(userId, agents, now);
}

export async function findAgent(userId: string, agentId: string): Promise<Agent | null> {
  return prisma.agent.findFirst({ where: { id: agentId, userId, deletedAt: null } });
}

function describeTrigger(kind: string, config: unknown): string {
  const body = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const hour = typeof body.hour === "number" ? body.hour : null;
  const minute = typeof body.minute === "number" ? body.minute : 0;
  const clock = hour === null ? null : `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const weekday = typeof body.weekday === "number" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][body.weekday] : null;
  switch (kind) {
    case "hourly":
      return `Every hour at :${String(minute).padStart(2, "0")}`;
    case "daily":
      return `Every day at ${clock}`;
    case "weekdays":
      return `Every weekday at ${clock}`;
    case "weekly":
      return `Every ${weekday ?? "week"} at ${clock}`;
    case "monthly":
      return `Monthly on day ${typeof body.monthday === "number" ? body.monthday : 1} at ${clock}`;
    case "once":
      return `Once at ${clock}`;
    case "cron":
      return "On a custom schedule";
    default:
      return "When something happens";
  }
}

export async function listAgentRoutines(userId: string, agentId: string): Promise<ClientAgentRoutine[]> {
  const rows = await prisma.workSchedule.findMany({
    where: { userId, session: { userId, agentId, deletedAt: null } },
    orderBy: [{ nextRunAt: "asc" }, { createdAt: "desc" }],
    include: { triggers: { where: { userId }, orderBy: { createdAt: "asc" }, take: 1 } },
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    instructions: row.instructions,
    enabled: row.enabled,
    timezone: row.timezone,
    schedule: row.triggers[0] ? describeTrigger(row.triggers[0].kind, row.triggers[0].config) : "No schedule",
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
  }));
}

export async function loadAgentDetail(userId: string, agentId: string, now = new Date()): Promise<ClientAgentDetail | null> {
  const agent = await findAgent(userId, agentId);
  if (!agent) return null;
  const [serialized, goals, ideas, notes, routines, tasks] = await Promise.all([
    serializeAgents(userId, [agent], now),
    prisma.agentGoal.findMany({
      where: { userId, agentId },
      orderBy: [{ createdAt: "asc" }],
      take: MAX_AGENT_GOALS * 2,
    }),
    prisma.agentIdea.findMany({
      where: { userId, agentId, status: "new" },
      orderBy: { createdAt: "desc" },
      take: 12,
    }),
    prisma.agentNote.findMany({
      where: { userId, agentId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_AGENT_NOTES,
    }),
    listAgentRoutines(userId, agentId),
    prisma.workSession.findMany({
      where: { userId, agentId, deletedAt: null },
      orderBy: { lastActivityAt: "desc" },
      select: TASK_SELECT,
      take: 12,
    }),
  ]);
  return {
    agent: serialized[0],
    goals: goals.map(serializeGoal),
    ideas: ideas.map(serializeIdea),
    notes: notes.map((note) => serializeNote(readNote(note))),
    routines,
    tasks: tasks.map(toTask),
  };
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export async function recordAgentEvent(input: {
  userId: string;
  agentId: string;
  kind: AgentEventKind;
  title: string;
  text?: string | null;
  detail?: Record<string, unknown>;
  sessionId?: string | null;
}): Promise<void> {
  await prisma.agentEvent
    .create({
      data: {
        userId: input.userId,
        agentId: input.agentId,
        kind: input.kind,
        title: input.title.slice(0, 200),
        detail: { ...(input.detail ?? {}), ...(input.text ? { text: input.text.slice(0, 1_000) } : {}) },
        sessionId: input.sessionId ?? null,
      },
    })
    // The log is a record of what happened, never a precondition for it: a
    // failed write here must not turn a goal that was saved into an error.
    .catch((err) => {
      console.error("[agents] could not record an event", {
        agentId: input.agentId,
        kind: input.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/** One line of a longer text, cut at a word where one is close. */
function clipLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

const TASK_TONE: Record<string, ClientAgentActivity["tone"]> = {
  completed: "success",
  waiting_input: "attention",
  waiting_approval: "attention",
  host_offline: "attention",
  failed: "danger",
  interrupted: "danger",
  budget_exceeded: "danger",
  timed_out: "danger",
};

const TASK_VERB: Record<string, string> = {
  draft: "Drafted",
  queued: "Queued",
  preparing: "Getting ready for",
  running: "Working on",
  waiting_input: "Asked a question about",
  waiting_approval: "Asked for approval on",
  paused: "Paused",
  completed: "Finished",
  failed: "Could not finish",
  cancelled: "Stopped",
  interrupted: "Was interrupted during",
  host_offline: "Waiting for your Mac on",
  budget_exceeded: "Ran out of usage window on",
  timed_out: "Timed out on",
};

/** Answered, by a person: the decisions an approval line reports. */
const DECIDED_APPROVALS = ["allowed", "allowed_always", "denied"];

/** Longest approval summary a log line keeps. The run's own log has it whole. */
const MAX_APPROVAL_LINE_CHARS = 160;

/**
 * The log: the agent's own events, its tasks and the approvals its tasks were
 * given, merged, newest first.
 *
 * A task contributes its CURRENT state at its last activity, not every
 * transition — the transitions are the run's own log, one press away in the
 * thread. What the agent's log answers is "what has it been doing", and one
 * line per task says that without drowning the goals and ideas between them.
 *
 * Approvals are the exception, one line per answer, because each is a
 * decision the person made rather than a step the agent took, and "what did I
 * let it do" is the question an agent's log exists to answer. Read from
 * Work's own rows at the moment of reading, never copied into the agent's
 * events, so the log cannot disagree with the run about what was allowed.
 */
export async function listAgentActivity(userId: string, agentId: string, limit = 60): Promise<ClientAgentActivity[]> {
  const [events, sessions, approvals] = await Promise.all([
    prisma.agentEvent.findMany({
      where: { userId, agentId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.workSession.findMany({
      where: { userId, agentId, deletedAt: null, status: { not: "draft" } },
      orderBy: { lastActivityAt: "desc" },
      select: TASK_SELECT,
      take: limit,
    }),
    prisma.workApproval.findMany({
      where: {
        userId,
        decision: { in: DECIDED_APPROVALS },
        decidedAt: { not: null },
        run: { userId, session: { userId, agentId, deletedAt: null } },
      },
      orderBy: { decidedAt: "desc" },
      select: { id: true, summary: true, decision: true, decidedAt: true, run: { select: { sessionId: true } } },
      take: limit,
    }),
  ]);
  const items: ClientAgentActivity[] = [
    ...events.filter((event) => event.kind !== "task_started").map(serializeAgentEvent),
    ...sessions.map((session) => ({
      id: `task:${session.id}`,
      kind: `task_${session.status}`,
      title: `${TASK_VERB[session.status] ?? "Worked on"} ${session.title}`,
      detail: null,
      at: session.lastActivityAt.toISOString(),
      sessionId: session.id,
      tone: TASK_TONE[session.status] ?? "neutral",
    })),
    ...approvals.map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval",
      title: `${approval.decision === "denied" ? "Refused" : "Approved"}: ${clipLine(approval.summary, MAX_APPROVAL_LINE_CHARS)}`,
      detail: null,
      at: (approval.decidedAt ?? new Date(0)).toISOString(),
      sessionId: approval.run.sessionId,
      tone: "neutral" as const,
    })),
  ];
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

/**
 * The agent's thread, created the first time anything needs it.
 *
 * Race-safe without a transaction: the conversation is created, then CLAIMED
 * with a conditional update that only succeeds while the agent still has no
 * thread (or still has the stale one this call saw). A second caller that lost
 * the race deletes the conversation it made and returns the winner's, so two
 * tabs opening a new agent at once still leave it exactly one thread.
 */
export async function ensureAgentThread(userId: string, agent: Agent): Promise<string> {
  if (agent.conversationId) {
    const existing = await prisma.conversation.findFirst({
      where: { id: agent.conversationId, userId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const settings = agent.model
    ? null
    : await prisma.settings.findFirst({ where: { userId }, select: { defaultModel: true } });
  const conversation = await prisma.conversation.create({
    data: {
      userId,
      title: agent.name,
      // The person named the agent; an auto-titler must not rename its thread
      // after the first thing it was asked.
      titleSource: "manual",
      kind: "chat",
      agentId: agent.id,
      projectId: agent.projectId,
      model: agent.model ?? settings?.defaultModel ?? DEFAULT_MODEL,
      activeConnectors: agent.connectorIds,
    },
    select: { id: true },
  });
  const claimed = await prisma.agent.updateMany({
    where: { id: agent.id, userId, conversationId: agent.conversationId },
    data: { conversationId: conversation.id },
  });
  if (claimed.count === 1) return conversation.id;
  await prisma.conversation.deleteMany({ where: { id: conversation.id, userId } }).catch(() => undefined);
  const winner = await prisma.agent.findFirst({ where: { id: agent.id, userId }, select: { conversationId: true } });
  return winner?.conversationId ?? conversation.id;
}

// ---------------------------------------------------------------------------
// Hiring, editing, pausing, retiring
// ---------------------------------------------------------------------------

/**
 * The linked apps among the ones asked for.
 *
 * An agent may be hired before an app is connected, and an app may be
 * disconnected after; a grant for an app nobody linked is a permission waiting
 * to become real the day somebody links it (the argument in
 * `createWorkSessionForUser`). So the agent stores only what is linked now.
 */
async function linkedConnectorIds(userId: string, wanted: readonly string[]): Promise<string[]> {
  if (wanted.length === 0) return [];
  const linked = await prisma.connection.findMany({
    where: { userId, provider: { in: [...wanted] } },
    select: { provider: true },
  });
  const have = new Set(linked.map((row) => row.provider));
  return wanted.filter((id) => have.has(id));
}

/**
 * Whether the account's plan includes the model an agent is being set to.
 *
 * Asked when the agent is saved rather than discovered at its first task,
 * where Work's plan gate would refuse it in a thread nobody is watching. The
 * chat route still falls back quietly if a plan changes later
 * (`agentTurnModel`); this is only about not accepting a choice that could
 * never have worked.
 */
async function modelInPlan(userId: string, model: string | null | undefined): Promise<boolean> {
  if (!model) return true;
  return canUseModel(await getUserPlan(userId), model);
}

const MODEL_NOT_IN_PLAN = "Your plan does not include that model. Pick another one, or keep your default.";

async function ownedProjectId(userId: string, projectId: string | null | undefined): Promise<string | null | undefined> {
  if (projectId === undefined) return undefined;
  if (projectId === null) return null;
  const project = await prisma.project.findFirst({ where: { id: projectId, userId }, select: { id: true } });
  return project ? project.id : undefined;
}

export async function createAgentForUser(user: AgentActor, input: CreateAgentInput): Promise<AgentResult<ClientAgent>> {
  const count = await prisma.agent.count({ where: { userId: user.id, deletedAt: null } });
  if (count >= MAX_AGENTS_PER_ACCOUNT) {
    return refusal(
      409,
      "too_many_agents",
      `You have ${MAX_AGENTS_PER_ACCOUNT} agents, which is the most one account keeps. Retire one to hire another.`
    );
  }
  const projectId = await ownedProjectId(user.id, input.projectId);
  if (input.projectId && projectId === undefined) return refusal(404, "project_not_found", "That project no longer exists.");
  if (!(await modelInPlan(user.id, input.model))) return refusal(403, "plan_locked", MODEL_NOT_IN_PLAN);
  const connectorIds = await linkedConnectorIds(user.id, input.connectorIds);

  const agent = await prisma.agent.create({
    data: {
      userId: user.id,
      name: input.name,
      role: input.role,
      avatar: {},
      style: input.style,
      instructions: input.instructions,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      approvalMode: input.approvalMode,
      connectorIds,
      projectId: projectId ?? null,
      proactive: input.proactive,
      template: input.template ?? null,
      sortOrder: count,
    },
  });
  // The face is written after the id exists, so a hire with no face chosen
  // gets the one seeded from its id — the same one a client would draw.
  const withFace = await prisma.agent.update({
    where: { id: agent.id, userId: user.id },
    data: { avatar: { ...normalizeAgentAvatar(input.avatar ?? null, agent.id) } },
  });
  await ensureAgentThread(user.id, withFace);
  await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "hired", title: `${agent.name} joined` });
  if (input.firstGoal) {
    await prisma.agentGoal.create({
      data: { userId: user.id, agentId: agent.id, title: input.firstGoal, cadence: "weekly" },
    });
    await recordAgentEvent({
      userId: user.id,
      agentId: agent.id,
      kind: "goal_set",
      title: `New goal: ${input.firstGoal}`,
    });
  }
  const fresh = await findAgent(user.id, agent.id);
  const [serialized] = await serializeAgents(user.id, fresh ? [fresh] : [withFace]);
  return { status: 201, body: { agent: serialized }, value: serialized };
}

/**
 * The routines an agent owns, switched off or back on with it.
 *
 * Pausing records WHICH routines it switched off, in the pause event, and
 * resuming switches back on only those — so a routine the person had already
 * turned off themselves stays off after a pause and resume, instead of the
 * resume quietly overruling a decision nobody asked it to revisit.
 */
async function pauseRoutines(userId: string, agentId: string): Promise<string[]> {
  const enabled = await prisma.workSchedule.findMany({
    where: { userId, enabled: true, session: { userId, agentId } },
    select: { id: true },
  });
  const ids = enabled.map((row) => row.id);
  if (ids.length > 0) {
    await prisma.workSchedule.updateMany({ where: { userId, id: { in: ids } }, data: { enabled: false } });
  }
  return ids;
}

async function resumeRoutines(userId: string, agentId: string): Promise<void> {
  const pause = await prisma.agentEvent.findFirst({
    where: { userId, agentId, kind: "paused" },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  const detail = pause?.detail && typeof pause.detail === "object" && !Array.isArray(pause.detail)
    ? (pause.detail as Record<string, unknown>)
    : {};
  const ids = Array.isArray(detail.routineIds) ? detail.routineIds.filter((id): id is string => typeof id === "string") : [];
  if (ids.length === 0) return;
  await prisma.workSchedule.updateMany({
    where: { userId, id: { in: ids }, session: { userId, agentId } },
    data: { enabled: true },
  });
}

export async function updateAgentForUser(
  user: AgentActor,
  agentId: string,
  patch: PatchAgentInput
): Promise<AgentResult<ClientAgent>> {
  const agent = await findAgent(user.id, agentId);
  if (!agent) return refusal(404, "not_found", "That agent no longer exists.");

  const projectId = await ownedProjectId(user.id, patch.projectId);
  if (patch.projectId && projectId === undefined) return refusal(404, "project_not_found", "That project no longer exists.");
  // Only a new choice is checked: a plan that changed since the model was set
  // is the chat route's to absorb, and must not stop an unrelated edit.
  const modelChanged = patch.model !== undefined && patch.model !== agent.model;
  if (modelChanged && !(await modelInPlan(user.id, patch.model))) return refusal(403, "plan_locked", MODEL_NOT_IN_PLAN);
  const connectorIds = patch.connectorIds ? await linkedConnectorIds(user.id, patch.connectorIds) : undefined;

  const updated = await prisma.agent.update({
    where: { id: agent.id, userId: user.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.avatar !== undefined ? { avatar: { ...patch.avatar } } : {}),
      ...(patch.style !== undefined ? { style: patch.style } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { reasoningEffort: patch.reasoningEffort } : {}),
      ...(patch.approvalMode !== undefined ? { approvalMode: patch.approvalMode } : {}),
      ...(connectorIds !== undefined ? { connectorIds } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.proactive !== undefined ? { proactive: patch.proactive } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    },
  });

  // The thread follows the agent it belongs to: its title is the agent's name,
  // the apps switched on in it are the apps the agent may use, and its picker
  // starts on the agent's model, so the next message is answered by the model
  // the person just chose here unless they pick another in the thread. Back to
  // the default, it starts where a new chat would, as when the thread was made
  // (`ensureAgentThread`).
  if (agent.conversationId && (patch.name !== undefined || connectorIds !== undefined || modelChanged)) {
    const threadModel = modelChanged
      ? (patch.model ??
        (await prisma.settings.findFirst({ where: { userId: user.id }, select: { defaultModel: true } }))?.defaultModel ??
        DEFAULT_MODEL)
      : undefined;
    await prisma.conversation.updateMany({
      where: { id: agent.conversationId, userId: user.id },
      data: {
        ...(patch.name !== undefined ? { title: patch.name, titleSource: "manual" } : {}),
        ...(connectorIds !== undefined ? { activeConnectors: connectorIds } : {}),
        ...(threadModel !== undefined ? { model: threadModel } : {}),
      },
    });
  }

  if (patch.status && patch.status !== agent.status) {
    if (patch.status === "paused") {
      const routineIds = await pauseRoutines(user.id, agent.id);
      await recordAgentEvent({
        userId: user.id,
        agentId: agent.id,
        kind: "paused",
        title: `${updated.name} was paused`,
        detail: { routineIds },
      });
    } else {
      await resumeRoutines(user.id, agent.id);
      await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "resumed", title: `${updated.name} is back` });
    }
  } else {
    const changed = Object.keys(patch).filter((key) => key !== "sortOrder" && key !== "status");
    if (changed.length > 0) {
      await recordAgentEvent({
        userId: user.id,
        agentId: agent.id,
        kind: "updated",
        title: "Profile updated",
        detail: { fields: changed },
      });
    }
  }

  const [serialized] = await serializeAgents(user.id, [updated]);
  return { status: 200, body: { agent: serialized }, value: serialized };
}

/**
 * Retires an agent. Its routines stop; its thread and its tasks stay, because
 * they are the account's record of what was done, and they are readable as an
 * ordinary chat and ordinary tasks once nobody owns them.
 */
export async function retireAgentForUser(user: AgentActor, agentId: string): Promise<AgentResult> {
  const agent = await findAgent(user.id, agentId);
  if (!agent) return refusal(404, "not_found", "That agent no longer exists.");
  await pauseRoutines(user.id, agent.id);
  await prisma.agent.updateMany({
    where: { id: agent.id, userId: user.id },
    data: { deletedAt: new Date(), status: "paused" },
  });
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Running work as the agent
// ---------------------------------------------------------------------------

export type StartAgentTaskOutcome =
  | { kind: "started"; sessionId: string; conversationId: string; replay: boolean }
  /** Nothing ran yet. `sessionId` is the draft that waits for the answer, for a caller who has to put it away. */
  | { kind: "confirm"; sessionId: string; estimatedCostMicroUsd: number }
  | { kind: "refused"; status: number; body: Record<string, unknown> };

/**
 * Starts a task as the agent: in its thread, under its autonomy, with its apps.
 *
 * The same two calls the Work routes and the chat's `start_task` make, in the
 * same order, so nothing an agent starts can skip a check a person's task
 * meets. The one difference from `start_task` is who is asked about cost: a
 * chat turn raises the inline approval card, and a press on an agent's page
 * returns `confirm` with the estimate, for the page to ask the person who is
 * standing right there. `confirmExpensive` is only ever sent after they said
 * yes.
 *
 * `askFirst` returns `confirm` whatever the estimate, for a caller that must
 * put every start in front of a person (a handoff from another agent's thread,
 * src/lib/chat/handoff-tool.ts). The confirmation lands on the same key, so
 * answering it starts the draft that was asked about rather than a second one.
 */
export async function startAgentTask(
  user: AgentActor,
  agent: Agent,
  input: { title: string; goal: string; idempotencyKey: string; confirmExpensive?: boolean; askFirst?: boolean }
): Promise<StartAgentTaskOutcome> {
  if (agent.status !== "active") {
    return {
      kind: "refused",
      status: 409,
      body: { error: "agent_paused", message: `${agent.name} is paused. Resume it to start something new.` },
    };
  }
  const [dispatch, protocol] = await Promise.all([import("@/lib/work/dispatch"), import("@/app/api/work/protocol")]);
  const conversationId = await ensureAgentThread(user.id, agent);
  const connectorIds = await linkedConnectorIds(user.id, agent.connectorIds);
  const keys = agentTaskKeys(agent.id, input.idempotencyKey);

  const body = protocol.createSessionSchema.safeParse({
    goal: input.goal,
    title: input.title,
    requestedTarget: "automatic",
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    conversationId,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    permissionPolicy: agentApprovalMode(agent.approvalMode),
    connectorIds,
    idempotencyKey: keys.session,
  });
  if (!body.success) {
    return { kind: "refused", status: 400, body: { error: "invalid_input", message: "That task could not be described." } };
  }
  const created = await dispatch.createWorkSessionForUser(user, body.data);
  if (!created.session) return { kind: "refused", status: created.status, body: created.body };
  const session = created.session;
  await prisma.workSession.updateMany({
    where: { id: session.id, userId: user.id, agentId: null },
    data: { agentId: agent.id, title: input.title, titleSource: "manual" },
  });

  const runBody = protocol.startRunSchema.parse({
    origin: "manual",
    requestedTarget: "automatic",
    idempotencyKey: keys.run,
    ...(input.confirmExpensive ? { confirmExpensive: true } : {}),
  });
  const preflight = await dispatch.startWorkRunForUser(user, session, runBody, { preflightOnly: true });
  if (preflight.run) {
    return { kind: "started", sessionId: session.id, conversationId, replay: true };
  }
  if (!preflight.preflight || preflight.status >= 400) {
    await discardDraft(user.id, session.id);
    return { kind: "refused", status: preflight.status, body: preflight.body };
  }
  if ((preflight.preflight.requiresConfirmation || input.askFirst) && !input.confirmExpensive) {
    // The draft is kept: the confirmation lands on the same idempotency key
    // and so on this session, rather than making a second one.
    return { kind: "confirm", sessionId: session.id, estimatedCostMicroUsd: preflight.preflight.estimatedCostMicroUsd };
  }
  const dispatched = await dispatch.startWorkRunForUser(user, session, runBody);
  if (!dispatched.run) {
    await discardDraft(user.id, session.id);
    return { kind: "refused", status: dispatched.status, body: dispatched.body };
  }
  await recordAgentEvent({
    userId: user.id,
    agentId: agent.id,
    kind: "task_started",
    title: `Started ${input.title}`,
    sessionId: session.id,
  });
  return { kind: "started", sessionId: session.id, conversationId, replay: false };
}

async function discardDraft(userId: string, sessionId: string): Promise<void> {
  await prisma.workSession
    .updateMany({ where: { id: sessionId, userId, status: "draft", deletedAt: null }, data: { deletedAt: new Date() } })
    .catch(() => undefined);
}

/**
 * Puts away the draft a `confirm` left waiting, when the answer was no. Only
 * ever a draft: a session that has a run is never touched.
 */
export async function discardAgentTaskDraft(userId: string, sessionId: string): Promise<void> {
  await discardDraft(userId, sessionId);
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

/**
 * A routine owned by the agent: a task it re-runs on a clock, firing into its
 * thread.
 *
 * The session is made through `createWorkSessionForUser` (so the plan gate,
 * the project defaults and the connector ownership check all apply) and the
 * schedule is written with the parser's own trigger output and bounds
 * (`createScheduleSchema`, `normalizeTriggerDrafts`), as
 * `POST /api/work/schedules` writes one. It is a cloud routine: an agent's
 * page offers the clocks, and a routine on a Mac or on an event is one step
 * away in Automations, where the full editor already lives.
 */
export async function createAgentRoutine(
  user: AgentActor,
  agent: Agent,
  input: CreateRoutineInput
): Promise<AgentResult<ClientAgentRoutine>> {
  const [dispatch, protocol, schedule, triggers] = await Promise.all([
    import("@/lib/work/dispatch"),
    import("@/app/api/work/protocol"),
    import("@/lib/work/schedule"),
    import("@/lib/work/triggers"),
  ]);
  if (!schedule.isValidTimeZone(input.timezone)) {
    return refusal(400, "invalid_timezone", `Unknown timezone "${input.timezone}".`);
  }
  const parsed = schedule.createScheduleSchema.safeParse({
    name: input.name,
    instructions: input.instructions,
    timezone: input.timezone,
    target: "cloud",
    triggers: [routineTrigger(input)],
    ...(agent.model ? { model: agent.model } : {}),
  });
  if (!parsed.success) return refusal(400, "invalid_input", "That routine could not be read.");
  const drafts = triggers.normalizeTriggerDrafts(parsed.data.triggers, parsed.data.timezone);
  if (!drafts.ok) return refusal(400, "invalid_trigger", drafts.message);

  const conversationId = await ensureAgentThread(user.id, agent);
  const connectorIds = await linkedConnectorIds(user.id, agent.connectorIds);
  const sessionBody = protocol.createSessionSchema.safeParse({
    goal: parsed.data.instructions,
    title: parsed.data.name,
    requestedTarget: "cloud",
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    conversationId,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
    permissionPolicy: agentApprovalMode(agent.approvalMode),
    connectorIds,
  });
  if (!sessionBody.success) return refusal(400, "invalid_input", "That routine could not be read.");
  const created = await dispatch.createWorkSessionForUser(user, sessionBody.data);
  if (!created.session) return { status: created.status, body: created.body };
  await prisma.workSession.updateMany({
    where: { id: created.session.id, userId: user.id },
    data: { agentId: agent.id, title: parsed.data.name, titleSource: "manual" },
  });

  const body = parsed.data;
  const row = await prisma.workSchedule.create({
    data: {
      userId: user.id,
      sessionId: created.session.id,
      name: body.name,
      // A routine made for a paused agent is made paused, and remembered as one
      // the pause switched off, so resuming the agent starts it.
      enabled: agent.status === "active",
      instructions: body.instructions,
      target: body.target,
      hostId: null,
      timezone: body.timezone,
      runKind: "work",
      codeConfig: {},
      runConfig: { model: body.model ?? null, requiredCapabilities: [] },
      maxCostMicroUsd: 0,
      maxTokens: 0,
      maxRuntimeMs: 0,
      unattendedPolicy: body.unattendedPolicy,
      hostOfflinePolicy: body.hostOfflinePolicy,
      missedRunPolicy: body.missedRunPolicy,
      notifyPolicy: body.notifyPolicy,
      maxConcurrentRuns: body.maxConcurrentRuns,
      nextRunAt: schedule.nextFireForTriggers(drafts.drafts, body.timezone, new Date()),
      triggers: {
        create: drafts.drafts.map((draft) => ({
          userId: user.id,
          kind: draft.kind,
          config: draft.config,
          enabled: draft.enabled,
          dedupeWindowSec: draft.dedupeWindowSec,
        })),
      },
    },
  });
  if (agent.status !== "active") {
    const pause = await prisma.agentEvent.findFirst({
      where: { userId: user.id, agentId: agent.id, kind: "paused" },
      orderBy: { createdAt: "desc" },
      select: { id: true, detail: true },
    });
    if (pause) {
      const detail = pause.detail && typeof pause.detail === "object" && !Array.isArray(pause.detail)
        ? (pause.detail as Record<string, unknown>)
        : {};
      const ids = Array.isArray(detail.routineIds) ? detail.routineIds : [];
      await prisma.agentEvent.updateMany({
        where: { id: pause.id, userId: user.id },
        data: { detail: { ...detail, routineIds: [...ids, row.id] } },
      });
    }
  }
  await recordAgentEvent({
    userId: user.id,
    agentId: agent.id,
    kind: "routine_created",
    title: `New routine: ${body.name}`,
    text: AGENT_ROUTINE_CADENCE_LABEL[input.cadence],
    sessionId: created.session.id,
  });
  const routines = await listAgentRoutines(user.id, agent.id);
  const routine = routines.find((item) => item.id === row.id);
  return { status: 201, body: { routine }, value: routine };
}

// ---------------------------------------------------------------------------
// The chat turn
// ---------------------------------------------------------------------------

/**
 * What the chat route appends for a turn in an agent's thread, or null.
 *
 * Null for a retired agent: its thread is kept and reads as an ordinary chat,
 * so it answers as Juno rather than as someone who no longer works here.
 *
 * `handoff` says the turn may carry `hand_off_to_teammate`; the answer's
 * `handoff` says whether it does, which also needs a teammate to hand to. The
 * route builds the tool from the answer, so the prompt and the tool can never
 * disagree about whether it exists.
 */
export async function agentChatContext(
  user: AgentActor,
  agentId: string,
  options: { taskHandoff: boolean; handoff?: boolean }
): Promise<{ agent: Agent; block: string; handoff: boolean } | null> {
  const agent = await findAgent(user.id, agentId);
  if (!agent) return null;
  const [goals, notes, teammates] = await Promise.all([
    prisma.agentGoal.findMany({
      where: { userId: user.id, agentId, status: "active" },
      orderBy: { createdAt: "asc" },
      take: 8,
      select: { title: true, status: true, lastCheckInNote: true },
    }),
    prisma.agentNote
      .findMany({
        where: { userId: user.id, agentId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 24,
        select: { content: true, source: true },
      })
      .then((rows) => rows.map((row) => ({ ...row, content: decryptField(row.content) }))),
    // Paused teammates are left out: nothing can be handed to them, and a
    // suggestion to ask one is a suggestion to ask somebody who is asleep.
    prisma.agent.findMany({
      where: { userId: user.id, deletedAt: null, status: "active", id: { not: agentId } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: AGENT_PROMPT_TEAMMATES,
      select: { name: true, role: true },
    }),
  ]);
  const handoff = options.handoff === true && teammates.length > 0;
  return {
    agent,
    handoff,
    block: buildAgentPromptBlock(
      {
        name: agent.name,
        role: agent.role,
        style: agent.style,
        instructions: agent.instructions,
        approvalMode: agent.approvalMode,
        goals,
        notes,
        teammates,
        taskHandoff: options.taskHandoff,
        handoff,
      },
      user.name
    ),
  };
}

// ---------------------------------------------------------------------------
// Goals, notes and ideas
// ---------------------------------------------------------------------------

export async function createAgentGoal(
  user: AgentActor,
  agent: Agent,
  input: { title: string; detail: string; cadence: string; dueAt?: string | null }
): Promise<AgentResult> {
  const count = await prisma.agentGoal.count({
    where: { userId: user.id, agentId: agent.id, status: { in: ["active", "paused"] } },
  });
  if (count >= MAX_AGENT_GOALS) {
    return refusal(409, "too_many_goals", `${agent.name} already has ${MAX_AGENT_GOALS} open goals. Finish or drop one first.`);
  }
  const goal = await prisma.agentGoal.create({
    data: {
      userId: user.id,
      agentId: agent.id,
      title: input.title,
      detail: input.detail,
      cadence: input.cadence,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
    },
  });
  await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "goal_set", title: `New goal: ${goal.title}` });
  return { status: 201, body: { goal: serializeGoal(goal) } };
}

export async function updateAgentGoal(
  user: AgentActor,
  agent: Agent,
  goalId: string,
  patch: { title?: string; detail?: string; cadence?: string; status?: string; dueAt?: string | null }
): Promise<AgentResult> {
  const goal = await prisma.agentGoal.findFirst({ where: { id: goalId, userId: user.id, agentId: agent.id } });
  if (!goal) return refusal(404, "not_found", "That goal no longer exists.");
  const updated = await prisma.agentGoal.update({
    where: { id: goal.id, userId: user.id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.cadence !== undefined ? { cadence: patch.cadence } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null } : {}),
    },
  });
  if (patch.status && patch.status !== goal.status) {
    const verb =
      patch.status === "achieved" ? "Achieved" : patch.status === "dropped" ? "Dropped" : patch.status === "paused" ? "Paused" : "Resumed";
    await recordAgentEvent({
      userId: user.id,
      agentId: agent.id,
      kind: "goal_updated",
      title: `${verb}: ${updated.title}`,
      detail: { status: patch.status },
    });
  }
  return { status: 200, body: { goal: serializeGoal(updated) } };
}

export async function deleteAgentGoal(user: AgentActor, agent: Agent, goalId: string): Promise<AgentResult> {
  const deleted = await prisma.agentGoal.deleteMany({ where: { id: goalId, userId: user.id, agentId: agent.id } });
  if (deleted.count === 0) return refusal(404, "not_found", "That goal no longer exists.");
  return { status: 200, body: { ok: true } };
}

export async function listAgentNotes(user: AgentActor, agent: Agent) {
  const notes = await prisma.agentNote.findMany({
    where: { userId: user.id, agentId: agent.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: MAX_AGENT_NOTES,
  });
  return notes.map((note) => serializeNote(readNote(note)));
}

export async function createAgentNote(user: AgentActor, agent: Agent, content: string): Promise<AgentResult> {
  const count = await prisma.agentNote.count({ where: { userId: user.id, agentId: agent.id, deletedAt: null } });
  if (count >= MAX_AGENT_NOTES) {
    return refusal(409, "too_many_notes", `${agent.name} already keeps ${MAX_AGENT_NOTES} notes. Delete some it no longer needs.`);
  }
  const note = await prisma.agentNote.create({
    data: { userId: user.id, agentId: agent.id, content: encryptField(content), source: "user" },
  });
  // The log says THAT it learned something, never what: the note is encrypted
  // at rest and the log is not, so copying it there would undo the one and
  // leave a plaintext duplicate of the person's own words.
  await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "note_added", title: "You told it something" });
  return { status: 201, body: { note: serializeNote({ ...note, content }) } };
}

export async function updateAgentNote(user: AgentActor, agent: Agent, noteId: string, content: string): Promise<AgentResult> {
  const note = await prisma.agentNote.findFirst({ where: { id: noteId, userId: user.id, agentId: agent.id, deletedAt: null } });
  if (!note) return refusal(404, "not_found", "That note no longer exists.");
  // An edited note is the person's words now, whoever wrote it first.
  const updated = await prisma.agentNote.update({
    where: { id: note.id, userId: user.id },
    data: { content: encryptField(content), source: "user" },
  });
  return { status: 200, body: { note: serializeNote({ ...updated, content }) } };
}

/** Deleted means gone from every later turn, which reads notes with `deletedAt: null`. */
export async function deleteAgentNote(user: AgentActor, agent: Agent, noteId: string): Promise<AgentResult> {
  const deleted = await prisma.agentNote.updateMany({
    where: { id: noteId, userId: user.id, agentId: agent.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (deleted.count === 0) return refusal(404, "not_found", "That note no longer exists.");
  return { status: 200, body: { ok: true } };
}

/**
 * Start or dismiss an idea.
 *
 * Start runs the idea's prompt as a task through `startAgentTask`, keyed on
 * the idea, so a double press or a retried request is one task; the idea is
 * marked started only once the task really is. A `confirm` answer leaves the
 * idea new, for the page to ask about the estimate and press again.
 */
export async function decideAgentIdea(
  user: AgentActor,
  agent: Agent,
  ideaId: string,
  input: { action: "start" | "dismiss"; confirmExpensive?: boolean }
): Promise<AgentResult> {
  const idea = await prisma.agentIdea.findFirst({ where: { id: ideaId, userId: user.id, agentId: agent.id } });
  if (!idea) return refusal(404, "not_found", "That idea no longer exists.");
  if (idea.status !== "new") {
    return { status: 200, body: { idea: serializeIdea(idea), replay: true } };
  }
  if (input.action === "dismiss") {
    const updated = await prisma.agentIdea.update({
      where: { id: idea.id, userId: user.id },
      data: { status: "dismissed", decidedAt: new Date() },
    });
    await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "idea_dismissed", title: `Not now: ${idea.title}` });
    return { status: 200, body: { idea: serializeIdea(updated) } };
  }
  const outcome = await startAgentTask(user, agent, {
    title: idea.title,
    goal: idea.prompt,
    idempotencyKey: `idea:${idea.id}`,
    confirmExpensive: input.confirmExpensive,
  });
  if (outcome.kind === "confirm") {
    return {
      status: 409,
      body: {
        error: "confirm_expensive",
        estimatedCostMicroUsd: outcome.estimatedCostMicroUsd,
        message: `This will cost about $${(outcome.estimatedCostMicroUsd / 1_000_000).toFixed(2)} of your usage window. Start it?`,
      },
    };
  }
  if (outcome.kind === "refused") return { status: outcome.status, body: outcome.body };
  const updated = await prisma.agentIdea.update({
    where: { id: idea.id, userId: user.id },
    data: { status: "started", decidedAt: new Date() },
  });
  await recordAgentEvent({
    userId: user.id,
    agentId: agent.id,
    kind: "idea_started",
    title: `Started: ${idea.title}`,
    sessionId: outcome.sessionId,
  });
  return {
    status: 200,
    body: { idea: serializeIdea(updated), sessionId: outcome.sessionId, conversationId: outcome.conversationId },
  };
}

/** The agent whose thread a conversation is, with its derived state, or null. */
export async function agentForThread(userId: string, conversationId: string): Promise<ClientAgent | null> {
  const agent = await prisma.agent.findFirst({ where: { userId, conversationId, deletedAt: null } });
  if (!agent) return null;
  const [serialized] = await serializeAgents(userId, [agent]);
  return serialized ?? null;
}
