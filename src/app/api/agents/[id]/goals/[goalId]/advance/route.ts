import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import { advanceGoal } from "@/lib/agents/goal-runner";
import { DEFAULT_GOAL_MAX_RUNS, MAX_GOAL_RUNS_LIMIT, parseBlockers } from "@/lib/agents/goals";
import { serializeGoal } from "@/lib/agents/types";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; goalId: string }> };

/**
 * "Keep working on it" / "Continue": the person asks the agent to drive this
 * goal now. A goal that was not driven gets the default run bound; one that
 * paused at its run bound gets another `DEFAULT_GOAL_MAX_RUNS`. Nothing else
 * is widened here: the agent's autonomy, apps, budget and approval floor
 * still decide what each step may do, and every step is one Work task.
 */
export async function POST(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, goalId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const limit = await rateLimit({ key: `agents:goal-advance:${user.id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited", message: "Give it a moment before asking again." }, { status: 429 });
  }
  const goal = await prisma.agentGoal.findFirst({ where: { id: goalId, userId: user.id, agentId: agent.id } });
  if (!goal) return NextResponse.json({ error: "not_found", message: "That goal no longer exists." }, { status: 404 });
  if (goal.status === "achieved" || goal.status === "dropped") {
    return NextResponse.json({ error: "goal_closed", message: "That goal is closed. Reopen it first." }, { status: 409 });
  }
  const stoppedAtBound = parseBlockers(goal.blockers).some((b) => b.kind === "run_budget");
  const maxRuns =
    goal.maxRuns === 0
      ? DEFAULT_GOAL_MAX_RUNS
      : stoppedAtBound
        ? Math.min(goal.runsUsed + DEFAULT_GOAL_MAX_RUNS, MAX_GOAL_RUNS_LIMIT)
        : goal.maxRuns;
  if (stoppedAtBound && maxRuns <= goal.runsUsed) {
    return NextResponse.json({ error: "goal_run_limit", message: `This goal has used its ${MAX_GOAL_RUNS_LIMIT} runs. Start a new goal to continue.` }, { status: 409 });
  }
  await prisma.agentGoal.updateMany({
    where: { id: goal.id, userId: user.id },
    data: {
      maxRuns,
      ...(goal.status === "paused" ? { status: "active" } : {}),
      // The person answered whatever it was waiting on by pressing Continue.
      blockers: [],
    },
  });
  const retryApproved = parseBlockers(goal.blockers).some((b) => b.kind === "needs_decision" || b.kind === "step_failed");
  const outcome = await advanceGoal({ user, goalId: goal.id, retryApproved });
  if (outcome.kind === "missing") return NextResponse.json({ error: "not_found", message: "That goal no longer exists." }, { status: 404 });
  const fresh = await prisma.agentGoal.findFirst({ where: { id: goal.id, userId: user.id } });
  return NextResponse.json({
    goal: fresh ? serializeGoal(fresh) : null,
    steps: outcome.kind === "advanced" ? outcome.steps : [],
    busy: outcome.kind === "busy",
  });
}
