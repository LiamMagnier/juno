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
import { agentWorkTarget } from "@/lib/agents/domain";
import { WORK_TARGETS, type WorkTarget } from "@/lib/work/domain";
import { isRetryLaterRefusal } from "@/lib/work/executor-presence";
import { PARKED_GOAL_STEP_EXPIRED_DETAIL } from "@/lib/work/store";
import { latestGoalCriteriaCheck, notifyGoalOutcome } from "@/lib/agents/goal-criteria";
import {
  GOAL_ACTING_EVENT_KINDS,
  GOAL_ADVANCE_LEASE_MS,
  GOAL_UNVERIFIED,
  goalProgress,
  lastFinishedMilestone,
  planGoalCompletion,
  type GoalCriteriaCheck,
  markMilestoneDone,
  parseBlockers,
  parseCriteria,
  parseMilestones,
  planGoalStep,
  planStepNotStarted,
  withBlocker,
  type GoalStep,
  type GoalStepNotStarted,
  type GoalTaskView,
  type GoalView,
} from "@/lib/agents/goals";

/** A session's stored target, read back; anything unknown is `cloud`. */
function targetOfSession(value: string): WorkTarget {
  return (WORK_TARGETS as readonly string[]).includes(value) ? (value as WorkTarget) : "cloud";
}

export type StartStepResult = { ok: true; sessionId: string } | ({ ok: false } & GoalStepNotStarted);

export interface GoalRunnerDeps {
  /** Starts the step's task as the agent; idempotent on `idempotencyKey`. */
  startStep(input: { user: AgentActor; agent: Agent; title: string; prompt: string; idempotencyKey: string }): Promise<StartStepResult>;
  /** A new attempt of an interrupted step's task; idempotent on `idempotencyKey`. */
  retryStep(input: { user: AgentActor; sessionId: string; idempotencyKey: string }): Promise<{ ok: true } | ({ ok: false } & GoalStepNotStarted)>;
  /**
   * The criteria verdict the final step's run recorded. Defaults to the
   * agent's log (`latestGoalCriteriaCheck`); null means none was recorded.
   */
  readCriteriaCheck?(input: { userId: string; agentId: string; goalId: string; sessionId: string }): Promise<GoalCriteriaCheck | null>;
  /** Tells the person the goal finished. Defaults to `notifyGoalOutcome`. */
  notifyOutcome?(input: Parameters<typeof notifyGoalOutcome>[0]): Promise<void>;
}

/** `retryLater` when dispatch said "try again later" (`isRetryLaterRefusal`), not "no". */
function notStarted(body: Record<string, unknown>, fallback: string): { ok: false } & GoalStepNotStarted {
  const message = typeof body.message === "string" ? body.message : fallback;
  return isRetryLaterRefusal(body) ? { ok: false, message, retryLater: true } : { ok: false, message };
}

/**
 * The deps that start real tasks.
 *
 * `unattended` is the sweep's (scripts/agent-reflector.ts): nobody is
 * watching, so dispatch reads the cloud heartbeat as three answers and a read
 * that failed comes back as `retryLater`, which leaves the goal's blockers
 * alone (`planStepNotStarted`). A person's press on the goal goes through the
 * interactive path and is told plainly, as any dispatch they make is.
 */
export function goalRunnerDeps(options: { unattended: boolean }): GoalRunnerDeps {
  const { unattended } = options;
  return {
    async startStep({ user, agent, title, prompt, idempotencyKey }) {
      const outcome = await startAgentTask(user, agent, { title, goal: prompt, idempotencyKey, unattended });
      if (outcome.kind === "started") return { ok: true, sessionId: outcome.sessionId };
      if (outcome.kind === "confirm") {
        const dollars = (outcome.estimatedCostMicroUsd / 1_000_000).toFixed(2);
        return { ok: false, needsConfirmation: true, message: `The next step is estimated at about $${dollars}. Start it from the goal to confirm.` };
      }
      return notStarted(outcome.body, "The next step could not start.");
    },
    async retryStep({ user, sessionId, idempotencyKey }) {
      const [dispatch, protocol] = await Promise.all([import("@/lib/work/dispatch"), import("@/app/api/work/protocol")]);
      const session = await prisma.workSession.findFirst({ where: { id: sessionId, userId: user.id, deletedAt: null } });
      if (!session) return { ok: false, message: "That step's task no longer exists." };
      // The agent's setting as it stands now, so a member moved to the Mac retries
      // there; a Mac that is offline refuses, and the refusal becomes a blocker.
      const agent = session.agentId
        ? await prisma.agent.findFirst({
            where: { id: session.agentId, userId: user.id },
            select: { executionTarget: true },
          })
        : null;
      const body = protocol.startRunSchema.parse({
        origin: "retry",
        requestedTarget: agent ? agentWorkTarget(agent.executionTarget) : targetOfSession(session.requestedTarget),
        idempotencyKey,
      });
      const started = await dispatch.startWorkRunForUser(user, session, body, { unattended });
      if (!started.run) return notStarted(started.body, "The retry could not start.");
      return { ok: true };
    },
  };
}

