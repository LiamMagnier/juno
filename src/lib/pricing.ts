import type { ModelInfo } from "@/lib/models";
import { geminiFlashRate, isGeminiPromoFlash } from "@/lib/scheduled-prices";
import { OFFICIAL_RATES, type OfficialRateEntry } from "@/lib/model-rates.generated";

/**
 * The lab's own published rate for this model, as `npm run models:sync` last
 * read it (src/lib/model-rates.generated.ts), or undefined when the sync could
 * not verify one. Everything below reads this FIRST: the hand-coded rules are
 * the fallback for a model the sync has no verified rate for, never a second
 * opinion that could override the lab's page.
 */
export function officialRate(model: Pick<ModelInfo, "id">): OfficialRateEntry | undefined {
  return OFFICIAL_RATES[model.id];
}

/**
 * A request's serving tier as the pricing and transport layers see it:
 * `false` standard, `true` the lab's fast / priority tier, `"ultrafast"`
 * OpenAI's Ultrafast service tier. Truthy for both premium tiers, so every
 * `if (fastMode)` that only asks "is this a premium tier?" keeps working.
 */
export type FastMode = boolean | "ultrafast";

/** The OpenAI-style `service_tier` value for a request's tier, or undefined for standard. */
export function serviceTierFor(fastMode: FastMode | undefined): "priority" | "ultrafast" | undefined {
  if (!fastMode) return undefined;
  return fastMode === "ultrafast" ? "ultrafast" : "priority";
}

/**
 * Per-model token + tool pricing so message cost and ApiSpend match real
 * provider billing as closely as list prices allow.
 *
 * Rates are USD per 1,000,000 tokens (list prices). Tool fees are flat USD.
 * Sources: provider pricing pages (see docs/models.md). Always recompute from
 * complete usage — never invent tokens when the API already reported them.
 */
export interface TokenRate {
  input: number;
  output: number;
  cacheRead: number; // $/MTok for a cache hit
  /** Default cache-write rate ($/MTok). Prefer cacheWrite5m / cacheWrite1h when split. */
  cacheWrite: number;
  /** Anthropic 5-minute ephemeral write (1.25× input). */
  cacheWrite5m: number;
  /** Anthropic 1-hour ephemeral write (2× input). Juno always uses 1h TTL. */
  cacheWrite1h: number;
}

/** Raw usage as reported by a provider stream (conventions differ, see below). */
export interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** Unspecified-TTL cache writes (or total when 5m/1h not split). */
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
}

/**
 * The prompt-cache fields an OpenAI-compatible `usage` object may carry, in
 * every dialect Juno has met. `prompt_tokens` always includes the cached
 * portion on this API family (see `normalizeUsage`).
 */
export interface CompatPromptCacheFields {
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  /** DeepSeek: its disk cache, hits and misses. Both are INSIDE prompt_tokens. */
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** Moonshot/Kimi: a top-level cached count. */
  cached_tokens?: number;
}

/**
 * Cache read/write token counts from a compat usage chunk.
 *
 * The write count is ONLY an explicit `cache_write_tokens` (OpenAI GPT-5.6+).
 * DeepSeek's `prompt_cache_miss_tokens` used to be taken as a write for every
 * non-OpenAI provider — but a miss is just the uncached remainder of
 * `prompt_tokens`, already billed as fresh input by `normalizeUsage`, so it was
 * charged twice: once at the input rate and again as a "write" at the same
 * rate (`tokenRate`'s default branch). Uncached DeepSeek input cost double.
 * No compat provider Juno routes to bills a cache-write premium through that
 * field, so dropping it is the whole fix.
 */
export function compatPromptCacheTokens(
  u: CompatPromptCacheFields
): { cacheRead: number | undefined; cacheWrite: number } {
  // `undefined` when no dialect reported a read count at all, so a caller
  // keeping "last chunk wins" state can tell "not reported" from zero.
  const read = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  return { cacheRead: read == null ? undefined : Math.max(0, read), cacheWrite: Math.max(0, cacheWrite) };
}

/** Provider token conventions reconciled into one additive shape. */
export interface NormalizedUsage {
  totalInput: number; // full prompt size, cache included
  freshInput: number; // input billed at the full input rate
  cacheRead: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}

/** Server-tool / live-search counts billed on top of tokens. */
export interface ToolUsageExtras {
  webSearchRequests?: number;
  xSearchRequests?: number;
  /** Adapter-computed fee override (already USD). */
  toolFeesUsd?: number;
}

/**
 * Anthropic reports `input_tokens` EXCLUDING cache read/write (they're separate
 * additive counters). OpenAI-compatible providers report `prompt_tokens`
 * INCLUDING the cached portion (cached_tokens is a subset). Normalize both so
 * `totalInput` and the per-bucket counts mean the same thing everywhere.
 */
export function normalizeUsage(provider: string, u: RawUsage): NormalizedUsage {
  const input = Math.max(0, u.input ?? 0);
  const cacheRead = Math.max(0, u.cacheRead ?? 0);
  const cacheWrite5m = Math.max(0, u.cacheWrite5m ?? 0);
  const cacheWrite1h = Math.max(0, u.cacheWrite1h ?? 0);
  // Prefer TTL split when present; else use the aggregate write counter.
  const cacheWrite =
    cacheWrite5m > 0 || cacheWrite1h > 0
      ? cacheWrite5m + cacheWrite1h
      : Math.max(0, u.cacheWrite ?? 0);

  const output = Math.max(0, u.output ?? 0);
  if (provider === "anthropic") {
    return {
      totalInput: input + cacheRead + cacheWrite,
      freshInput: input,
      cacheRead,
      cacheWrite,
      cacheWrite5m,
      cacheWrite1h,
      output,
    };
  }
  // OpenAI-compatible: prompt_tokens already includes cacheRead.
  const freshInput = Math.max(0, input - cacheRead);
  return {
    totalInput: input,
    freshInput,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    output,
  };
}

