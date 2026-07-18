import type { ModelInfo } from "@/lib/models";

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
  let cacheWrite5m = Math.max(0, u.cacheWrite5m ?? 0);
  let cacheWrite1h = Math.max(0, u.cacheWrite1h ?? 0);
  let cacheWrite = Math.max(0, u.cacheWrite ?? 0);

  // If only the aggregate write is set, treat it as unspecified TTL.
  if (!cacheWrite5m && !cacheWrite1h && cacheWrite > 0) {
    // leave cacheWrite as-is; cost path picks default write rate
  } else if (cacheWrite5m || cacheWrite1h) {
    // Prefer the split; keep aggregate as sum for display.
    cacheWrite = cacheWrite5m + cacheWrite1h;
  }

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
function baseRate(model: ModelInfo): { input: number; output: number } {
  const pm = model.providerModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      if (pm.includes("fable") || pm.includes("mythos")) return { input: 10, output: 50 };
      if (pm.includes("opus-4-1")) return { input: 15, output: 75 }; // pre-4.5 Opus pricing
      if (pm.includes("opus")) return { input: 5, output: 25 };
      if (pm.includes("haiku")) return { input: 1, output: 5 };
      if (pm.includes("sonnet-5")) return { input: 2, output: 10 }; // intro pricing — $3/$15 from Sep 1 2026
      return { input: 3, output: 15 }; // sonnet-class
    case "openai":
      if (/^o\d/.test(pm) || pm.includes("-o1") || pm.includes("-o3")) return { input: 15, output: 60 };
      if (pm.includes("gpt-5.6-terra")) return { input: 2.5, output: 15 };
      if (pm.includes("gpt-5.6-luna")) return { input: 1, output: 6 };
      if (pm.includes("gpt-5.6")) return { input: 5, output: 30 }; // sol + bare alias
      if (pm.includes("gpt-5.5-pro") || pm.includes("gpt-5.4-pro")) return { input: 30, output: 180 };
      if (pm.includes("gpt-5.5")) return { input: 5, output: 30 };
      if (pm.includes("gpt-5.4-nano")) return { input: 0.2, output: 1.25 };
      if (pm.includes("gpt-5.4-mini")) return { input: 0.75, output: 4.5 };
      if (pm.includes("gpt-5.4")) return { input: 2.5, output: 15 };
      if (pm.includes("gpt-5.3-codex")) return { input: 1.75, output: 14 };
      if (pm.includes("gpt-5.2-pro")) return { input: 21, output: 168 };
      if (pm.includes("gpt-5.2")) return { input: 1.75, output: 14 };
      if (pm.includes("gpt-5.1-codex-mini")) return { input: 0.25, output: 2 };
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
      if (pm.includes("3.5-flash")) return { input: 1.5, output: 9 };
      if (pm.includes("pro")) return { input: 2, output: 12 };
      return { input: 0.3, output: 2.5 }; // older flash-class
    case "meta": // Llama API shut down 2026-07-06 — kept for straggler cost display
      if (pm.includes("maverick")) return { input: 0.35, output: 0.85 };
      if (pm.includes("scout")) return { input: 0.17, output: 0.66 };
      return { input: 0.35, output: 0.85 };
    case "deepseek":
      // NOTE mid-July 2026: V4 goes official with 2x peak-hour pricing
      // (09:00-12:00 / 14:00-18:00 Beijing) — revisit when announced.
      if (pm.includes("v4-pro")) return { input: 0.435, output: 0.87 };
      return { input: 0.14, output: 0.28 }; // v4-flash + retiring aliases
    case "zhipu":
      if (pm.includes("flash") || pm.includes("air")) return { input: 0.1, output: 0.1 };
      if (pm.includes("glm-5.2")) return { input: 1.4, output: 4.4 }; // docs.z.ai/guides/overview/pricing
      if (pm.includes("turbo")) return { input: 1.2, output: 4.0 };
      return { input: 0.6, output: 2.2 };
    case "moonshot":
      if (pm.includes("k2.")) return { input: 0.95, output: 4 };
      return { input: 0.6, output: 2.5 };
    case "mistral":
      if (pm.includes("medium")) return { input: 1.5, output: 7.5 };
      if (pm.includes("large")) return { input: 0.5, output: 1.5 };
      if (pm.includes("small")) return { input: 0.15, output: 0.6 };
      if (pm.includes("ministral")) return { input: 0.15, output: 0.15 };
      if (pm.includes("codestral")) return { input: 0.3, output: 0.9 };
      return { input: 0.5, output: 2.2 };
    case "xai":
      if (pm.includes("grok-4.5")) return { input: 2, output: 6 };
      if (pm.includes("grok-4.3")) return { input: 1.25, output: 2.5 };
      if (pm.includes("grok-build")) return { input: 1, output: 2 };
      return { input: 2, output: 6 };
    case "minimax":
      return { input: 0.3, output: 1.2 };
    case "mimo":
      if (pm.includes("pro")) return { input: 0.435, output: 0.87 };
      return { input: 0.2, output: 0.8 };
    case "qwen":
      if (pm.includes("qwen3.7-max")) return { input: 2.5, output: 7.5 };
      if (pm.includes("qwen3.7-plus")) return { input: 0.4, output: 1.6 };
      if (pm.includes("flash")) return { input: 0.19, output: 1.13 };
      return { input: 0.4, output: 1.2 };
    case "longcat":
      return { input: 0.75, output: 2.95 }; // standard rate (launch promo $0.30/$1.20)
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
 *    only — 4.7's fast mode is deprecated (removed 2026-07-24) and 4.6/other
 *    models error or silently run standard. Docs price it 2x ($10/$50 vs $5/$25).
 *  - OpenAI priority (`service_tier:"priority"`): the 5.6/5.5/5.4 chat tiers.
 *    5.5 is 2.5x, the rest 2x. The -pro line, 5.1 and 4o are NOT priority-eligible.
 *
 * Keep in sync with supportsFastMode(); both are the single source of truth for
 * which models show the "Fast" toggle and how the premium is billed.
 */
export function fastModeMultiplier(model: ModelInfo): number | null {
  const pm = model.providerModel.toLowerCase();
  if (model.provider === "anthropic") return pm.includes("opus-4-8") ? 2 : null;
  if (model.provider === "openai") {
    if (pm.includes("-pro")) return null; // pro tiers aren't priority-eligible
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
 * Full rate incl. cache multipliers.
 * Anthropic: read 0.1×, 5m write 1.25×, 1h write 2×.
 * Juno always writes Anthropic system prefixes with ttl:"1h", so the default
 * `cacheWrite` for Anthropic is the **1h** rate (2×).
 * `fastMode` scales base input/output (and derived cache rates).
 */
export function tokenRate(model: ModelInfo, fastMode = false): TokenRate {
  const raw = baseRate(model);
  const mult = fastMode ? fastModeMultiplier(model) ?? 1 : 1;
  const input = raw.input * mult;
  const output = raw.output * mult;
  if (model.provider === "anthropic") {
    return {
      input,
      output,
      cacheRead: input * 0.1,
      cacheWrite: input * 2, // default = 1h (what we actually write)
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 2,
    };
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
  if (model.provider === "openai" && model.providerModel.toLowerCase().includes("gpt-5.6")) {
    // GPT-5.6 family: 90% cached-input discount; cache writes 1.25× uncached.
    return {
      input,
      output,
      cacheRead: input * 0.1,
      cacheWrite: input * 1.25,
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 1.25,
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
 * Sources (2026-07): Anthropic $10/1k web searches; OpenAI $10/1k web search;
 * xAI $5/1k web_search and $5/1k x_search. Google grounding is token-only.
 */
export function toolFeesUsd(
  provider: ModelInfo["provider"] | string,
  extras: ToolUsageExtras = {}
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
      // Built-in web search on Responses: $10 / 1k calls
      return web * 0.01;
    case "xai":
      // Web Search + X Search: $5 / 1k each
      return web * 0.005 + x * 0.005;
    default:
      return 0;
  }
}

/** Token-only cost (no tool fees). */
function tokenCostUsd(model: ModelInfo, u: RawUsage, fastMode = false): number {
  const n = normalizeUsage(model.provider, u);
  const r = tokenRate(model, fastMode);

  let writeCost = 0;
  if (n.cacheWrite5m > 0 || n.cacheWrite1h > 0) {
    writeCost = n.cacheWrite5m * r.cacheWrite5m + n.cacheWrite1h * r.cacheWrite1h;
  } else {
    // Unspecified TTL: Anthropic defaults to 1h rate (what we write);
    // everyone else uses cacheWrite.
    writeCost = n.cacheWrite * r.cacheWrite;
  }

  const cost =
    (n.freshInput * r.input + n.cacheRead * r.cacheRead + writeCost + n.output * r.output) / 1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/** Estimated USD cost of one generation (tokens + tool fees). */
export function estimateCostUsd(
  model: ModelInfo,
  u: RawUsage,
  fastMode = false,
  extras: ToolUsageExtras = {}
): number {
  const tokens = tokenCostUsd(model, u, fastMode);
  const tools = toolFeesUsd(model.provider, extras);
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
  fastMode?: boolean;
  promptChars?: number;
  completionChars?: number;
  reasoningChars?: number;
  webSearchRequests?: number | null;
  xSearchRequests?: number | null;
  toolFeesUsd?: number | null;
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
  const fees = toolFeesUsd(model.provider, extras);
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
    !!opts.fastMode,
    extras
  );
  return {
    costUsd,
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    cacheRead: tokens.cacheRead,
    toolFeesUsd: fees,
  };
}

/** Recompute ledger cost in micro-USD from stored token counts (repair path). */
export function recomputeCostMicroUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  resolve: (id: string) => ModelInfo | null
): number {
  const model = resolve(modelId);
  if (!model) {
    // Mid-tier fallback $2/$10 per MTok when the model id is gone.
    return Math.max(0, Math.round(promptTokens * 2 + completionTokens * 10));
  }
  const usd = estimateCostUsd(model, { input: promptTokens, output: completionTokens });
  return Math.max(0, Math.round(usd * 1_000_000));
}
