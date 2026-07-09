import type { ModelInfo } from "@/lib/models";
import type { Provider } from "@/lib/providers";

export type ReasoningEffort = "low" | "medium" | "high" | "max" | null;

export interface ModelMetrics {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  contextTokens: number;
  speed: number;
  intelligence: number;
  source: "official" | "provider" | "estimated";
}

const MTOK = 1_000_000;

// Estimates informed by the provider's positioning + cost tier ("provider");
// use `official` only for figures stated verbatim in docs/models.md.
function metric(
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  contextTokens: number,
  speed: number,
  intelligence: number,
  source: ModelMetrics["source"] = "provider"
): ModelMetrics {
  return { inputUsdPerMTok, outputUsdPerMTok, contextTokens, speed, intelligence, source };
}

const official = (i: number, o: number, ctx: number, speed: number, intelligence: number): ModelMetrics =>
  metric(i, o, ctx, speed, intelligence, "official");

interface FamilyRule {
  hints: string[]; // ALL must be substrings of the lowercased providerModel id
  metric: ModelMetrics;
}

// Per-provider family rules, MOST SPECIFIC FIRST — covers every family in the
// curated registry (synced with docs/models.md, audit 2026-07-01). Pricing is
// USD per 1M tokens; contextTokens is a FALLBACK for discovered models (the
// registry's per-model contextWindow wins in getModelMetrics). speed and
// intelligence are 1–10 normalized across ALL providers (10 = frontier-pro
// intelligence / fastest nano-class model), monotonic within each provider.
const FAMILY_RULES: Partial<Record<Provider, FamilyRule[]>> = {
  anthropic: [
    { hints: ["fable"], metric: metric(8, 40, 1_000_000, 3, 10) },
    { hints: ["mythos"], metric: metric(8, 40, 1_000_000, 3, 10) },
    { hints: ["opus"], metric: metric(5, 25, 1_000_000, 3, 9) },
    { hints: ["sonnet-5"], metric: official(2, 10, 1_000_000, 6, 9) }, // intro pricing through Aug 31 2026
    { hints: ["sonnet"], metric: metric(3, 15, 1_000_000, 6, 8) },
    { hints: ["haiku"], metric: metric(1, 5, 200_000, 9, 7) },
  ],
  openai: [
    { hints: ["gpt-5.6-sol"], metric: official(5, 30, 1_050_000, 5, 9) }, // GA 2026-07 flagship tier
    { hints: ["gpt-5.6-terra"], metric: official(2.5, 15, 1_050_000, 7, 8) },
    { hints: ["gpt-5.6-luna"], metric: official(1, 6, 1_050_000, 9, 7) },
    { hints: ["gpt-5.6"], metric: official(5, 30, 1_050_000, 5, 9) }, // bare alias routes to Sol
    { hints: ["gpt-5.5-pro"], metric: official(30, 180, 1_050_000, 2, 10) },
    { hints: ["gpt-5.5"], metric: official(5, 30, 1_050_000, 5, 9) },
    { hints: ["gpt-5.4-pro"], metric: official(30, 180, 400_000, 2, 9) },
    { hints: ["gpt-5.4-mini"], metric: official(0.75, 4.5, 400_000, 9, 7) },
    { hints: ["gpt-5.4-nano"], metric: official(0.2, 1.25, 400_000, 10, 5) },
    { hints: ["gpt-5.4"], metric: official(2.5, 15, 1_050_000, 7, 8) },
    { hints: ["gpt-5.3-codex"], metric: metric(1.25, 10, 400_000, 4, 9) },
    { hints: ["gpt-5.2-pro"], metric: official(21, 168, 400_000, 2, 9) },
    { hints: ["gpt-5.2-codex"], metric: official(1.75, 14, 400_000, 4, 8) },
    { hints: ["gpt-5.2"], metric: official(1.75, 14, 400_000, 5, 8) },
    { hints: ["gpt-5.1-codex-mini"], metric: official(0.25, 2, 400_000, 7, 6) },
    { hints: ["gpt-5.1-codex"], metric: official(1.25, 10, 400_000, 5, 8) },
    { hints: ["gpt-5.1"], metric: official(1.25, 10, 400_000, 5, 8) },
    { hints: ["gpt-5-pro"], metric: metric(15, 120, 400_000, 2, 9) },
    { hints: ["gpt-5-mini"], metric: metric(0.25, 2, 400_000, 9, 6) },
    { hints: ["gpt-5-nano"], metric: metric(0.05, 0.4, 400_000, 10, 4) },
    { hints: ["o4-mini"], metric: metric(1.1, 4.4, 200_000, 6, 7) },
    { hints: ["o3-mini"], metric: metric(1.1, 4.4, 200_000, 6, 6) },
    { hints: ["o3"], metric: metric(2, 8, 200_000, 3, 8) },
    { hints: ["o1"], metric: metric(15, 60, 200_000, 2, 7) },
    { hints: ["4o-mini"], metric: metric(0.15, 0.6, 128_000, 9, 4) },
    { hints: ["4o"], metric: metric(2.5, 10, 128_000, 7, 6) },
    { hints: ["gpt-4.1"], metric: metric(2, 8, 1_000_000, 7, 7) },
    { hints: ["gpt-4-turbo"], metric: metric(10, 30, 128_000, 4, 5) },
    { hints: ["gpt-3.5"], metric: metric(0.5, 1.5, 16_385, 8, 2) },
    { hints: ["nano"], metric: metric(0.1, 0.5, 400_000, 10, 5) },
    { hints: ["mini"], metric: metric(0.5, 2.5, 400_000, 9, 7) },
    { hints: ["gpt-5"], metric: metric(1.25, 10, 400_000, 5, 8) },
  ],
  google: [
    { hints: ["3.5-flash"], metric: metric(0.5, 3, 1_048_576, 8, 9) },
    { hints: ["3.1-flash-lite"], metric: metric(0.1, 0.4, 1_048_576, 10, 6) },
    { hints: ["3.1-pro"], metric: metric(2, 12, 1_048_576, 4, 9) },
    { hints: ["3-flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 7) },
    { hints: ["2.5-pro"], metric: metric(1.25, 10, 1_048_576, 4, 8) },
    { hints: ["2.5-flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 6) },
    { hints: ["flash-lite"], metric: metric(0.1, 0.4, 1_048_576, 10, 5) },
    { hints: ["flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 6) },
    { hints: ["pro"], metric: metric(1.25, 10, 1_048_576, 5, 8) },
  ],
  meta: [
    { hints: ["maverick"], metric: metric(0.9, 0.9, 1_000_000, 6, 8) },
    { hints: ["scout"], metric: metric(0.4, 0.4, 10_000_000, 8, 7) },
    { hints: ["llama-3.3"], metric: metric(0.2, 0.2, 128_000, 8, 6) },
    { hints: ["llama"], metric: metric(0.4, 0.4, 1_000_000, 7, 7) },
  ],
  zhipu: [
    { hints: ["glm-5.2"], metric: metric(1.4, 4.4, 1_000_000, 5, 9) }, // official Z.ai list price
    { hints: ["glm-5v-turbo"], metric: metric(1.2, 4.0, 128_000, 7, 7) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5v"], metric: metric(0.6, 1.8, 128_000, 7, 7) },
    { hints: ["glm-5-turbo"], metric: metric(1.2, 4.0, 200_000, 8, 7) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5.1"], metric: metric(0.6, 2.2, 200_000, 5, 8) },
    { hints: ["glm-4.7-flash"], metric: metric(0, 0, 200_000, 9, 6) }, // free tier
    { hints: ["glm-4.7"], metric: metric(0.3, 1.2, 200_000, 6, 7) },
    { hints: ["glm-4.6v"], metric: metric(0.3, 1.2, 128_000, 6, 6) },
    { hints: ["glm-4.6"], metric: metric(0.25, 1, 128_000, 6, 6) },
    { hints: ["air"], metric: metric(0.2, 1.1, 128_000, 7, 6) },
    { hints: ["flash"], metric: metric(0, 0, 128_000, 10, 5) },
    { hints: ["glm-5"], metric: metric(0.6, 2.2, 200_000, 5, 8) },
    { hints: ["glm"], metric: metric(0.6, 2.2, 200_000, 6, 7) },
  ],
  moonshot: [
    { hints: ["highspeed"], metric: metric(2.4, 10, 262_144, 8, 9) }, // premium ~180 tok/s serving
    { hints: ["k2.7"], metric: metric(1.2, 5, 262_144, 4, 9) },
    { hints: ["k2.6"], metric: metric(1, 4, 262_144, 4, 9) },
    { hints: ["k2.5"], metric: metric(0.6, 2.5, 262_144, 5, 8) },
    { hints: ["moonshot-v1"], metric: metric(1, 3, 131_072, 6, 5) },
    { hints: ["kimi"], metric: metric(1, 4, 262_144, 5, 8) },
  ],
  deepseek: [
    { hints: ["v4-pro"], metric: metric(1.2, 4.2, 1_000_000, 4, 9) },
    { hints: ["v4-flash"], metric: metric(0.4, 1.4, 1_000_000, 8, 8) }, // ~a third of V4 Pro
    { hints: ["v4"], metric: metric(0.4, 1.4, 1_000_000, 8, 8) },
    { hints: ["reason"], metric: metric(0.4, 1.4, 1_000_000, 5, 8) }, // alias → V4 Flash
    { hints: ["deepseek"], metric: metric(0.4, 1.4, 1_000_000, 7, 7) }, // alias → V4 Flash
  ],
  mistral: [
    { hints: ["magistral"], metric: metric(2, 5, 131_072, 3, 8) },
    { hints: ["devstral"], metric: metric(0.4, 2, 262_144, 6, 7) },
    { hints: ["codestral"], metric: metric(0.3, 0.9, 262_144, 9, 6) },
    { hints: ["ministral"], metric: metric(0.15, 0.15, 131_072, 9, 4) },
    { hints: ["medium"], metric: metric(0.5, 2.2, 262_144, 5, 8) },
    { hints: ["large"], metric: metric(0.3, 0.9, 262_144, 5, 7) }, // open-weight, priced low
    { hints: ["small"], metric: metric(0.1, 0.3, 262_144, 8, 6) },
  ],
  xai: [
    { hints: ["multi-agent"], metric: metric(3, 15, 1_000_000, 2, 9) },
    { hints: ["grok-build"], metric: metric(0.5, 2, 256_000, 8, 8) },
    { hints: ["grok-4.3"], metric: metric(2, 10, 1_000_000, 5, 9) },
    { hints: ["4.20", "non-reasoning"], metric: metric(1.5, 8, 1_000_000, 7, 7) },
    { hints: ["4.20"], metric: metric(1.5, 8, 1_000_000, 5, 8) },
    { hints: ["fast"], metric: metric(0.2, 0.5, 2_000_000, 9, 7) },
    { hints: ["grok"], metric: metric(2, 10, 1_000_000, 5, 8) },
  ],
  minimax: [
    { hints: ["m3"], metric: metric(0.5, 2.2, 1_000_000, 5, 9) },
    { hints: ["highspeed"], metric: metric(0.6, 2.4, 204_800, 9, 8) }, // low-latency serving premium
    { hints: ["m2.7"], metric: metric(0.3, 1.2, 204_800, 5, 8) },
    { hints: ["m2.5"], metric: metric(0.2, 0.8, 204_800, 5, 7) },
    { hints: ["m2"], metric: metric(0.3, 1.2, 204_800, 5, 7) },
  ],
  mimo: [
    { hints: ["flash"], metric: metric(0.2, 0.8, 256_000, 9, 8) },
    { hints: ["pro"], metric: metric(0.4, 1.6, 256_000, 5, 9) },
  ],
  qwen: [
    { hints: ["qwen3.7-max"], metric: metric(1.25, 3.75, 1_000_000, 4, 9) },
    { hints: ["qwen3.7-plus"], metric: metric(0.4, 1.2, 1_000_000, 6, 8) },
    { hints: ["qwen3.6-plus"], metric: metric(0.4, 1.2, 1_000_000, 7, 8) },
    { hints: ["qwen3.6-flash"], metric: metric(0.19, 1.13, 1_000_000, 9, 6) },
    { hints: ["qwen3.5-plus"], metric: metric(0.4, 1.2, 1_000_000, 7, 7) },
    { hints: ["qwen3.5-flash"], metric: metric(0.19, 1.13, 1_000_000, 9, 5) },
    { hints: ["qwen-long"], metric: metric(0.4, 1.2, 10_000_000, 5, 6) },
    { hints: ["qwen3-max"], metric: metric(1.2, 6, 262_144, 4, 9) },
    { hints: ["qwen3-coder"], metric: metric(1, 5, 1_000_000, 6, 8) },
    { hints: ["qwen3-vl"], metric: metric(0.8, 3.2, 262_144, 6, 8) },
    { hints: ["qwen-vl"], metric: metric(0.8, 3.2, 32_768, 6, 6) },
    { hints: ["qwen3-235"], metric: metric(0.7, 2.8, 262_144, 5, 8) },
    { hints: ["qwen3-30"], metric: metric(0.2, 0.8, 262_144, 8, 7) },
    { hints: ["qwq"], metric: metric(0.8, 2.4, 131_072, 4, 7) },
    { hints: ["plus"], metric: metric(0.4, 1.2, 1_000_000, 6, 8) },
    { hints: ["flash"], metric: metric(0.05, 0.4, 1_000_000, 9, 6) },
    { hints: ["turbo"], metric: metric(0.05, 0.2, 1_000_000, 9, 5) },
    { hints: ["max"], metric: metric(1.2, 6, 32_768, 4, 8) },
    { hints: ["qwen"], metric: metric(0.4, 1.2, 262_144, 6, 7) },
  ],
  hunyuan: [
    { hints: ["hy3"], metric: metric(0.6, 2.4, 256_000, 6, 8) },
    { hints: ["hunyuan"], metric: metric(0.6, 2.4, 256_000, 6, 8) },
  ],
};

// Sensible per-provider default so an unrecognized model still gets real-ish
// numbers (not the generic cost-tier estimate).
const PROVIDER_DEFAULT: Partial<Record<Provider, ModelMetrics>> = {
  anthropic: metric(3, 15, 200_000, 6, 8),
  openai: metric(2.5, 15, 400_000, 6, 8),
  google: metric(0.5, 3, 1_048_576, 8, 7),
  meta: metric(0.4, 0.4, 1_000_000, 7, 7),
  zhipu: metric(0.6, 2.2, 200_000, 6, 7),
  moonshot: metric(1, 4, 262_144, 5, 8),
  deepseek: metric(0.4, 1.4, 1_000_000, 6, 8),
  mistral: metric(0.5, 2.2, 262_144, 6, 7),
  xai: metric(2, 10, 1_000_000, 5, 8),
  minimax: metric(0.3, 1.2, 204_800, 6, 8),
  mimo: metric(0.4, 1.6, 256_000, 6, 8),
  qwen: metric(0.4, 1.2, 262_144, 6, 8),
  longcat: metric(0.4, 2, 1_000_000, 6, 8),
  hunyuan: metric(0.6, 2.4, 256_000, 6, 8),
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
  const base: ModelMetrics = known ?? {
    inputUsdPerMTok: model.cost === 3 ? 2 : model.cost === 2 ? 0.5 : 0.1,
    outputUsdPerMTok: model.cost === 3 ? 10 : model.cost === 2 ? 2 : 0.4,
    contextTokens: model.cost === 3 ? 256_000 : 128_000,
    speed: model.cost === 1 ? 9 : model.cost === 2 ? 7 : 5,
    intelligence: model.cost === 3 ? 8 : model.cost === 2 ? 7 : 5,
    source: "estimated",
  };
  // The registry's verified per-model context window always wins; the family
  // rule's contextTokens is only a fallback for discovered models.
  if (model.contextWindow && model.contextWindow !== base.contextTokens) {
    return { ...base, contextTokens: model.contextWindow };
  }
  return base;
}

export function reasoningMultiplier(effort: ReasoningEffort): number {
  if (effort === "max") return 2;
  if (effort === "high") return 1.65;
  if (effort === "medium") return 1.25;
  if (effort === "low") return 1.08;
  return 1;
}

export function applyReasoning(metrics: ModelMetrics, effort: ReasoningEffort, supportsReasoning: boolean): ModelMetrics {
  if (!supportsReasoning || !effort) return metrics;
  const multiplier = reasoningMultiplier(effort);
  const intelligenceBoost = effort === "max" ? 2.4 : effort === "high" ? 2 : effort === "medium" ? 1 : 0.4;
  const speedPenalty = effort === "max" ? 0.48 : effort === "high" ? 0.62 : effort === "medium" ? 0.82 : 0.93;
  return {
    ...metrics,
    outputUsdPerMTok: roundMoney(metrics.outputUsdPerMTok * multiplier),
    speed: Math.max(1, Math.round(metrics.speed * speedPenalty)),
    intelligence: Math.min(10, Math.round(metrics.intelligence + intelligenceBoost)),
  };
}

// ---------------------------------------------------------------------------
// Per-model thinking/reasoning tiers — REAL, provider-verified data (2026-07).
// Juno's ladder is Instant · Low · Medium · High · Max. Most providers stop at
// "high"; only a few genuinely expose a tier above it. Some models always reason
// (no Instant), and a couple are pure on/off toggles.
// ---------------------------------------------------------------------------
export type ReasoningTier = "low" | "medium" | "high" | "max";
const TIER_ORDER: ReasoningTier[] = ["low", "medium", "high", "max"];
const LMH: ReasoningTier[] = ["low", "medium", "high"];
const LMHX: ReasoningTier[] = ["low", "medium", "high", "max"];

export interface ReasoningCaps {
  /** Selectable depth tiers for this model (subset of low/medium/high/max). */
  tiers: ReasoningTier[];
  /** Whether thinking can be turned OFF (an "Instant" option is valid). */
  canDisable: boolean;
  /** On/off-only model (e.g. GLM-4.6): one "Thinking" state, no depth levels. */
  onOff: boolean;
}

const caps = (tiers: ReasoningTier[], canDisable: boolean, onOff = false): ReasoningCaps => ({ tiers, canDisable, onOff });

/** What thinking tiers a model actually supports, keyed off its provider + id. */
export function reasoningCaps(model: ModelInfo): ReasoningCaps {
  if (!model.reasoning) return caps([], true);
  const id = model.providerModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      if (id.includes("fable") || id.includes("mythos")) return caps(LMHX, false); // always reason
      if (id.includes("opus-4-5") || id.includes("haiku")) return caps(LMH, true); // no "max"
      return caps(LMHX, true); // opus 4.6/4.7/4.8, sonnet 4.6/5
    case "openai":
      if (/gpt-5(\.\d)?-pro/.test(id)) return caps([], false); // pro tier (5-pro/5.4-pro/5.5-pro): fixed effort, no control
      if (id.includes("gpt-5.6") || id.includes("gpt-5.5") || id.includes("gpt-5.3-codex") || id.includes("gpt-5.2")) return caps(LMHX, true);
      if (/(^|[^a-z0-9])o[134](-|$)/.test(id) || id.includes("o4-mini")) return caps(LMH, false); // o-series always reason
      if (id.includes("gpt-5")) return caps(LMH, true); // gpt-5, gpt-5.1 (no "max")
      return caps(LMH, true);
    case "google":
      if (id.includes("pro")) return caps(LMH, false); // Gemini Pro always thinks, no "max"
      return caps(LMH, true); // flash / flash-lite — no "max"
    case "xai":
      if (id.includes("grok-4.3")) return caps(LMH, true); // effort none/low/medium/high
      if (id.includes("grok-3-mini")) return caps(["low", "high"], false); // only low + high
      return caps([], false); // grok-4 / grok-build: reasons, no control
    case "deepseek":
      if (id.includes("v4")) return caps(["high", "max"], true);
      return caps([], false); // deepseek-reasoner: always on, no control
    case "zhipu":
      if (/glm-?5/.test(id)) return caps(["high", "max"], true);
      return caps([], true, true); // glm-4.5/4.6: on/off toggle
    case "mistral":
      if (id.includes("magistral")) return caps([], false); // always on, no control
      if (id.includes("medium")) return caps(LMH, true); // Medium 3.5: reasoning effort, off by default
      return caps([], false); // small 4 hybrid: reasons, no exposed control
    case "moonshot":
      return caps([], false); // kimi thinking: always on, no control
    case "minimax":
      if (id.includes("m3")) return caps([], true, true); // M3 adaptive thinking: on/off toggle
      return caps([], false); // M2.x: always-on interleaved thinking
    case "mimo":
      return caps(LMH, true); // MiMo: OpenAI-style reasoning_effort, off by default
    case "qwen":
      if (id.includes("qwq")) return caps([], false); // QwQ always reasons, no control
      if (id.includes("coder")) return caps([], true); // Qwen3-Coder: non-thinking
      return caps(LMHX, true); // Qwen3 hybrid: instant + budget-mapped depth tiers
    case "hunyuan":
      return caps(LMH, true); // Hunyuan: OpenAI-style reasoning_effort, off by default
    default:
      return caps([], false);
  }
}

const TIER_LABEL: Record<ReasoningTier, string> = { low: "Low", medium: "Medium", high: "High", max: "Max" };

export interface ReasoningOption {
  value: ReasoningEffort;
  label: string;
}

/** The full ordered option list to render for a model (empty = hide the control). */
export function reasoningOptions(model: ModelInfo): ReasoningOption[] {
  if (!model.reasoning) return [];
  const c = reasoningCaps(model);
  const out: ReasoningOption[] = [];
  if (c.canDisable) out.push({ value: null, label: "Instant" });
  if (c.onOff) out.push({ value: "high", label: "Thinking" });
  else for (const t of c.tiers) out.push({ value: t, label: TIER_LABEL[t] });
  return out;
}

/** Default effort when switching to a model (Instant if it can disable, else a
 *  sensible middle tier for always-on models). */
export function defaultReasoning(model: ModelInfo): ReasoningEffort {
  if (!model.reasoning) return null;
  const c = reasoningCaps(model);
  if (c.canDisable) return null;
  if (c.tiers.length === 0) return null; // always-on with no control — send nothing
  if (c.tiers.includes("medium")) return "medium";
  return c.tiers[Math.min(1, c.tiers.length - 1)] ?? null;
}

/** Coerce a requested effort into something the model actually accepts, so a
 *  stale/unsupported value (e.g. "max" on Gemini) is never sent to the provider. */
export function clampReasoningEffort(model: ModelInfo, requested: ReasoningEffort): ReasoningEffort {
  if (!model.reasoning) return null;
  const c = reasoningCaps(model);
  if (c.onOff) return requested ? "high" : null;
  if (c.tiers.length === 0) return null; // always-on, no control → send nothing
  if (requested == null) return null; // Instant (or provider default for always-on)
  if (c.tiers.includes(requested as ReasoningTier)) return requested;
  const ri = TIER_ORDER.indexOf(requested as ReasoningTier);
  const atOrBelow = c.tiers.filter((t) => TIER_ORDER.indexOf(t) <= ri);
  return atOrBelow.length ? atOrBelow[atOrBelow.length - 1] : c.tiers[0];
}

// Documented assumption for the budget gauge's "requests left" estimate:
// an average chat request costs 800 prompt + 500 completion tokens.
export const AVG_REQUEST_PROMPT_TOKENS = 800;
export const AVG_REQUEST_COMPLETION_TOKENS = 500;

/** Micro-USD cost of an average request (800 in / 500 out) on this model.
 *  µUSD = tokens × $/MTok — the two 10^6 factors cancel. */
export function averageRequestCostMicroUsd(model: ModelInfo): number {
  const m = getModelMetrics(model);
  return Math.round(
    AVG_REQUEST_PROMPT_TOKENS * m.inputUsdPerMTok + AVG_REQUEST_COMPLETION_TOKENS * m.outputUsdPerMTok
  );
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