// Verified against provider pricing pages + Artificial Analysis, 2026-07-10
// (sources in docs/models.md). Keep in sync with model-metrics.ts FAMILY_RULES.
function baseRate(model: ModelInfo, at: Date | number = Date.now()): { input: number; output: number } {
  const official = officialRate(model);
  if (official) return { input: official.input, output: official.output };
  const pm = model.providerModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      if (pm.includes("fable") || pm.includes("mythos")) return { input: 10, output: 50 };
      if (pm.includes("opus-4-1")) return { input: 15, output: 75 }; // pre-4.5 Opus pricing
      // BEFORE the generic opus row, which this id also matches: Opus 5.5 is
      // the first Opus since 4.5 to move off $5/$25.
      if (pm.includes("opus-5-5")) return { input: 4, output: 20 };
      if (pm.includes("opus")) return { input: 5, output: 25 };
      if (pm.includes("haiku")) return { input: 1, output: 5 };
      // Sonnet 5 and 5.5. $2/$10 became Sonnet 5's standard price; the
      // scheduled Sep 1 2026 rise to $3/$15 was cancelled (pricing page).
      if (pm.includes("sonnet-5")) return { input: 2, output: 10 };
      return { input: 3, output: 15 }; // sonnet-class
    case "openai":
      // o3 $2/$8 and o3-mini $1.10/$4.40 (model pages, 2026-10-04); o1 $15/$60.
      if (pm.includes("o3-mini")) return { input: 1.1, output: 4.4 };
      if (/^o3(?:$|-)/.test(pm)) return { input: 2, output: 8 };
      if (/^o\d/.test(pm) || pm.includes("-o1") || pm.includes("-o3")) return { input: 15, output: 60 };
      if (pm.includes("gpt-6-astra")) return { input: 10, output: 50 };
      if (pm.includes("gpt-6.1-sol")) return { input: 2, output: 10 };
      if (pm.includes("gpt-6-sol")) return { input: 2, output: 10 };
      if (pm.includes("gpt-6-luna")) return { input: 0.1, output: 0.5 };
      // Terra/Luna were cut on 2026-07-30 (Terra −20%, Luna −80%) from their
      // 2026-07-09 launch rates of $2.50/$15 and $1/$6. Sol was not repriced.
      if (pm.includes("gpt-5.6-terra")) return { input: 2, output: 12 };
      if (pm.includes("gpt-5.6-luna")) return { input: 0.2, output: 1.2 };
      // Sol is $4/$20 on its model page ("promotional pricing ... at least
      // through November 21, 2026").
      if (pm.includes("gpt-5.6")) return { input: 4, output: 20 }; // sol + bare alias
      if (pm.includes("gpt-5.5-pro") || pm.includes("gpt-5.4-pro")) return { input: 30, output: 180 };
      if (pm.includes("gpt-5.5")) return { input: 5, output: 30 };
      if (pm.includes("gpt-5.4-nano")) return { input: 0.2, output: 1.25 };
      if (pm.includes("gpt-5.4-mini")) return { input: 0.75, output: 4.5 };
      if (pm.includes("gpt-5.4")) return { input: 2.5, output: 15 };
      if (pm.includes("gpt-5.3-codex")) return { input: 1.75, output: 14 };
      if (pm.includes("gpt-5.2-pro")) return { input: 21, output: 168 };
      if (pm.includes("gpt-5.2")) return { input: 1.75, output: 14 };
      if (pm.includes("gpt-5.1")) return { input: 1.25, output: 10 };
      if (pm.includes("realtime")) return { input: 32, output: 64 }; // audio tokens, per 1M
      if (pm.includes("nano")) return { input: 0.1, output: 0.4 };
      if (pm.includes("mini")) return { input: 0.25, output: 2 };
      if (pm.includes("gpt-5")) return { input: 1.25, output: 10 };
      if (pm.includes("gpt-4.1")) return { input: 2, output: 8 };
      if (pm.includes("gpt-4o")) return { input: 2.5, output: 10 };
      return { input: 2.5, output: 10 };
    case "google":
      if (pm.includes("3.1-flash-lite")) return { input: 0.25, output: 1.5 };
      // $0.75/$3.75 through 2026-12-31, $1.50/$7.50 from 2027-01-01 UTC
      // (scheduled-prices.ts), priced at the moment the tokens were used.
      if (isGeminiPromoFlash(pm)) return { ...geminiFlashRate(at) };
      // Before the 3.5-flash test, which this id also matches — see the same
      // ordering note in model-metrics.ts.
      if (pm.includes("3.5-flash-lite")) return { input: 0.3, output: 2.5 };
      if (pm.includes("3.5-flash")) return { input: 1.5, output: 9 };
      // Gemini 2.5 Pro is $1.25/$10 (≤200K prompts), not 3.1 Pro's $2/$12.
      if (pm.includes("2.5-pro")) return { input: 1.25, output: 10 };
      if (pm.includes("pro")) return { input: 2, output: 12 };
      // gemini-3-flash-preview: $0.50/$3 on Google's pricing page.
      if (pm.includes("3-flash")) return { input: 0.5, output: 3 };
      return { input: 0.3, output: 2.5 }; // older flash-class
    case "meta":
      // BEFORE the muse-spark test, which `muse-spark-1.3-contributor` also
      // matches — the same ordering hazard the Gemini flash-lite rule above
      // documents, and here it is worth 12.5x on input and 21x on output. The
      // contributor tier is now a registered, selectable model rather than an
      // id only a hand-edit could reach, so this branch is no longer
      // hypothetical: get the order wrong and everyone who picked the cheap
      // tier is metered at the standard one.
      if (pm.includes("contributor")) return { input: 0.1, output: 0.2 };
      if (pm.includes("muse-spark")) return { input: 1.25, output: 4.25 };
      // No muse-image row, for the reason model-metrics.ts gives: it bills per
      // returned image and `mediaRequestCost` is what charges for it, so a
      // token rate here would only be read by estimators — and a zero would be
      // rendered as "Free" over a model that costs a cent a shot.
      // Llama API shut down 2026-07-06 — kept for straggler cost display.
      if (pm.includes("maverick")) return { input: 0.35, output: 0.85 };
      if (pm.includes("scout")) return { input: 0.17, output: 0.66 };
      return { input: 0.35, output: 0.85 };
    case "deepseek":
      // NOTE mid-July 2026: V4 goes official with 2x peak-hour pricing
      // (09:00-12:00 / 14:00-18:00 Beijing) — revisit when announced.
      // V4.1 Flash, off-peak. DeepSeek doubles these in its peak windows.
      if (pm === "deepseek-flash") return { input: 0.15, output: 0.6 };
      // api-docs.deepseek.com/quick_start/pricing (2026-10-04), off-peak.
      if (pm.includes("v4-pro")) return { input: 0.66, output: 1.98 };
      return { input: 0.14, output: 0.28 }; // v4-flash + retiring aliases
    case "zhipu":
      // docs.z.ai/guides/overview/pricing (2026-10-04). FlashX before Flash
      // and AirX before Air: each id contains the shorter one.
      if (pm.includes("glm-5.3-flashx")) return { input: 0.37, output: 1.25 };
      if (pm.includes("glm-5.3-flash")) return { input: 0.15, output: 0.5 };
      if (pm.includes("glm-4.7-flashx")) return { input: 0.07, output: 0.4 };
      if (pm.includes("glm-4.6v-flashx")) return { input: 0.04, output: 0.4 };
      // GLM-4.7 / 4.5 / 4.6V Flash are free on Z.ai. Billing keeps the old
      // nominal floor so a run on them still meters (work-pricing tests).
      if (pm.includes("flash")) return { input: 0.1, output: 0.1 };
      if (pm.includes("airx")) return { input: 1.1, output: 4.5 };
      if (pm.includes("air")) return { input: 0.2, output: 1.1 };
      if (pm.includes("glm-4.5-x")) return { input: 2.2, output: 8.9 };
      if (pm.includes("glm-4.5v")) return { input: 0.6, output: 1.8 };
      if (pm.includes("glm-4.6v")) return { input: 0.3, output: 0.9 };
      if (pm.includes("glm-4-32b")) return { input: 0.1, output: 0.1 };
      // 5.3, 5.2 and 5.1 share one rate on Z.ai's price card.
      if (pm.includes("glm-5.3") || pm.includes("glm-5.2") || pm.includes("glm-5.1")) return { input: 1.4, output: 4.4 };
      if (pm.includes("turbo")) return { input: 1.2, output: 4.0 }; // delisted; last known rate
      if (/^glm-5(?:$|-)/.test(pm)) return { input: 1, output: 3.2 };
      return { input: 0.6, output: 2.2 }; // GLM-4.7 / 4.6 / 4.5
    case "moonshot":
      // platform.kimi.ai/docs/pricing/chat (2026-10-04). K3 used to fall
      // through to $0.60/$2.50 — a fifth of its real rate.
      if (pm.includes("kimi-k3")) return { input: 3, output: 15 };
      if (pm.includes("highspeed")) return { input: 1.9, output: 8 };
      if (pm.includes("k2.")) return { input: 0.95, output: 4 };
      return { input: 0.6, output: 2.5 };
    case "mistral":
      if (pm.includes("medium")) return { input: 1.5, output: 7.5 };
      if (pm.includes("large")) return { input: 0.5, output: 1.5 };
      if (pm.includes("small")) return { input: 0.15, output: 0.6 };
      // Ministral 3: 14B $0.20, 8B $0.15, 3B $0.10 (in = out; Mistral model pages).
      if (pm.includes("ministral-14b")) return { input: 0.2, output: 0.2 };
      if (pm.includes("ministral-3b")) return { input: 0.1, output: 0.1 };
      if (pm.includes("ministral")) return { input: 0.15, output: 0.15 };
      if (pm.includes("codestral")) return { input: 0.3, output: 0.9 };
      return { input: 0.5, output: 2.2 };
    case "xai":
      // docs.x.ai/developers/models (2026-10-04), below the 200K tier.
      if (pm.includes("grok-4.5")) return { input: 2, output: 6 };
      if (pm.includes("grok-4.3")) return { input: 1.25, output: 2.5 };
      if (pm.includes("grok-build")) return { input: 1, output: 2 };
      // All three 4.20 ids, multi-agent included: $1.25 / $2.50.
      if (pm.includes("grok-4.20")) return { input: 1.25, output: 2.5 };
      return { input: 2, output: 6 }; // 4.6 / 4.7
    case "minimax":
      // platform.minimax.io/docs/guides/pricing-paygo (2026-10-04): M3 ≤512K
      // input, M2.7 and M2.5 are $0.30/$1.20; the highspeed tiers double it.
      if (pm.includes("highspeed")) return { input: 0.6, output: 2.4 };
      return { input: 0.3, output: 1.2 };
    case "mimo":
      // Xiaomi's published V2.6 card. These were estimates for one commit and
      // two of the three were wrong, which is worth leaving on the record:
      //
      //   Flash       estimated 0.20 / 0.80   actual 0.14 / 0.28
      //   Pro         estimated 0.435 / 0.87  actual 0.435 / 0.87   ✓
      //   UltraSpeed  estimated 1.305 / 2.61  actual 4.35 / 8.70
      //
      // UltraSpeed is 10x Pro, not the 3x the V2.5 UltraSpeed precedent
      // suggested — so the estimate under-billed it by 3.3x, which is the
      // direction Juno eats rather than the user. A precedent from the
      // previous generation is not a rate.
      //
      // UltraSpeed is still tested BEFORE `pro`, and that ordering is now
      // load-bearing for a much bigger gap: its id is
      // `mimo-v2.6-pro-ultraspeed`, so it matches `pro` too, and falling
      // through would bill a $4.35 model at $0.435 — a tenth of cost, silently,
      // on every call.
      if (pm.includes("ultraspeed")) return { input: 4.35, output: 8.7 };
      if (pm.includes("pro")) return { input: 0.435, output: 0.87 };
      // V2.6 Flash, and the V2/V2.5 rows that fall through to it.
      return { input: 0.14, output: 0.28 };
    case "qwen":
      // Singapore (international) list prices from each model's Model Studio
      // page, read 2026-10-04; tiered models quote their lowest input tier.
      if (pm.includes("qwen3.8-max")) return { input: 2, output: 6 };
      if (pm.includes("qwen3.8-flash")) return { input: 0.15, output: 0.47 };
      if (pm.includes("qwen3.7-max")) return { input: 2.5, output: 7.5 };
      if (pm.includes("qwen3.7-plus")) return { input: 0.4, output: 1.6 };
      if (pm.includes("qwen3.7-flash")) return { input: 0.03, output: 0.13 };
      if (pm.includes("qwen3.6-plus")) return { input: 0.5, output: 3 };
      if (pm.includes("qwen3.6-flash")) return { input: 0.25, output: 1.5 };
      if (pm.includes("qwen3.5-plus")) return { input: 0.4, output: 2.4 };
      if (pm.includes("qwen3.5-flash")) return { input: 0.1, output: 0.4 };
      if (pm.includes("qwen3-vl-plus")) return { input: 0.2, output: 1.6 };
      if (pm.includes("qwen3-vl-flash")) return { input: 0.05, output: 0.4 };
      if (pm.includes("qwen3-coder-plus")) return { input: 1, output: 5 };
      if (pm.includes("qwen3-235b")) return { input: 0.7, output: 2.8 };
      if (pm.includes("qwen3-30b")) return { input: 0.2, output: 0.8 };
      if (pm.includes("qwen-vl-max")) return { input: 0.8, output: 3.2 };
      if (pm.includes("qwen-max")) return { input: 1.6, output: 6.4 };
      if (pm.includes("qwen-turbo")) return { input: 0.05, output: 0.2 };
      if (pm.includes("qwq")) return { input: 0.8, output: 2.4 };
      if (pm.includes("qwen-long")) return { input: 0.072, output: 0.287 }; // Beijing only
      if (pm.includes("flash")) return { input: 0.19, output: 1.13 };
      return { input: 0.4, output: 1.2 };
    case "longcat":
      // longcat.chat/platform/docs/pricing (2026-10-04): $0.30 / $1.20 for
      // LongCat-2.0 and 2.5 Preview — the only rate the docs publish.
      return { input: 0.3, output: 1.2 };
    default: {
      // Unknown provider → fall back by relative cost tier.
      if (model.cost === 3) return { input: 10, output: 40 };
      if (model.cost === 1) return { input: 0.2, output: 0.8 };
      return { input: 2, output: 8 };
    }
  }
}

