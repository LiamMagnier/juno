import "server-only";

/**
 * The durable-goal driver: advances one goal by one bounded step.
 *
 * Each step is an ordinary Work task started as the agent (`startAgentTask`,
 * the same path a person's press takes, under the agent's autonomy, apps,
 * budget and approval floor), linked to the goal with `WorkSession.goalId`.
 * Leases, heartbeats, checkpoints, approvals and the stale-run sweep are the
 * Work ledger's own (src/lib/work/store.ts). This file only decides, through
 * the pure rules in src/lib/agents/goals.ts, and records what it decided on
 * the goal: progress, next action, blockers, runs used.
 *
 * Restart safety: everything is re-read from the database on every advance.
 * The goal's own lease (`advanceLeaseUntil`) stops two advances overlapping;
 * the step's idempotency key (`goal:<id>:<step>:<run slot>`) makes a crash
 * between "task started" and "goal updated" replay to the same task instead of
 * starting a second one.
 */

import type { Agent, AgentGoal, Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { recordAgentEvent, startAgentTask, type AgentActor } from "@/lib/agents/store";
import {
  GOAL_ACTING_EVENT_KINDS,
  GOAL_ADVANCE_LEASE_MS,
  goalProgress,
  markMilestoneDone,
  parseBlockers,
  parseCriteria,
  parseMilestones,
  planGoalStep,
  type GoalBlocker,
  type GoalStep,
  type GoalTaskView,
  type GoalView,
} from "@/lib/agents/goals";

export type StartStepResult =
  | { ok: true; sessionId: string }
  | { ok: false; message: string; needsConfirmation?: boolean };

export interface GoalRunnerDeps {
  /** Starts the step's task as the agent; idempotent on `idempotencyKey`. */
  startStep(input: { user: AgentActor; agent: Agent; title: string; prompt: string; idempotencyKey: string }): Promise<StartStepResult>;
  /** A new attempt of an interrupted step's task; idempotent on `idempotencyKey`. */
  retryStep(input: { user: AgentActor; sessionId: string; idempotencyKey: string }): Promise<{ ok: true } | { ok: false; message: string }>;
}

export const defaultGoalRunnerDeps: GoalRunnerDeps = {
  async startStep({ user, agent, title, prompt, idempotencyKey }) {
    const outcome = await startAgentTask(user, agent, { title, goal: prompt, idempotencyKey });
    if (outcome.kind === "started") return { ok: true, sessionId: outcome.sessionId };
    if (outcome.kind === "confirm") {
      const dollars = (outcome.estimatedCostMicroUsd / 1_000_000).toFixed(2);
      return { ok: false, needsConfirmation: true, message: `The next step is estimated at about $${dollars}. Start it from the goal to confirm.` };
    }
    const message = typeof outcome.body.message === "string" ? outcome.body.message : "The next step could not start.";
    return { ok: false, message };
  },
  async retryStep({ user, sessionId, idempotencyKey }) {
    const [dispatch, protocol] = await Promise.all([import("@/lib/work/dispatch"), import("@/app/api/work/protocol")]);
    const session = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id, deletedAt: null } });
    if (!session) return { ok: false, message: "That step's task no longer exists." };
    const body = protocol.startRunSchema.parse({ origin: "retry", requestedTarget: "cloud", idempotencyKey });
    const started = await dispatch.startWorkRunForUser(user, session, body);
    if (!started.run) return { ok: false, message: typeof started.body.message === "string" ? started.body.message : "The retry could not start." };
    return { ok: true };
  },
};

export type AdvanceGoalOutcome =
  | { kind: "busy" }
  | { kind: "missing" }
  | { kind: "advanced"; steps: GoalStep["kind"][]; goal: AgentGoal };

/** The most steps one advance applies (a completed step is accounted for, then the next one starts). */
const MAX_STEPS_PER_ADVANCE = 3;

