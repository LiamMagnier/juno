import "server-only";

/**
 * A crew member's own budget: the reads that need the database. The rule and
 * its sentences are in `budget.ts`.
 */

import { prisma } from "@/lib/prisma";
import { memberBudgetMessage, memberBudgetVerdict, memberBudgetWindow } from "@/lib/agents/budget";

/**
 * What a member has spent in a window: the cost of the runs of the tasks it
 * owns that started inside it. `excludeRunId` leaves out a run the caller is
 * counting itself (the runner's own, whose live cost is newer than the row).
 */
export async function memberSpendMicroUsd(input: {
  userId: string;
  agentId: string;
  since: Date;
  excludeRunId?: string | null;
}): Promise<number> {
  const sum = await prisma.workRun.aggregate({
    where: {
      userId: input.userId,
      createdAt: { gte: input.since },
      session: { userId: input.userId, agentId: input.agentId },
      ...(input.excludeRunId ? { id: { not: input.excludeRunId } } : {}),
    },
    _sum: { costMicroUsd: true },
  });
  return sum._sum.costMicroUsd ?? 0;
}

export type MemberBudgetCheck =
  | { ok: true; remainingMicroUsd: number | null }
  | { ok: false; message: string; capMicroUsd: number; resetsAtMs: number | null };

/**
 * The member's cap, checked. `weekly` is the account's weekly window as the
 * caller already read it (`checkUsageWindows(...).weekly`), so the account's
 * own gate and this one read the same window without a second trip.
 */
export async function checkMemberBudget(input: {
  userId: string;
  agentId: string | null | undefined;
  weekly: { startMs: number; resetsAtMs: number } | null;
  pendingMicroUsd?: number;
  excludeRunId?: string | null;
  stage: "admission" | "running";
  now?: Date;
}): Promise<MemberBudgetCheck> {
  if (!input.agentId) return { ok: true, remainingMicroUsd: null };
  const member = await prisma.agent.findFirst({
    where: { id: input.agentId, userId: input.userId },
    select: { name: true, budgetMicroUsd: true },
  });
  if (!member || member.budgetMicroUsd === null) return { ok: true, remainingMicroUsd: null };
  const now = input.now ?? new Date();
  const window = memberBudgetWindow({ weekly: input.weekly, now });
  const spent = await memberSpendMicroUsd({
    userId: input.userId,
    agentId: input.agentId,
    since: window.since,
    excludeRunId: input.excludeRunId,
  });
  const verdict = memberBudgetVerdict({
    capMicroUsd: member.budgetMicroUsd,
    spentMicroUsd: spent,
    pendingMicroUsd: input.pendingMicroUsd,
  });
  if (verdict.allowed) return { ok: true, remainingMicroUsd: verdict.remainingMicroUsd };
  return {
    ok: false,
    capMicroUsd: member.budgetMicroUsd,
    resetsAtMs: window.resetsAtMs,
    message: memberBudgetMessage({
      name: member.name,
      capMicroUsd: member.budgetMicroUsd,
      resetsAtMs: window.resetsAtMs,
      stage: input.stage,
    }),
  };
}