/**
 * Fast-mode / priority premium multiplier applied to a model's standard input +
 * output rates (and thus the cache rates derived from them). `null` = the model
 * has no fast mode at all.
 *
 *  - Anthropic fast mode (`speed:"fast"` + `fast-mode-2026-02-01` beta): Opus 4.8
 *    and Opus 5.5 — 4.7's fast mode is deprecated (removed 2026-07-24) and
 *    4.6/other models error or silently run standard. Priced at 2x on both:
 *    $10/$50 over 4.8's $5/$25, and $8/$40 over 5.5's $4/$20 (Anthropic's
 *    fast-mode pricing table, 2026-09-22).
 *  - OpenAI priority (`service_tier:"priority"`, which OpenAI renamed "Fast
 *    mode" and still accepts): GPT-6 Astra/Sol/Luna and the 5.6/5.5/5.4 chat
 *    tiers. 5.5 is 2.5x, the rest 2x. The -pro line, 5.1 and 4o are NOT
 *    priority-eligible.
 *
 * Keep in sync with supportsFastMode(); both are the single source of truth for
 * which models show the "Fast" toggle and how the premium is billed.
 */
export function fastModeMultiplier(model: ModelInfo): number | null {
  // The lab's fast table, when the sync read one, is the whole answer: a
  // model absent from it (null) has no fast tier, whatever the rules below say.
  const official = officialRate(model);
  if (official && official.fast !== undefined) {
    return official.fast ? Math.round((official.fast.input / official.input) * 100) / 100 : null;
  }
  const pm = model.providerModel.toLowerCase();
  if (model.provider === "anthropic") return pm.includes("opus-4-8") || pm.includes("opus-5-5") ? 2 : null;
  if (model.provider === "openai") {
    if (pm.includes("-pro")) return null; // pro tiers aren't priority-eligible
    if (/gpt-6(?:\.\d+)?-(astra|sol|luna)/.test(pm)) return 2;
    if (pm.includes("gpt-5.6")) return 2; // sol / terra / luna
    if (pm.includes("gpt-5.5")) return 2.5;
    if (pm.includes("gpt-5.4")) return 2;
    return null;
  }
  return null;
}

