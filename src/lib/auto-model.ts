/**
 * "Auto" model routing: pick the cheapest chat model that can handle the prompt.
 *
 * Complexity is estimated with cheap, deterministic heuristics (no extra LLM call)
 * so routing adds near-zero latency. Capability floors use the same intelligence /
 * price metrics as the model selector.
 */

import type { Plan } from "@prisma/client";
import { canUseModel } from "@/lib/plans";
import { MODEL_LIST, type ModelId, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { averageRequestCostMicroUsd, getModelMetrics } from "@/lib/model-metrics";

/** Sentinel id shown in the model selector; never sent to a provider API. */
export const AUTO_MODEL_ID: ModelId = "juno:auto";

export function isAutoModelId(id: string | null | undefined): boolean {
  return !!id && (id === AUTO_MODEL_ID || id === "auto" || id.toLowerCase() === "juno:auto");
}

export type PromptComplexity = "simple" | "medium" | "hard" | "expert";

export interface PromptComplexityResult {
  level: PromptComplexity;
  /** Minimum intelligence score (1–10) a model should clear. */
  minIntelligence: number;
  /** Prefer models with reasoning/thinking when true. */
  preferReasoning: boolean;
  /** Why the router chose this tier (debug / future UI). */
  reasons: string[];
}

export interface AutoPickInput {
  message: string;
  plan: Plan;
  hasImages?: boolean;
  wantsWebSearch?: boolean;
  /** Prefer current generation models unless nothing else fits. */
  preferCurrent?: boolean;
}

export interface AutoPickResult {
  model: ModelInfo;
  complexity: PromptComplexityResult;
  /** Models considered, cheapest-first among eligible (for logging). */
  candidatesConsidered: number;
}

const MIN_INTEL: Record<PromptComplexity, number> = {
  simple: 4,
  medium: 6,
  hard: 8,
  expert: 9,
};

/**
 * Score how hard the user prompt is. Tuned to push obvious trivial asks to
 * cheap tiers and multi-step / code / architecture work to flagship tiers.
 */
export function classifyPromptComplexity(message: string): PromptComplexityResult {
  const text = message.trim();
  const lower = text.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const len = text.length;
  if (len > 12_000) {
    score += 4;
    reasons.push("very long prompt");
  } else if (len > 4_000) {
    score += 3;
    reasons.push("long prompt");
  } else if (len > 1_200) {
    score += 2;
    reasons.push("medium-length prompt");
  } else if (len > 280) {
    score += 1;
  }

  const fenceCount = (text.match(/```/g) ?? []).length;
  if (fenceCount >= 2) {
    score += 2;
    reasons.push("code blocks");
  } else if (/`[^`]+`/.test(text) || /\b(function|const |class |import |export |def |fn )\b/.test(text)) {
    score += 1;
    reasons.push("inline code");
  }

  if (
    /\b(architect|refactor|migrate|distributed|concurrency|race condition|security audit|prove|theorem|formal|compiler|kernel|cryptograph)/i.test(
      text
    )
  ) {
    score += 3;
    reasons.push("deep technical language");
  }

  if (
    /\b(step by step|multi-?step|plan then|break down|compare (and|&) contrast|trade-?offs?|pros and cons|research|investigate|debug|root cause|why does|how would you design)/i.test(
      text
    )
  ) {
    score += 2;
    reasons.push("multi-step / analysis framing");
  }

  if (/\b(implement|build|write a|create a|full (app|stack)|end-to-end|production-ready|from scratch)\b/i.test(text)) {
    score += 2;
    reasons.push("build-from-scratch request");
  }

  if (/\b(agent|tool use|function call|orchestrat|workflow|pipeline)\b/i.test(text)) {
    score += 2;
    reasons.push("agentic / tooling request");
  }

  // Structured system-style curricula and long role prompts need a stronger model.
  if (/<\/?[a-z][\w:-]*\b[^>]*>/i.test(text) && len > 2_000) {
    score += 2;
    reasons.push("structured / system-style prompt");
  }

  const hardReasoning =
    /\b(reason|think carefully|chain of thought|prove|rigorous|exhaustive|edge cases?)\b/i.test(text) ||
    score >= 6;
  if (hardReasoning && !reasons.includes("deep technical language")) {
    score += 1;
    reasons.push("reasoning-heavy wording");
  }

  // Trivial short asks stay simple even with a keyword hit.
  if (len < 80 && fenceCount === 0 && score <= 2) {
    score = Math.min(score, 1);
  }

  let level: PromptComplexity;
  if (score >= 8) level = "expert";
  else if (score >= 5) level = "hard";
  else if (score >= 3) level = "medium";
  else level = "simple";

  if (reasons.length === 0) reasons.push("short everyday request");

  return {
    level,
    minIntelligence: MIN_INTEL[level],
    preferReasoning: level === "hard" || level === "expert" || hardReasoning,
    reasons,
  };
}

function isEligibleChatModel(m: ModelInfo, plan: Plan, needsVision: boolean, needsWebSearch: boolean): boolean {
  if (m.modality !== "chat") return false;
  if (m.comingSoon) return false;
  if (m.status === "deprecated") return false;
  if (!isProviderConfigured(m.provider)) return false;
  if (!canUseModel(plan, m.id)) return false;
  if (needsVision && !m.vision) return false;
  if (needsWebSearch && !m.webSearch) return false;
  return true;
}

/**
 * Among models the user can call, pick the cheapest that clears the intelligence
 * floor for this prompt. Prefer `current` over legacy when prices are close.
 */
export function pickAutoModel(input: AutoPickInput): AutoPickResult {
  const complexity = classifyPromptComplexity(input.message);
  const needsVision = !!input.hasImages;
  const needsWebSearch = !!input.wantsWebSearch;
  const preferCurrent = input.preferCurrent !== false;

  let pool = MODEL_LIST.filter((m) => isEligibleChatModel(m, input.plan, needsVision, needsWebSearch));

  // Prefer current generation; fall back to legacy if the floor can't be met.
  if (preferCurrent) {
    const currentOnly = pool.filter((m) => m.status === "current" || !m.status);
    if (currentOnly.some((m) => getModelMetrics(m).intelligence >= complexity.minIntelligence)) {
      pool = currentOnly;
    }
  }

  const capable = pool.filter((m) => {
    const intel = getModelMetrics(m).intelligence;
    if (intel < complexity.minIntelligence) return false;
    if (complexity.preferReasoning && complexity.level === "expert" && !m.reasoning && intel < 9) {
      // Expert work: require explicit reasoning OR top-tier intelligence.
      return false;
    }
    return true;
  });

  const ranked = (capable.length > 0 ? capable : pool).slice().sort((a, b) => {
    const costA = averageRequestCostMicroUsd(a);
    const costB = averageRequestCostMicroUsd(b);
    if (costA !== costB) return costA - costB;
    // Tie-break: higher intelligence at same price, then current over legacy.
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    const curA = a.status === "current" ? 0 : 1;
    const curB = b.status === "current" ? 0 : 1;
    if (curA !== curB) return curA - curB;
    return a.name.localeCompare(b.name);
  });

  const fallback =
    ranked[0] ??
    MODEL_LIST.find((m) => isEligibleChatModel(m, input.plan, false, false)) ??
    MODEL_LIST.find((m) => m.modality === "chat" && !m.comingSoon);

  if (!fallback) {
    throw new Error("No chat model is available for Auto routing.");
  }

  return {
    model: fallback,
    complexity,
    candidatesConsidered: ranked.length || pool.length,
  };
}

/** Lightweight ModelInfo used only for UI when Auto is selected. */
export const AUTO_MODEL_INFO: ModelInfo = {
  id: AUTO_MODEL_ID,
  provider: "anthropic", // logo fallback; UI special-cases Auto
  providerModel: "auto",
  name: "Auto",
  description: "Picks the cheapest model that can handle each prompt.",
  minPlan: "FREE",
  vision: true,
  reasoning: true,
  cost: 1,
  modality: "chat",
  webSearch: true,
  status: "current",
  family: "auto",
  legacy: false,
};