async function readTasks(userId: string, goalId: string): Promise<{ tasks: GoalTaskView[]; spent: number }> {
  const sessions = await prisma.workSession.findMany({
    where: { userId, goalId, deletedAt: null },
    select: {
      id: true,
      goalStepKey: true,
      status: true,
      createdAt: true,
      runs: { select: { id: true, attempt: true, costMicroUsd: true }, orderBy: { attempt: "desc" } },
    },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  let spent = 0;
  const currentRunIds = sessions.map((session) => session.runs[0]?.id).filter((id): id is string => !!id);
  const acting = currentRunIds.length
    ? await prisma.workEvent.findMany({
        where: { userId, runId: { in: currentRunIds }, kind: { in: [...GOAL_ACTING_EVENT_KINDS] } },
        select: { runId: true },
        distinct: ["runId"],
      })
    : [];
  const acted = new Set(acting.map((row) => row.runId));
  const tasks = sessions.map((session) => {
    for (const run of session.runs) spent += run.costMicroUsd;
    const current = session.runs[0];
    return {
      sessionId: session.id,
      stepKey: session.goalStepKey,
      status: session.status,
      attempt: current?.attempt ?? 0,
      acted: current ? acted.has(current.id) : false,
      costMicroUsd: current?.costMicroUsd ?? 0,
      createdAt: session.createdAt,
    };
  });
  return { tasks, spent };
}

function view(goal: AgentGoal, spent: number): GoalView {
  return {
    id: goal.id,
    title: goal.title,
    detail: goal.detail,
    status: goal.status,
    milestones: parseMilestones(goal.milestones),
    successCriteria: parseCriteria(goal.successCriteria),
    budgetMicroUsd: goal.budgetMicroUsd,
    spentMicroUsd: spent,
    maxRuns: goal.maxRuns,
    runsUsed: goal.runsUsed,
    maxAttemptsPerStep: goal.maxAttemptsPerStep,
    dueAt: goal.dueAt,
    cadence: goal.cadence,
  };
}

function withBlocker(existing: unknown, blocker: GoalBlocker): GoalBlocker[] {
  return [blocker, ...parseBlockers(existing).filter((b) => b.kind !== blocker.kind)].slice(0, 4);
}

/**
 * Advances one goal by at most `MAX_STEPS_PER_ADVANCE` decisions. Safe to call
 * from a sweep, a page press and a restart at the same time: only one holds
 * the goal's lease, and every task start is idempotent.
 */
export async function advanceGoal(input: {
  user: AgentActor;
  goalId: string;
  now?: Date;
  deps?: GoalRunnerDeps;
  /** The person pressed Continue on a stopped step: retry it once (still within the run bound). */
  retryApproved?: boolean;
}): Promise<AdvanceGoalOutcome> {
  const now = input.now ?? new Date();
  const deps = input.deps ?? defaultGoalRunnerDeps;
  const userId = input.user.id;
  const claimed = await prisma.agentGoal.updateMany({
    where: { id: input.goalId, userId, OR: [{ advanceLeaseUntil: null }, { advanceLeaseUntil: { lt: now } }] },
    data: { advanceLeaseUntil: new Date(now.getTime() + GOAL_ADVANCE_LEASE_MS) },
  });
  if (claimed.count !== 1) {
    const exists = await prisma.agentGoal.count({ where: { id: input.goalId, userId } });
    return exists ? { kind: "busy" } : { kind: "missing" };
  }
  const applied: GoalStep["kind"][] = [];
  try {
    for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
      const goal = await prisma.agentGoal.findFirst({ where: { id: input.goalId, userId } });
      if (!goal) return { kind: "missing" };
      const agent = await prisma.agent.findFirst({ where: { id: goal.agentId, userId, deletedAt: null } });
      if (!agent) return { kind: "missing" };
      const { tasks, spent } = await readTasks(userId, goal.id);
      let step = planGoalStep(view(goal, spent), tasks, now, { retryApproved: input.retryApproved === true && i === 0 });
      if (agent.status !== "active" && (step.kind === "start" || step.kind === "retry")) {
        step = {
          kind: "ask",
          pause: false,
          blocker: { kind: "agent_paused", text: `${agent.name} is paused. Resume it to continue this goal.`, at: now.toISOString() },
          nextAction: `Waiting for ${agent.name} to be resumed`,
        };
      }
      applied.push(step.kind);
      const data: Prisma.AgentGoalUpdateManyMutationInput = { spentMicroUsd: spent, lastAdvancedAt: now, nextAction: step.nextAction };
      let again = false;

      switch (step.kind) {
        case "idle":
          break;
        case "complete_step": {
          const milestones = markMilestoneDone(parseMilestones(goal.milestones), step.stepKey, step.sessionId, now);
          data.milestones = milestones as unknown as Prisma.InputJsonValue;
          data.progress = goalProgress(milestones, goal.status);
          data.blockers = [];
          const title = milestones.find((m) => m.id === step.stepKey)?.title ?? goal.title;
          await recordAgentEvent({ userId, agentId: agent.id, kind: "goal_step", title: `Finished "${title}" for ${goal.title}`, sessionId: step.sessionId, detail: { goalId: goal.id, stepKey: step.stepKey } });
          again = true;
          break;
        }
        case "achieved":
          data.status = "achieved";
          data.progress = 100;
          data.blockers = [];
          await recordAgentEvent({ userId, agentId: agent.id, kind: "goal_achieved", title: `Met the goal: ${goal.title}`, detail: { goalId: goal.id } });
          break;
        case "ask": {
          const known = parseBlockers(goal.blockers).some((b) => b.kind === step.blocker.kind && b.text === step.blocker.text);
          data.blockers = withBlocker(goal.blockers, step.blocker) as unknown as Prisma.InputJsonValue;
          if (step.pause) data.status = "paused";
          if (!known) {
            await recordAgentEvent({ userId, agentId: agent.id, kind: "goal_blocked", title: step.blocker.text.slice(0, 200), detail: { goalId: goal.id, blocker: step.blocker.kind } });
          }
          break;
        }
        case "retry": {
          const result = await deps.retryStep({ user: input.user, sessionId: step.sessionId, idempotencyKey: `goal-retry:${step.sessionId}:${step.attempt}` });
          if (result.ok) {
            data.runsUsed = { increment: 1 };
            data.blockers = [];
            await recordAgentEvent({ userId, agentId: agent.id, kind: "goal_step", title: step.nextAction, sessionId: step.sessionId, detail: { goalId: goal.id, stepKey: step.stepKey, attempt: step.attempt } });
          } else {
            data.blockers = withBlocker(goal.blockers, { kind: "needs_decision", text: result.message, at: now.toISOString() }) as unknown as Prisma.InputJsonValue;
            data.nextAction = "Waiting for you: the retry could not start";
          }
          break;
        }
        case "start": {
          const result = await deps.startStep({ user: input.user, agent, title: step.title, prompt: step.prompt, idempotencyKey: step.idempotencyKey });
          if (result.ok) {
            // Link the task to the goal. Conditional on the account, and on the
            // session not already belonging to another goal.
            await prisma.workSession.updateMany({
              where: { id: result.sessionId, userId, OR: [{ goalId: null }, { goalId: goal.id }] },
              data: {
                goalId: goal.id,
                goalStepKey: step.stepKey,
                completionCriteria: parseCriteria(goal.successCriteria).join("\n") || null,
                deadlineAt: goal.dueAt,
                maxAttempts: goal.maxAttemptsPerStep,
              },
            });
            data.runsUsed = { increment: 1 };
            data.blockers = [];
            await recordAgentEvent({ userId, agentId: agent.id, kind: "goal_step", title: `Started "${step.stepTitle}" for ${goal.title}`, sessionId: result.sessionId, detail: { goalId: goal.id, stepKey: step.stepKey } });
          } else {
            const blocker: GoalBlocker = { kind: "needs_decision", text: result.message, at: now.toISOString() };
            data.blockers = withBlocker(goal.blockers, blocker) as unknown as Prisma.InputJsonValue;
            data.nextAction = result.needsConfirmation ? "Waiting for your OK to spend on the next step" : "Waiting for you: the next step could not start";
          }
          break;
        }
      }
      await prisma.agentGoal.updateMany({ where: { id: goal.id, userId }, data });
      if (!again) break;
    }
  } finally {
    await prisma.agentGoal.updateMany({ where: { id: input.goalId, userId }, data: { advanceLeaseUntil: null } }).catch(() => undefined);
  }
  const goal = await prisma.agentGoal.findFirst({ where: { id: input.goalId, userId } });
  return goal ? { kind: "advanced", steps: applied, goal } : { kind: "missing" };
}

/** Goals one sweep may advance, and of those how many may be one account's. */
export const GOAL_SWEEP_PER_TICK = 10;
export const GOAL_SWEEP_PER_ACCOUNT = 3;

/**
 * The sweep: active, driven goals (`maxRuns > 0`) of active agents, oldest advance first, bounded per tick and per account.
 * Called from the agent reflector's loop (scripts/agent-reflector.ts).
 */
export async function sweepGoals(now = new Date(), deps?: GoalRunnerDeps): Promise<{ advanced: number }> {
  // Cross-account read, said out loud (see reflect-sweep.ts); every write goes
  // through advanceGoal with the owner's id.
  const candidates = await prismaUnguarded.agentGoal.findMany({
    where: {
      status: "active",
      // Only goals their owner chose to have driven; 0 is a reflection topic.
      maxRuns: { gt: 0 },
      agent: { status: "active", deletedAt: null },
      OR: [{ advanceLeaseUntil: null }, { advanceLeaseUntil: { lt: now } }],
    },
    select: { id: true, userId: true },
    orderBy: [{ lastAdvancedAt: { sort: "asc", nulls: "first" } }],
    take: GOAL_SWEEP_PER_TICK * 3,
  });
  const perAccount = new Map<string, number>();
  let advanced = 0;
  for (const goal of candidates) {
    if (advanced >= GOAL_SWEEP_PER_TICK) break;
    const count = perAccount.get(goal.userId) ?? 0;
    if (count >= GOAL_SWEEP_PER_ACCOUNT) continue;
    perAccount.set(goal.userId, count + 1);
    try {
      const outcome = await advanceGoal({ user: { id: goal.userId }, goalId: goal.id, now, deps });
      if (outcome.kind === "advanced") advanced += 1;
    } catch (error) {
      console.error("[goals] advance failed", { goalId: goal.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { advanced };
}
