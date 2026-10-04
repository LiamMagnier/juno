/**
 * When the product offers an upgrade outside the plans page: the sidebar's
 * account row and the account menu read this one rule.
 *
 *   free        on Free, always: every paid plan is a step up
 *   near_limit  on a paid plan with somewhere to go, once the month is 80%
 *               spent (the line where the footer's usage note turns amber) or
 *               a rolling window has 10% or less left
 *
 * Never when nothing above the plan is for sale, when billing is off, or for
 * an account with no enforced budget (the owner, a switched-off cap). Pure, so
 * the rule is tested without a browser (tests/upgrade-nudge.test.ts).
 */
import type { Plan } from "@prisma/client";
import { planRank } from "@/lib/plans";
import type { ClientSpend } from "@/types/app";

export type UpgradeNudge = "free" | "near_limit" | null;

/** The month's share at which a paid plan is shown the way up. */
export const NEAR_LIMIT_MONTH_SHARE = 0.8;
/** A rolling window with this share or less left counts as nearly spent. */
export const NEAR_LIMIT_WINDOW_LEFT = 0.1;

export function upgradeNudge(input: {
  plan: Plan;
  billing: boolean;
  purchasablePlans: readonly Plan[];
  spend: Pick<ClientSpend, "spentMicroUsd" | "reservedMicroUsd" | "budgetMicroUsd" | "windows">;
}): UpgradeNudge {
  if (!input.billing || input.plan === "OWNER") return null;
  const above = input.purchasablePlans.some((p) => planRank(p) > planRank(input.plan));
  if (!above) return null;
  if (input.plan === "FREE") return "free";
  const { spend } = input;
  if (spend.budgetMicroUsd == null || spend.budgetMicroUsd <= 0) return null;
  const monthShare = (spend.spentMicroUsd + spend.reservedMicroUsd) / spend.budgetMicroUsd;
  if (monthShare >= NEAR_LIMIT_MONTH_SHARE) return "near_limit";
  for (const window of [spend.windows?.session, spend.windows?.weekly]) {
    if (!window?.budgetMicroUsd || window.budgetMicroUsd <= 0) continue;
    if (1 - window.spentMicroUsd / window.budgetMicroUsd <= NEAR_LIMIT_WINDOW_LEFT) return "near_limit";
  }
  return null;
}
