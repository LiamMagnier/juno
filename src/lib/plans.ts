import type { Plan } from "@prisma/client";
import { getModel, type ModelId } from "@/lib/models";

export interface PlanConfig {
  id: Plan;
  name: string;
  /**
   * Display price in EUR per month, sold HT — every surface that renders it
   * (upgrade, settings) prints "€", and the Stripe prices are EUR. The model
   * budgets in spend.ts are also EUR-defined; API_COST_EUR_PER_USD is the one
   * place the two currencies meet.
   */
  price: number;
  tagline: string;
  /** Monthly message allowance. null = effectively unlimited. */
  monthlyMessages: number | null;
  maxUploadMb: number;
  /**
   * Requested output-token budget per reply. Set effectively unlimited on every
   * plan — the real ceiling is each model's own native max, applied by
   * clampMaxTokens() / PROVIDER_MAX_OUTPUT. No plan imposes a smaller per-reply
   * cap, so replies are never truncated below what the model itself allows.
   */
  maxOutputTokens: number;
  voice: boolean;
  canvas: boolean;
  webSearch: boolean;
  /** env key holding the Stripe price id; undefined for FREE. */
  priceEnvKey?: "STRIPE_PRICE_PRO" | "STRIPE_PRICE_MAX" | "STRIPE_PRICE_MAX20";
  features: string[];
}

export const PLANS: Record<Plan, PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free",
    price: 0,
    tagline: "Try Juno with 15 messages a month.",
    // Trial allowance, not a free tier: enough to feel the product think
    // before paying, small enough to cost cents. The count is enforced by the
    // usual message quota; BUDGET_EUR.FREE in spend.ts is the matching hard
    // spend ceiling, so a trial can never outrun what these 15 messages were
    // sized for. Pricing is ultimately the owner's call — to end the trial,
    // set this back to 0 and BUDGET_EUR.FREE back to 0 (and revert the
    // effectiveMinPlan floor below).
    monthlyMessages: 15,
    maxUploadMb: 5,
    maxOutputTokens: 8192,
    voice: false,
    canvas: true,
    webSearch: false,
    // Leading with the allowance, because settings renders only the first
    // three entries. "Everyday models" = the chat models the catalog itself
    // prices at minPlan FREE (Sonnet, Haiku, GPT Mini, Gemini Flash…) — the
    // set effectiveMinPlan below actually unlocks; flagships stay paid.
    features: [
      "15 messages a month to try Juno, free",
      "Everyday models (Claude Sonnet, GPT Mini, Gemini Flash…)",
      "Canvas, artifacts & file uploads",
      "Import your ChatGPT or Claude history",
      "Export everything you own, any time",
    ],
  },
  PRO: {
    id: "PRO",
    name: "Pro",
    price: 20,
    tagline: "For everyday power use.",
    monthlyMessages: null,
    maxUploadMb: 20,
    // Effectively unlimited — clamped down to each model's own native max.
    maxOutputTokens: 200000,
    voice: true,
    canvas: true,
    webSearch: true,
    priceEnvKey: "STRIPE_PRICE_PRO",
    features: [
      "Access to every model (Claude Opus, GPT-5.5, Gemini Pro, GLM, Kimi)",
      "Monthly usage limit based on tokens",
      "Voice mode & voice-to-chat",
      "Memory across conversations",
      "Canvas, artifacts & file uploads",
      "Priority streaming",
    ],
  },
  MAX: {
    id: "MAX",
    name: "Max x5",
    price: 100,
    tagline: "For professionals who live in Juno.",
    monthlyMessages: null,
    maxUploadMb: 50,
    // Effectively unlimited — clamped down to each model's own native max.
    maxOutputTokens: 200000,
    voice: true,
    canvas: true,
    webSearch: true,
    priceEnvKey: "STRIPE_PRICE_MAX",
    features: [
      "Access to every model, at highest priority",
      "5× more tokens than Pro every month",
      "Voice mode & voice-to-chat",
      "Memory across conversations",
      "Canvas, artifacts & file uploads",
      "Highest priority access",
    ],
  },
  MAX20: {
    id: "MAX20",
    name: "Max x20",
    price: 200,
    tagline: "For teams of one who never stop.",
    monthlyMessages: null,
    maxUploadMb: 50,
    // Effectively unlimited — clamped down to each model's own native max.
    maxOutputTokens: 200000,
    voice: true,
    canvas: true,
    webSearch: true,
    priceEnvKey: "STRIPE_PRICE_MAX20",
    features: [
      "Access to every model, at highest priority",
      "The most tokens of any plan — for your heaviest days",
      "Voice mode & voice-to-chat",
      "Memory across conversations",
      "Canvas, artifacts & file uploads",
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
    // Effectively unlimited — clamped down to whatever each model actually allows.
    maxOutputTokens: 200000,
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

export const PLAN_LIST: PlanConfig[] = [PLANS.FREE, PLANS.PRO, PLANS.MAX, PLANS.MAX20];

export function planRank(plan: Plan): number {
  return { FREE: 0, PRO: 1, MAX: 2, MAX20: 3, OWNER: 4 }[plan];
}

/**
 * Policy: the catalog's own minPlan is enforced as-is. Models the catalog
 * prices at FREE are the trial tier — what PLANS.FREE.monthlyMessages and
 * BUDGET_EUR.FREE (spend.ts) let a signed-up user actually try — while
 * flagships keep their paid minimum. While FREE granted zero messages this
 * floored everything at Pro; to end the trial, restore
 * `planRank(minPlan) < planRank("PRO") ? "PRO" : minPlan`.
 *
 * Kept as a function although it is now the identity: it is the single seam
 * every lock badge, picker and API gate reads the policy through.
 */
export function effectiveMinPlan(minPlan: Plan): Plan {
  return minPlan;
}

/** A model is usable if the user's plan meets the model's effective minimum. */
export function canUseModel(plan: Plan, modelId: ModelId): boolean {
  // Auto is always selectable; the router only returns models the plan can call.
  if (modelId === "juno:auto" || modelId === "auto") return true;
  const m = getModel(modelId);
  if (!m) return false;
  return planRank(plan) >= planRank(effectiveMinPlan(m.minPlan));
}
