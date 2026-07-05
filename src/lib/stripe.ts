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
