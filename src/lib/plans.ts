import type { Plan } from "@prisma/client";
import { getModel, type ModelId } from "@/lib/models";

export interface PlanConfig {
  id: Plan;
  name: string;
  /** Display price in USD per month. */
  price: number;
  tagline: string;
  /** Monthly message allowance. null = effectively unlimited. */
  monthlyMessages: number | null;
  maxUploadMb: number;
  voice: boolean;
  canvas: boolean;
  webSearch: boolean;
  /** env key holding the Stripe price id; undefined for FREE. */
  priceEnvKey?: "STRIPE_PRICE_PRO" | "STRIPE_PRICE_MAX";
  features: string[];
}

export const PLANS: Record<Plan, PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free",
    price: 0,
    tagline: "Create an account and look around.",
    monthlyMessages: 0,
    maxUploadMb: 5,
    voice: false,
    canvas: true,
    webSearch: false,
    features: [
      "Browse the app and your history",
      "Upgrade to Pro to chat with any model",
      "Canvas & artifacts",
      "File & image uploads (5 MB)",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    price: 20,
    tagline: "For everyday power use.",
    monthlyMessages: 1500,
    maxUploadMb: 20,
    voice: true,
    canvas: true,
    webSearch: true,
    priceEnvKey: "STRIPE_PRICE_PRO",
    features: [
      "1,500 messages / month",
      "All models (Claude Opus, GPT-5.5, Gemini Pro, GLM, Kimi)",
      "Uploads up to 20 MB",
      "Voice mode & voice-to-chat",
      "Memory across conversations",
      "Priority streaming",
    ],
  },
  MAX: {
    id: "MAX",
    name: "Max",
    price: 100,
    tagline: "For professionals who live in Juno.",
    monthlyMessages: null,
    maxUploadMb: 50,
    voice: true,
    canvas: true,
    webSearch: true,
    priceEnvKey: "STRIPE_PRICE_MAX",
    features: [
      "Unlimited messages",
      "All models, highest priority",
      "Uploads up to 50 MB",
      "Voice mode & voice-to-chat",
      "Memory across conversations",
      "Highest priority access",
    ],
  },
  // Not purchasable — granted via OWNER_EMAILS. Not shown on the upgrade page.
  OWNER: {
    id: "OWNER",
    name: "Owner",
    price: 0,
    tagline: "Full, unlimited access to everything.",
    monthlyMessages: null,
    maxUploadMb: 1000,
    voice: true,
    canvas: true,
    webSearch: true,
    features: [
      "Unlimited messages & tokens",
      "Every model, incl. experimental",
      "No rate limits",
      "Uploads up to 1 GB",
      "All current and future features",
    ],
  },
};

export const PLAN_LIST: PlanConfig[] = [PLANS.FREE, PLANS.PRO, PLANS.MAX];

export function planRank(plan: Plan): number {
  return { FREE: 0, PRO: 1, MAX: 2, OWNER: 3 }[plan];
}

/**
 * Policy: every model is locked behind a paid plan — the effective minimum is
 * never below Pro, even for models whose own minPlan is Free.
 */
export function effectiveMinPlan(minPlan: Plan): Plan {
  return planRank(minPlan) < planRank("PRO") ? "PRO" : minPlan;
}

/** A model is usable if the user's plan meets the model's (Pro-floored) minimum. */
export function canUseModel(plan: Plan, modelId: ModelId): boolean {
  const m = getModel(modelId);
  if (!m) return false;
  return planRank(plan) >= planRank(effectiveMinPlan(m.minPlan));
}
