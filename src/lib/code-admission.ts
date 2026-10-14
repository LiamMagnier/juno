import "server-only";

import { checkMemberBudget } from "@/lib/agents/budget-store";
import { checkUsageWindows } from "@/lib/spend";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import { getUserPlan } from "@/lib/usage";

/**
 * Spend admission for Code work, the same two checks a Work run passes: the
 * account's binding usage window, then the owning agent's own budget cap.
 *
 * Code starts (the composer, a routine fired by hand or by URL, a scheduled
 * routine) used to be admitted on the plan alone, so an account past its
 * window could keep starting cloud runs that bill model calls. A run whose
 * every role is the person's own key or subscription is not paid for by the
 * plan and is not gated here, exactly as the plan gate exempts it.
 */
export type CodeAdmission =
  | { ok: true }
  | { ok: false; reason: "usage_window_exceeded" | "member_budget_exhausted"; message: string; resetsAtMs: number | null };

export async function admitCodeStart(input: {
  userId: string;
  /** The agent the work runs as, when it is an agent's (a routine on its task). */
  agentId?: string | null;
  /** True when no role of the run is billed by Alevr (own keys, own subscriptions). */
  unbilled?: boolean;
}): Promise<CodeAdmission> {
  if (input.unbilled) return { ok: true };
  const plan = await getUserPlan(input.userId);
  const windows = await checkUsageWindows(input.userId, plan);
  if (!windows.allowed && windows.bound !== null) {
    return {
      ok: false,
      reason: "usage_window_exceeded",
      message: `${windowLimitMessage(windows.bound, windows.resetsAtMs)} Nothing was started.`,
      resetsAtMs: windows.resetsAtMs ?? null,
    };
  }
  const member = await checkMemberBudget({
    userId: input.userId,
    agentId: input.agentId ?? null,
    weekly: { startMs: windows.weekly.startMs, resetsAtMs: windows.weekly.resetsAtMs },
    stage: "admission",
  });
  if (!member.ok) {
    return { ok: false, reason: "member_budget_exhausted", message: member.message, resetsAtMs: member.resetsAtMs ?? null };
  }
  return { ok: true };
}
