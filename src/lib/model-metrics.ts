import type { ModelInfo } from "@/lib/models";
import type { Provider } from "@/lib/providers";

export type ReasoningEffort = "low" | "medium" | "high" | null;

export interface ModelMetrics {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  contextTokens: number;
  speed: number;
  intelligence: number;
  source: "official" | "provider" | "estimated";
}

const MTOK = 1_000_000;

function metric(
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  contextTokens: number,
  speed: number,
  intelligence: number
): ModelMetrics {
  return { inputUsdPerMTok, outputUsdPerMTok, contextTokens, speed, intelligence, source: "official" };
}

interface FamilyRule {
  hints: string[]; // ALL must be substrings of the lowercased providerModel id
  metric: ModelMetrics;
}

// Per-provider family rules, MOST SPECIFIC FIRST. Real current pricing (USD per
// 1M tokens) + context windows; speed/intelligence are 1–10 normalized across
// ALL providers (10 = SOTA frontier intelligence / fastest tiny model). Sourced
// from a per-provider pricing sweep, adversarially sanity-checked.
const FAMILY_RULES: Partial<Record<Provider, FamilyRule[]>> = {
  anthropic: [
    { hints: ["opus"], metric: metric(5, 25, 1_000_000, 3, 10) },
    { hints: ["sonnet"], metric: metric(3, 15, 1_000_000, 5, 9) },
    { hints: ["haiku"], metric: metric(1, 5, 200_000, 9, 7) },
  ],
  openai: [
    { hints: ["4o-mini"], metric: metric(0.15, 0.6, 128_000, 10, 4) },
    { hints: ["4o"], metric: metric(2.5, 10, 128_000, 8, 6) },
    { hints: ["o3"], metric: metric(2, 8, 200_000, 4, 9) },
    { hints: ["o4"], metric: metric(2, 8, 200_000, 4, 9) },
    { hints: ["o1"], metric: metric(2, 8, 200_000, 4, 9) },
    { hints: ["nano"], metric: metric(0.2, 1.25, 400_000, 10, 6) },
    { hints: ["mini"], metric: metric(0.75, 4.5, 400_000, 9, 8) },
    { hints: ["gpt-4.1"], metric: metric(2, 8, 1_000_000, 7, 8) },
    { hints: ["gpt-5"], metric: metric(2.5, 15, 1_000_000, 6, 9) },
  ],
  google: [
    { hints: ["flash-lite"], metric: metric(0.1, 0.4, 1_048_576, 10, 5) },
    { hints: ["flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 7) },
    { hints: ["pro"], metric: metric(1.25, 10, 1_048_576, 5, 9) },
  ],
  zhipu: [
    { hints: ["air"], metric: metric(0.2, 1.1, 128_000, 6, 7) },
    { hints: ["flash"], metric: metric(0, 0, 128_000, 10, 5) },
    { hints: ["glm"], metric: metric(0.6, 2.2, 200_000, 6, 8) },
  ],
  moonshot: [
    { hints: ["k2.6"], metric: metric(0.95, 4, 262_144, 4, 9) },
    { hints: ["k2.5"], metric: metric(0.6, 3, 262_144, 4, 8) },
    { hints: ["kimi"], metric: metric(0.6, 2.5, 262_144, 5, 8) },
  ],
  deepseek: [
    { hints: ["reason"], metric: metric(0.55, 2.19, 64_000, 3, 9) },
    { hints: ["deepseek"], metric: metric(0.27, 1.1, 64_000, 5, 7) },
  ],
  mistral: [
    { hints: ["magistral"], metric: metric(2, 5, 131_072, 3, 8) },
    { hints: ["large"], metric: metric(0.5, 1.5, 262_144, 5, 7) },
    { hints: ["small"], metric: metric(0.15, 0.6, 131_072, 9, 6) },
  ],
  xai: [
    { hints: ["fast"], metric: metric(0.2, 0.5, 2_000_000, 8, 8) },
    { hints: ["grok"], metric: metric(1.25, 2.5, 1_000_000, 6, 9) },
  ],
};

// Sensible per-provider default so an unrecognized model still gets real-ish
// numbers (not the generic cost-tier estimate).
const PROVIDER_DEFAULT: Partial<Record<Provider, ModelMetrics>> = {
  anthropic: metric(3, 15, 200_000, 6, 8),
  openai: metric(2.5, 15, 400_000, 6, 8),
  google: metric(0.3, 2.5, 1_048_576, 9, 7),
  zhipu: metric(0.6, 2.2, 128_000, 6, 7),
  moonshot: metric(0.6, 2.5, 262_144, 5, 8),
  deepseek: metric(0.27, 1.1, 64_000, 5, 7),
  mistral: metric(0.5, 1.5, 131_072, 6, 7),
  xai: metric(1.25, 2.5, 1_000_000, 6, 9),
};

function familyMetric(model: ModelInfo): ModelMetrics | null {
  const id = model.providerModel.toLowerCase();
  const rules = FAMILY_RULES[model.provider];
  if (rules) {
    for (const rule of rules) {
      if (rule.hints.every((h) => id.includes(h))) return rule.metric;
    }
  }
  return PROVIDER_DEFAULT[model.provider] ?? null;
}

export function getModelMetrics(model: ModelInfo): ModelMetrics {
  const known = familyMetric(model);
  if (known) return known;
  const base = {
    inputUsdPerMTok: model.cost === 3 ? 2 : model.cost === 2 ? 0.5 : 0.1,
    outputUsdPerMTok: model.cost === 3 ? 10 : model.cost === 2 ? 2 : 0.4,
    contextTokens: model.cost === 3 ? 256_000 : 128_000,
    speed: model.cost === 1 ? 9 : model.cost === 2 ? 7 : 5,
    intelligence: model.cost === 3 ? 8 : model.cost === 2 ? 7 : 5,
  };
  return { ...base, source: "estimated" };
}

export function reasoningMultiplier(effort: ReasoningEffort): number {
  if (effort === "high") return 1.65;
  if (effort === "medium") return 1.25;
  if (effort === "low") return 1.08;
  return 1;
}

export function applyReasoning(metrics: ModelMetrics, effort: ReasoningEffort, supportsReasoning: boolean): ModelMetrics {
  if (!supportsReasoning || !effort) return metrics;
  const multiplier = reasoningMultiplier(effort);
  const intelligenceBoost = effort === "high" ? 2 : effort === "medium" ? 1 : 0.4;
  const speedPenalty = effort === "high" ? 0.62 : effort === "medium" ? 0.82 : 0.93;
  return {
    ...metrics,
    outputUsdPerMTok: roundMoney(metrics.outputUsdPerMTok * multiplier),
    speed: Math.max(1, Math.round(metrics.speed * speedPenalty)),
    intelligence: Math.min(10, Math.round(metrics.intelligence + intelligenceBoost)),
  };
}

export function costScore(metrics: ModelMetrics): number {
  const blended = metrics.inputUsdPerMTok * 0.35 + metrics.outputUsdPerMTok * 0.65;
  return Math.max(1, Math.min(10, Math.round(11 - Math.log2(blended + 1) * 2.2)));
}

/**
 * Expensiveness on a 1–10 scale: HIGHER = pricier (output-weighted, log-scaled).
 * Opus/GPT-flagship land ~9–10; tiny/mini models land ~1–2. Rises with reasoning
 * effort because thinking burns more output tokens.
 */
export function expensivenessScore(metrics: ModelMetrics): number {
  const blended = metrics.inputUsdPerMTok * 0.25 + metrics.outputUsdPerMTok * 0.75;
  return Math.max(1, Math.min(10, Math.round(Math.log2(blended + 1) * 2.0 + 0.2)));
}

export function contextScore(tokens: number): number {
  if (tokens >= MTOK) return 10;
  if (tokens >= 256_000) return 8;
  if (tokens >= 128_000) return 6;
  if (tokens >= 64_000) return 5;
  return 4;
}

export function formatContext(tokens: number): string {
  if (tokens >= MTOK) {
    const m = tokens / MTOK;
    return `${Number.isInteger(m) ? m : +m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
}

export function formatPrice(value: number): string {
  return `$${value >= 1 ? value.toFixed(value % 1 === 0 ? 0 : 2) : value.toFixed(2)}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