/** Whether this model supports a faster, premium-priced "fast mode". */
export function supportsFastMode(model: ModelInfo): boolean {
  return fastModeMultiplier(model) !== null;
}

/**
 * OpenAI's Ultrafast service tier (`service_tier: "ultrafast"`, Responses API):
 * the rate multiple over standard, or null when the model is not served on it.
 *
 * Read only from the lab's Ultrafast pricing table (via the sync), never
 * inferred: OpenAI serves it on GPT-6 Astra and GPT-6.1 Sol at 6x standard,
 * and a guess here would put a 6x premium in front of a model that rejects it.
 */
export function ultraFastMultiplier(model: ModelInfo): number | null {
  const official = officialRate(model);
  if (!official?.ultrafast) return null;
  return Math.round((official.ultrafast.input / official.input) * 100) / 100;
}

/** Whether this model can be served on the Ultrafast tier. */
export function supportsUltraFastMode(model: ModelInfo): boolean {
  return ultraFastMultiplier(model) !== null;
}

/**
 * The serving tier a request gets: Ultrafast only where the model is on
 * OpenAI's Ultrafast table, Fast only where it has a fast tier, else standard.
 * An Ultrafast request on a model without it does NOT fall back to Fast: the
 * reader agreed to a specific premium, not to whichever one is available.
 */