/** A person's press (the goal's advance route). */
export const defaultGoalRunnerDeps: GoalRunnerDeps = goalRunnerDeps({ unattended: false });

/** The sweep's: a heartbeat that could not be read is "later", never a blocker. */
export const unattendedGoalRunnerDeps: GoalRunnerDeps = goalRunnerDeps({ unattended: true });

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
      runs: {
        select: { id: true, attempt: true, costMicroUsd: true, status: true, pauseReason: true, terminalDetail: true },
        orderBy: { attempt: "desc" },
      },
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
      // Parked or paused, and by whom; and whether the run ended because it
      // waited out its answer (src/lib/work/store.ts `expireParkedGoalSteps`).
      pauseReason: current?.status === "paused" ? current.pauseReason : null,
      waitedOut: current?.status === "interrupted" && current.terminalDetail === PARKED_GOAL_STEP_EXPIRED_DETAIL,
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
  // The lease this advance holds, exactly: every write below is conditioned on
  // it, so an advance that outlived its lease (a slow step) cannot write over,
  // or release, the advance that took the goal after it.
  const lease = new Date(now.getTime() + GOAL_ADVANCE_LEASE_MS);
  const claimed = await prisma.agentGoal.updateMany({
    where: { id: input.goalId, userId, OR: [{ advanceLeaseUntil: null }, { advanceLeaseUntil: { lt: now } }] },
    data: { advanceLeaseUntil: lease },
  });
  if (claimed.count !== 1) {
    const exists = await prisma.agentGoal.count({ where: { id: input.goalId, userId } });
    return exists ? { kind: "busy" } : { kind: "missing" };
  }
  const applied: GoalStep["kind"][] = [];
  const readCriteriaCheck = deps.readCriteriaCheck ?? latestGoalCriteriaCheck;
  const notifyOutcome = deps.notifyOutcome ?? notifyGoalOutcome;
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
      let completed: { status: "achieved" | typeof GOAL_UNVERIFIED; nextAction: string } | null = null;

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
        case "achieved": {
          // Every milestone ran. Met only if the final step's run checked the
          // success criteria and the check passed (src/lib/agents/goal-criteria.ts);
          // anything else is `unverified` for the person, never a silent pass.
          const last = lastFinishedMilestone(parseMilestones(goal.milestones));
          const check = last?.sessionId
            ? await readCriteriaCheck({ userId, agentId: agent.id, goalId: goal.id, sessionId: last.sessionId })
            : null;
          const completion = planGoalCompletion({ title: goal.title, check });
          data.status = completion.status;
          data.progress = 100;
          data.blockers = [];
          data.nextAction = completion.nextAction;
          await recordAgentEvent({
            userId,
            agentId: agent.id,
            kind: completion.event.kind,
            title: completion.event.title,
            sessionId: last?.sessionId ?? null,
            detail: { goalId: goal.id, verdict: check?.verdict ?? "unchecked" },
          });
          completed = { status: completion.status, nextAction: completion.nextAction };
          break;
        }
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
            const planned = planStepNotStarted({ step: "retry", result, blockers: goal.blockers, now });
            if (planned.blockers) data.blockers = planned.blockers as unknown as Prisma.InputJsonValue;
            data.nextAction = planned.nextAction;
            // Refused (its Mac offline, no cloud worker): said on the member's
            // page once, never retried somewhere else. A heartbeat that could
            // not be read is neither, and is simply tried again next time.
            if (planned.recordRefusal) {
              await recordAgentEvent({ userId, agentId: agent.id, kind: "task_refused", title: result.message.slice(0, 200), sessionId: step.sessionId, detail: { goalId: goal.id, stepKey: step.stepKey } });
            }
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
            const planned = planStepNotStarted({ step: "start", result, blockers: goal.blockers, now });
            if (planned.blockers) data.blockers = planned.blockers as unknown as Prisma.InputJsonValue;
            data.nextAction = planned.nextAction;
            if (planned.recordRefusal) {
              await recordAgentEvent({ userId, agentId: agent.id, kind: "task_refused", title: result.message.slice(0, 200), detail: { goalId: goal.id, stepKey: step.stepKey } });
            }
          }
          break;
        }
      }
      const wrote = await prisma.agentGoal.updateMany({ where: { id: goal.id, userId, advanceLeaseUntil: lease }, data });
      if (wrote.count !== 1) return { kind: "busy" };
      if (completed) {
        // After the write, so the person is told only what the goal now says.
        // A notification that cannot be sent never undoes the outcome.
        await notifyOutcome({ userId, agent, goal: { id: goal.id, title: goal.title }, ...completed }).catch(() => undefined);
      }
      if (!again) break;
    }
  } finally {
    await prisma.agentGoal
      .updateMany({ where: { id: input.goalId, userId, advanceLeaseUntil: lease }, data: { advanceLeaseUntil: null } })
      .catch(() => undefined);
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
export async function sweepGoals(now = new Date(), deps: GoalRunnerDeps = unattendedGoalRunnerDeps): Promise<{ advanced: number }> {
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
