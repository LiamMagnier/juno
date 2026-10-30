/**
 * The vocabulary of Agents, and the decisions worth being sure about.
 *
 * `docs/design/AGENTS.md` is the argument; this file is what it means as
 * values. The same discipline as `src/lib/work/domain.ts`: a value that is not
 * here is not a value an agent has, and every decision a screen would
 * otherwise make for itself — what state an agent is in, what the sentence
 * beside its face says — is a pure function here, tested without a database
 * or a browser (`tests/agents-domain.test.ts`).
 */

import { z } from "zod";
import {
  WORK_PERMISSION_POLICIES,
  isLiveStatus,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { AGENT_EYES, AGENT_MARKS, AGENT_SHAPES, AGENT_TONES } from "@/lib/agents/avatar";
import { resolveModel } from "@/lib/models";
import { MAX_MEMBER_BUDGET_MICRO_USD } from "@/lib/agents/budget";
import { REASONING_TIERS } from "@/lib/model-metrics";
import type { ReasoningEffort } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { AgentState, AgentTaskGlance } from "@/lib/agents/state-labels";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** How it talks. Never what it may do — that is `approvalMode`. */
export const AGENT_STYLES = ["warm", "direct", "playful", "formal"] as const;
export type AgentStyle = (typeof AGENT_STYLES)[number];

export const AGENT_STYLE_LABEL: Record<AgentStyle, string> = {
  warm: "Warm",
  direct: "Direct",
  playful: "Playful",
  formal: "Formal",
};

/** The line under each style where a person picks it. */
export const AGENT_STYLE_SUMMARY: Record<AgentStyle, string> = {
  warm: "Friendly and encouraging, still to the point.",
  direct: "Short answers, the decision first, no pleasantries.",
  playful: "Light and quick, with a little personality.",
  formal: "Measured and precise, the way you would write to a client.",
};

/** What the model is told for each style. One sentence, so it cannot drown the brief. */
export const AGENT_STYLE_PROMPT: Record<AgentStyle, string> = {
  warm: "Be warm and encouraging, but get to the point.",
  direct: "Be direct: lead with the answer or the decision, keep it short, skip pleasantries.",
  playful: "Be light and quick, with a little personality, never at the expense of clarity.",
  formal: "Be measured and precise, in complete sentences, as you would write to a client.",
};

/** A paused agent keeps everything and starts nothing. */
export const AGENT_STATUSES = ["active", "paused"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/*
 * The face's states, their words, the task glance and the sentence beside the
 * face live in `src/lib/agents/state-labels.ts`, which imports no zod: the
 * shared shell draws them on every page (tests/shell-weight.test.ts). They
 * are re-exported here so every caller keeps one import.
 */
export {
  AGENT_STATES,
  AGENT_STATE_LABEL,
  agentStateSentence,
  formatAgentWhen,
  type AgentState,
  type AgentTaskGlance,
} from "@/lib/agents/state-labels";

/** The statuses a person (or their chat) may set on a goal. */
export const AGENT_GOAL_STATUSES = ["active", "paused", "achieved", "dropped"] as const;
export type AgentGoalSettableStatus = (typeof AGENT_GOAL_STATUSES)[number];
/**
 * Every status a goal can be in. `unverified` is set only by the goal driver:
 * every milestone ran, but a check of its success criteria did not pass or
 * could not run (src/lib/agents/goals.ts `planGoalCompletion`). The person
 * then marks it met (`achieved`) or keeps it going (`active`).
 */
export const AGENT_GOAL_ALL_STATUSES = [...AGENT_GOAL_STATUSES, "unverified"] as const;
export type AgentGoalStatus = (typeof AGENT_GOAL_ALL_STATUSES)[number];

export const AGENT_GOAL_CADENCES = ["none", "daily", "weekly"] as const;
export type AgentGoalCadence = (typeof AGENT_GOAL_CADENCES)[number];

export const AGENT_GOAL_CADENCE_LABEL: Record<AgentGoalCadence, string> = {
  none: "No check-ins",
  daily: "Checks in daily",
  weekly: "Checks in weekly",
};

export const AGENT_IDEA_STATUSES = ["new", "started", "dismissed"] as const;
export type AgentIdeaStatus = (typeof AGENT_IDEA_STATUSES)[number];

export const AGENT_NOTE_SOURCES = ["user", "agent", "reflection"] as const;
export type AgentNoteSource = (typeof AGENT_NOTE_SOURCES)[number];

/**
 * Where an agent's work runs. `cloud`: the cloud executor, which keeps going
 * with the laptop closed. `mac`: the person's own Mac through the Work relay
 * (Work's `local` target), refused rather than moved to the cloud when that
 * Mac is offline.
 */
export const AGENT_EXECUTION_TARGETS = ["cloud", "mac"] as const;
export type AgentExecutionTarget = (typeof AGENT_EXECUTION_TARGETS)[number];

/** A stored value read back; anything unknown is the default, `cloud`. */
export function agentExecutionTarget(value: string | null | undefined): AgentExecutionTarget {
  return value === "mac" ? "mac" : "cloud";
}

/**
 * The Work target vocabulary (`WORK_TARGETS`) for an agent's setting. Never
 * `automatic`: an agent's work goes where its person put it, and `automatic`
 * is what lets work move between machines on its own.
 */
export function agentWorkTarget(value: string | null | undefined): "cloud" | "local" {
  return agentExecutionTarget(value) === "mac" ? "local" : "cloud";
}

/**
 * The Work dispatch fields for an agent's task: its target, and its preferred
 * Mac when it runs on one and has named one. Cloud agents never carry a host.
 */
export function agentDispatchTarget(agent: {
  executionTarget?: string | null;
  preferredHostId?: string | null;
}): { requestedTarget: "cloud" | "local"; preferredHostId?: string } {
  const requestedTarget = agentWorkTarget(agent.executionTarget);
  return requestedTarget === "local" && agent.preferredHostId
    ? { requestedTarget, preferredHostId: agent.preferredHostId }
    : { requestedTarget };
}

/**
 * The Mac an agent's routine is pinned to, for where the agent runs.
 *
 * A routine is a `WorkSchedule`, and a local schedule has to name its Mac
 * (`hostId`), where a task only carries a preference. So: a cloud routine
 * names none; a Mac routine takes the agent's preferred Mac when that Mac is
 * switched on for Work, else the Mac it is already pinned to when that one
 * still is (`currentHostId`), else the only switched-on Mac. With several and
 * no way to choose, it is `pick_mac`; with none it is `no_mac`; and with a
 * preferred Mac that is switched off while others are on it is
 * `preferred_off`, so the refusal names the chosen Mac rather than claiming no
 * Mac is on. A Mac is never picked for the person, and the routine is never
 * left in the cloud instead. Used by `createAgentRoutine` and by every change
 * to where an agent runs, so its routines go where it goes.
 */
export function agentRoutineHost(input: {
  target: "cloud" | "local";
  preferredHostId?: string | null;
  /** The account's Macs that are switched on for Work and not revoked. */
  enabledHostIds: readonly string[];
  currentHostId?: string | null;
}): { ok: true; hostId: string | null } | { ok: false; reason: "no_mac" | "pick_mac" | "preferred_off" } {
  if (input.target === "cloud") return { ok: true, hostId: null };
  const enabled = new Set(input.enabledHostIds);
  if (input.preferredHostId) {
    if (enabled.has(input.preferredHostId)) return { ok: true, hostId: input.preferredHostId };
    return { ok: false, reason: input.enabledHostIds.length > 0 ? "preferred_off" : "no_mac" };
  }
  if (input.currentHostId && enabled.has(input.currentHostId)) return { ok: true, hostId: input.currentHostId };
  if (input.enabledHostIds.length === 1) return { ok: true, hostId: input.enabledHostIds[0]! };
  return { ok: false, reason: input.enabledHostIds.length === 0 ? "no_mac" : "pick_mac" };
}

export const AGENT_NOTIFY_LEVELS = ["needs_you", "results", "all"] as const;
export type AgentNotifyLevel = (typeof AGENT_NOTIFY_LEVELS)[number];

/**
 * Each notify level in words: `label` is the sentence (the profile's line, a
 * setup change's before and after), `short` the control's segment.
 */
export const AGENT_NOTIFY_META: Record<AgentNotifyLevel, { label: string; short: string }> = {
  needs_you: { label: "Only when it needs you", short: "Needs you" },
  results: { label: "When a task finishes or needs you", short: "Results" },
  all: { label: "Everything, ideas included", short: "Everything" },
};

export function agentNotifyLevel(value: string | null | undefined): AgentNotifyLevel {
  if (value === "needs_you" || value === "results" || value === "all") {
    return value;
  }
  if (value === "quiet") return "needs_you";
  return "results";
}

/**
 * What the agent's own log records. Task progress is not here: it is read from
 * Work's sessions, which already record it (`AgentEvent` says why).
 */
export const AGENT_EVENT_KINDS = [
  "hired",
  "updated",
  "paused",
  "resumed",
  "goal_set",
  "goal_updated",
  "goal_checked_in",
  "idea_raised",
  "idea_started",
  "idea_dismissed",
  "routine_created",
  "note_added",
  "note_learned",
  "task_started",
  "reflected",
  // A handoff (src/lib/chat/handoff-tool.ts), written on both agents: the one
  // that gave the work away and the teammate whose thread it now runs in.
  "handed_off",
  "handoff_received",
  // A task changed hands (src/lib/work/ownership-store.ts), written on both
  // members: `detail.direction` is "out" on the one it left and "in" on the
  // one that took it.
  "task_transferred",
  // A setup change asked for in the member's thread
  // (src/lib/agents/setup-changes.ts): applied, or undone.
  "setup_changed",
  // Moved here from an assistant (D-007); `detail.assistantId` names it.
  "moved_from_assistant",
  "computer_enabled",
  "computer_disabled",
  "computer_reset",
  "takeover_started",
  "takeover_ended",
  "duplicated",
  "undone",
  // The agent's computer (src/lib/computer): replaced after it went missing, a
  // secret typed in from a card, a saved sign-in kept or forgotten, and a task
  // taught by showing. None of these carry the secret, an id or an address.
  "computer_recreated",
  "secret_filled",
  "sign_in_saved",
  "sign_in_removed",
  "skill_learned",
  // Rooms (src/lib/agents/rooms.ts): joining a room, and asking another member.
  "room_joined",
  "room_asked",
  // Payments (src/lib/payments): a limit changed, a card issued for a purchase.
  "spend_limit_changed",
  "payment_issued",
  // iMessage (src/lib/channels): a text reached this agent.
  "channel_message",
  // Durable goals (src/lib/agents/goal-runner.ts): a step started or finished,
  // the goal stopped to ask, or it was met.
  "goal_step",
  "goal_blocked",
  "goal_achieved",
  // Its success criteria checked against what its steps produced, by the
  // final step's run (src/lib/agents/goal-criteria.ts): `detail.verdict` is
  // met, not_met or unchecked. And every step ran without that check passing.
  "goal_checked",
  "goal_unverified",
  // Teams (src/lib/agents/team.ts): a temporary specialist team ran a request.
  "team_run",
  // Work it started on its own (a routine or a goal step) was refused, e.g.
  // its Mac was offline. Never moved to another machine instead.
  "task_refused",
] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

/** The clocks a routine can be set to from an agent's page. The rest are one step away in Automations. */
export const AGENT_ROUTINE_CADENCES = ["hourly", "daily", "weekdays", "weekly", "monthly"] as const;
export type AgentRoutineCadence = (typeof AGENT_ROUTINE_CADENCES)[number];

export const AGENT_ROUTINE_CADENCE_LABEL: Record<AgentRoutineCadence, string> = {
  hourly: "Every hour",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many agents an account may keep. Not a budget — the usage windows are
 * the budget, and an idle agent costs nothing — but a roster past this is a
 * list nobody can scan peripherally, which is the whole point of a face.
 */
export const MAX_AGENTS_PER_ACCOUNT = 24;
export const MAX_AGENT_NAME_CHARS = 40;
export const MAX_AGENT_ROLE_CHARS = 80;
export const MAX_AGENT_INSTRUCTIONS_CHARS = 6_000;
export const MAX_AGENT_GOALS = 20;
export const MAX_AGENT_NOTES = 200;
export const MAX_AGENT_NOTE_CHARS = 1_000;
export const MAX_GOAL_TITLE_CHARS = 140;
export const MAX_GOAL_DETAIL_CHARS = 2_000;
export const MAX_AGENT_CONNECTORS = 32;

/**
 * The shortest gap between two reflections of one agent, unless a person asks.
 * Reflection is a background model call billed to the account; six hours keeps
 * a proactive agent to four a day at most, and one opened page never costs more
 * than one.
 */
export const AGENT_REFLECT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** How long a finished run keeps the face in `done` before it settles to `idle`. */
export const AGENT_DONE_WINDOW_MS = 15 * 60 * 1000;

/** How long a failed run keeps the face `blocked` before it is history, not state. */
export const AGENT_BLOCKED_WINDOW_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// `AgentTaskGlance` (the newest task an agent owns, as much of it as state
// needs) lives in state-labels.ts with the words; it is re-exported above.

const BLOCKED_TERMINALS = new Set(["failed", "interrupted", "budget_exceeded", "timed_out", "host_offline"]);

/**
 * The face's state, from the agent and ONE task.
 *
 * Kept for callers that hold a single task; the roster and the thread use
 * `aggregateAgentState`, which applies the same rule over every task the
 * member owns and is defined in terms of this one.
 *
 * In order, and the order is the policy:
 *   1. Paused beats everything: a paused agent is asleep even while a run it
 *      started finishes, because pausing is the person's statement.
 *   2. A task that needs the person is `waiting`, live or not — `host_offline`
 *      is terminal and still needs a decision, which is why Work stores
 *      `needsAttention` rather than deriving it.
 *   3. A live task is `working`. A draft is not live work (it costs nothing and
 *      holds no executor) and a run paused by the person is waiting on the
 *      person to resume it, so both fall through to `idle`.
 *   4. A run that finished in the last fifteen minutes is `done`; one that
 *      failed in the last six hours is `blocked`. After that it is history, and
 *      the log is where history is read.
 */
export function deriveAgentState(input: {
  status: string;
  task: AgentTaskGlance | null;
  now: Date;
}): Exclude<AgentState, "thinking" | "listening"> {
  if (input.status === "paused") return "sleeping";
  const task = input.task;
  if (!task) return "idle";
  if (task.needsAttention || task.status === "waiting_input" || task.status === "waiting_approval") {
    return "waiting";
  }
  if (isLiveStatus(task.status)) {
    return task.status === "draft" || task.status === "paused" ? "idle" : "working";
  }
  const age = input.now.getTime() - task.lastActivityAt.getTime();
  if (task.status === "completed" && age <= AGENT_DONE_WINDOW_MS) return "done";
  if (BLOCKED_TERMINALS.has(task.status) && age <= AGENT_BLOCKED_WINDOW_MS) return "blocked";
  return "idle";
}

/** How strongly each state claims the face when a member has several tasks. */
const STATE_PRECEDENCE: Record<Exclude<AgentState, "thinking" | "listening" | "sleeping">, number> = {
  waiting: 4,
  working: 3,
  blocked: 2,
  done: 1,
  idle: 0,
};

/**
 * The face's state over EVERY task a member owns, and the task it is about.
 *
 * A member can own several tasks at once now: the person's request, a routine
 * that fired in its thread, a hand-off it took. Reading only the newest made a
 * member with a waiting task and a newer running routine look "working" while
 * the needs-you count beside it said otherwise. The rule is the single-task
 * rule applied to each task, and the strongest wins: waiting beats working
 * beats a recent failure beats a recent finish beats idle. Ties go to the most
 * recently active task, which is the one the sentence then names.
 *
 * Paused still beats everything, whatever the tasks say.
 */
export function aggregateAgentState(input: {
  status: string;
  tasks: readonly AgentTaskGlance[];
  now: Date;
}): { state: Exclude<AgentState, "thinking" | "listening">; task: AgentTaskGlance | null } {
  if (input.status === "paused") {
    const newest = [...input.tasks].sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())[0] ?? null;
    return { state: "sleeping", task: newest };
  }
  let best: { state: Exclude<AgentState, "thinking" | "listening" | "sleeping">; task: AgentTaskGlance } | null = null;
  for (const task of input.tasks) {
    const state = deriveAgentState({ status: input.status, task, now: input.now }) as Exclude<
      AgentState,
      "thinking" | "listening" | "sleeping"
    >;
    if (
      !best ||
      STATE_PRECEDENCE[state] > STATE_PRECEDENCE[best.state] ||
      (STATE_PRECEDENCE[state] === STATE_PRECEDENCE[best.state] &&
        task.lastActivityAt.getTime() > best.task.lastActivityAt.getTime())
    ) {
      best = { state, task };
    }
  }
  if (!best) return { state: "idle", task: null };
  // An idle verdict is about no task in particular: the sentence then speaks
  // of what is next, not of a task that finished long ago.
  return best.state === "idle" ? { state: "idle", task: null } : best;
}

// `agentStateSentence` and `formatAgentWhen` live in state-labels.ts (re-exported above).

/** Whether a reflection is due, for the lazy trigger on the agent's page and the scheduler's sweep. */
export function reflectionDue(input: {
  status: string;
  proactive: boolean;
  lastReflectedAt: Date | null;
  now: Date;
  force?: boolean;
}): boolean {
  if (input.status !== "active") return false;
  if (input.force) return true;
  if (!input.proactive) return false;
  if (!input.lastReflectedAt) return true;
  return input.now.getTime() - input.lastReflectedAt.getTime() >= AGENT_REFLECT_INTERVAL_MS;
}

/**
 * The idempotency keys of a task started as an agent, from the caller's own
 * key. Namespaced by the agent, so the same key (one chat message, one idea)
 * can never replay a task onto a different agent than the one it started.
 */
export function agentTaskKeys(agentId: string, key: string): { session: string; run: string } {
  return { session: `agent-task:${agentId}:${key}`, run: `agent-run:${agentId}:${key}` };
}

// ---------------------------------------------------------------------------
// The model it answers with
// ---------------------------------------------------------------------------

/**
 * The model an agent may be set to, as its canonical id, or null when the id
 * is not one: a chat model the catalogue resolves (a live provider id
 * resolves too, as it does in the chat picker) or Auto. Never a model that is
 * announced but not out, and never an image or voice model, because the thread
 * is a chat and its tasks start on the same id.
 */
export function agentModelChoice(id: string): string | null {
  const model = resolveModel(id.trim());
  if (!model || (model.modality ?? "chat") !== "chat" || model.comingSoon) return null;
  return model.id;
}

/** A stored effort, or null for anything that is not one. */
export function agentReasoningEffort(value: string | null | undefined): ReasoningEffort | null {
  return value && (REASONING_TIERS as readonly string[]).includes(value) ? (value as ReasoningEffort) : null;
}

/**
 * What a turn in an agent's thread answers with.
 *
 * The agent's model is its thread's model (the schema: "the model its thread
 * and its tasks use when set"), so a request that names no model, or names the
 * agent's own, is the agent's to answer, at the agent's effort when one is set.
 * A request naming any other model is the person choosing one for this
 * message, and their choice wins: every client sends the model its picker
 * shows, and the thread's picker starts on the agent's because the thread
 * follows its agent (`updateAgentForUser`), so a different id is a decision.
 *
 * An agent's model the turn cannot use (gone from the catalogue, off the plan,
 * its provider not configured) is dropped without a word, and the turn resolves
 * as if no model were named. The person set the agent up once, perhaps on
 * another plan; a thread that refuses to answer until they find the setting
 * that broke it is worse than one that answers on their default.
 */
export type AgentTurnModel =
  | { kind: "request" }
  | { kind: "agent"; model: string; reasoningEffort: ReasoningEffort | null }
  | { kind: "fallback" };

export function agentTurnModel(input: {
  agent: { model: string | null; reasoningEffort: string | null } | null;
  requestedModel: string | null | undefined;
  usable: (modelId: string) => boolean;
}): AgentTurnModel {
  const own = input.agent?.model ? agentModelChoice(input.agent.model) : null;
  if (!own) return { kind: "request" };
  const requested = input.requestedModel?.trim() ? agentModelChoice(input.requestedModel) : null;
  if (requested && requested !== own) return { kind: "request" };
  if (!input.usable(own)) return { kind: "fallback" };
  return { kind: "agent", model: own, reasoningEffort: agentReasoningEffort(input.agent?.reasoningEffort) };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const avatarSchema = z.object({
  shape: z.enum(AGENT_SHAPES),
  tone: z.enum(AGENT_TONES),
  eyes: z.enum(AGENT_EYES),
  mark: z.enum(AGENT_MARKS),
});

const nameSchema = z.string().trim().min(1).max(MAX_AGENT_NAME_CHARS);
/** Stored by its canonical id, so the thread and the task read the same spelling. */
const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .transform((id, ctx) => {
    const model = agentModelChoice(id);
    if (model) return model;
    ctx.addIssue({ code: "custom", message: `That is not a chat model ${PRODUCT_NAME} offers.` });
    return z.NEVER;
  });
const effortSchema = z.enum(REASONING_TIERS);
const connectorListSchema = z
  .array(z.string().trim().min(1).max(120))
  .max(MAX_AGENT_CONNECTORS)
  .transform((ids) => [...new Set(ids)]);

export const createAgentSchema = z.object({
  creationKey: z.string().uuid().optional(),
  starterMessage: z.string().trim().min(1).max(MAX_AGENT_INSTRUCTIONS_CHARS).optional(),
  name: nameSchema,
  role: z.string().trim().max(MAX_AGENT_ROLE_CHARS).default(""),
  avatar: avatarSchema.optional(),
  style: z.enum(AGENT_STYLES).default("warm"),
  instructions: z.string().trim().max(MAX_AGENT_INSTRUCTIONS_CHARS).default(""),
  model: modelSchema.nullable().optional(),
  reasoningEffort: effortSchema.nullable().optional(),
  approvalMode: z.enum(WORK_PERMISSION_POLICIES).default("balanced"),
  connectorIds: connectorListSchema.default([]),
  projectId: z.string().trim().min(1).max(200).nullable().optional(),
  proactive: z.boolean().default(true),
  notify: z.enum(AGENT_NOTIFY_LEVELS).default("results"),
  executionTarget: z.enum(AGENT_EXECUTION_TARGETS).default("cloud"),
  preferredHostId: z.string().trim().min(1).max(200).nullable().optional(),
  template: z.string().trim().min(1).max(40).nullable().optional(),
  firstGoal: z.string().trim().min(1).max(MAX_GOAL_TITLE_CHARS).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const patchAgentSchema = z
  .object({
    name: nameSchema.optional(),
    role: z.string().trim().max(MAX_AGENT_ROLE_CHARS).optional(),
    avatar: avatarSchema.optional(),
    style: z.enum(AGENT_STYLES).optional(),
    instructions: z.string().trim().max(MAX_AGENT_INSTRUCTIONS_CHARS).optional(),
    model: modelSchema.nullable().optional(),
    reasoningEffort: effortSchema.nullable().optional(),
    approvalMode: z.enum(WORK_PERMISSION_POLICIES).optional(),
    connectorIds: connectorListSchema.optional(),
    projectId: z.string().trim().min(1).max(200).nullable().optional(),
    status: z.enum(AGENT_STATUSES).optional(),
    proactive: z.boolean().optional(),
    notify: z.enum(AGENT_NOTIFY_LEVELS).optional(),
    pinned: z.boolean().optional(),
    sortOrder: z.int().min(0).max(10_000).optional(),
    /** Its own weekly cap in micro-USD, or null for none (src/lib/agents/budget.ts). */
    budgetMicroUsd: z.int().min(0).max(MAX_MEMBER_BUDGET_MICRO_USD).nullable().optional(),
    /** Where its work runs. The person's choice only; no agent tool sets it. */
    executionTarget: z.enum(AGENT_EXECUTION_TARGETS).optional(),
    /** The Mac it prefers (a WorkHost id), or null for any switched-on Mac. */
    preferredHostId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });
export type PatchAgentInput = z.infer<typeof patchAgentSchema>;

/** A milestone as a request names it: a title, or {id?, title, done?}. */
const goalMilestoneInput = z.union([
  z.string().trim().min(1).max(160),
  z.object({ id: z.string().trim().max(40).optional(), title: z.string().trim().min(1).max(160), done: z.boolean().optional() }),
]);

/** The durable-goal fields (src/lib/agents/goals.ts), shared by create and patch. */
const durableGoalFields = {
  milestones: z.array(goalMilestoneInput).max(12).optional(),
  successCriteria: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
  /** Tasks this goal may start before it asks; 0 turns driving off. */
  maxRuns: z.int().min(0).max(50).optional(),
  budgetMicroUsd: z.int().min(0).max(MAX_MEMBER_BUDGET_MICRO_USD).nullable().optional(),
};

export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(MAX_GOAL_TITLE_CHARS),
  detail: z.string().trim().max(MAX_GOAL_DETAIL_CHARS).default(""),
  cadence: z.enum(AGENT_GOAL_CADENCES).default("weekly"),
  dueAt: z.iso.datetime().nullable().optional(),
  ...durableGoalFields,
});

export const patchGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_GOAL_TITLE_CHARS).optional(),
    detail: z.string().trim().max(MAX_GOAL_DETAIL_CHARS).optional(),
    cadence: z.enum(AGENT_GOAL_CADENCES).optional(),
    status: z.enum(AGENT_GOAL_STATUSES).optional(),
    dueAt: z.iso.datetime().nullable().optional(),
    ...durableGoalFields,
  })
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