export function resolveFastMode(model: ModelInfo, req: { fastMode?: boolean; ultraFast?: boolean }): FastMode {
  if (req.ultraFast) return supportsUltraFastMode(model) ? "ultrafast" : false;
  return !!req.fastMode && supportsFastMode(model);
}

/** Input / output rate multiples for a request's serving tier. */
function speedMultipliers(model: ModelInfo, fastMode: FastMode): { input: number; output: number } {
  if (!fastMode) return { input: 1, output: 1 };
  const official = officialRate(model);
  const tier = fastMode === "ultrafast" && official?.ultrafast ? official.ultrafast : official?.fast;
  if (official && tier) return { input: tier.input / official.input, output: tier.output / official.output };
  const m = fastModeMultiplier(model) ?? 1;
  return { input: m, output: m };
}

/**
 * Full rate incl. cache multipliers.
 * Anthropic: read 0.1× (0.025× on Fable/Mythos 5.1, 0.05× on Opus 5.5),
 * 5m write 1.25×, 1h write 2×.
 * Juno always writes Anthropic system prefixes with ttl:"1h", so the default
 * `cacheWrite` for Anthropic is the **1h** rate (2×).
 * `fastMode` scales base input/output (and derived cache rates).
 */
export function tokenRate(model: ModelInfo, fastMode: FastMode = false, at: Date | number = Date.now()): TokenRate {
  const raw = baseRate(model, at);
  const speed = speedMultipliers(model, fastMode);
  const rate = computedRate(model, raw.input * speed.input, raw.output * speed.output);
  const official = officialRate(model);
  if (!official) return rate;
  // The lab's own cache columns win over the ratios computedRate assumes, at
  // the same tier multiple as the input they discount.
  const k = speed.input;
  if (official.cacheRead != null) rate.cacheRead = official.cacheRead * k;
  if (official.cacheWrite5m != null) rate.cacheWrite5m = official.cacheWrite5m * k;
  if (official.cacheWrite1h != null) {
    rate.cacheWrite1h = official.cacheWrite1h * k;
    if (model.provider === "anthropic") rate.cacheWrite = rate.cacheWrite1h; // Juno writes 1h
  }
  if (official.cacheWrite != null && model.provider !== "anthropic") {
    rate.cacheWrite = rate.cacheWrite5m = rate.cacheWrite1h = official.cacheWrite * k;
  }
  return rate;
}

