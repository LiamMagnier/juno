import type { Plan } from "@prisma/client";
import { getModel, type ModelId, type ModelInfo } from "@/lib/models";
import { PRODUCT_NAME } from "@/lib/brand/names";

export interface PlanConfig {
  id: Plan;
  name: string;
  /**
   * Price in EUR per month, HT (before VAT). The Stripe prices are these HT
   * amounts with Stripe Tax adding the buyer's VAT at checkout, and the model
   * budgets in spend.ts are sized against them. Never render this number to a
   * consumer as-is: EU and French law (Directive 98/6/EC, Code de la
   * consommation L112-1) want the TTC price, so every price on screen goes
   * through `displayPrice()` in price-display.ts.
   */
  price: number;
  tagline: string;
  /** Monthly message allowance. null = metered by the token budget alone. */
  monthlyMessages: number | null;
  maxUploadMb: number;
  /**
   * Requested output-token budget per reply, before clampMaxTokens() bounds it
   * by the lab ceiling and the model's own context window.
   *
   * Effectively unlimited from Pro up, so a reply there is only ever limited
   * by what the model itself allows. FREE and LITE are capped deliberately:
   * their budgets are small, and one 100K-token reply would spend a Lite
   * month. Raising either is a cost decision, not a bug fix.
   */
  maxOutputTokens: number;
  voice: boolean;
  canvas: boolean;
  webSearch: boolean;
  /** The Code product (the ⌘⇧2 surface) and sandboxed code execution in chat. */
  code: boolean;
  /** Agents: Orbit, background Work and the chat task tool. */
  agents: boolean;
  /** Deep research runs. */
  research: boolean;
  /** env key holding the monthly Stripe price id; undefined when not sold. */
  priceEnvKey?:
    | "STRIPE_PRICE_LITE"
    | "STRIPE_PRICE_PRO"
    | "STRIPE_PRICE_PLUS"
    | "STRIPE_PRICE_MAX"
    | "STRIPE_PRICE_MAX20"
    | "STRIPE_PRICE_ULTRA";
  features: string[];
}

