import { hasRetired, isSupersededModel, MODELS, type ModelInfo } from "@/lib/models";
import { PROVIDER_LIST, type Provider } from "@/lib/providers";
import { BENCHMARKS, type ModelBenchmark } from "@/lib/benchmarks.generated";
import { geminiFlashRate, type TokenPrice } from "@/lib/scheduled-prices";
import { OFFICIAL_RATES } from "@/lib/model-rates.generated";

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
  /** A published price with an end date: replaces metric's in/out rates with
   *  the ones in force at the moment asked about (scheduled-prices.ts). */
  scheduled?: (at: Date | number) => TokenPrice;
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
    // BEFORE the generic opus row, which this id also matches: 5.5 is priced
    // $4/$20. Official price/context; the grades stay positioning estimates
    // (Opus 5's) until a benchmark covers it.
    { hints: ["opus-5-5"], metric: official(4, 20, 1_000_000, 4, 9) },
    { hints: ["opus"], metric: official(5, 25, 1_000_000, 4, 9) }, // II 55.7 · 56 tok/s
    // Sonnet 5.5 (2026-09-28): $2/$10, 1M, 128K out. Same price as Sonnet 5;
    // the grade stays Sonnet 5's until a benchmark covers it.
    { hints: ["sonnet-5-5"], metric: official(2, 10, 1_000_000, 5, 9) },
    // $2/$10 is now Sonnet 5's standard price: Anthropic cancelled the
    // scheduled Sep 1 2026 rise to $3/$15 (pricing page, footnote 3).
    { hints: ["sonnet-5"], metric: official(2, 10, 1_000_000, 5, 9) }, // II 53.4 · 79 tok/s
    // Sonnet 4.5 is a 200K model; the catch-all row below is Sonnet 4.6's 1M.
    { hints: ["sonnet-4-5"], metric: official(3, 15, 200_000, 5, 7) },
    { hints: ["sonnet"], metric: metric(3, 15, 1_000_000, 5, 7) },
    { hints: ["haiku"], metric: official(1, 5, 200_000, 6, 5) }, // II 29.6 (reasoning) · 94 tok/s
  ],
  openai: [
    { hints: ["gpt-6-astra"], metric: official(10, 50, 1_050_000, 4, 10) }, // official price/context; speed is positioning-based pending benchmark coverage
    // GPT-6 Sol/Luna (2026-09-22): official price/context; speed and
    // intelligence carry over from the 5.6 tier each replaces until a
    // benchmark grades them — deliberately not higher, since Auto and Work
    // rank on these numbers and Luna is the cheapest model OpenAI sells.
    // GPT-6.1 Sol (2026-09-29): official $2/$10 and 1.05M context; scored like
    // GPT-6 Sol until a benchmark grades it.
    { hints: ["gpt-6.1-sol"], metric: official(2, 10, 1_050_000, 5, 9) },
    { hints: ["gpt-6-sol"], metric: official(2, 10, 1_050_000, 5, 9) },
    { hints: ["gpt-6-luna"], metric: official(0.1, 0.5, 1_050_000, 9, 8) },
    { hints: ["gpt-5.6-sol"], metric: official(4, 20, 1_050_000, 5, 9) }, // II 58.9 #2 · 73 tok/s — $4/$20 on the model page
    { hints: ["gpt-5.6-terra"], metric: official(2, 12, 1_050_000, 8, 9) }, // II 55.0 · 141 tok/s — repriced 2026-07-30 (was $2.50/$15)
    { hints: ["gpt-5.6-luna"], metric: official(0.2, 1.2, 1_050_000, 9, 8) }, // II 51.2 · 204 tok/s — repriced 2026-07-30, −80% (was $1/$6); best value in the OpenAI lineup
    { hints: ["gpt-5.6"], metric: official(4, 20, 1_050_000, 5, 9) }, // bare alias routes to Sol
    { hints: ["gpt-5.5-pro"], metric: official(30, 180, 1_050_000, 1, 9) }, // no AA/arena data — positioning estimate
    { hints: ["gpt-5.5"], metric: official(5, 30, 1_050_000, 4, 9) }, // II 54.8 · 64 tok/s
    { hints: ["gpt-5.4-pro"], metric: official(30, 180, 1_050_000, 2, 8) },
    { hints: ["gpt-5.4-mini"], metric: official(0.75, 4.5, 400_000, 8, 6) }, // II 40.0 · 160 tok/s
    { hints: ["gpt-5.4-nano"], metric: official(0.2, 1.25, 400_000, 8, 6) }, // II 38.2 · 170 tok/s
    { hints: ["gpt-5.4"], metric: official(2.5, 15, 1_050_000, 7, 8) },
    { hints: ["gpt-5.3-codex"], metric: official(1.75, 14, 400_000, 5, 7) }, // II 44.3 (coding-tuned) · 76 tok/s
    { hints: ["gpt-5.2-pro"], metric: official(21, 168, 400_000, 2, 8) },
    { hints: ["gpt-5.2"], metric: official(1.75, 14, 400_000, 5, 7) },
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
    // Hints are AND'd (every() in familyMetric), so the old single row with all
    // three ids could never match anything: 3.8 and 3.7 fell to the generic
    // `flash` row ($0.30/$2.50) and 3.6 hit a $1.50/$9 row. Google's pricing
    // page lists all three at $0.75/$3.75 through 2026-12-31 and $1.50/$7.50
    // from 2027-01-01; `scheduled` swaps the rates at 00:00 UTC that day.
    { hints: ["3.8-flash"], metric: official(0.75, 3.75, 1_048_576, 8, 9), scheduled: geminiFlashRate },
    { hints: ["3.7-flash"], metric: official(0.75, 3.75, 1_048_576, 8, 9), scheduled: geminiFlashRate },
    { hints: ["3.6-flash"], metric: official(0.75, 3.75, 1_048_576, 8, 8), scheduled: geminiFlashRate },
    // BEFORE "3.5-flash", which `gemini-3.5-flash-lite` also contains: the
    // Lite is a sixth of the price and the fastest model Google ships, and
    // matching it against the full Flash row would have priced it 5x over.
    { hints: ["3.5-flash-lite"], metric: official(0.3, 2.5, 1_048_576, 10, 5) }, // 350 tok/s
    { hints: ["3.5-flash"], metric: official(1.5, 9, 1_048_576, 8, 8) }, // II 50.2 · 152 tok/s — 3x the 2.5 Flash price
    { hints: ["3.1-flash-lite"], metric: official(0.25, 1.5, 1_048_576, 10, 4) }, // II 25.0 · 251 tok/s — fastest in the lineup
    { hints: ["3.1-pro"], metric: official(2, 12, 1_048_576, 7, 7) }, // II 46.5 · 117 tok/s
    { hints: ["3-flash"], metric: official(0.5, 3, 1_048_576, 9, 5) }, // gemini-3-flash-preview: $0.50/$3
    { hints: ["2.5-pro"], metric: official(1.25, 10, 1_048_576, 4, 4) }, // ≤200K prompt rate
    { hints: ["2.5-flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 3) },
    { hints: ["flash-lite"], metric: metric(0.1, 0.4, 1_048_576, 10, 3) },
    { hints: ["flash"], metric: metric(0.3, 2.5, 1_048_576, 9, 4) },
    { hints: ["pro"], metric: metric(1.25, 10, 1_048_576, 5, 5) },
  ],
  meta: [
    // Muse Spark on the Meta Model API. Prices are Meta's published rates; the
    // grades are positioning estimates — the 1.x line has no AA/arena coverage
    // yet, so these stay source:"provider" until a benchmark sync grounds them.
    //
    // BEFORE the bare "muse-spark" rule, which this id also contains. Matching
    // the contributor tier against the standard row would price it at 12.5x
    // input and 21x output — and because `pickAutoModel` and `pickWorkModel`
    // rank on exactly these numbers, the lie would not merely be displayed,
    // it would change which model the routers choose.
    { hints: ["muse-spark-1.3-contributor"], metric: metric(0.1, 0.2, 1_048_576, 6, 8) },
    // 1.2 Contributor: the same contributor rate, one generation back.
    { hints: ["muse-spark-1.2-contributor"], metric: metric(0.1, 0.2, 1_048_576, 6, 8) },
    // 1.3 finishes the same task in ~20% fewer tool calls and ~25% fewer
    // tokens than 1.2 and reports 98.5% on million-token retrieval, so it
    // grades a notch above the row below at the same published price.
    { hints: ["muse-spark-1.3"], metric: metric(1.25, 4.25, 1_048_576, 6, 9) },
    // 1.1, the original release, a notch below 1.2 at the same standard price.
    { hints: ["muse-spark-1.1"], metric: metric(1.25, 4.25, 1_048_576, 6, 7) },
    { hints: ["muse-spark"], metric: metric(1.25, 4.25, 1_048_576, 6, 8) },
    // No row for muse-image on purpose. It bills per returned image, not per
    // token (`mediaRequestCost` in spend.ts is the authority), and there is no
    // per-image unit in ModelMetrics — so it falls to PROVIDER_DEFAULT like
    // every other image model in this catalog does for its own provider.
    // A zeroed row would be worse than an approximate one: the picker reads
    // 0-in/0-out as "Free" (that is how the genuinely free GLM Flash tiers are
    // labelled), and it would print that over a model that costs a cent a shot.
    // Llama API shut down 2026-07-06 — rules below kept only so stragglers
    // resolving through migration still price correctly.
    { hints: ["maverick"], metric: metric(0.35, 0.85, 1_000_000, 7, 2) }, // II 14.3
    { hints: ["scout"], metric: metric(0.17, 0.66, 10_000_000, 7, 1) }, // II 10.0
    { hints: ["llama-3.3"], metric: metric(0.2, 0.2, 128_000, 8, 1) },
    { hints: ["llama"], metric: metric(0.35, 0.85, 1_000_000, 7, 2) },
  ],
  zhipu: [
    // Rates: docs.z.ai/guides/overview/pricing (2026-10-04), which now lists
    // 5.3 at the same $1.40/$4.40 as 5.2 and 5.1.
    { hints: ["glm-5.3-flashx"], metric: official(0.37, 1.25, 1_000_000, 10, 8) },
    { hints: ["glm-5.3-flash"], metric: official(0.15, 0.5, 1_000_000, 8, 8) },
    { hints: ["glm-5.3"], metric: official(1.4, 4.4, 1_000_000, 9, 9) },
    { hints: ["glm-5.2"], metric: official(1.4, 4.4, 1_000_000, 9, 8) }, // II 51.1 — AA's #1 open-weights · 181 tok/s
    { hints: ["glm-5v-turbo"], metric: metric(1.2, 4.0, 128_000, 7, 5) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5v"], metric: metric(0.6, 1.8, 128_000, 7, 5) },
    { hints: ["glm-5-turbo"], metric: metric(1.2, 4.0, 200_000, 8, 6) }, // kept in sync with pricing.ts turbo rate
    { hints: ["glm-5.1"], metric: official(1.4, 4.4, 200_000, 5, 6) },
    // FlashX before Flash, and the V-FlashX/V-Flash before GLM-4.6V: each id
    // contains the shorter hint.
    { hints: ["glm-4.7-flashx"], metric: official(0.07, 0.4, 200_000, 9, 4) },
    { hints: ["glm-4.7-flash"], metric: official(0, 0, 200_000, 9, 4) }, // free tier
    { hints: ["glm-4.7"], metric: official(0.6, 2.2, 200_000, 6, 5) },
    { hints: ["glm-4.6v-flashx"], metric: official(0.04, 0.4, 128_000, 9, 3) },
    { hints: ["glm-4.6v-flash"], metric: official(0, 0, 128_000, 9, 3) }, // free tier
    { hints: ["glm-4.6v"], metric: official(0.3, 0.9, 128_000, 6, 4) },
    { hints: ["glm-4.6"], metric: official(0.6, 2.2, 200_000, 6, 4) },
    { hints: ["glm-4.5v"], metric: official(0.6, 1.8, 64_000, 6, 3) },
    { hints: ["glm-4.5-x"], metric: official(2.2, 8.9, 128_000, 9, 4) },
    { hints: ["glm-4-32b"], metric: official(0.1, 0.1, 128_000, 8, 2) },
    { hints: ["airx"], metric: official(1.1, 4.5, 128_000, 9, 4) },
    { hints: ["air"], metric: official(0.2, 1.1, 128_000, 7, 4) },
    { hints: ["flash"], metric: metric(0, 0, 128_000, 10, 3) },
    { hints: ["glm-5"], metric: official(1, 3.2, 200_000, 5, 6) },
    { hints: ["glm"], metric: metric(0.6, 2.2, 200_000, 6, 5) },
  ],
  moonshot: [
    // platform.kimi.ai/docs/pricing/chat (2026-10-04).
    { hints: ["k3"], metric: official(3, 15, 1_048_576, 4, 8) }, // flagship 2.8T reasoner, 1M ctx — tops the lineup (no AA/arena index yet)
    { hints: ["highspeed"], metric: official(1.9, 8, 262_144, 9, 7) }, // premium ~180-260 tok/s serving of K2.7 Code
    { hints: ["k2.7"], metric: official(0.95, 4, 262_144, 2, 7) }, // II 41.9 (coding) · 45 tok/s
    { hints: ["k2.6"], metric: official(0.95, 4, 262_144, 2, 7) }, // II 44.2 · 41.5 tok/s — slowest in the lineup
    { hints: ["k2.5"], metric: metric(0.6, 2.5, 262_144, 4, 6) },
    { hints: ["moonshot-v1"], metric: metric(1, 3, 131_072, 6, 2) },
    { hints: ["kimi"], metric: metric(0.95, 4, 262_144, 3, 6) },
  ],
  deepseek: [
    // Off-peak rates. DeepSeek bills 2x during its peak windows (01:00-04:00
    // and 06:00-10:00 UTC on weekdays); the catalog quotes the rate a request
    // outside those hours actually pays, as it does for the rest of the line.
    { hints: ["deepseek-flash"], metric: official(0.15, 0.6, 1_048_576, 8, 7) },
    { hints: ["v4-pro"], metric: official(0.66, 1.98, 1_000_000, 3, 7) }, // II 44.3 · 51 tok/s
    { hints: ["v4-flash"], metric: official(0.14, 0.28, 1_000_000, 6, 6) }, // II 40.3 · 98 tok/s — cheapest credible model on the board
    { hints: ["v4"], metric: official(0.14, 0.28, 1_000_000, 6, 6) },
    { hints: ["reason"], metric: metric(0.14, 0.28, 1_000_000, 4, 6) }, // alias → V4 Flash (retires Jul 24 2026)
    { hints: ["deepseek"], metric: metric(0.14, 0.28, 1_000_000, 6, 6) }, // alias → V4 Flash (retires Jul 24 2026)
  ],
  mistral: [
    { hints: ["magistral"], metric: metric(2, 5, 131_072, 3, 4) },
    { hints: ["devstral"], metric: metric(0.4, 2, 262_144, 6, 4) },
    { hints: ["codestral"], metric: official(0.3, 0.9, 128_000, 9, 3) },
    { hints: ["ministral-14b"], metric: official(0.2, 0.2, 262_144, 9, 2) },
    { hints: ["ministral-3b"], metric: official(0.1, 0.1, 262_144, 9, 2) },
    { hints: ["ministral"], metric: official(0.15, 0.15, 262_144, 9, 2) },
    { hints: ["medium"], metric: official(1.5, 7.5, 262_144, 4, 5) }, // II 29.9 · 67 tok/s — flagship, but far off frontier
    { hints: ["large"], metric: official(0.5, 1.5, 262_144, 2, 2) }, // II 15.9 · 43 tok/s — scores BELOW Medium despite the name
    { hints: ["small"], metric: official(0.15, 0.6, 262_144, 8, 3) }, // II 19.6 · 165 tok/s
  ],
  xai: [
    // No AA Intelligence Index published for 4.7 yet — positioning estimate
    // (same price/context as 4.6, larger base model), stays source:"provider"
    // until a benchmark run lands. See docs/models-september-22-2026.md.
    { hints: ["grok-4.7"], metric: metric(2, 6, 500_000, 6, 9) },
    // Was `hints: ["grok-4.6", "grok-4.5"]` — FAMILY_RULES hints are AND'd
    // (every() below), and no id contains both substrings, so that rule could
    // never match either model: grok-4.5 silently fell through to the generic
    // `grok` catch-all (source "provider", wrong 1,000,000 context) and lost
    // its official II 53.8 benchmark. Split into two rules, same metric — the
    // two models really do share EU mid-July pricing and the same benchmark.
    { hints: ["grok-4.6"], metric: official(2, 6, 500_000, 6, 9) }, // II 53.8 · 93 tok/s — cheapest frontier-class model (EU mid-July)
    { hints: ["grok-4.5"], metric: official(2, 6, 500_000, 6, 9) }, // same EU mid-July price/benchmark as 4.6
    // docs.x.ai/developers/models (2026-10-04): multi-agent and both 4.20
    // ids are $1.25/$2.50, Build $1/$2 (were $3/$15, $1.50/$8, $0.50/$2).
    { hints: ["multi-agent"], metric: official(1.25, 2.5, 1_000_000, 2, 7) },
    { hints: ["grok-build"], metric: official(1, 2, 256_000, 8, 6) },
    { hints: ["grok-4.3"], metric: official(1.25, 2.5, 1_000_000, 7, 6) }, // II 37.6 · 105 tok/s
    { hints: ["4.20", "non-reasoning"], metric: official(1.25, 2.5, 1_000_000, 7, 5) },
    { hints: ["4.20"], metric: official(1.25, 2.5, 1_000_000, 5, 6) },
    { hints: ["grok"], metric: metric(2, 6, 1_000_000, 6, 6) },
  ],
  minimax: [
    // M3.1 Flash Preview: M Plan only, no pay-as-you-go rate; priced as M3.
    { hints: ["m3.1"], metric: metric(0.3, 1.2, 1_000_000, 7, 7) },
    { hints: ["m3"], metric: official(0.3, 1.2, 1_000_000, 6, 7) }, // II 44.4 — AA's #2 open-weights · 96 tok/s
    // platform.minimax.io/docs/guides/pricing-paygo (2026-10-04).
    { hints: ["highspeed"], metric: official(0.6, 2.4, 204_800, 9, 6) }, // low-latency serving premium
    { hints: ["m2.7"], metric: official(0.3, 1.2, 204_800, 5, 6) },
    { hints: ["m2.5"], metric: official(0.3, 1.2, 204_800, 5, 5) },
    { hints: ["m2"], metric: metric(0.3, 1.2, 204_800, 5, 5) },
  ],
  mimo: [
    // mimo.mi.com pay-as-you-go, overseas (2026-10-04): every V2.6/V2.5 row
    // has a 1M window. UltraSpeed first — its id contains "pro".
    { hints: ["ultraspeed"], metric: official(4.35, 8.7, 1_050_000, 9, 7) },
    { hints: ["flash"], metric: official(0.14, 0.28, 1_050_000, 8, 5) },
    { hints: ["v2.5-pro"], metric: official(0.435, 0.87, 1_050_000, 3, 7) }, // II 42.2 · 46 tok/s — arena-overperforms (#31)
    { hints: ["v2.5"], metric: official(0.14, 0.28, 1_050_000, 6, 6) }, // Pro-level agentics at roughly half the cost
    { hints: ["pro"], metric: official(0.435, 0.87, 1_050_000, 3, 7) },
  ],
  qwen: [
    // Singapore (international) list prices from each Model Studio model
    // page (2026-10-04); tiered models quote their lowest input tier.
    { hints: ["qwen3.8-max"], metric: official(2, 6, 1_000_000, 8, 8) },
    { hints: ["qwen3.8-flash"], metric: official(0.15, 0.47, 1_000_000, 9, 6) },
    { hints: ["qwen3.7-max"], metric: official(2.5, 7.5, 1_000_000, 9, 7) }, // II 46.0 · 192 tok/s · arena #17
    { hints: ["qwen3.7-flash"], metric: official(0.03, 0.13, 1_000_000, 9, 5) },
    { hints: ["qwen3.7-plus"], metric: official(0.4, 1.6, 1_000_000, 3, 6) }, // II 39.0 · 52 tok/s
    { hints: ["qwen3.6-plus"], metric: official(0.5, 3, 1_000_000, 5, 5) },
    { hints: ["qwen3.6-flash"], metric: official(0.25, 1.5, 1_000_000, 9, 4) },
    { hints: ["qwen3.5-plus"], metric: official(0.4, 2.4, 1_000_000, 6, 4) },
    { hints: ["qwen3.5-flash"], metric: official(0.1, 0.4, 1_000_000, 9, 3) },
    { hints: ["qwen-long"], metric: official(0.072, 0.287, 10_000_000, 5, 3) }, // China (Beijing) only
    { hints: ["qwen3-max"], metric: metric(1.2, 6, 262_144, 4, 5) },
    { hints: ["qwen3-coder"], metric: official(1, 5, 1_000_000, 6, 5) },
    { hints: ["qwen3-vl-plus"], metric: official(0.2, 1.6, 262_144, 6, 5) },
    { hints: ["qwen3-vl-flash"], metric: official(0.05, 0.4, 262_144, 8, 4) },
    { hints: ["qwen-vl"], metric: official(0.8, 3.2, 131_072, 6, 3) },
    { hints: ["qwen3-235"], metric: official(0.7, 2.8, 131_072, 5, 5) },
    { hints: ["qwen3-30"], metric: official(0.2, 0.8, 131_072, 8, 4) },
    { hints: ["qwq"], metric: official(0.8, 2.4, 131_072, 4, 3) },
    { hints: ["plus"], metric: metric(0.4, 1.2, 1_000_000, 6, 5) },
    { hints: ["flash"], metric: metric(0.05, 0.4, 1_000_000, 9, 4) },
    { hints: ["turbo"], metric: official(0.05, 0.2, 131_072, 9, 3) },
    { hints: ["max"], metric: official(1.6, 6.4, 32_768, 4, 5) },
    { hints: ["qwen"], metric: metric(0.4, 1.2, 262_144, 6, 4) },
  ],
  longcat: [
    // longcat.chat/platform/docs/pricing (2026-10-04) lists only the
    // limited-time $0.30/$1.20 for both 2.0 and 2.5 Preview; no standard rate.
    { hints: ["longcat"], metric: official(0.3, 1.2, 1_000_000, 6, 7) },
  ],
};

// Sensible per-provider default so an unrecognized model still gets real-ish
// numbers (not the generic cost-tier estimate).
const PROVIDER_DEFAULT: Partial<Record<Provider, ModelMetrics>> = {
  anthropic: metric(3, 15, 200_000, 5, 7),
  openai: metric(2.5, 15, 400_000, 6, 7),
  google: metric(1.5, 9, 1_048_576, 8, 6),
  // Anything Meta serves now comes off the Meta Model API, so the default
  // tracks Muse Spark rather than the retired Llama pricing.
  meta: metric(1.25, 4.25, 1_048_576, 6, 8),
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

function familyMetric(model: ModelInfo, at: Date | number): ModelMetrics | null {
  const id = model.providerModel.toLowerCase();
  const rules = FAMILY_RULES[model.provider];
  if (rules) {
    for (const rule of rules) {
      if (!rule.hints.every((h) => id.includes(h))) continue;
      if (!rule.scheduled) return rule.metric;
      const price = rule.scheduled(at);
      return { ...rule.metric, inputUsdPerMTok: price.input, outputUsdPerMTok: price.output };
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

export function getModelMetrics(model: ModelInfo, at: Date | number = Date.now()): ModelMetrics {
  const known = familyMetric(model, at);
  const base: ModelMetrics = known ?? {
    inputUsdPerMTok: model.cost === 3 ? 2 : model.cost === 2 ? 0.5 : 0.1,
    outputUsdPerMTok: model.cost === 3 ? 10 : model.cost === 2 ? 2 : 0.4,
    contextTokens: model.cost === 3 ? 256_000 : 128_000,
    speed: model.cost === 1 ? 9 : model.cost === 2 ? 7 : 5,
    intelligence: model.cost === 3 ? 8 : model.cost === 2 ? 7 : 5,
    source: "estimated",
  };
  const benchmarked = overlayBenchmark(base, BENCHMARKS[model.id]);
  // The lab's own published rate (models:sync) outranks both the hand-tuned
  // family rule and a leaderboard's copy of it: it is the figure billing uses.
  const official = OFFICIAL_RATES[model.id];
  const grounded: ModelMetrics = official
    ? { ...benchmarked, inputUsdPerMTok: official.input, outputUsdPerMTok: official.output, source: "official" }
    : benchmarked;
  // The registry's verified per-model context window always wins; the family
  // rule's contextTokens is only a fallback for discovered models.
  if (model.contextWindow && model.contextWindow !== grounded.contextTokens) {
    return { ...grounded, contextTokens: model.contextWindow };
  }
  return grounded;
}

/** First version number a model's display name advertises — "GPT-5.6 Sol" → 5.6,
 *  "Gemini 3.6 Flash" → 3.6, "Kimi K3" → 3. Null when the name carries no
 *  version ("Nano Banana Pro"), which sends the comparison to the release date.
 *
 *  Deliberately reads the display NAME only, never the provider id: ids encode
 *  the API surface rather than the product line, so `gemini-3-pro-image` would
 *  score "Nano Banana Pro" a 3 and float it over the newer "Nano Banana 2". */
export function modelGeneration(name: string): number | null {
  const match = /\d+(?:\.\d+)?/.exec(name);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Canonical display order for a model list, applied wherever the payload/list is
 * built so BOTH the web selector and the native apps (which consume the manifest
 * and trust its order) render identically. Sort key, in order:
 *   1. lab/provider — PROVIDER_LIST index ascending (the rail order)
 *   2. current before legacy — a superseded model never outranks a live one,
 *      whatever its grades, because the pickers group them separately
 *   3. generation — descending, parsed from the name, so a lab reads
 *      5.6 → 5.5 → 5.4 → 5.3 as a user expects
 *   4. release date — descending "YYYY-MM" compare, breaking ties inside one
 *      generation and ordering anything the parser couldn't version
 *   5. intelligence — descending, which orders one generation's siblings by
 *      power (5.6 Sol before Terra before Luna)
 *   6. cost tier — descending, the power tiebreak that still works when
 *      intelligence ties. It ties often: `familyMetric` falls back to one
 *      per-provider default, so every model a benchmark hasn't graded (notably
 *      anything freshly discovered) scores identically, and without this the
 *      order collapsed to alphabetical — Luna ahead of Sol.
 *   7. name — ascending, as a stable final tiebreak
 *
 * Generation outranks the release date because shipping order and version order
 * disagree: GPT-5.3 Codex shipped (2026-04) after the GPT-5.4 line (2026-03), so
 * a pure date sort listed 5.3 above 5.4. It also fixes newly DISCOVERED models,
 * which carry a name but no `released` at all — under a date-first sort a
 * just-published "Gemini 3.6 Flash" sank below every dated 3.5, the exact
 * opposite of what a new release should do.
 *
 * Generation is only ever compared inside one lab (key 1 runs first), so the
 * numbering schemes of different labs never meet.
 *
 * Returns a new array; the input is not mutated.
 */
/** Anthropic's product-line order, most capable first. Used only to keep Opus
 *  above Sonnet when their version numbers disagree (Opus 4.8 vs Sonnet 5). */
const ANTHROPIC_FAMILY_RANK: Record<string, number> = { fable: 0, opus: 1, sonnet: 2, haiku: 3 };

export function sortModelsForDisplay<T extends ModelInfo>(models: T[]): T[] {
  return [...models].sort((a, b) => {
    const labDelta = PROVIDER_LIST.indexOf(a.provider) - PROVIDER_LIST.indexOf(b.provider);
    if (labDelta !== 0) return labDelta;
    const legacyDelta = Number(isSupersededModel(a)) - Number(isSupersededModel(b));
    if (legacyDelta !== 0) return legacyDelta;
    // Anthropic ships parallel product lines under mismatched version numbers —
    // Opus 5 alongside Sonnet 5, Opus 4.8 alongside Sonnet 5 — so the raw
    // generation compare below interleaves them wrongly (Sonnet 5 floating over
    // Opus 4.8). A fixed line rank keeps the family order Fable → Opus → Sonnet
    // → Haiku whatever the numbers say. Only Anthropic's families are ranked;
    // every other lab's families are absent from the map, so their order is
    // untouched — and generation still orders siblings *within* a family below.
    const famA = ANTHROPIC_FAMILY_RANK[a.family ?? ""];
    const famB = ANTHROPIC_FAMILY_RANK[b.family ?? ""];
    if (famA !== undefined && famB !== undefined && famA !== famB) return famA - famB;
    // Only decisive when BOTH names carry a version; otherwise the release date
    // below still places an unversioned model sensibly against its siblings.
    const genA = modelGeneration(a.name);
    const genB = modelGeneration(b.name);
    if (genA !== null && genB !== null && genA !== genB) return genB - genA;
    // "" sorts before any real date; descending compare pushes nullish releases last.
    const relDelta = (b.released ?? "").localeCompare(a.released ?? "");
    if (relDelta !== 0) return relDelta;
    const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
    if (intelDelta !== 0) return intelDelta;
    const costDelta = b.cost - a.cost;
    if (costDelta !== 0) return costDelta;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The catalog a picker can render directly: everything still served, with the
 * newest of each product line current and every older generation marked
 * `legacy` so the UI files it under "Past models".
 *
 * **Mark, don't drop.** An earlier version of this deleted superseded models
 * outright, which read as the models being gone — and gone is what a lab whose
 * account ran out of credit had already looked like. A picker showing Opus 5
 * beside 4.8, 4.7, 4.6 and 4.5 is five ways to say "Opus" and buries the one
 * answer that is usually right, but that is a *grouping* problem, not a reason
 * to withhold a model a provider still answers on. Both pickers already have
 * the disclosure to put them behind (web "Past models", native "Older models");
 * they were simply never given anything to show.
 *
 * Two things decide the marking, and neither alone is enough:
 *  - **The registry's own verdict.** A curated `legacy`/`deprecated` status is
 *    a statement that something newer replaced it, and it survives untouched.
 *  - **The family collapse.** Two entries of one line can both say
 *    `current` (a newer generation curated before the older row is demoted),
 *    so only comparing entries within their `family` can demote the older one.
 *
 * What IS removed is a model whose `retiresOn` has passed: the provider stopped
 * answering, so it is not an option, past or otherwise.
 *
 * A model with no family is its own family (keyed by id) — never demoted on a
 * guess. Returns display order, so callers do not need to sort again.
 */
export function withSupersededMarked<T extends ModelInfo>(models: T[], today?: string): T[] {
  const live = models.filter((model) => !hasRetired(model, today));
  const winners = new Map<string, T>();
  for (const model of live) {
    if (isSupersededModel(model)) continue;
    const held = winners.get(familyKey(model));
    if (!held || newerInFamily(model, held) < 0) winners.set(familyKey(model), model);
  }
  return sortModelsForDisplay(
    live.map((model) => {
      if (isSupersededModel(model) || winners.get(familyKey(model)) === model) return model;
      // Superseded by a sibling the registry has not caught up with yet. Both
      // fields move together: `legacy` is what the pickers read and `status` is
      // what the native manifest turns into its `lifecycle`, and letting them
      // disagree is how a model lands in "Past models" still labelled current.
      return { ...model, legacy: true, status: "legacy" as const };
    })
  );
}

function familyKey(model: ModelInfo): string {
  return `${model.provider}|${model.modality ?? "chat"}|${(model.family ?? model.id).toLowerCase()}`;
}

/** The newest model of each product line — the "current" half of the catalog. */
export function latestPerFamily<T extends ModelInfo>(models: T[], today?: string): T[] {
  return withSupersededMarked(models, today).filter((model) => !isSupersededModel(model));
}

/**
 * Which of two models from the SAME product line to keep. Negative keeps `a`.
 *
 * Deliberately not `sortModelsForDisplay`'s comparator. That one mixes rules
 * that are individually sensible but jointly non-transitive (generation, then
 * release, then grades), which a sort is allowed to resolve in any consistent
 * way — fine for laying out a list, useless for picking a winner, because the
 * answer then depends on what else happened to be in the array. This runs
 * pairwise over one family and always gives the same answer for the same pair.
 */
function newerInFamily(a: ModelInfo, b: ModelInfo): number {
  // 1. Version, when both names carry one. This is what lets a freshly
  //    discovered Gemini Flash generations replace the curated row the day they ship.
  const genA = modelGeneration(a.name);
  const genB = modelGeneration(b.name);
  if (genA !== null && genB !== null && genA !== genB) return genB - genA;
  // 2. Otherwise the curated entry. Both describe the same model, but only the
  //    curated one has a verified name, price, context window and release date —
  //    discovery's is `prettifyModelName` over an id. Losing that swapped
  //    "Mistral Medium 3.5" for a bare "Mistral Medium" pointing at a snapshot.
  const curatedDelta = Number(!Object.hasOwn(MODELS, a.id)) - Number(!Object.hasOwn(MODELS, b.id));
  if (curatedDelta !== 0) return curatedDelta;
  // 3. Then the later release; an entry with no date at all sorts last.
  const relDelta = (b.released ?? "").localeCompare(a.released ?? "");
  if (relDelta !== 0) return relDelta;
  const intelDelta = getModelMetrics(b).intelligence - getModelMetrics(a).intelligence;
  if (intelDelta !== 0) return intelDelta;
  return a.id.localeCompare(b.id);
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
//  - GPT-5.6 Sol/Terra/Luna: OpenAI model docs (2026-07) list
//    none | low | medium | high | xhigh | max. "max" is the deepest effort
//    (above xhigh); Instant maps to none. Default is medium.
//    GPT-5.5 / 5.4 stop at xhigh (no max).
//  - GPT-6 Sol/Luna take the 5.6 ladder, `none` included; GPT-6 Astra has
//    no `none`, so it alone among the GPT-6 models offers no Instant.
//  - The gpt-5.x-pro MODELS accept only medium|high|xhigh and cannot be run
//    non-thinking. On GPT-5.6, by contrast, "pro" is not an effort at all — it is
//    a separate reasoning.mode axis (see PRO_MODE_MODELS below).
//  - Claude Haiku 4.5 has NO effort parameter — extended thinking is on/off only.
//  - Claude Opus 4.5 tops out at high; 4.6 adds max; 4.7+ adds xhigh.
//  - Claude Opus 5.5, like Fable/Mythos, cannot turn thinking off at all —
//    `thinking: {type: "disabled"}` is a 400 — and defaults to medium.
//  - Where "max" is also real outside GPT-5.6: Claude Opus 4.6+/4.7+ and
//    Sonnet 4.6+; GLM-5.2; DeepSeek v4.

//  - Gemini reads reasoning_effort on its OpenAI-compat shim (enum
//    none|minimal|low|medium|high), which maps onto the native thinking_config.
//    Only gemini-3.1-flash-lite has a PROVEN off-switch; the pro line is
//    unverified (this key's free tier is quota 0 there).
//  - Mistral Medium 3.5 / Small are on/off only (reasoning_effort: high|none).
//  - GLM-5.3 (low|high|max, always on) and GLM-5.2 (high|max + off) take
//    reasoning_effort; the older GLMs are on/off.
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

/**
 * How much of the composer aura a given effort earns, 0…1 — 0 being the
 * quietest bloom Juno draws and 1 the full one. The empty state reads this so
 * the light behind the composer answers the thinking slider: Instant is a hint,
 * Max burns.
 *
 * Indexed off TIER_ORDER rather than a hand-written table, for the reason the
 * comment above it already gives: a parallel list of these literals drifted
 * once before, and a new tier silently landing at the bottom of this ramp is
 * exactly the kind of quiet wrongness that took 26 models to notice.
 */
export function reasoningGlow(effort: ReasoningEffort): number {
  if (!effort) return 0;
  const i = TIER_ORDER.indexOf(effort as ReasoningTier);
  return i < 0 ? 0 : (i + 1) / TIER_ORDER.length;
}
const LMH: ReasoningTier[] = ["low", "medium", "high"];
/** OpenAI GPT-5.2 / 5.4 / 5.5 (+ some codex) — xhigh yes, max no. */
const LMHX: ReasoningTier[] = ["low", "medium", "high", "xhigh"];
/** GPT-5.6 + Claude Opus 4.7+/Sonnet 4.6+/Fable — full ladder through max. */
const LMHXM: ReasoningTier[] = ["low", "medium", "high", "xhigh", "max"];

export interface ReasoningCaps {
  /** Selectable depth tiers for this model (subset of low/medium/high/max). */
  tiers: ReasoningTier[];
  /** Whether thinking can be turned OFF (an "Instant" option is valid). */
  canDisable: boolean;
  /** On/off-only model (e.g. GLM-4.6): one "Thinking" state, no depth levels. */
  onOff: boolean;
  /** Provider/model default represented in Juno's canonical tier vocabulary. */
  defaultLevel: ReasoningEffort;
}

const caps = (
  tiers: ReasoningTier[],
  canDisable: boolean,
  onOff = false,
  defaultLevel?: ReasoningEffort,
): ReasoningCaps => ({
  tiers,
  canDisable,
  onOff,
  defaultLevel:
    defaultLevel !== undefined
      ? defaultLevel
      : canDisable || tiers.length === 0
        ? null
        : tiers.includes("medium")
          ? "medium"
          : tiers[Math.min(1, tiers.length - 1)] ?? null,
});

/** What thinking tiers a model actually supports, keyed off its provider + id. */
export function reasoningCaps(model: ModelInfo): ReasoningCaps {
  if (!model.reasoning) return caps([], false);
  const id = model.providerModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      // Wire shape is decided in anthropic.ts (buildAnthropicThinkingBits):
      //   adaptive + output_config.effort — fable/mythos/opus-4.6+/sonnet-4.6+/sonnet-5
      //   manual type:enabled + budget_tokens — haiku 4.5, opus 4.5, sonnet 4.5
      // Haiku 4.5 is absent from the effort-supported list entirely — on/off only.
      if (id.includes("haiku")) return caps([], true, true);
      // Fable/Mythos: adaptive always on; disabled rejected.
      // Fable 5 / Mythos 5 too: the API default effort is `high` on every
      // Fable and Mythos (effort docs, 2026-10-04) — the 5.0 row used to fall
      // to caps()'s `medium` and show a default the API never runs at.
      if (id.includes("fable") || id.includes("mythos")) return caps(LMHXM, false, false, "high");
      // Opus 5.5: adaptive and always on like Fable 5.1 (disabled → 400), on
      // the same ladder, but the API's own default is medium rather than high.
      if (id.includes("opus-5-5")) return caps(LMHXM, false, false, "medium");
      // Opus 4.5: manual budget_tokens only (no adaptive); effort API is
      // supported alongside budget but we still expose LMH for the slider.
      if (id.includes("opus-4-5")) return caps(LMH, true); // no xhigh, no max
      // Opus 4.6: adaptive preferred; max yes, xhigh no.
      if (id.includes("opus-4-6")) return caps(["low", "medium", "high", "max"], true);
      // Sonnet 4.5: manual budget_tokens only.
      if (id.includes("sonnet-4-5")) return caps(LMH, true);
      // Sonnet 4.6: like Opus 4.6, `max` but no `xhigh` — the effort docs list
      // xhigh only from Opus 4.7 / Sonnet 5 on (2026-10-04). It used to fall
      // through to the full ladder below and offer an Extra high it rejects.
      if (id.includes("sonnet-4-6")) return caps(["low", "medium", "high", "max"], true);
      // Opus 4.7/4.8/5, Sonnet 5/5.5: adaptive + full effort ladder. Instant is
      // real on each (thinking-troubleshooting table): omitted thinking on
      // Opus 4.7/4.8, `disabled` on Opus 5 / Sonnet 5, `between_tools` on
      // Sonnet 5.5 — anthropic-thinking.ts sends the right one.
      return caps(LMHXM, true);
    case "openai":
      // Every ladder below is the `reasoning.effort` list on the model's own
      // page (developers.openai.com/api/docs/models/<id>, re-read 2026-10-04),
      // with that page's default. Instant (canDisable) only where `none` is
      // listed.
      // GPT-6 Astra and GPT-6.1 Sol: low|medium(default)|high|xhigh|max — no
      // `none` and no `minimal`, so no Instant option the API would reject.
      if (id.includes("gpt-6-astra")) return caps(LMHXM, false, false, "medium");
      if (id.includes("gpt-6.1-sol")) return caps(LMHXM, false, false, "medium");
      // GPT-6 Sol/Luna and GPT-5.6 Sol/Terra/Luna list none|low|medium|high|
      // xhigh|max, default medium.
      if (id.includes("gpt-6-sol") || id.includes("gpt-6-luna")) return caps(LMHXM, true, false, "medium");
      if (id.includes("gpt-5.6")) return caps(LMHXM, true, false, "medium");
      // The gpt-5.x-pro models: medium|high|xhigh, always reasoning. GPT-5.5
      // Pro defaults to high; 5.4 Pro to medium (5.2 Pro states no default).
      if (id.includes("gpt-5.5-pro")) return caps(["medium", "high", "xhigh"], false, false, "high");
      if (/gpt-5(\.\d)?-pro/.test(id)) return caps(["medium", "high", "xhigh"], false, false, "medium");
      // GPT-5.3 Codex: low|medium|high|xhigh. Its page lists no `none`.
      if (id.includes("gpt-5.3-codex")) return caps(LMHX, false);
      // Any other Codex id (the 5.1/5.2 snapshots shut down 2026-07-23) is
      // treated as always-on with the common ladder.
      if (id.includes("codex")) return caps(LMH, false);
      // GPT-5.1: none(default)|low|medium|high — no xhigh.
      if (id.includes("gpt-5.1")) return caps(LMH, true);
      // GPT-5.5: none|low|medium(default)|high|xhigh.
      if (id.includes("gpt-5.5")) return caps(LMHX, true, false, "medium");
      // GPT-5.2 and 5.4 (+ -mini/-nano): none(default)|low|medium|high|xhigh.
      if (/gpt-5\.[24]/.test(id)) return caps(LMHX, true);
      // Original GPT-5 / GPT-5 Mini: minimal|low|medium|high; `none` did not exist yet.
      if (id.includes("gpt-5")) return caps(["minimal", "low", "medium", "high"], false);
      if (/(^|[^a-z0-9])o[134](-|$)/.test(id) || id.includes("o4-mini")) return caps(LMH, false); // o-series always reason
      return caps(LMH, true);
    case "google":
      // Per-model contracts from Google's current Gemini thinking table. Gemini
      // 3.x uses thinking_level on Juno's native GenerateContent transport;
      // Gemini 2.5 retains the legacy budget transport. Reasoning cannot be
      // disabled for any selectable row below.
      // 3.7 and 3.8 Flash: low | medium | high, default medium. No `minimal`
      // on this pair — 3.5 and 3.6 have it and the two newer rows do not,
      // which is why they are matched separately rather than folded together.
      // Keeping 3.8 explicit also stops a live-discovered 3.8 row falling
      // through to the unknown-model branch and losing its thinking selector.
      if (/3\.[78]-flash/.test(id)) return caps(LMH, false, false, "medium");
      if (/3\.[56]-flash/.test(id)) {
        return caps(["minimal", ...LMH], false, false, "medium");
      }
      /*
       * PRO TAKES LOW AND HIGH ONLY. There is no MEDIUM on the Pro line, and
       * asking for one is a hard failure: `400 INVALID_ARGUMENT Thinking level
       * MEDIUM is not supported for this model`, reported the same way through
       * the OpenAI-compat surface as `reasoning_effort: "medium"` rejected
       * while low and high succeed.
       *
       * This entry said `LMH`, so Juno's own picker offered Medium on Gemini
       * 3.1 Pro and every message sent with it 400ed. `gemini-core.ts` has
       * carried a comment quoting that exact error since the `thinkingLevel`
       * work — the adapter knew, the catalog never did, and the catalog is
       * what the picker reads.
       *
       * Default high: Gemini 3 defaults to high when no level is sent, and
       * unlike the Flash line Pro never moved to medium.
       */
      //
      // 2026-10-04: Google's thinking table now separates the two. Gemini 3
      // Pro (`gemini-3-pro-preview`) takes low|high only — that is the model
      // the 400 above was observed on. Gemini 3.1 Pro takes low|medium|high,
      // default high, so 3.1 gets the medium the old shared regex took away.
      if (/3\.[1-9]\d*-pro/.test(id)) return caps(LMH, false, false, "high");
      if (/3-pro/.test(id)) return caps(["low", "high"], false, false, "high");
      // 3.5 Flash-Lite defaults to MINIMAL for speed, and Google documents
      // raising it to medium or high for subagents that write code or call
      // APIs — so the whole ladder is offered, with minimal as the default.
      if (/3\.5-flash-lite/.test(id)) {
        return caps(["minimal", ...LMH], false, false, "minimal");
      }
      if (/3\.1-flash-lite/.test(id)) {
        return caps(["minimal", ...LMH], false, false, "minimal");
      }
      if (/3-flash/.test(id)) {
        return caps(["minimal", ...LMH], false, false, "high");
      }
      if (/2\.5-pro/.test(id)) return caps(LMH, false, false, "high");
      // Unknown discovered Gemini models fail closed: provider default only,
      // with no invented ladder exposed in any picker.
      return caps([], false);
    case "xai":
      if (id.includes("multi-agent")) return caps(LMHX, false); // effort selects agent COUNT
      // low | medium | high (default) | xhigh — same ladder as 4.6, one rung
      // longer runs aimed at multi-hour agent loops. Not verified against a
      // live key; see docs/models-september-22-2026.md.
      if (id.includes("grok-4.7")) return caps(LMHX, false, false, "high");
      if (id.includes("grok-4.6")) return caps(LMHX, false, false, "high");
      // Always reasons; xAI's reasoning guide gives the default as high, which
      // caps() would otherwise have reported as medium.
      if (id.includes("grok-4.5")) return caps(LMH, false, false, "high");
      // none|low|medium|high|xhigh, API default low (xAI's grok-4.3 page,
      // 2026-10-04) — was LMH with no xhigh and an Instant default.
      if (id.includes("grok-4.3")) return caps(LMHX, true, false, "low");
      return caps([], false); // grok-build: reasons, no documented control
    case "deepseek":
      // V4 Pro and the unversioned `deepseek-flash` (V4.1 Flash) both think by
      // default at "high". api-docs.deepseek.com (create-chat-completion, read
      // 2026-10-04): reasoning_effort none|low|high|max — "none disables
      // thinking mode; low / high / max enable" it — and thinking.type
      // enabled|disabled is the same switch. minimal→low, medium/xhigh→high,
      // so low|high|max are the three real depths.
      if (id.includes("v4") || id.includes("deepseek-flash")) return caps(["low", "high", "max"], true); // thinking on/off + effort
      return caps([], false); // deepseek-reasoner: always on, no control
    case "zhipu":
      // GLM-5.3: reasoning is ALWAYS on — `thinking: {type: "disabled"}` makes
      // the request fail — and its depth is the top-level `reasoning_effort`
      // enum low|high|max, default max (docs.z.ai/guides/llm/glm-5.3, read
      // 2026-10-04: "Any other input will result in an error"). So a ladder,
      // no Instant, and the API's own default.
      if (id.includes("glm-5.3")) return caps(["low", "high", "max"], false, false, "max");
      // GLM-5.2 takes reasoning_effort too, but only two depths are real
      // (docs.z.ai/guides/capabilities/thinking): low/medium→high, xhigh→max,
      // and none/minimal STOP thinking — the old minimal…max ladder offered a
      // "Minimal" that silently meant Instant. Off is thinking.type disabled.
      if (id.includes("glm-5.2")) return caps(["high", "max"], true);
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
      // Default max (platform.kimi.ai/docs/guide/use-reasoning-effort).
      if (id.includes("k3")) return caps(["low", "high", "max"], false, false, "max");
      if (id.includes("k2.7")) return caps([], false); // "disabled" is rejected — always on
      return caps([], true, true); // k2.6: thinking enabled/disabled
    case "meta":
      // Muse Spark exposes the full OpenAI-style reasoning_effort ladder EXCEPT
      // "max": minimal|low|medium|high|xhigh, default medium. canDisable is
      // false on purpose — reasoning is mandatory on this line, there is no
      // configuration that returns the weights without some deliberation, so an
      // "Instant" tier here would be a lie that still bills reasoning tokens.
      //
      // Curated from Meta's model docs, not probed: the account's billing is not
      // yet verified, so every completion returns 402 and no live oracle exists.
      // /v1/models confirms the id; the effort enum is documentation-only. Worth
      // re-probing once billing clears.
      // 1.3 documents two reasoning variants ABOVE the shared ladder — `max`
      // (top) and `xhigh` (faster) — on the same endpoints, SDKs and pricing
      // as 1.2, so it is 1.2's ladder plus a max rung.
      // …but NOT on the Contributor tier: dev.meta.ai/docs/reasoning says
      // `max` is "Standard-tier muse-spark-1.3 only; not available on
      // Contributor-tier models", so the contributor id keeps 1.2's ladder.
      if (id.includes("muse-spark-1.3") && !id.includes("contributor")) return caps(["minimal", ...LMHXM], false);
      if (id.includes("muse-spark")) return caps(["minimal", ...LMHX], false);
      return caps([], false); // retired Llama ids resolving through migration
    case "minimax":
      // M3.1 Flash Preview always thinks ("disabled" is a 400) and is the one
      // MiniMax that tunes depth: reasoning_effort low…max, default max
      // (platform.minimax.io text-chat-openai, read 2026-10-04).
      if (id.includes("m3.1")) return caps(LMHXM, false, false, "max");
      if (id.includes("m3")) return caps([], true, true); // adaptive/disabled toggle
      return caps([], false); // M2.x: thinking param ignored, always on
    case "mimo":
      return caps([], true, true); // thinking: enabled/disabled — not an effort ladder
    case "qwen":
      if (id.includes("qwq")) return caps([], false); // QwQ always reasons, no control
      if (id.includes("coder")) return caps([], true); // Qwen3-Coder: non-thinking
      // Qwen3.8 (Max and Flash) is HYBRID — thinking on by default, off with
      // enable_thinking:false — and its depth is reasoning_effort
      // low|medium|xhigh (default xhigh; high/max map to xhigh). It must not
      // also get a thinking_budget: "Setting both will cause an error"
      // (Model Studio, OpenAI Chat Completions reference, read 2026-10-04).
      if (id.includes("qwen3.8")) return caps(["low", "medium", "xhigh"], true);
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
  return reasoningCaps(model).defaultLevel;
}

/** Coerce a requested effort into something the model actually accepts, so a
 *  stale/unsupported value (e.g. "max" on Gemini) is never sent to the provider. */
export function clampReasoningEffort(model: ModelInfo, requested: ReasoningEffort): ReasoningEffort {
  if (!model.reasoning) return null;
  const c = reasoningCaps(model);
  if (c.onOff) return requested ? "high" : null;
  if (c.tiers.length === 0) return null; // always-on, no control → send nothing
  if (requested == null) return c.canDisable ? null : c.defaultLevel;
  if (c.tiers.includes(requested as ReasoningTier)) return requested;
  // Persisted values from a different model are reset to this model's declared
  // default. This is explicit and stable; silently mapping Max to High makes a
  // saved preference look preserved when it is not.
  return c.defaultLevel;
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
