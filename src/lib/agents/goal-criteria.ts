import "server-only";

/**
 * Checking a durable goal's success criteria, and telling the person.
 *
 * A goal used to be "met" the moment its last milestone's task completed
 * (gap 11 of the 2026-10-27 Orbit discovery): nothing compared what its steps
 * produced with what the goal said it needed. Now:
 *
 *   1. The run that finishes the goal's LAST milestone checks the criteria,
 *      in scripts/work-runner.ts, right after its own validation passes
 *      (`goalCriteriaCheckFor`). It uses the same seam as the run's own judge
 *      (runner/agent-core/src/work/judge.ts `checkGoalCriteria`): the run's
 *      provider and model, which is the agent's model, so no second
 *      credential, no other model and no other provider see the content. The
 *      verdict is recorded on the agent's log (`goal_checked`), met, not met
 *      or unchecked. Recording it never changes the run's own outcome: the
 *      step was done either way.
 *   2. The goal driver (src/lib/agents/goal-runner.ts), once every milestone
 *      is marked, reads that verdict (`latestGoalCriteriaCheck`) and applies
 *      `planGoalCompletion` (src/lib/agents/goals.ts): `achieved` only on a
 *      recorded pass; otherwise `unverified`, "Every step ran. Check the
 *      result.", with the steps' tasks listed on the goal. No verdict at all
 *      (a step that ran on a Mac, a check that timed out) is unverified, never
 *      met.
 *   3. The person is told (`notifyGoalOutcome`): an unverified goal is a
 *      needs-you item on every notify level; a met one is a result, sent
 *      unless the agent only notifies when it needs them.
 */

import { prisma } from "@/lib/prisma";
import { agentNotifyLevel } from "@/lib/agents/domain";
import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import { recordAgentEvent } from "@/lib/agents/store";
import {
  GOAL_UNVERIFIED,
  composeGoalDeliverables,
  isFinalGoalStep,
  parseCriteria,
  parseMilestones,
  readGoalCriteriaCheck,
  type GoalCriteriaCheck,
  type GoalStepResult,
} from "@/lib/agents/goals";
import { notifyUser } from "@/lib/notifications";
import { agentPath } from "@/lib/notify/paths";

/** The judge, bound to the run's provider and model by the executor. Null: it could not conclude. */
export type GoalCriteriaChecker = (input: {
  goal: string;
  criteria: readonly string[];
  deliverables: string;
}) => Promise<{ met: boolean; why: string } | null>;

/** The structural shape of a Work validator's input and result (agent-core is vendored; see work-runner.ts). */
interface ValidatorInput {
  answer: string;
  artifacts: readonly { title: string }[];
}

/**
 * Wraps the run's validator. When the run is one of a goal's steps and its own
 * validation passed, it checks the goal's criteria if this step is the last
 * one left. The validator's result is returned unchanged: a goal's verdict is
 * the goal's, not the step's. Never throws for the check: a failure is logged
 * by id and recorded as unchecked.
 */
export function goalCriteriaCheckFor<I extends ValidatorInput, R extends { satisfied: boolean }>(
  base: (input: I) => Promise<R> | R,
  context: {
    userId: string;
    runId: string;
    session: { id: string; goalId: string | null; goalStepKey: string | null; agentId: string | null };
    check: GoalCriteriaChecker;
  }
): (input: I) => Promise<R> {
  const { session } = context;
  if (!session.goalId || !session.agentId || !session.goalStepKey) return async (input) => base(input);
  const goalId = session.goalId;
  const agentId = session.agentId;
  const stepKey = session.goalStepKey;
  return async (input) => {
    const result = await base(input);
    if (!result.satisfied) return result;
    await checkGoalAfterFinalStep({
      userId: context.userId,
      agentId,
      goalId,
      stepKey,
      sessionId: session.id,
      runId: context.runId,
      answer: input.answer,
      artifacts: input.artifacts.map((artifact) => artifact.title),
      check: context.check,
    }).catch((error: unknown) => {
      console.error("[goals] criteria check could not be recorded", {
        goalId,
        runId: context.runId,
        error: error instanceof Error ? error.name : "unknown",
      });
    });
    return result;
  };
}

/** The final answer a completed run wrote (its `run_finished` report), or null. */
function reportAnswer(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const report = (payload as Record<string, unknown>).report;
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const answer = (report as Record<string, unknown>).answer;
  return typeof answer === "string" && answer.trim() ? answer.trim() : null;
}

/**
 * Checks the goal's criteria against every step's result, when `stepKey` is
 * the last milestone left, and records the verdict. Returns it, or null when
 * this step is not the goal's last (nothing is checked or recorded then).
 */
