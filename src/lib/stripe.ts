import Stripe from "stripe";
import type { Plan } from "@prisma/client";
import { env } from "@/lib/env";
import type { TopUpPackId } from "@/lib/credits";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.stripe.secretKey) throw new Error("Stripe is not configured.");
  if (!stripe) stripe = new Stripe(env.stripe.secretKey, { typescript: true });
  return stripe;
}

/**
 * How often a subscription bills. NOT a plan: an annual PRO subscriber has
 * exactly the same entitlement as a monthly one, so the Plan enum — and the
 * database — is unchanged.
 *
 * Budgets stay monthly for both. billingPeriodFor walks in month-sized cells
 * anchored on the subscription boundary, so a Stripe period end a year out
 * still yields ~31-day budget windows on the subscriber's anniversary day.
 * Verified before this shipped, because getting it wrong would either hand an
 * annual subscriber a year of budget at once or never reset them.
 */
export type BillingInterval = "month" | "year";

export function planFromPriceId(priceId?: string | null): Plan | null {
  if (!priceId) return null;
  for (const plan of PAID_PLANS) {
    for (const interval of BILLING_INTERVALS) {
      if (priceId === priceIdForPlan(plan, interval)) return plan;
    }
  }
  return null;
}

const PAID_PLANS = ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];
const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

export function isPaidPlanId(plan: string): plan is PaidPlan {
  return (PAID_PLANS as readonly string[]).includes(plan);
}

export function priceIdForPlan(plan: Plan, interval: BillingInterval = "month"): string | undefined {
  const s = env.stripe;
  const ids: Partial<Record<Plan, { month?: string; year?: string }>> = {
    LITE: { month: s.priceLite, year: s.priceLiteYearly },
    PRO: { month: s.pricePro, year: s.priceProYearly },
    PLUS: { month: s.pricePlus, year: s.pricePlusYearly },
    MAX: { month: s.priceMax, year: s.priceMaxYearly },
    MAX20: { month: s.priceMax20, year: s.priceMax20Yearly },
    ULTRA: { month: s.priceUltra, year: s.priceUltraYearly },
  };
  return ids[plan]?.[interval] || undefined;
}

/** Which interval a recognised plan price bills at, or null for an unknown price. */
export function intervalFromPriceId(priceId?: string | null): BillingInterval | null {
  if (!priceId) return null;
  for (const plan of PAID_PLANS) {
    for (const interval of BILLING_INTERVALS) {
      if (priceId === priceIdForPlan(plan, interval)) return interval;
    }
  }
  return null;
}

/** The one-off Stripe price for a usage top-up pack (STRIPE_PRICE_TOPUP_5/20). */
export function priceIdForTopUp(pack: TopUpPackId): string | undefined {
  return (pack === "5" ? env.stripe.priceTopUp5 : env.stripe.priceTopUp20) || undefined;
}

/** The top-up packs this deployment can sell (their price id is configured). */
export function purchasableTopUps(): TopUpPackId[] {
  return (["5", "20"] as const).filter((pack) => Boolean(priceIdForTopUp(pack)));
}

/**
 * A plan tier can only be *offered* when its Stripe price id is configured.
 *
 * This is deliberately separate from whether a plan is *recognised*: an
 * existing MAX20 subscriber must keep their entitlement even if
 * STRIPE_PRICE_MAX20 is missing from this deployment's env. Gate what is sold,
 * never what is honoured.
 */
export function isPlanPurchasable(plan: Plan, interval: BillingInterval = "month"): boolean {
  return Boolean(priceIdForPlan(plan, interval));
}

/** The paid tiers this deployment can actually sell at a given interval. */
export function purchasablePlans(interval: BillingInterval = "month"): Plan[] {
  return PAID_PLANS.filter((plan) => isPlanPurchasable(plan, interval));
}

export interface ResolvePlanInput {
  /** Stripe subscription status, verbatim. */
  status: string;
  /** What `planFromPriceId` made of the subscription's price, or null. */
  mappedPlan: Plan | null;
  /** The plan currently on record for this customer. */
  currentPlan: Plan;
}

/**
 * Decide what plan a Stripe subscription sync should write.
 *
 * The one rule that matters: an unrecognised price id must never downgrade a
 * paying customer. `PLANS.FREE.monthlyMessages` is 0, so a spurious FREE locks
 * the account out entirely while Stripe keeps billing it — the worst outcome
 * this webhook can produce. A price Juno cannot map is a *deployment* problem
 * (legacy price, promo, currency variant, undeployed STRIPE_PRICE_* var), not
 * evidence about what the customer is entitled to.
 *
 * A canceled subscription is different: that is Stripe stating the entitlement
 * has ended, so FREE is correct regardless of the price.
 */
export function resolveSubscriptionPlan({ status, mappedPlan, currentPlan }: ResolvePlanInput): Plan {
  if (status === "canceled") return "FREE";
  return mappedPlan ?? currentPlan;
}
