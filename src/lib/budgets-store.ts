import "server-only";

/**
 * The database reads behind `budgets.ts` lines that had no reader before:
 * a routine's spend this billing period, and an agent's line with its spend in
 * the same weekly window its cap is enforced in. Enforcement is untouched —
 * these only report what the existing gates already count.
 */

import { prisma } from "@/lib/prisma";
import { getUserPlan } from "@/lib/usage";
import { checkUsageWindows, resolveBillingPeriod } from "@/lib/spend";
import { memberBudgetWindow } from "@/lib/agents/budget";
import { memberSpendMicroUsd } from "@/lib/agents/budget-store";
import { agentBudgetLine, type BudgetLine } from "@/lib/budgets";

/** What each routine's runs cost since the start of the account's billing period. */
export async function routineSpendThisPeriod(userId: string, scheduleIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (scheduleIds.length === 0) return out;
  const period = await resolveBillingPeriod(userId);
  const rows = await prisma.workRun.groupBy({
    by: ["scheduleId"],
    where: { userId, scheduleId: { in: [...scheduleIds] }, createdAt: { gte: new Date(period.startMs) } },
    _sum: { costMicroUsd: true },
  });
  for (const id of scheduleIds) out.set(id, 0);
  for (const row of rows) if (row.scheduleId) out.set(row.scheduleId, row._sum.costMicroUsd ?? 0);
  return out;
}

/** An agent's own budget as a line: cap, spend in the window the cap is enforced in, and when it frees. */
export async function agentBudgetLineFor(
  userId: string,
  agent: { id: string; name: string; budgetMicroUsd: number | null }
): Promise<BudgetLine> {
  const plan = await getUserPlan(userId);
  const windows = await checkUsageWindows(userId, plan);
  const window = memberBudgetWindow({
    weekly: { startMs: windows.weekly.startMs, resetsAtMs: windows.weekly.resetsAtMs },
    now: new Date(),
  });
  const spent = await memberSpendMicroUsd({ userId, agentId: agent.id, since: window.since });
  return agentBudgetLine({
    name: agent.name,
    capMicroUsd: agent.budgetMicroUsd,
    spentMicroUsd: spent,
    resetsAtMs: window.resetsAtMs,
  });
}
