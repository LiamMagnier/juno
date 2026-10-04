import type { Plan } from "@prisma/client";
import { PLAN_LIST } from "@/lib/plans";
import { budgetFallback, type BudgetFallback } from "@/lib/credits";
import { budgetExceededMessage } from "@/lib/spend";
import { isPlanPurchasable, purchasableTopUps } from "@/lib/stripe";
import { isStripeConfigured } from "@/lib/env";

/**
 * The fair fallback when a month's budget is spent: what the client may offer.
 *
 * Paid plans get the top-up packs this deployment sells; every plan below the
 * top gets the cheapest tier above it that is for sale. A deployment without
 * Stripe offers nothing (and the clients then show the message alone).
 */
export function budgetFallbackFor(plan: Plan): BudgetFallback {
  if (!isStripeConfigured()) return { options: [], topUpPacks: [], cheapestUpgrade: null };
  return budgetFallback({
    plan,
    planOrder: PLAN_LIST.map((p) => p.id),
    sellable: (p) => isPlanPurchasable(p, "month"),
    sellableTopUps: purchasableTopUps(),
  });
}

/**
 * The 402 body for a spent monthly budget. Backwards compatible: `error` stays
 * "budget_exceeded" (or whatever the route's existing code is, passed as
 * `extra`) and `message` stays the sentence older clients print; the fallback
 * fields are additive.
 */
export function budgetExceededBody(
  plan: Plan,
  resetsAtMs?: number | null,
  extra: Record<string, unknown> = {}
): Record<string, unknown> & BudgetFallback & { message: string; resetsAtMs: number | null } {
  return {
    error: "budget_exceeded",
    message: budgetExceededMessage(plan, resetsAtMs),
    resetsAtMs: resetsAtMs ?? null,
    ...budgetFallbackFor(plan),
    ...extra,
  };
}
