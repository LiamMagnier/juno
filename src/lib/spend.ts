import "server-only";
import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";

/**
 * The single budget module: per-plan monthly API budgets, per-request cost
 * computation, the ApiSpend ledger writer, and the pre-stream budget gate.
 *
 * Money is integer micro-USD (1e-6 $) end to end. Budgets are defined in EUR
 * and treated 1:1 with the USD model prices unless API_COST_EUR_PER_USD says
 * how many EUR one USD of model spend costs (e.g. 0.92).
 */

/** Monthly API budget per plan, in EUR. null = unlimited (OWNER). */
const BUDGET_EUR: Record<Plan, number | null> = {
  FREE: 0,
  PRO: 15,
  MAX: 75,
  MAX20: 150,
  OWNER: null,
};

/** How many EUR one USD of model spend costs. Defaults to 1 (EUR ≙ USD). */
export function eurPerUsd(): number {
  const raw = Number(process.env.API_COST_EUR_PER_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** Plan budget in micro-USD, or null for unlimited (OWNER). */
export function budgetForPlan(plan: Plan): number | null {
  const eur = BUDGET_EUR[plan];
  if (eur == null) return null;
  return Math.round((eur / eurPerUsd()) * 1_000_000);
}

/**
 * Cost of one chat request in micro-USD, from the per-model $/1M in/out
 * pricing in model-metrics.ts (µUSD = tokens × $/MTok — the 10^6s cancel).
 * Unknown models fall back to a mid-tier $2/$10 per MTok rate.
 */
export function modelRequestCost({
  modelId,
  promptTokens,
  completionTokens,
}: {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}): number {
  const { input, output } = modelRatesMicroUsdPerToken(modelId);
  return Math.max(0, Math.round(promptTokens * input + completionTokens * output));
}

/**
 * Per-token cost in micro-USD for a model (input and output). Numerically equal
 * to the $/MTok rates — the 10^6 (dollars→micro) and 10^6 (per-MTok→per-token)
 * cancel. Used for real-time, mid-stream budget enforcement in the chat route.
 */
export function modelRatesMicroUsdPerToken(modelId: string): { input: number; output: number } {
  const model = resolveModel(modelId);
  const metrics = model ? getModelMetrics(model) : null;
  return { input: metrics?.inputUsdPerMTok ?? 2, output: metrics?.outputUsdPerMTok ?? 10 };
}

/**
 * Flat per-request cost for media generations, in micro-USD. Image/video
 * providers report no token usage, so each request is billed a documented
 * approximation of public list prices:
 *
 *   image — GPT Image $0.04 · Nano Banana Pro $0.06 · Gemini flash image /
 *           Imagen $0.03 · lite tiers $0.01 · Grok Imagine $0.03 (quality) /
 *           $0.01 (fast) · GLM Image / CogView / MiniMax Image $0.02
 *   video — $0.50 per clip, $0.25 for fast/mini tiers, $0.75 for
 *           cost-tier-3 flagships (Veo 3.1, Seedance 2.0, Hailuo 2.3…)
 */
export function mediaRequestCost(modelId: string, kind: "image" | "video"): number {
  const model = resolveModel(modelId);
  const id = (model?.id ?? modelId).toLowerCase();
  if (kind === "video") {
    if (/fast|mini|lite/.test(id)) return 250_000;
    return (model?.cost ?? 3) >= 3 ? 750_000 : 500_000;
  }
  if (id.includes("gpt-image")) return 40_000;
  if (id.includes("pro-image")) return 60_000;
  if (id.includes("lite")) return 10_000;
  if (id.includes("grok-imagine-image")) return id.includes("quality") ? 30_000 : 10_000;
  if (id.includes("glm-image") || id.includes("cogview") || id.includes("image-01")) return 20_000;
  return 30_000;
}

/** Rough token estimate when a provider reports no usage: chars / 4. */
function estimateTokens(chars: number | undefined): number {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export interface RecordSpendInput {
  userId: string;
  model: string;
  kind: "chat" | "image" | "video" | "voice";
  promptTokens?: number;
  completionTokens?: number;
  /** Fallback when the provider reported no usage: tokens ≈ chars / 4. */
  promptChars?: number;
  completionChars?: number;
  /**
   * Precomputed request cost in USD (cache-aware, per-provider). When set, it
   * is billed verbatim instead of re-deriving at the full input rate — the
   * caller already reconciled cache reads/writes (which providers discount).
   */
  costUsd?: number;
}

/**
 * Compute the request cost and append an ApiSpend ledger row. Fire-and-forget
 * safe: never throws into the caller's stream — failures are logged and the
 * generation proceeds unbilled rather than broken.
 */
export async function recordSpend(input: RecordSpendInput): Promise<void> {
  try {
    const promptTokens = input.promptTokens ?? estimateTokens(input.promptChars);
    const completionTokens = input.completionTokens ?? estimateTokens(input.completionChars);
    const costMicroUsd =
      input.costUsd != null && input.costUsd > 0
        ? Math.round(input.costUsd * 1_000_000)
        : input.kind === "image" || input.kind === "video"
          ? mediaRequestCost(input.model, input.kind)
          : modelRequestCost({ modelId: input.model, promptTokens, completionTokens });
    await prisma.apiSpend.create({
      data: {
        userId: input.userId,
        model: input.model,
        kind: input.kind,
        promptTokens,
        completionTokens,
        costMicroUsd,
      },
    });
  } catch (err) {
    console.error("[spend] failed to record spend", {
      userId: input.userId,
      model: input.model,
      kind: input.kind,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Total spend for the current calendar month (UTC), in micro-USD. */
export async function monthlySpendMicroUsd(userId: string): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const agg = await prisma.apiSpend.aggregate({
    where: { userId, createdAt: { gte: monthStart } },
    _sum: { costMicroUsd: true },
  });
  return agg._sum.costMicroUsd ?? 0;
}

export interface BudgetStatus {
  allowed: boolean;
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
  remainingMicroUsd: number | null;
}

/**
 * Pre-stream budget gate. OWNER is always allowed without touching the
 * database. FREE has a 0 budget and is always blocked — consistent with its
 * 0-monthly-messages policy. Paid plans are allowed while spend < budget.
 */
export async function checkBudget(userId: string, plan: Plan): Promise<BudgetStatus> {
  const budgetMicroUsd = budgetForPlan(plan);
  if (budgetMicroUsd == null) {
    return { allowed: true, spentMicroUsd: 0, budgetMicroUsd: null, remainingMicroUsd: null };
  }
  const spentMicroUsd = await monthlySpendMicroUsd(userId);
  return {
    allowed: spentMicroUsd < budgetMicroUsd,
    spentMicroUsd,
    budgetMicroUsd,
    remainingMicroUsd: Math.max(0, budgetMicroUsd - spentMicroUsd),
  };
}

/** "August 1" — the first day of next month (UTC), when budgets reset. */
export function nextResetLabel(now = new Date()): string {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return reset.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}

/** Friendly sentence for the 402 budget_exceeded response. */
export function budgetExceededMessage(plan: Plan): string {
  if (plan === "FREE") {
    return "The Free plan doesn't include a model budget. Upgrade to Pro to start chatting.";
  }
  return `You've used up your monthly API budget — it resets on ${nextResetLabel()}. Upgrade your plan for a bigger monthly budget.`;
}
