import type { Plan } from "@prisma/client";
import { getModel, type ModelId } from "@/lib/models";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
   * Requested output-token budget per reply, before clampMaxTokens() bounds it
   * by the lab ceiling and the model's own context window.
   *
   * Effectively unlimited on every PAID plan, so a paid reply is only ever
   * limited by what the model itself allows. FREE is the one exception at 8192,
   * and it is deliberate rather than an oversight — but it does mean a free
   * reply can stop early on a model that would happily have written more, and
   * it is the plan-level twin of the per-model truncation PROVIDER_MAX_OUTPUT
   * exists to prevent. Raising it is a cost decision, not a bug fix.
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
    tagline: "Create an account and look around.",
    // An account, not a tier: every model needs a paid plan. The zero is
    // enforced by the usual message quota (the composer and chat view read
    // `limit === 0` as "this plan includes no messages"), BUDGET_EUR.FREE in
    // spend.ts is the matching zero spend ceiling, and effectiveMinPlan below
    // floors every model at Pro — three independent locks on the same rule.
    monthlyMessages: 0,
    maxUploadMb: 5,
    maxOutputTokens: 8192,
    voice: false,
    canvas: true,
    webSearch: false,
    // Leading with the constraint, because settings renders only the first
    // three entries. Nothing here may promise something that needs a model
    // reply (canvas, artifacts, uploads): Free cannot send a message.
    features: [
      "No messages included — chatting needs a paid plan",
      "Import your ChatGPT or Claude history",
      "Browse the app and read your conversations",
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
    // Display names only — the ids and the Stripe price mapping are untouched.
    // The multiplier is the ratio of enforced budgets (BUDGET_EUR in spend.ts:
    // 55 € against Pro's 11 €), and a true "×" rather than a letter x.
    name: "Max ×5",
    price: 100,
    tagline: `For professionals who live in ${PRODUCT_NAME}.`,
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
    // "×10", not the "x20" the id still carries: the enforced budget is 110 €
    // against Pro's 11 € and the price is 200 € against 20 € — ten times on
    // both counts. The id is a Stripe/DB constant and cannot be renamed
    // without a migration; the name is what a customer reads, and it was
    // promising twice what the meter delivers.
    name: "Max ×10",
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
      "The most tokens of any plan, for your heaviest days",
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
 * Policy: every model is locked behind a paid plan — the effective minimum is
 * never below Pro, even for models the catalog itself prices at FREE. Free
 * accounts can sign up, import and browse, but cannot call any model.
 *
 * This is the single seam every lock badge, picker and API gate reads the
 * policy through.
 */
export function effectiveMinPlan(minPlan: Plan): Plan {
  return planRank(minPlan) < planRank("PRO") ? "PRO" : minPlan;
}

/** A model is usable if the user's plan meets the model's effective minimum. */
export function canUseModel(plan: Plan, modelId: ModelId): boolean {
  // Auto is always selectable; the router only returns models the plan can call.
  if (modelId === "juno:auto" || modelId === "auto") return true;
  const m = getModel(modelId);
  if (!m) return false;
  return planRank(plan) >= planRank(effectiveMinPlan(m.minPlan));
}
