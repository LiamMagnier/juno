import Stripe from "stripe";
import type { Plan } from "@prisma/client";
import { env } from "@/lib/env";

let stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!env.stripe.secretKey) throw new Error("Stripe is not configured.");
  if (!stripe) stripe = new Stripe(env.stripe.secretKey, { typescript: true });
  return stripe;
}

export function planFromPriceId(priceId?: string | null): Plan | null {
  if (!priceId) return null;
  if (priceId === env.stripe.pricePro) return "PRO";
  if (priceId === env.stripe.priceMax) return "MAX";
  if (priceId === env.stripe.priceMax20) return "MAX20";
  return null;
}

export function priceIdForPlan(plan: Plan): string | undefined {
  if (plan === "PRO") return env.stripe.pricePro;
  if (plan === "MAX") return env.stripe.priceMax;
  if (plan === "MAX20") return env.stripe.priceMax20;
  return undefined;
}

/** A plan tier can only be *offered* when its Stripe price id is configured. */
export function isPlanPurchasable(plan: Plan): boolean {
  return Boolean(priceIdForPlan(plan));
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
