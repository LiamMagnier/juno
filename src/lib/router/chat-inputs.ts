import "server-only";

/**
 * The chat route's side of the router: the facts about a request and an
 * account that the pure decision in `decide.ts` takes as inputs.
 */

import type { Plan } from "@prisma/client";
import { classifyPromptComplexity } from "@/lib/auto-model";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { checkBudget, checkUsageWindows, type BillingPeriod } from "@/lib/spend";
import { parsePaidTierAttestation } from "@/lib/router/data-policy";
import { classifyTask, estimateTokens, type TaskClass } from "@/lib/router/task-class";

/**
 * Providers whose deployment keys the owner attests are on a paid,
 * no-training tier (`AUTO_ROUTER_PAID_TIER_PROVIDERS=google,mistral`).
 */
export function autoPaidTierProviders(): ReadonlySet<string> {
  return parsePaidTierAttestation(process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS);
}

/**
 * Room left for this turn: the smaller of the monthly remainder and the
 * binding usage window, after open holds. Null when neither bounds it, or
 * when the read fails — a failed budget read must not make Auto refuse; the
 * admission gates downstream still run.
 */
export async function autoBudgetRoom(
  userId: string,
  plan: Plan,
  period: BillingPeriod | null,
  budget: EffectiveBudget
): Promise<number | null> {
  try {
    const [month, windows] = await Promise.all([
      checkBudget(userId, plan, period, budget),
      checkUsageWindows(userId, plan, period, budget),
    ]);
    const rooms = [month.remainingMicroUsd, windows.remainingMicroUsd].filter((n): n is number => n != null);
    return rooms.length ? Math.max(0, Math.min(...rooms)) : null;
  } catch {
    return null;
  }
}

/**
 * Tokens already in the context at routing time. Only what the route holds
 * before the history is loaded: a private chat's history (sent by the client)
 * plus the message. A saved chat's history is read after routing, so a long
 * saved thread is not yet a long-context signal (AUTO_ROUTER.md, "Known gaps").
 */
export function autoContextTokens(
  input: { message?: string | null },
  privateHistory: ReadonlyArray<{ content: string }>
): number {
  let total = estimateTokens(input.message ?? "");
  for (const m of privateHistory) total += estimateTokens(m.content);
  return total;
}

/** The task class for a turn Auto did not route, so hand-routed turns are evidence too. */
export function classifyTaskForTelemetry(message: string): TaskClass {
  return classifyTask({ message, complexity: classifyPromptComplexity(message) }).taskClass;
}