export const createNoteSchema = z.object({
  content: z.string().trim().min(1).max(MAX_AGENT_NOTE_CHARS),
});

export const patchNoteSchema = z.object({
  content: z.string().trim().min(1).max(MAX_AGENT_NOTE_CHARS),
});

/** Keeps a note a task saved for review (src/lib/agents/note-review.ts). The person's press only. */
export const keepNoteSchema = z.object({ action: z.literal("keep") }).strict();

export const patchIdeaSchema = z.object({
  action: z.enum(["start", "dismiss"]),
  /** Only after a person saw the estimate and said yes. */
  confirmExpensive: z.boolean().optional(),
});

export const createRoutineSchema = z.object({
  name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(4_000),
  cadence: z.enum(AGENT_ROUTINE_CADENCES),
  hour: z.int().min(0).max(23).default(9),
  minute: z.int().min(0).max(59).default(0),
  /** 0 (Sunday) to 6, for `weekly`. */
  weekday: z.int().min(0).max(6).optional(),
  /** 1 to 31, for `monthly`. */
  monthday: z.int().min(1).max(31).optional(),
  timezone: z.string().trim().min(1).max(120),
});
export type CreateRoutineInput = z.infer<typeof createRoutineSchema>;

export const startAgentTaskSchema = z.object({
  title: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(4_000),
  confirmExpensive: z.boolean().optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
});

/**
 * The trigger a routine cadence becomes, in the shape `WorkTrigger.config`
 * stores (`parseTimeTrigger` in src/lib/work/schedule.ts reads it back).
 */
export function routineTrigger(input: Pick<CreateRoutineInput, "cadence" | "hour" | "minute" | "weekday" | "monthday">): {
  kind: AgentRoutineCadence;
  config: Record<string, number>;
  enabled: true;
} {
  const config: Record<string, number> = { minute: input.minute };
  if (input.cadence !== "hourly") config.hour = input.hour;
  if (input.cadence === "weekly") config.weekday = input.weekday ?? 1;
  if (input.cadence === "monthly") config.monthday = input.monthday ?? 1;
  return { kind: input.cadence, config, enabled: true };
}

/** An agent's autonomy is a Work permission policy, validated as one. */
export function agentApprovalMode(value: string): WorkPermissionPolicy {
  return (WORK_PERMISSION_POLICIES as readonly string[]).includes(value)
    ? (value as WorkPermissionPolicy)
    : "balanced";
}

export function agentStyle(value: string): AgentStyle {
  return (AGENT_STYLES as readonly string[]).includes(value) ? (value as AgentStyle) : "warm";
}
