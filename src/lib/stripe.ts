import Stripe from "stripe";
import type { Plan } from "@prisma/client";
import { env } from "@/lib/env";

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

const PAID_PLANS = ["PRO", "MAX", "MAX20"] as const;
const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

export function priceIdForPlan(plan: Plan, interval: BillingInterval = "month"): string | undefined {
  if (interval === "year") {
    if (plan === "PRO") return env.stripe.priceProYearly;
    if (plan === "MAX") return env.stripe.priceMaxYearly;
    if (plan === "MAX20") return env.stripe.priceMax20Yearly;
    return undefined;
  }
  if (plan === "PRO") return env.stripe.pricePro;
  if (plan === "MAX") return env.stripe.priceMax;
  if (plan === "MAX20") return env.stripe.priceMax20;
  return undefined;
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
