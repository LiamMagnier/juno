import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { findAgent } from "@/lib/agents/store";
import { boardStateSentence, projectTaskBoard } from "@/lib/work/board";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/**
 * The agent's task board: its Work tasks in the ledger's vocabulary
 * (src/lib/work/board.ts): pending, claimed, running, waiting for you,
 * waiting for another task, blocked, completed, failed, cancelled, with the
 * goal each one advances, its dependencies, deadline and completion criteria.
 * A read of the existing Work rows; there is no second queue behind it.
 */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const sessions = await prisma.workSession.findMany({
    where: { userId: user.id, agentId: agent.id, deletedAt: null, status: { not: "draft" } },
    orderBy: { lastActivityAt: "desc" },
    take: 50,
    select: {
      id: true,
      title: true,
      status: true,
      goalId: true,
      goalStepKey: true,
      dependsOnSessionIds: true,
      deadlineAt: true,
      completionCriteria: true,
      maxAttempts: true,
      lastActivityAt: true,
      runs: { orderBy: { attempt: "desc" }, take: 1, select: { attempt: true, leaseExpiresAt: true, status: true } },
    },
  });
  // Dependencies outside the 50 newest are read too, so a waiting task is judged on its real upstream.
  const known = new Set(sessions.map((s) => s.id));
  const missing = [...new Set(sessions.flatMap((s) => s.dependsOnSessionIds))].filter((dep) => !known.has(dep));
  const upstream = missing.length
    ? await prisma.workSession.findMany({ where: { userId: user.id, id: { in: missing }, deletedAt: null }, select: { id: true, status: true } })
    : [];
  const projected = projectTaskBoard([
    ...sessions.map((s) => ({ id: s.id, status: s.status, dependsOnSessionIds: s.dependsOnSessionIds, deadlineAt: s.deadlineAt, leaseExpiresAt: s.runs[0]?.leaseExpiresAt ?? null })),
    ...upstream.map((s) => ({ id: s.id, status: s.status })),
  ]);
  const byId = new Map(projected.map((task) => [task.id, task]));
  return NextResponse.json({
    tasks: sessions.map((s) => {
      const board = byId.get(s.id)!;
      return {
        sessionId: s.id,
        title: s.title,
        state: board.state,
        sentence: boardStateSentence(board),
        overdue: board.overdue,
        waitingOn: board.waitingOn,
        goalId: s.goalId,
        goalStepKey: s.goalStepKey,
        deadlineAt: s.deadlineAt?.toISOString() ?? null,
        completionCriteria: s.completionCriteria,
        attempt: s.runs[0]?.attempt ?? 0,
        maxAttempts: s.maxAttempts,
        lastActivityAt: s.lastActivityAt.toISOString(),
      };
    }),
  });
}
