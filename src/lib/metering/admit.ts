import "server-only";
import type { Plan } from "@prisma/client";
import { budgetExceededBody } from "@/lib/billing/budget-fallback";
import { checkBudget, checkUsageWindows } from "@/lib/spend";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import { admissionVerdict } from "@/lib/metering/unit-prices";

/**
 * The pre-call gate for a metered call that is not a chat turn: TTS, STT,
 * code web search, a design edit, a media generation. The month (settled spend
 * plus open holds), the rolling 5-hour and weekly windows, and this call's own
 * estimate against what is left — the same three questions the chat route asks
 * before it calls a model. Returns the 402 body to send when refused.
 */
export async function admitMeteredCall(input: {
  userId: string;
  plan: Plan;
  estimateMicroUsd: number;
}): Promise<
  | { allowed: true; remainingMicroUsd: number | null }
  | { allowed: false; status: 402; body: Record<string, unknown> }
> {
  const [budget, windows] = await Promise.all([
    checkBudget(input.userId, input.plan),
    checkUsageWindows(input.userId, input.plan),
  ]);
  const verdict = admissionVerdict({ budget, windows, estimateMicroUsd: input.estimateMicroUsd });
  if (verdict.allowed) {
    const remains = [budget.remainingMicroUsd, windows.remainingMicroUsd].filter((v): v is number => v != null);
    return { allowed: true, remainingMicroUsd: remains.length ? Math.min(...remains) : null };
  }
  if (verdict.reason === "window" && windows.bound) {
    return {
      allowed: false,
      status: 402,
      body: {
        error: windowLimitMessage(windows.bound, windows.resetsAtMs),
        code: "QUOTA_EXCEEDED",
        window: windows.bound,
        resetsAtMs: windows.resetsAtMs,
      },
    };
  }
  return { allowed: false, status: 402, body: budgetExceededBody(input.plan, budget.resetsAtMs) };
}