/** The provider-rule rates for an already tier-scaled input / output price. */
function computedRate(model: ModelInfo, input: number, output: number): TokenRate {
  if (model.provider === "anthropic") {
    return {
      input,
      output,
      cacheRead: input * anthropicCacheReadRatio(model.providerModel),
      cacheWrite: input * 2, // default = 1h (what we actually write)
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 2,
    };
  }
  if (model.provider === "google") {
    // Every Gemini text model Juno serves prices a cached token at 10% of its
    // input rate (ai.google.dev/gemini-api/docs/pricing, read 2026-10-04:
    // 3.1 Pro $0.20 on $2, 3.5 Flash $0.15 on $1.50, 2.5 Pro $0.125 on $1.25,
    // 2.5 Flash-Lite $0.01 on $0.10). Only the 3.5-3.8 Flash rows used to get
    // it; Pro, Flash-Lite and 3 Flash fell through to the 0.25x default and a
    // reader was billed 2.5x the real price on every implicit-cache hit.
    // Implicit caching has no storage fee, so writes cost plain input.
    return { input, output, cacheRead: input * 0.1, cacheWrite: input, cacheWrite5m: input, cacheWrite1h: input };
  }
  if (model.provider === "deepseek") {
    // api-docs.deepseek.com/quick_start/pricing (2026-10-04): a cache hit is
    // $0.003 on $0.15 for V4.1 Flash (2%) and $0.022 on $0.66 for V4 Pro
    // (3.3%). The 0.25x fallback billed a Flash cache hit at 12x its price,
    // on the longest conversations, because those are the ones that cache.
    // The legacy V4 Flash ids share the Flash ratio. No write premium.
    const pm = model.providerModel.toLowerCase();
    return {
      input,
      output,
      cacheRead: input * (pm.includes("v4-pro") ? 0.0333 : 0.02),
      cacheWrite: input,
      cacheWrite5m: input,
      cacheWrite1h: input,
    };
  }
  if (model.provider === "moonshot") {
    // platform.kimi.ai/docs/pricing/chat (2026-10-04): K3 $0.30 on $3 (10%),
    // K2.7 Code and its High-Speed tier 20% ($0.19 / $0.38), K2.6 $0.16 on
    // $0.95 (~17%). Older K2 rows keep the conservative 0.25x.
    const pm = model.providerModel.toLowerCase();
    const ratio = pm.includes("kimi-k3") ? 0.1 : pm.includes("k2.7") ? 0.2 : pm.includes("k2.6") ? 0.168 : 0.25;
    return { input, output, cacheRead: input * ratio, cacheWrite: input, cacheWrite5m: input, cacheWrite1h: input };
  }
  if (model.provider === "zhipu") {
    // Z.ai bills GLM cached input at $0.26 vs $1.40 fresh (GLM-5.2) ≈ 0.186x;
    // cache storage is currently free, so writes cost the plain input rate.
    return {
      input,
      output,
      cacheRead: input * 0.186,
      cacheWrite: input,
      cacheWrite5m: input,
      cacheWrite1h: input,
    };
  }
  if (
    model.provider === "openai" &&
    (model.providerModel.toLowerCase().includes("gpt-5.6") ||
      /gpt-6(?:\.\d+)?-(astra|sol|luna)/.test(model.providerModel.toLowerCase()))
  ) {
    // GPT-5.6+ family: 90% cached-input discount (95% on GPT-6.1 Sol: $0.10
    // against $2); cache writes 1.25× uncached.
    return {
      input,
      output,
      cacheRead: input * (model.providerModel.toLowerCase().includes("gpt-6.1-sol") ? 0.05 : 0.1),
      cacheWrite: input * 1.25,
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 1.25,
    };
  }
  if (model.provider === "xai") {
    // xAI's cached-input column per model (docs.x.ai/developers/models):
    // 4.6/4.7 $0.50 on $2 (0.25x), 4.5 $0.30 on $2 (0.15x), 4.3 and the 4.20
    // ids $0.20 on $1.25 (0.16x), Build $0.20 on $1 (0.2x). No write premium.
    const pm = model.providerModel.toLowerCase();
    const ratio = pm.includes("grok-4.5") ? 0.15 : pm.includes("grok-build") ? 0.2 : /grok-4\.(3|20)/.test(pm) ? 0.16 : 0.25;
    return { input, output, cacheRead: input * ratio, cacheWrite: input, cacheWrite5m: input, cacheWrite1h: input };
  }
  if (model.provider === "meta") {
    /*
     * Meta prices a cache hit as its own column, and both tiers sit well below
     * the 0.25x this function otherwise assumes:
     *
     *   standard      $0.15   against $1.25   = 12%
     *   contributor   $0.002  against $0.10   = 2%
     *
     * The fallback billed a standard cached token at $0.3125 against a real
     * $0.15 — 2x — and a contributor one at $0.025 against $0.002, which is
     * 12.5x. Both land on the longest conversations, because those are the
     * ones that cache at all.
     *
     * The `contributor` test comes first for the same reason it does in
     * `baseRate`: the cheap id contains the whole of the expensive one's name.
     * No published cache-WRITE premium, so writes cost plain input — the same
     * conservative reading the zhipu and mimo branches take.
     */
    const pm = model.providerModel.toLowerCase();
    return {
      input,
      output,
      cacheRead: input * (pm.includes("contributor") ? 0.02 : 0.12),
      cacheWrite: input,
      cacheWrite5m: input,
      cacheWrite1h: input,
    };
  }
  if (model.provider === "mimo") {
    /*
     * Xiaomi prices a cache hit as its own column ("Input (cache hit)"), and it
     * sits far below the 0.25x this function falls back to:
     *
     *   Flash       0.0028 against 0.14   = 2%
     *   Pro         0.0036 against 0.435  = 0.83%
     *   UltraSpeed  0.036  against 4.35   = 0.83%
     *
     * The fallback was billing a Pro cache hit at $0.109 against a real
     * $0.0036 — 30x, charged to the reader on every cached token, on the
     * longest conversations because those are the ones that cache.
     *
     * The `pro` test mirrors `baseRate`'s exactly, which is what keeps the two
     * in step: any row billing Pro's input also bills Pro's cache ratio, and
     * `-ultraspeed` lands here too because its id contains `pro` — correctly,
     * since 0.036/4.35 is the same 0.83%.
     *
     * No published cache-WRITE rate, so writes cost plain input — the same
     * conservative reading the zhipu branch above takes.
     */
    const pm = model.providerModel.toLowerCase();
    return {
      input,
      output,
      cacheRead: input * (pm.includes("pro") ? 0.00828 : 0.02),
      cacheWrite: input,
      cacheWrite5m: input,
      cacheWrite1h: input,
    };
  }
  // Others: cached input is typically a fraction of full; writes carry no premium.
  return {
    input,
    output,
    cacheRead: input * 0.25,
    cacheWrite: input,
    cacheWrite5m: input,
    cacheWrite1h: input,
  };
}

/**
 * Flat server-tool fees (USD), on top of token usage.
 * Sources (2026-07): Anthropic $10/1k web searches; OpenAI $10/1k web search
 * calls ($25/1k on non-reasoning models);
 * xAI $5/1k web_search and $5/1k x_search; Meta $2.50/1k web_search queries
 * (2026-10). Google grounding is $14/1k queries
 * beyond the deployment's monthly free quota (SPEC §3.9): the chat route splits
 * a turn's grounded queries against that quota and passes only the BILLABLE
 * count here as `webSearchRequests` (`splitGroundingQueries`, tools/metering.ts),
 * so free queries stay free.
 *
 * Juno's own tool fees (a keyed engine's price, sandbox time) are NOT this:
 * they are separate `juno-tool:<id>` ledger rows, never passed as
 * `toolFeesUsd`, which would override the provider fee computed here.
 */