export async function checkGoalAfterFinalStep(input: {
  userId: string;
  agentId: string;
  goalId: string;
  stepKey: string;
  sessionId: string;
  runId: string;
  answer: string;
  artifacts: readonly string[];
  check: GoalCriteriaChecker;
}): Promise<GoalCriteriaCheck | null> {
  const goal = await prisma.agentGoal.findFirst({ where: { id: input.goalId, userId: input.userId, agentId: input.agentId } });
  if (!goal || goal.status !== "active") return null;
  const milestones = parseMilestones(goal.milestones);
  if (!isFinalGoalStep(milestones, input.stepKey)) return null;

  const doneIds = milestones.filter((m) => m.done && m.sessionId).map((m) => m.sessionId!);
  const sessions = doneIds.length
    ? await prisma.workSession.findMany({
        where: { userId: input.userId, id: { in: doneIds } },
        select: {
          id: true,
          runs: {
            where: { userId: input.userId, status: "completed" },
            orderBy: { attempt: "desc" },
            take: 1,
            select: { events: { where: { userId: input.userId, kind: "run_finished" }, orderBy: { seq: "desc" }, take: 1, select: { payload: true } } },
          },
          artifacts: { where: { deletedAt: null }, select: { title: true }, take: 10 },
        },
      })
    : [];
  const bySession = new Map(sessions.map((session) => [session.id, session]));
  const steps: GoalStepResult[] = milestones.flatMap((m): GoalStepResult[] => {
    if (m.id === input.stepKey) return [{ title: m.title, answer: input.answer.trim() || null, artifacts: input.artifacts }];
    if (!m.done || !m.sessionId) return [];
    const session = bySession.get(m.sessionId);
    return [
      {
        title: m.title,
        answer: reportAnswer(session?.runs[0]?.events[0]?.payload),
        artifacts: session?.artifacts.map((a) => a.title) ?? [],
      },
    ];
  });

  let verdict: { met: boolean; why: string } | null = null;
  try {
    verdict = await input.check({
      goal: [goal.title, goal.detail].filter((part) => part.trim()).join("\n\n"),
      criteria: parseCriteria(goal.successCriteria),
      deliverables: composeGoalDeliverables(steps),
    });
  } catch {
    verdict = null;
  }
  const check: GoalCriteriaCheck = verdict
    ? { verdict: verdict.met ? "met" : "not_met", why: verdict.why.slice(0, 300) || null }
    : { verdict: "unchecked", why: null };
  await recordAgentEvent({
    userId: input.userId,
    agentId: input.agentId,
    kind: "goal_checked",
    title:
      check.verdict === "met"
        ? `Checked "${goal.title}" against its criteria: met`
        : check.verdict === "not_met"
          ? `Checked "${goal.title}" against its criteria: not met yet`
          : `Could not check "${goal.title}" against its criteria`,
    sessionId: input.sessionId,
    detail: { goalId: goal.id, stepKey: input.stepKey, runId: input.runId, verdict: check.verdict, why: check.why },
  });
  return check;
}

/** The verdict the run of this session recorded for this goal, or null when none did. */
export async function latestGoalCriteriaCheck(input: {
  userId: string;
  agentId: string;
  goalId: string;
  sessionId: string;
}): Promise<GoalCriteriaCheck | null> {
  const rows = await prisma.agentEvent.findMany({
    where: { userId: input.userId, agentId: input.agentId, kind: "goal_checked", sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { detail: true },
  });
  for (const row of rows) {
    const detail = row.detail as Record<string, unknown> | null;
    if (detail && detail.goalId === input.goalId) return readGoalCriteriaCheck(detail);
  }
  return null;
}

/**
 * Tells the person a goal finished, honestly: unverified is a question for
 * them (needs-you, on every notify level); met is a result (updates, unless
 * the agent only notifies when it needs them). One row per goal outcome.
 */
export async function notifyGoalOutcome(input: {
  userId: string;
  agent: { id: string; name: string; avatar: unknown; notify?: string | null };
  goal: { id: string; title: string };
  status: "achieved" | typeof GOAL_UNVERIFIED;
  nextAction: string;
}): Promise<void> {
  const unverified = input.status === GOAL_UNVERIFIED;
  if (!unverified && agentNotifyLevel(input.agent.notify) === "needs_you") return;
  const title = unverified ? `Check the result: ${input.goal.title}` : `Met: ${input.goal.title}`;
  const body = unverified ? input.nextAction : `${input.agent.name} met this goal, and its criteria were checked.`;
  await notifyUser({
    userId: input.userId,
    type: "agent_goal",
    title: title.slice(0, 200),
    body: body.slice(0, 500),
    priority: unverified ? "normal" : "low",
    sourceType: "agent",
    sourceId: input.agent.id,
    actionData: { agentId: input.agent.id, goalId: input.goal.id, status: input.status },
    path: agentPath(input.agent.id),
    agent: { id: input.agent.id, name: input.agent.name, avatar: normalizeAgentAvatar(input.agent.avatar, input.agent.id) },
    channel: unverified ? "needs_you" : "updates",
    collapseKey: `agent-goal:${input.goal.id}`,
    push: {
      title: input.agent.name,
      body: title.slice(0, 180),
      threadId: `agent-${input.agent.id}`,
      collapseId: `agent-goal-${input.goal.id}`,
      interruption: unverified ? "active" : "passive",
      data: { agentId: input.agent.id },
    },
  });
}