export const PLANS: Record<Plan, PlanConfig> = {
  FREE: {
    id: "FREE",
    name: "Free",
    price: 0,
    tagline: "Try it, no card needed.",
    // A small token allowance (BUDGET_EUR.FREE in spend.ts, ~0.20 € of model
    // cost a month) on the cheapest models only — modelRequiredPlan() admits a
    // Free account to a model only when the catalog marks it FREE and cost 1.
    // Voice, web search, Code, agents and research stay paid: those are the
    // features whose cost a 0.20 € budget cannot absorb.
    monthlyMessages: null,
    maxUploadMb: 5,
    maxOutputTokens: 4096,
    voice: false,
    canvas: true,
    webSearch: false,
    code: false,
    agents: false,
    research: false,
    // Settings renders only the first three entries, so the allowance leads.
    features: [
      "A small monthly allowance on fast models",
      "Claude Haiku, GPT-6 Luna, Gemini Flash-Lite, GLM Flash",
      "Import your ChatGPT or Claude history",
      "Export everything you own, any time",
    ],
  },
  LITE: {
    id: "LITE",
    name: "Lite",
    price: 9,
    tagline: "Everyday chat at an everyday price.",
    monthlyMessages: null,
    maxUploadMb: 10,
    maxOutputTokens: 16384,
    voice: false,
    canvas: true,
    webSearch: true,
    code: false,
    agents: false,
    research: false,
    priceEnvKey: "STRIPE_PRICE_LITE",
    features: [
      "Fast everyday models: Claude Sonnet, Gemini Flash, GPT-6 Luna, GLM",
      "Monthly usage limit based on tokens",
      "Web search",
      "Memory, canvas, artifacts & file uploads",
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
    code: true,
    agents: true,
    research: true,
    priceEnvKey: "STRIPE_PRICE_PRO",
    features: [
      "Every model: Claude Opus, GPT-6, Gemini Pro, GLM, Muse Spark",
      "Monthly usage limit based on tokens",
      "Code, agents & deep research",
      "Voice mode & voice-to-chat",
      "Memory, canvas, artifacts & file uploads",
    ],
  },
  PLUS: {
    id: "PLUS",
    name: "Plus",
    price: 50,
    tagline: "For the days Pro runs out by Thursday.",
    monthlyMessages: null,
    maxUploadMb: 50,
    maxOutputTokens: 200000,
    voice: true,
    canvas: true,
    webSearch: true,
    code: true,
    agents: true,
    research: true,
    priceEnvKey: "STRIPE_PRICE_PLUS",
    features: [
      "Every model, at higher priority",
      "2.5× more usage than Pro every month",
      "Code, agents & deep research",
      "Voice mode & voice-to-chat",
      "Memory, canvas, artifacts & file uploads",
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
    code: true,
    agents: true,
    research: true,
    priceEnvKey: "STRIPE_PRICE_MAX",
    features: [
      "Every model, at highest priority",
      "5× more usage than Pro every month",
      "Code, agents & deep research",
      "Voice mode & voice-to-chat",
      "Memory, canvas, artifacts & file uploads",
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
    code: true,
    agents: true,
    research: true,
    priceEnvKey: "STRIPE_PRICE_MAX20",
    features: [
      "Every model, at highest priority",
      "10× more usage than Pro every month",
      "Code, agents & deep research",
      "Voice mode & voice-to-chat",
      "Memory, canvas, artifacts & file uploads",
    ],
  },
  ULTRA: {
    id: "ULTRA",
    name: "Ultra",
    price: 500,
    tagline: "Agents running all day, every day.",
    monthlyMessages: null,
    maxUploadMb: 200,
    maxOutputTokens: 200000,
    voice: true,
    canvas: true,
    webSearch: true,
    code: true,
    agents: true,
    research: true,
    priceEnvKey: "STRIPE_PRICE_ULTRA",
    features: [
      "Every model, at highest priority",
      "25× more usage than Pro every month",
      "Code, agents & deep research",
      "Uploads up to 200 MB",
      "Voice mode & voice-to-chat",
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
    code: true,
    agents: true,
    research: true,
    features: [
      "Unlimited messages & tokens",
      "Every model, incl. experimental",
      "No rate limits",
      "Uploads up to 1 GB",
      "All current and future features",
    ],
  },
};

/** Every tier a customer can hold, cheapest first. */
export const PLAN_LIST: PlanConfig[] = [
  PLANS.FREE,
  PLANS.LITE,
  PLANS.PRO,
  PLANS.PLUS,
  PLANS.MAX,
  PLANS.MAX20,
  PLANS.ULTRA,
];

/**
 * Tier order. The enum's own ordinal is append-only (Postgres adds labels at
 * the end), so LITE sits after OWNER there; THIS is the order every gate reads.
 */
export function planRank(plan: Plan): number {
  return { FREE: 0, LITE: 1, PRO: 2, PLUS: 3, MAX: 4, MAX20: 5, ULTRA: 6, OWNER: 7 }[plan];
}

/** Any plan someone pays for (or the owner). Lite counts: it is a paid plan. */
export function isPaidPlan(plan: Plan): boolean {
  return plan !== "FREE";
}

export type PlanFeature = "voice" | "webSearch" | "code" | "agents" | "research" | "canvas";

export function planIncludes(plan: Plan, feature: PlanFeature): boolean {
  return PLANS[plan][feature];
}

/** The cheapest tier that includes a feature, for "Upgrade to X" copy. */
export function cheapestPlanWith(feature: PlanFeature): Plan {
  return PLAN_LIST.find((p) => p[feature])?.id ?? "PRO";
}

/**
 * Policy: which tier a model needs.
 *
 *   FREE  — the catalog prices it FREE *and* it is a cost-1 model (Haiku,
 *           GPT-6 Luna, Flash-Lite, GLM Flash). The free allowance is ~0.20 €
 *           a month; a mid-price model would spend it in a handful of turns.
 *   LITE  — every other model the catalog prices FREE (Sonnet, Gemini Flash).
 *   as-is — PRO and above stay what the catalog says.
 *
 * This is the single seam every lock badge, picker and API gate reads the
 * policy through.
 */
export function modelRequiredPlan(model: Pick<ModelInfo, "minPlan" | "cost">): Plan {
  if (planRank(model.minPlan) >= planRank("PRO")) return model.minPlan;
  return model.cost <= 1 ? "FREE" : "LITE";
}

/**
 * The tier a catalog `minPlan` maps to when only the plan is known (no cost).
 * Prefer modelRequiredPlan(model): this answers LITE for every FREE-priced
 * model, the conservative reading.
 */
export function effectiveMinPlan(minPlan: Plan): Plan {
  return planRank(minPlan) < planRank("LITE") ? "LITE" : minPlan;
}

/** A model is usable if the user's plan meets the model's required tier. */
export function canUseModel(plan: Plan, modelId: ModelId): boolean {
  // Auto is always selectable; the router only returns models the plan can call.
  if (modelId === "juno:auto" || modelId === "auto") return true;
  const m = getModel(modelId);
  if (!m) return false;
  return planRank(plan) >= planRank(modelRequiredPlan(m));
}