export function toolFeesUsd(
  provider: ModelInfo["provider"] | string,
  extras: ToolUsageExtras = {},
  /** OpenAI prices hosted search by model class; absent reads as a reasoning model. */
  model?: Pick<ModelInfo, "reasoning">
): number {
  if (extras.toolFeesUsd != null && extras.toolFeesUsd > 0) {
    return extras.toolFeesUsd;
  }
  const web = Math.max(0, extras.webSearchRequests ?? 0);
  const x = Math.max(0, extras.xSearchRequests ?? 0);
  if (!web && !x) return 0;

  switch (provider) {
    case "anthropic":
      // $10 / 1,000 searches
      return web * 0.01;
    case "openai":
      // Hosted web search on Responses (developers.openai.com/api/docs/pricing,
      // read 2026-10-04): $10 / 1k calls on reasoning models (search content
      // tokens billed as input, already in usage); $25 / 1k on the
      // non-reasoning gpt-4o / gpt-4.1 line (search content tokens free).
      return web * (model && !model.reasoning ? 0.025 : 0.01);
    case "xai":
      // Web Search + X Search: $5 / 1k each
      return web * 0.005 + x * 0.005;
    case "google":
      // Grounding with Google Search: $14 / 1k billable queries.
      return web * 0.014;
    case "meta":
      // Muse Spark `web_search` grounding: $2.50 / 1k search queries, on top
      // of tokens (dev.meta.ai/docs/pricing-rate-limits, read 2026-10-04).
      return web * 0.0025;
    case "zhipu":
      // Z.ai built-in Web Search: $0.01 per use (docs.z.ai pricing, 2026-10-04).
      return web * 0.01;
    case "mimo":
      // MiMo Web Search plugin: $5 / 1k calls overseas (mimo.mi.com web-search guide).
      return web * 0.005;
    case "qwen":
      // Model Studio web search, Singapore: $10 / 1k calls. Chat Completions
      // reports no count, so this only bills if one is ever reported.
      return web * 0.01;
    default:
      return 0;
  }
}

/**
 * Cache-hit price as a fraction of the base input rate, per Anthropic's
 * pricing table: 0.1x by default, but the newest models discount reads
 * further — Fable/Mythos 5.1 to 0.025x ($0.25 on $10) and Opus 5.5 to 0.05x
 * ($0.20 on $4). Writes keep the standard 1.25x / 2x everywhere.
 */
function anthropicCacheReadRatio(providerModel: string): number {
  const pm = providerModel.toLowerCase();
  if (/(fable|mythos)-5-1/.test(pm)) return 0.025;
  if (pm.includes("opus-5-5")) return 0.05;
  return 0.1;
}

/**
 * A lab's long-context surcharge: once one prompt crosses `threshold` input
 * tokens the WHOLE request bills at `inputMultiplier` (input and cache rates)
 * and `outputMultiplier`. `inclusive` says whether a prompt of exactly
 * `threshold` tokens is already in the higher band.
 *
 * Exported because it is the single source of truth for two readers: billing
 * (`longContextMultipliers` below) and the Code context-window selector, which
 * turns each surcharge into a selectable tier (src/lib/code-v2/context-tiers.ts).
 *
 *  - OpenAI GPT-6 Astra, Sol and Luna: more than 272K input tokens bills the
 *    full request at 2x input and cache rates and 1.5x output.
 *  - xAI, every Grok chat model: a prompt that REACHES 200K tokens bills every
 *    token in the request at the higher tier — 2x input, cached input and
 *    output alike ($4 / $1 / $12 against $2 / $0.50 / $6 on 4.7). xAI's
 *    model page lists the same doubled tier for 4.5, 4.3, the 4.20 ids and
 *    Build, not just 4.6/4.7.
 */
export interface LongContextPricing {
  threshold: number;
  inclusive: boolean;
  inputMultiplier: number;
  outputMultiplier: number;
}

export function longContextPricing(
  model: Pick<ModelInfo, "provider" | "providerModel" | "modality"> & Partial<Pick<ModelInfo, "id">>
): LongContextPricing | null {
  const official = officialRate({ id: model.id ?? `${model.provider}:${model.providerModel}` });
  if (official && official.longContext !== undefined) return official.longContext ? { ...official.longContext } : null;
  const pm = model.providerModel.toLowerCase();
  if (model.provider === "openai" && /gpt-6(?:\.\d+)?-(astra|sol|luna)/.test(pm)) {
    return { threshold: 272_000, inclusive: false, inputMultiplier: 2, outputMultiplier: 1.5 };
  }
  if (model.provider === "xai" && pm.startsWith("grok-") && model.modality === "chat") {
    return { threshold: 200_000, inclusive: true, inputMultiplier: 2, outputMultiplier: 2 };
  }
  return null;
}

/** Whole-request surcharge for this request's prompt size (see `longContextPricing`). */
function longContextMultipliers(model: ModelInfo, totalInput: number): { input: number; output: number } {
  const lc = longContextPricing(model);
  if (lc && (lc.inclusive ? totalInput >= lc.threshold : totalInput > lc.threshold)) {
    return { input: lc.inputMultiplier, output: lc.outputMultiplier };
  }
  return { input: 1, output: 1 };
}

