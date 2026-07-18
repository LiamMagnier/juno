import type { ModelInfo } from "@/lib/models";
import { PROVIDER_LIST, type Provider } from "@/lib/providers";
import { BENCHMARKS, type ModelBenchmark } from "@/lib/benchmarks.generated";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;

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
// curated registry (synced with docs/models.md, benchmark audit 2026-07-10).
// Pricing is USD per 1M tokens; contextTokens is a FALLBACK for discovered
// models (the registry's per-model contextWindow wins in getModelMetrics).
//
// speed and intelligence are 1–10, normalized across ALL providers with a
// reproducible mapping (sources: Artificial Analysis leaderboard + LMArena,
// 2026-07-10 — see docs/models.md):
//   intelligence = clamp(round((AA Intelligence Index − 2) / 6), 1, 10)
//     e.g. Fable 5 (II 59.9) → 10 · Sonnet 5 (53.4) → 9 · GLM-5.2 (51.1) → 8
//          Grok 4.3 (37.6) → 6 · Haiku 4.5 (29.6) → 5 · Mistral Large 3 (15.9) → 2
//   speed bands from AA median output tok/s: ≥230→10 ≥180→9 ≥140→8 ≥100→7
//     ≥85→6 ≥70→5 ≥55→4 ≥45→3 ≥38→2 else 1 (−1 for extreme time-to-first-
//     answer, e.g. Fable 5's ~2-min adaptive-thinking median).
// Models with no benchmark coverage yet (5.5 Pro, LongCat 2.0, Grok Build…)
// keep positioning-based estimates and stay source:"provider".
const FAMILY_RULES: Partial<Record<Provider, FamilyRule[]>> = {
  anthropic: [
    { hints: ["fable"], metric: official(10, 50, 1_000_000, 3, 10) }, // II 59.9 #1 · 61 tok/s but ~122s to first answer
    { hints: ["mythos"], metric: metric(10, 50, 1_000_000, 3, 10) }, // same specs as Fable, invitation-only
    { hints: ["opus"], metric: official(5, 25, 1_000_000, 4, 9) }, // II 55.7 · 56 tok/s
    { hints: ["sonnet-5"], metric: official(2, 10, 1_000_000, 5, 9) }, // II 53.4 · 79 tok/s · intro pricing, $3/$15 from Sep 1 2026
    { hints: ["sonnet"], metric: metric(3, 15, 1_000_000, 5, 7) },
    { hints: ["haiku"], metric: official(1, 5, 200_000, 6, 5) }, // II 29.6 (reasoning) · 94 tok/s
  ],
  openai: [
    { hints: ["gpt-5.6-sol"], metric: official(5, 30, 1_050_000, 5, 9) }, // II 58.9 #2 · 73 tok/s
    { hints: ["gpt-5.6-terra"], metric: official(2.5, 15, 1_050_000, 8, 9) }, // II 55.0 · 141 tok/s — best value in the OpenAI lineup
    { hints: ["gpt-5.6-luna"], metric: official(1, 6, 1_050_000, 9, 8) }, // II 51.2 · 204 tok/s
    { hints: ["gpt-5.6"], metric: official(5, 30, 1_050_000, 5, 9) }, // bare alias routes to Sol
    { hints: ["gpt-5.5-pro"], metric: official(30, 180, 1_050_000, 1, 9) }, // no AA/arena data — positioning estimate
    { hints: ["gpt-5.5"], metric: official(5, 30, 1_050_000, 4, 9) }, // II 54.8 · 64 tok/s
    { hints: ["gpt-5.4-pro"], metric: official(30, 180, 400_000, 2, 8) },
    { hints: ["gpt-5.4-mini"], metric: official(0.75, 4.5, 400_000, 8, 6) }, // II 40.0 · 160 tok/s
    { hints: ["gpt-5.4-nano"], metric: official(0.2, 1.25, 400_000, 8, 6) }, // II 38.2 · 170 tok/s
    { hints: ["gpt-5.4"], metric: official(2.5, 15, 1_050_000, 7, 8) },
    { hints: ["gpt-5.3-codex"], metric: official(1.75, 14, 400_000, 5, 7) }, // II 44.3 (coding-tuned) · 76 tok/s
    { hints: ["gpt-5.2-pro"], metric: official(21, 168, 400_000, 2, 8) },
    { hints: ["gpt-5.2-codex"], metric: official(1.75, 14, 400_000, 4, 7) },
    { hints: ["gpt-5.2"], metric: official(1.75, 14, 400_000, 5, 7) },
    { hints: ["gpt-5.1-codex-mini"], metric: official(0.25, 2, 400_000, 7, 4) },
    { hints: ["gpt-5.1-codex"], metric: official(1.25, 10, 400_000, 5, 7) },
    { hints: ["gpt-5.1"], metric: official(1.25, 10, 400_000, 5, 7) },
    { hints: ["gpt-5-pro"], metric: metric(15, 120, 400_000, 2, 7) },
    { hints: ["gpt-5-mini"], metric: metric(0.25, 2, 400_000, 8, 4) },
    { hints: ["gpt-5-nano"], metric: metric(0.05, 0.4, 400_000, 9, 3) },
    { hints: ["o4-mini"], metric: metric(1.1, 4.4, 200_000, 6, 4) },
    { hints: ["o3-mini"], metric: metric(1.1, 4.4, 200_000, 6, 3) },
    { hints: ["o3"], metric: metric(2, 8, 200_000, 3, 5) },
    { hints: ["o1"], metric: metric(15, 60, 200_000, 2, 4) },
    { hints: ["4o-mini"], metric: metric(0.15, 0.6, 128_000, 8, 2) },
    { hints: ["4o"], metric: metric(2.5, 10, 128_000, 7, 3) },
    { hints: ["gpt-4.1"], metric: metric(2, 8, 1_000_000, 7, 4) },
    { hints: ["gpt-4-turbo"], metric: metric(10, 30, 128_000, 4, 2) },
    { hints: ["gpt-3.5"], metric: metric(0.5, 1.5, 16_385, 8, 1) },
    { hints: ["nano"], metric: metric(0.1, 0.5, 400_000, 9, 4) },
    { hints: ["mini"], metric: metric(0.5, 2.5, 400_000, 8, 5) },
    { hints: ["gpt-5"], metric: metric(1.25, 10, 400_000, 5, 6) },
  ],
  google: [
    { hints: ["3.5-flash"], metric: official(1.5, 9, 1_048_576, 8, 8) }, // II 50.2 · 152 tok/s — 3x the 2.5 Flash price
    { hints: ["3.1-flash-lite"], metric: official(0.25, 1.5, 1_048_576, 10, 4) }, // II 25.0 · 251 tok/s — fastest in the lineup
    { hints: ["3.1-pro"], metric: official(2, 12, 1_048_576, 7, 7) }, // II 46.5 · 117 tok/s
    { hints: ["3-flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 5) },
    { hints: ["2.5-pro"], metric: metric(1.25, 10, 1_048_576, 4, 4) },
    { hints: ["2.5-flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 3) },
    { hints: ["flash-lite"], metric: metric(0.1, 0.4, 1_048_576, 10, 3) },
    { hints: ["flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 4) },
    { hints: ["pro"], metric: metric(1.25, 10, 1_048_576, 5, 5) },
  ],
  // Llama API shut down 2026-07-06 — rules kept only so stragglers resolving
  // through migration still price correctly. Grades reflect AA/arena standing.
  meta: [
    { hints: ["maverick"], metric: metric(0.35, 0.85, 1_000_000, 7, 2) }, // II 14.3
    { hints: ["scout"], metric: metric(0.17, 0.66, 10_000_000, 7, 1) }, // II 10.0
    { hints: ["llama-3.3"], metric: metric(0.2, 0.2, 128_000, 8, 1) },
    { hints: ["llama"], metric: metric(0.35, 0.85, 1_000_000, 7, 2) },
  ],
  zhipu: [
    { hints: ["glm-5.2"], metric: official(1.4, 4.4, 1_000_000, 9, 8) }, // II 51.1 — AA's #1 open-weights · 181 tok/s
    { hints: ["glm-5v-turbo"], metric: metric(1.2, 4.0, 128_000, 7, 5) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5v"], metric: metric(0.6, 1.8, 128_000, 7, 5) },
    { hints: ["glm-5-turbo"], metric: metric(1.2, 4.0, 200_000, 8, 6) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5.1"], metric: metric(0.6, 2.2, 200_000, 5, 6) },
    { hints: ["glm-4.7-flash"], metric: metric(0, 0, 200_000, 9, 4) }, // free tier
    { hints: ["glm-4.7"], metric: metric(0.3, 1.2, 200_000, 6, 5) },
    { hints: ["glm-4.6v"], metric: metric(0.3, 1.2, 128_000, 6, 4) },
    { hints: ["glm-4.6"], metric: metric(0.25, 1, 128_000, 6, 4) },
    { hints: ["air"], metric: metric(0.2, 1.1, 128_000, 7, 4) },
    { hints: ["flash"], metric: metric(0, 0, 128_000, 10, 3) },
    { hints: ["glm-5"], metric: metric(0.6, 2.2, 200_000, 5, 6) },
    { hints: ["glm"], metric: metric(0.6, 2.2, 200_000, 6, 5) },
  ],
  moonshot: [
    { hints: ["k3"], metric: metric(3, 15, 1_000_000, 4, 8) }, // flagship 2.5T reasoner, 1M ctx — tops the lineup (no AA/arena index yet)
    { hints: ["highspeed"], metric: metric(2.4, 10, 262_144, 9, 7) }, // premium ~180-260 tok/s serving of K2.7 Code
    { hints: ["k2.7"], metric: official(0.95, 4, 262_144, 2, 7) }, // II 41.9 (coding) · 45 tok/s
    { hints: ["k2.6"], metric: official(0.95, 4, 262_144, 2, 7) }, // II 44.2 · 41.5 tok/s — slowest in the lineup
    { hints: ["k2.5"], metric: metric(0.6, 2.5, 262_144, 4, 6) },
    { hints: ["moonshot-v1"], metric: metric(1, 3, 131_072, 6, 2) },
    { hints: ["kimi"], metric: metric(0.95, 4, 262_144, 3, 6) },
  ],
  deepseek: [
    { hints: ["v4-pro"], metric: official(0.435, 0.87, 1_000_000, 3, 7) }, // II 44.3 · 51 tok/s
    { hints: ["v4-flash"], metric: official(0.14, 0.28, 1_000_000, 6, 6) }, // II 40.3 · 98 tok/s — cheapest credible model on the board
    { hints: ["v4"], metric: official(0.14, 0.28, 1_000_000, 6, 6) },
    { hints: ["reason"], metric: metric(0.14, 0.28, 1_000_000, 4, 6) }, // alias → V4 Flash (retires Jul 24 2026)
    { hints: ["deepseek"], metric: metric(0.14, 0.28, 1_000_000, 6, 6) }, // alias → V4 Flash (retires Jul 24 2026)
  ],
  mistral: [
    { hints: ["magistral"], metric: metric(2, 5, 131_072, 3, 4) },
    { hints: ["devstral"], metric: metric(0.4, 2, 262_144, 6, 4) },
    { hints: ["codestral"], metric: metric(0.3, 0.9, 262_144, 9, 3) },
    { hints: ["ministral"], metric: metric(0.15, 0.15, 131_072, 9, 2) },
    { hints: ["medium"], metric: official(1.5, 7.5, 262_144, 4, 5) }, // II 29.9 · 67 tok/s — flagship, but far off frontier
    { hints: ["large"], metric: official(0.5, 1.5, 262_144, 2, 2) }, // II 15.9 · 43 tok/s — scores BELOW Medium despite the name
    { hints: ["small"], metric: official(0.15, 0.6, 262_144, 8, 3) }, // II 19.6 · 165 tok/s
  ],
  xai: [
    { hints: ["grok-4.5"], metric: official(2, 6, 500_000, 6, 9) }, // II 53.8 · 93 tok/s — cheapest frontier-class model (EU mid-July)
    { hints: ["multi-agent"], metric: metric(3, 15, 1_000_000, 2, 7) },
    { hints: ["grok-build"], metric: metric(0.5, 2, 256_000, 8, 6) },
    { hints: ["grok-4.3"], metric: official(1.25, 2.5, 1_000_000, 7, 6) }, // II 37.6 · 105 tok/s
    { hints: ["4.20", "non-reasoning"], metric: metric(1.5, 8, 1_000_000, 7, 5) },
    { hints: ["4.20"], metric: metric(1.5, 8, 1_000_000, 5, 6) },
    { hints: ["fast"], metric: metric(0.2, 0.5, 2_000_000, 9, 5) },
    { hints: ["grok"], metric: metric(2, 6, 1_000_000, 6, 6) },
  ],
  minimax: [
    { hints: ["m3"], metric: official(0.3, 1.2, 1_000_000, 6, 7) }, // II 44.4 — AA's #2 open-weights · 96 tok/s
    { hints: ["highspeed"], metric: metric(0.6, 2.4, 204_800, 9, 6) }, // low-latency serving premium
    { hints: ["m2.7"], metric: metric(0.3, 1.2, 204_800, 5, 6) },
    { hints: ["m2.5"], metric: metric(0.2, 0.8, 204_800, 5, 5) },
    { hints: ["m2"], metric: metric(0.3, 1.2, 204_800, 5, 5) },
  ],
  mimo: [
    { hints: ["flash"], metric: metric(0.2, 0.8, 256_000, 8, 5) },
    { hints: ["pro"], metric: official(0.435, 0.87, 256_000, 3, 7) }, // II 42.2 · 46 tok/s — arena-overperforms (#31)
  ],
  qwen: [
    { hints: ["qwen3.7-max"], metric: official(2.5, 7.5, 1_000_000, 9, 7) }, // II 46.0 · 192 tok/s · arena #17
    { hints: ["qwen3.7-plus"], metric: official(0.4, 1.6, 1_000_000, 3, 6) }, // II 39.0 · 52 tok/s
    { hints: ["qwen3.6-plus"], metric: metric(0.4, 1.2, 1_000_000, 5, 5) },
    { hints: ["qwen3.6-flash"], metric: metric(0.19, 1.13, 1_000_000, 9, 4) },
    { hints: ["qwen3.5-plus"], metric: metric(0.4, 1.2, 1_000_000, 6, 4) },
    { hints: ["qwen3.5-flash"], metric: metric(0.19, 1.13, 1_000_000, 9, 3) },
    { hints: ["qwen-long"], metric: metric(0.4, 1.2, 10_000_000, 5, 3) },
    { hints: ["qwen3-max"], metric: metric(1.2, 6, 262_144, 4, 5) },
    { hints: ["qwen3-coder"], metric: metric(1, 5, 1_000_000, 6, 5) },
    { hints: ["qwen3-vl"], metric: metric(0.8, 3.2, 262_144, 6, 5) },
    { hints: ["qwen-vl"], metric: metric(0.8, 3.2, 32_768, 6, 3) },
    { hints: ["qwen3-235"], metric: metric(0.7, 2.8, 262_144, 5, 5) },
    { hints: ["qwen3-30"], metric: metric(0.2, 0.8, 262_144, 8, 4) },
    { hints: ["qwq"], metric: metric(0.8, 2.4, 131_072, 4, 3) },
    { hints: ["plus"], metric: metric(0.4, 1.2, 1_000_000, 6, 5) },
    { hints: ["flash"], metric: metric(0.05, 0.4, 1_000_000, 9, 4) },
    { hints: ["turbo"], metric: metric(0.05, 0.2, 1_000_000, 9, 3) },
    { hints: ["max"], metric: metric(1.2, 6, 32_768, 4, 5) },
    { hints: ["qwen"], metric: metric(0.4, 1.2, 262_144, 6, 4) },
  ],
  longcat: [
    // No AA/arena coverage yet (released 2026-07-06) — positioning estimate
    // from launch benchmarks (near-GPT-5.5 on SWE-bench Pro). Standard pricing
    // $0.75/$2.95 (launch promo $0.30/$1.20 not baked in).
    { hints: ["longcat"], metric: metric(0.75, 2.95, 1_000_000, 6, 7) },
  ],
};

// Sensible per-provider default so an unrecognized model still gets real-ish
// numbers (not the generic cost-tier estimate).
const PROVIDER_DEFAULT: Partial<Record<Provider, ModelMetrics>> = {
  anthropic: metric(3, 15, 200_000, 5, 7),
  openai: metric(2.5, 15, 400_000, 6, 7),
  google: metric(1.5, 9, 1_048_576, 8, 6),
  meta: metric(0.35, 0.85, 1_000_000, 7, 2),
  zhipu: metric(0.6, 2.2, 200_000, 6, 5),
  moonshot: metric(0.95, 4, 262_144, 4, 6),
  deepseek: metric(0.14, 0.28, 1_000_000, 6, 6),
  mistral: metric(0.5, 2.2, 262_144, 6, 4),
  xai: metric(2, 6, 1_000_000, 6, 6),
  minimax: metric(0.3, 1.2, 204_800, 6, 6),
  mimo: metric(0.435, 0.87, 256_000, 4, 6),
  qwen: metric(0.4, 1.2, 262_144, 6, 5),
  longcat: metric(0.75, 2.95, 1_000_000, 6, 7),
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

// —— Live leaderboard overlay (benchmarks.generated.ts, nightly sync) ——
// The SAME grade mappings as the FAMILY_RULES header — keep the two in sync.

/** intelligence = clamp(round((AA Intelligence Index − 2) / 6), 1, 10). */
export function intelligenceGradeFromIndex(ii: number): number {
  return Math.max(1, Math.min(10, Math.round((ii - 2) / 6)));
}

/** speed from AA median output tok/s bands, −1 when TTFT exceeds 30s. */
export function speedGradeFromThroughput(tokPerSec: number, ttftSeconds?: number): number {
  const bands: [number, number][] = [[230, 10], [180, 9], [140, 8], [100, 7], [85, 6], [70, 5], [55, 4], [45, 3], [38, 2]];
  const base = bands.find(([min]) => tokPerSec >= min)?.[1] ?? 1;
  return Math.max(1, base - (ttftSeconds !== undefined && ttftSeconds > 30 ? 1 : 0));
}

/** True when live leaderboard data backs this model's displayed metrics —
 *  the picker shows the required "Scores by Artificial Analysis" credit. */
export function hasLiveBenchmark(model: ModelInfo): boolean {
  return BENCHMARKS[model.id]?.source === "artificial-analysis";
}

function overlayBenchmark(base: ModelMetrics, bench: ModelBenchmark | undefined): ModelMetrics {
  // ONLY Artificial Analysis data may override the hand-tuned tables: it
  // reports first-party list prices. OpenRouter rows are informational —
  // their prices are OpenRouter's resale rates (discounted hosts, and generic
  // slugs sometimes point at older versions), which would corrupt ApiSpend
  // metering if applied here.
  if (!bench || bench.source !== "artificial-analysis") return base;
  const out = { ...base };
  if (bench.priceInPerMTok !== undefined && bench.priceInPerMTok > 0) out.inputUsdPerMTok = bench.priceInPerMTok;
  if (bench.priceOutPerMTok !== undefined && bench.priceOutPerMTok > 0) out.outputUsdPerMTok = bench.priceOutPerMTok;
  if (bench.intelligenceIndex !== undefined) out.intelligence = intelligenceGradeFromIndex(bench.intelligenceIndex);
  if (bench.outputTokensPerSec !== undefined) out.speed = speedGradeFromThroughput(bench.outputTokensPerSec, bench.ttftSeconds);
  out.source = "official";
  return out;
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
  const grounded = overlayBenchmark(base, BENCHMARKS[model.id]);
  // The registry's verified per-model context window always wins; the family
  // rule's contextTokens is only a fallback for discovered models.
  if (model.contextWindow && model.contextWindow !== grounded.contextTokens) {
    return { ...grounded, contextTokens: model.contextWindow };
  }
  return grounded;
}

/**
 * Canonical display order for a model list, applied wherever the payload/list is
 * built so BOTH the web selector and the Mac app (which consumes /api/models and
 * trusts its order) render identically. Sort key, in order:
 *   1. lab/provider — PROVIDER_LIST index ascending (the rail order)
 *   2. intelligence — descending (best model in a lab first)
 *   3. release date — descending as a "YYYY-MM" string compare (nullish last)
 *   4. name — ascending, as a stable final tiebreak
 * Returns a new array; the input is not mutated.
 */
export function sortModelsForDisplay<T extends ModelInfo>(models: T[]): T[] {
  return [...models].sort((a, b) => {
    const labDelta = PROVIDER_LIST.indexOf(a.provider) - PROVIDER_LIST.indexOf(b.provider);
    if (labDelta !== 0) return labDelta;
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    // "" sorts before any real date; descending compare pushes nullish releases last.
    const relDelta = (b.released ?? "").localeCompare(a.released ?? "");
    if (relDelta !== 0) return relDelta;
    return a.name.localeCompare(b.name);
  });
}

export function reasoningMultiplier(effort: ReasoningEffort): number {
  if (effort === "max") return 2;
  if (effort === "xhigh") return 1.85;
  if (effort === "high") return 1.65;
  if (effort === "medium") return 1.25;
  if (effort === "low") return 1.08;
  if (effort === "minimal") return 1.02;
  return 1;
}

export function applyReasoning(metrics: ModelMetrics, effort: ReasoningEffort, supportsReasoning: boolean): ModelMetrics {
  if (!supportsReasoning || !effort) return metrics;
  const multiplier = reasoningMultiplier(effort);
  const BOOST: Record<Exclude<ReasoningEffort, null>, number> = {
    minimal: 0.15, low: 0.4, medium: 1, high: 2, xhigh: 2.2, max: 2.4,
  };
  const PENALTY: Record<Exclude<ReasoningEffort, null>, number> = {
    minimal: 0.98, low: 0.93, medium: 0.82, high: 0.62, xhigh: 0.54, max: 0.48,
  };
  const intelligenceBoost = BOOST[effort];
  const speedPenalty = PENALTY[effort];
  return {
    ...metrics,
    outputUsdPerMTok: roundMoney(metrics.outputUsdPerMTok * multiplier),
    speed: Math.max(1, Math.round(metrics.speed * speedPenalty)),
    intelligence: Math.min(10, Math.round(metrics.intelligence + intelligenceBoost)),
  };
}

// ---------------------------------------------------------------------------
// Per-model thinking/reasoning tiers — REAL, provider-verified data.
// Audited against official provider docs on 2026-07-15; see docs/models.md.
//
// Juno's ladder is Instant · Minimal · Low · Medium · High · Extra high · Max,
// which is the UNION of what providers expose. No single model offers all of it,
// so every entry below is an explicit subset. Getting this wrong is not cosmetic:
// clampReasoningEffort() feeds these tiers straight to the provider, and sending
// a tier a model doesn't accept (e.g. "max" to GPT-5.5) is a 400.
//
// Notable, easily-missed facts encoded here:
//  - "max" is NOT a GPT tier at all. GPT-5.6 REJECTS it ("Supported values are:
//    'none', 'low', 'medium', 'high', and 'xhigh'") and GPT-5.5 stops at xhigh.
//    The old note here read '"max" is GPT-5.6 ONLY', which was backwards and is
//    what shipped a 400 on every sol/terra/luna request at the top tier.
//    Where "max" IS real: Claude Opus 4.6+/4.7+ and Sonnet 4.6+; GLM-5.2
//    (live-verified, its deepest rung); DeepSeek v4 (unverified — key has no
//    balance).
//  - The gpt-5.x-pro MODELS accept only medium|high|xhigh and cannot be run
//    non-thinking. On GPT-5.6, by contrast, "pro" is not an effort at all — it is
//    a separate reasoning.mode axis (see PRO_MODE_MODELS below).
//  - Claude Haiku 4.5 has NO effort parameter — extended thinking is on/off only.
//  - Claude Opus 4.5 tops out at high; 4.6 adds max; 4.7+ adds xhigh.
//  - Gemini reads reasoning_effort on its OpenAI-compat shim (enum
//    none|minimal|low|medium|high), which maps onto the native thinking_config.
//    Only gemini-3.1-flash-lite has a PROVEN off-switch; the pro line is
//    unverified (this key's free tier is quota 0 there).
//  - Mistral Medium 3.5 / Small are on/off only (reasoning_effort: high|none).
//  - GLM-5.2 is the only GLM with reasoning_effort; the rest are on/off.
// ---------------------------------------------------------------------------
/**
 * Every tier Juno knows, ORDERED shallowest → deepest (TIER_ORDER depends on
 * that order for clamping).
 *
 * This is the single source of truth: /api/chat's body schema builds its zod
 * enum from this array rather than repeating the literals. It used to repeat
 * them and drifted — the schema listed only low|medium|high|max, so every
 * "Extra high" and "Minimal" option this file advertised was rejected by Juno's
 * OWN route with 400 "Invalid request." before the request ever reached a
 * provider (26 models). Adding a tier here now extends the route enum for free.
 */
export const REASONING_TIERS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningTier = (typeof REASONING_TIERS)[number];
const TIER_ORDER: ReasoningTier[] = [...REASONING_TIERS];
const LMH: ReasoningTier[] = ["low", "medium", "high"];
/** OpenAI's full non-thinking-excluded ladder for the 5.4/5.5 generation. */
const LMHX: ReasoningTier[] = ["low", "medium", "high", "xhigh"];
/** Claude Opus 4.7+ / Sonnet 4.6+ — the only families with a real tier above
 *  xhigh. NOT GPT-5.6, which rejects "max" (see the openai branch below). */
const LMHXM: ReasoningTier[] = ["low", "medium", "high", "xhigh", "max"];

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
      // Wire shape is decided in anthropic.ts (buildAnthropicThinkingBits):
      //   adaptive + output_config.effort — fable/mythos/opus-4.6+/sonnet-4.6+/sonnet-5
      //   manual type:enabled + budget_tokens — haiku 4.5, opus 4.5, sonnet 4.5
      // Haiku 4.5 is absent from the effort-supported list entirely — on/off only.
      if (id.includes("haiku")) return caps([], true, true);
      // Fable/Mythos: adaptive always on; disabled rejected.
      if (id.includes("fable") || id.includes("mythos")) return caps(LMHXM, false);
      // Opus 4.5: manual budget_tokens only (no adaptive); effort API is
      // supported alongside budget but we still expose LMH for the slider.
      if (id.includes("opus-4-5")) return caps(LMH, true); // no xhigh, no max
      // Opus 4.6: adaptive preferred; max yes, xhigh no.
      if (id.includes("opus-4-6")) return caps(["low", "medium", "high", "max"], true);
      // Sonnet 4.5: manual budget_tokens only.
      if (id.includes("sonnet-4-5")) return caps(LMH, true);
      // Opus 4.7/4.8, Sonnet 4.6/5: adaptive + full effort ladder.
      return caps(LMHXM, true);
    case "openai":
      // The gpt-5.x-pro MODELS (5-pro/5.2-pro/5.4-pro/5.5-pro) restrict effort to
      // medium|high|xhigh and always reason. Note GPT-5.6 has no -pro model id.
      // Verified on /v1/responses: none|minimal|low all 400 with "Supported
      // values are: 'medium', 'high', and 'xhigh'" on 5.5/5.4/5.2-pro.
      if (/gpt-5(\.\d)?-pro/.test(id)) return caps(["medium", "high", "xhigh"], false);
      // 5.6 REJECTS "max" (the old '"max" is 5.6-only' comment was backwards).
      // Oracle: "does not support 'max' with this model. Supported values are:
      // 'none', 'low', 'medium', 'high', and 'xhigh'." canDisable verified:
      // reasoning_effort:"none" -> 200 with reasoning_tokens=0 on sol/terra/luna.
      if (id.includes("gpt-5.6")) return caps(LMHX, true);
      // Codex is NOT uniformly always-on — each snapshot verified separately on
      // /v1/responses (they 404 on chat/completions, so the oracle lives there).
      // 5.3-codex: "minimal" -> 400 "Supported values are: 'none', 'low',
      // 'medium', 'high', and 'xhigh'"; "none" -> 200 reasoning_tokens=0.
      if (id.includes("gpt-5.3-codex")) return caps(LMHX, true);
      // 5.2-codex: "none" -> 400 "Supported values are: 'low', 'medium',
      // 'high', and 'xhigh'" — genuinely always-on.
      if (id.includes("gpt-5.2-codex")) return caps(LMHX, false);
      // 5.1-codex / -codex-mini: "none" -> 400 "Supported values are: 'low',
      // 'medium', and 'high'" — no xhigh, no off-switch.
      if (id.includes("codex")) return caps(LMH, false);
      // gpt-5.1 has NO xhigh. Oracle: "does not support 'xhigh' with this
      // model. Supported values are: 'none', 'low', 'medium', and 'high'."
      // Must precede the 5.2/5.4/5.5 branch, which does grant xhigh.
      if (id.includes("gpt-5.1")) return caps(LMH, true);
      // 5.2/5.4/5.5 (+ -mini/-nano): oracle enumerates
      // none|low|medium|high|xhigh on each; xhigh -> 200 verified on all.
      if (/gpt-5\.[245]/.test(id)) return caps(LMHX, true);
      // Original GPT-5: `minimal` is the floor and `none` did not exist yet.
      if (id.includes("gpt-5")) return caps(["minimal", "low", "medium", "high"], false);
      if (/(^|[^a-z0-9])o[134](-|$)/.test(id) || id.includes("o4-mini")) return caps(LMH, false); // o-series always reason
      return caps(LMH, true);
    case "google":
      // These tiers are only real because openai-compat.ts now actually SENDS
      // reasoning_effort to Google (it previously sent nothing, making every
      // Gemini tier inert). The shim's enum is none|minimal|low|medium|high.
      //
      // Honouring is PROVEN, not assumed. The compat shim reports no reasoning
      // accounting at all, so it was measured by budget starvation (max_tokens
      // 64), calibrated against native generateContent thoughtsTokenCount on
      // the same model:
      //   native   thinkingLevel=high    -> thoughts=646, answer truncated
      //   native   thinkingLevel=minimal -> thoughts=0,   full answer
      //   compat   effort=low/medium/high -> completion<=1 (thinking ate it)
      //   compat   effort=none/minimal    -> completion=60, full answer
      // i.e. the shim maps reasoning_effort onto the same thinking_config the
      // native API uses — corroborated by the shim's own 400 when both are set:
      // "Expected one of either `reasoning_effort` or custom `thinking_config`".
      //
      // Pro line: UNVERIFIED — this key's free tier is quota 0 on gemini-*-pro
      // (429 "limit: 0"), so no completion was ever obtainable. Left as-is.
      if (id.includes("pro")) return caps(LMH, false);
      // gemini-3.1-flash-lite: off-switch PROVEN on both transports (native
      // thinkingLevel=minimal/thinkingBudget=0 -> thoughtsTokenCount absent(=0);
      // compat effort=none -> full answer under a 64-token cap).
      if (/3\.1-flash-lite/.test(id)) return caps(["minimal", "low", "medium", "high"], true);
      // Everything else on the flash line keeps canDisable:false DELIBERATELY.
      // gemini-3-flash-preview THINKS BY DEFAULT (native thoughts=380 with the
      // param omitted; compat omitted -> completion=0, fully starved), and its
      // off-switch is proven NATIVELY (thinkingLevel=minimal -> 0) but could NOT
      // be exercised through the compat transport Juno actually uses — the
      // free-tier daily cap was exhausted mid-probe. gemini-3.5-flash is 429 on
      // every transport today, so it is unverified too. Exposing "Instant" here
      // on inference alone would risk an Instant that silently reasons and bills
      // the user, so the tier stays hidden until it can be proven.
      return caps(["minimal", "low", "medium", "high"], false);
    case "xai":
      if (id.includes("multi-agent")) return caps(LMHX, false); // effort selects agent COUNT
      if (id.includes("grok-4.5")) return caps(LMH, false); // always reasons, default high
      if (id.includes("grok-4.3")) return caps(LMH, true); // none|low|medium|high
      return caps([], false); // grok-build: reasons, no documented control
    case "deepseek":
      if (id.includes("v4")) return caps(["high", "max"], true); // thinking on/off + effort
      return caps([], false); // deepseek-reasoner: always on, no control
    case "zhipu":
      // GLM-5.2 is the ONLY GLM exposing reasoning_effort; the rest are on/off.
      if (id.includes("glm-5.2")) return caps(["minimal", ...LMHXM], true);
      return caps([], true, true); // glm-5 / 4.6 / 4.7: thinking on/off toggle
    case "mistral":
      // SUBSTRING COLLISION FIX: "magistral-medium-2509".includes("medium") is
      // true, so magistral used to take the on/off branch below and was told it
      // could be switched — but it REJECTS the parameter outright:
      // reasoning_effort "none" AND "high" both -> 400 "reasoning_effort is not
      // enabled for this model". It reasons unconditionally (bare call -> 200
      // with a "thinking" content chunk) and exposes no control. Must be matched
      // BEFORE the medium/small test to be reachable at all.
      if (id.includes("magistral")) return caps([], false);
      // Medium/Small ONLY. Per-model oracle: 'max' -> 400 "reasoning_effort max
      // is not supported for this model, supported values: [high, none]".
      // Off is real: "none" -> 200, content a plain string (no thinking chunk);
      // "high" -> content list with chunk types ['thinking','text'].
      if (id.includes("medium") || id.includes("small")) return caps([], true, true);
      // large 3 / codestral / ministral / devstral: verified to REJECT the
      // parameter (400 "reasoning_effort is not enabled for this model") and to
      // never reason (bare call -> 200, plain-string content).
      return caps([], false);
    case "moonshot":
      // Kimi K3: thinking is always on and its DEPTH is now selectable via the
      // NEW top-level reasoning_effort enum (low|high|max) — this replaces the
      // K2.x `thinking` object. No off switch (thinking can't be disabled), and
      // medium/xhigh are not offered by K3. openai-compat.ts routes K3 (and only
      // K3) on Moonshot through the reasoning_effort send path.
      if (id.includes("k3")) return caps(["low", "high", "max"], false);
      if (id.includes("k2.7")) return caps([], false); // "disabled" is rejected — always on
      return caps([], true, true); // k2.6: thinking enabled/disabled
    case "minimax":
      if (id.includes("m3")) return caps([], true, true); // adaptive/disabled toggle
      return caps([], false); // M2.x: thinking param ignored, always on
    case "mimo":
      return caps([], true, true); // thinking: enabled/disabled — not an effort ladder
    case "qwen":
      if (id.includes("qwq")) return caps([], false); // QwQ always reasons, no control
      if (id.includes("coder")) return caps([], true); // Qwen3-Coder: non-thinking
      // enable_thinking + thinking_budget: depth tiers are mapped to budgets.
      return caps(LMH, true);
    case "longcat":
      return caps([], true, true); // thinking: enabled/disabled
    default:
      return caps([], false);
  }
}

/**
 * Models where "Pro" is a SEPARATE axis from effort — OpenAI's GPT-5.6 line
 * takes `reasoning.mode: "standard" | "pro"` on the same model id and at the
 * same per-token price (Pro simply reasons more). This is why GPT-5.6 has no
 * `-pro` model id, unlike the 5.5/5.4/5.2 generations where Pro is its own
 * (far pricier) model.
 */
export function supportsProMode(model: ModelInfo): boolean {
  return model.provider === "openai" && model.providerModel.toLowerCase().includes("gpt-5.6");
}

const TIER_LABEL: Record<ReasoningTier, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

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