/** Token-only cost (no tool fees). */
function tokenCostUsd(model: ModelInfo, u: RawUsage, fastMode: FastMode = false, at: Date | number = Date.now()): number {
  const n = normalizeUsage(model.provider, u);
  const r = tokenRate(model, fastMode, at);

  let writeCost = 0;
  if (n.cacheWrite5m > 0 || n.cacheWrite1h > 0) {
    writeCost = n.cacheWrite5m * r.cacheWrite5m + n.cacheWrite1h * r.cacheWrite1h;
  } else {
    // Unspecified TTL: Anthropic defaults to 1h rate (what we write);
    // everyone else uses cacheWrite.
    writeCost = n.cacheWrite * r.cacheWrite;
  }

  const { input: inputMultiplier, output: outputMultiplier } = longContextMultipliers(model, n.totalInput);
  const cost =
    ((n.freshInput * r.input + n.cacheRead * r.cacheRead + writeCost) * inputMultiplier +
      n.output * r.output * outputMultiplier) /
    1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * What a request sent through a provider's asynchronous Batch API costs, as a
 * fraction of the interactive price. Anthropic Message Batches, the OpenAI
 * Batch API and the Gemini Batch API all bill every token at 50% of standard.
 * `null` for a provider whose batch API Juno does not use, so a caller can
 * never apply a discount the provider did not give.
 */
export function batchPriceMultiplier(provider: ModelInfo["provider"] | string): number | null {
  switch (provider) {
    case "anthropic":
    case "openai":
    case "google":
      return 0.5;
    default:
      return null;
  }
}

/** Estimated USD cost of one generation (tokens + tool fees). */
export function estimateCostUsd(
  model: ModelInfo,
  u: RawUsage,
  fastMode: FastMode = false,
  extras: ToolUsageExtras = {},
  at: Date | number = Date.now()
): number {
  const tokens = tokenCostUsd(model, u, fastMode, at);
  const tools = toolFeesUsd(model.provider, extras, model);
  const cost = tokens + tools;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** Rough token estimate when a provider reports no usage: chars / 4. */
export function estimateTokensFromChars(chars: number | undefined): number {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/**
 * Billable token counts for one generation.
 *
 * Providers disagree on whether `completion_tokens` already includes reasoning
 * / thinking tokens. We never double-count: when the API reports a separate
 * reasoning total that exceeds completion, we lift output to that total; when
 * the API is silent we floor on streamed answer + reasoning characters so a
 * long thinking turn never bills as a short reply.
 */
export function resolveBillableTokens(opts: {
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Reasoning/thinking tokens when the provider reports them separately. */
  reasoningTokens?: number | null;
  /**
   * `total_tokens` when present — used as a cross-check so output can't fall
   * below total − input (some providers omit reasoning from completion_tokens).
   */
  totalTokens?: number | null;
  cacheRead?: number | null;
  promptChars?: number;
  /** Visible answer characters. */
  completionChars?: number;
  /** Streamed reasoning / thinking characters (summary or full). */
  reasoningChars?: number;
}): {
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
} {
  const cacheRead = Math.max(0, opts.cacheRead ?? 0);
  const charIn = estimateTokensFromChars(opts.promptChars);
  const charOut = estimateTokensFromChars((opts.completionChars ?? 0) + (opts.reasoningChars ?? 0));

  let prompt = Math.max(0, opts.promptTokens ?? 0);
  let completion = Math.max(0, opts.completionTokens ?? 0);
  const reasoning = Math.max(0, opts.reasoningTokens ?? 0);
  const total = Math.max(0, opts.totalTokens ?? 0);

  // No provider usage at all → char estimate.
  if (!opts.promptTokens && !opts.completionTokens && !opts.totalTokens) {
    return {
      promptTokens: charIn,
      completionTokens: charOut,
      cacheRead,
    };
  }

  if (!prompt) prompt = charIn;

  // Lift completion when:
  //  - reasoning was reported separately and is larger than completion (answer-only report)
  //  - total_tokens implies a higher output than completion_tokens alone
  //  - char floor exceeds reported completion (missing usage on thinking streams)
  if (reasoning > completion) completion = reasoning;
  if (total > 0 && prompt > 0) {
    const impliedOut = Math.max(0, total - prompt);
    if (impliedOut > completion) completion = impliedOut;
  }
  if (charOut > completion) completion = charOut;

  return { promptTokens: prompt, completionTokens: completion, cacheRead };
}

export type GenerationCostOpts = {
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  cacheWrite5m?: number | null;
  cacheWrite1h?: number | null;
  fastMode?: FastMode;
  promptChars?: number;
  completionChars?: number;
  reasoningChars?: number;
  webSearchRequests?: number | null;
  xSearchRequests?: number | null;
  toolFeesUsd?: number | null;
  /**
   * Served through the provider's asynchronous Batch API: tokens bill at
   * `batchPriceMultiplier` (50%). Ignored for a provider with no batch price,
   * so the flag can never invent a discount.
   */
  batch?: boolean;
};

/**
 * Single source of truth for "how much did this generation cost?".
 * Always prefers real provider usage, floors on streamed characters, applies
 * fast-mode / cache rates, and adds server-tool fees.
 */
export function estimateGenerationCostUsd(
  model: ModelInfo,
  opts: GenerationCostOpts
): {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheRead: number;
  toolFeesUsd: number;
} {
  const tokens = resolveBillableTokens(opts);
  const extras: ToolUsageExtras = {
    webSearchRequests: opts.webSearchRequests ?? undefined,
    xSearchRequests: opts.xSearchRequests ?? undefined,
    toolFeesUsd: opts.toolFeesUsd ?? undefined,
  };
  const fees = toolFeesUsd(model.provider, extras, model);
  const costUsd = estimateCostUsd(
    model,
    {
      input: tokens.promptTokens,
      output: tokens.completionTokens,
      cacheRead: tokens.cacheRead || undefined,
      cacheWrite: opts.cacheWrite ?? undefined,
      cacheWrite5m: opts.cacheWrite5m ?? undefined,
      cacheWrite1h: opts.cacheWrite1h ?? undefined,
    },
    opts.fastMode ?? false,
    extras
  );
  const batchMultiplier = opts.batch ? batchPriceMultiplier(model.provider) : null;
  // Tool fees are per call, not per token: the batch discount never applies to them.
  const billedUsd = batchMultiplier != null ? Math.max(0, (costUsd - fees) * batchMultiplier + fees) : costUsd;
  return {
    costUsd: billedUsd,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    cacheRead: tokens.cacheRead,
    toolFeesUsd: fees,
  };
}

/** Recompute ledger cost in micro-USD from stored token counts (repair path).
 *  `at` is when the row was spent: a scheduled price change must not reprice
 *  older rows, and the repair writes any higher figure back to the ledger. */
export function recomputeCostMicroUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  resolve: (id: string) => ModelInfo | null,
  at: Date | number = Date.now()
): number {
  const model = resolve(modelId);
  if (!model) {
    // Mid-tier fallback $2/$10 per MTok when the model id is gone.
    return Math.max(0, Math.round(promptTokens * 2 + completionTokens * 10));
  }
  const usd = estimateCostUsd(model, { input: promptTokens, output: completionTokens }, false, {}, at);
  return Math.max(0, Math.round(usd * 1_000_000));
}
