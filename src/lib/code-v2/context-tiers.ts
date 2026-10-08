/**
 * Context-window tiers (Code v2 SPEC §4).
 *
 * A tier is one selectable context window with the price it bills at. Nothing
 * here holds a rate of its own: every number is read from `pricing.ts`
 * (`tokenRate` for the base rate, `longContextPricing` for the surcharge a lab
 * applies once a prompt crosses a size), and every window from the curated
 * catalogue (`ModelInfo.contextWindow`, docs/models-*.md). A lab's long-context
 * surcharge therefore becomes two tiers — the window below the threshold at
 * the standard rate, and the full window at the surcharged rate — and a model
 * without one has exactly one tier.
 *
 * Where the catalogue knows a lab prices long prompts higher but has never
 * recorded the band, the tier carries `unverified: true` and says so in its
 * note instead of implying the shown rate holds for the whole window. Windows
 * are never invented: a model with no curated `contextWindow` gets the metrics
 * fallback, marked unverified.
 */
import type { ModelInfo } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";
import { longContextPricing, tokenRate } from "@/lib/pricing";
import { estimateTierCostUsd, pickContextTier, type ContextTier } from "@/lib/code-v2/contracts";

export type { ContextTier };

const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

function trimNumber(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** "272K", "1M" (1,000,000 or 1,048,576), "1.05M", "256K" (262,144). */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
    return `${trimNumber(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    if (tokens % 1_000 === 0) return `${tokens / 1_000}K`;
    if (tokens % 1_024 === 0) return `${tokens / 1_024}K`;
    return `${trimNumber(tokens / 1_000)}K`;
  }
  return String(tokens);
}

function multiplierText(n: number): string {
  return `${trimNumber(n)}×`;
}

/**
 * Labs the catalogue knows bill long prompts above the rate it records, without
 * the band being recorded. Kept narrow and sourced from pricing.ts's own notes:
 *  - Gemini Pro: pricing.ts quotes the "≤200K prompts" rate.
 *  - Qwen (Model Studio): "tiered models quote their lowest input tier".
 *  - MiniMax M3: "$0.30/$1.20 ≤512K input".
 */
function unverifiedAbove(model: Pick<ModelInfo, "provider" | "providerModel">): { above: number | null; note: string } | null {
  const pm = model.providerModel.toLowerCase();
  if (model.provider === "google" && /gemini-[\d.]+-pro/.test(pm)) {
    return { above: 200_000, note: "Rate above 200K not confirmed" };
  }
  if (model.provider === "qwen" && /qwen3\.[5-9]-(max|plus|flash)/.test(pm)) {
    return { above: null, note: "Tiered by prompt size; lowest tier shown" };
  }
  if (model.provider === "minimax" && pm.includes("minimax-m3")) {
    return { above: 512_000, note: "Rate above 512K not confirmed" };
  }
  return null;
}

/**
 * The selectable windows for a model, smallest first. The LAST tier is the
 * model's full window; the FIRST is its default (the cheapest band), which is
 * what `contextWindow` consumers that predate tiers should keep reading.
 */
export function tiersFor(model: ModelInfo, at: Date | number = Date.now()): ContextTier[] {
  if (model.contextTiers && model.contextTiers.length > 0) {
    return [...model.contextTiers].sort((a, b) => a.tokens - b.tokens);
  }
  const knownWindow = model.contextWindow;
  const window = knownWindow ?? getModelMetrics(model, at).contextTokens;
  const rate = tokenRate(model, false, at);
  const base = {
    inputPerMTok: round(rate.input),
    outputPerMTok: round(rate.output),
    cachedInputPerMTok: round(rate.cacheRead),
  };
  const lc = longContextPricing(model);
  const vague = unverifiedAbove(model);
  const tiers: ContextTier[] = [];

  if (lc && window > lc.threshold) {
    tiers.push({ tokens: lc.threshold, label: formatContextTokens(lc.threshold), ...base });
    const parts = [`${multiplierText(lc.inputMultiplier)} input`];
    if (lc.outputMultiplier !== 1) parts.push(`${multiplierText(lc.outputMultiplier)} output`);
    tiers.push({
      tokens: window,
      label: formatContextTokens(window),
      inputPerMTok: round(rate.input * lc.inputMultiplier),
      outputPerMTok: round(rate.output * lc.outputMultiplier),
      cachedInputPerMTok: round(rate.cacheRead * lc.inputMultiplier),
      note: `${parts.join(", ")} above ${formatContextTokens(lc.threshold)}`,
    });
  } else {
    const tier: ContextTier = { tokens: window, label: formatContextTokens(window), ...base };
    if (vague && (vague.above === null || window > vague.above)) {
      tier.unverified = true;
      tier.note = vague.note;
    }
    tiers.push(tier);
  }

  if (!knownWindow) {
    const last = tiers[tiers.length - 1];
    last.unverified = true;
    last.note = last.note ? `${last.note}; window not confirmed` : "Window not confirmed";
  }
  return tiers;
}

/** The default tier: the cheapest band (first). */
export function defaultTierFor(model: ModelInfo, at: Date | number = Date.now()): ContextTier {
  return tiersFor(model, at)[0];
}

/** A model with its tiers attached — the shape catalogue payloads send. */
export function withContextTiers<T extends ModelInfo>(model: T, at: Date | number = Date.now()): T & { contextTiers: ContextTier[] } {
  return { ...model, contextTiers: tiersFor(model, at) };
}

export interface PriceDelta {
  inputMultiplier: number;
  outputMultiplier: number;
  cachedInputMultiplier: number;
  /** "Same price", or "2× input, 1.5× output". */
  label: string;
}

/** How `tier` is priced against `base` (normally the default tier). */
export function priceDelta(tier: ContextTier, base: ContextTier): PriceDelta {
  const ratio = (a: number, b: number) => (b > 0 ? round(a / b) : 1);
  const inputMultiplier = ratio(tier.inputPerMTok, base.inputPerMTok);
  const outputMultiplier = ratio(tier.outputPerMTok, base.outputPerMTok);
  const cachedInputMultiplier = ratio(
    tier.cachedInputPerMTok ?? tier.inputPerMTok,
    base.cachedInputPerMTok ?? base.inputPerMTok,
  );
  const parts: string[] = [];
  if (inputMultiplier !== 1) parts.push(`${multiplierText(inputMultiplier)} input`);
  if (outputMultiplier !== 1) parts.push(`${multiplierText(outputMultiplier)} output`);
  return { inputMultiplier, outputMultiplier, cachedInputMultiplier, label: parts.length ? parts.join(", ") : "Same price" };
}

export interface EstimateCostOptions {
  /** Every tier of the model: lets a small prompt on a large tier bill at the band it actually falls in. */
  tiers?: readonly ContextTier[];
  /** Expected output tokens for the turn (default 0: the cost of sending the thread). */
  outputTokens?: number;
  /** How much of the thread is a prompt-cache hit. */
  cachedInputTokens?: number;
}

/**
 * USD to send a thread of `threadTokens` once on `tier` (plus `outputTokens`),
 * or null when the thread does not fit the tier's window.
 *
 * A lab bills the band the PROMPT falls in, not the window chosen: a 100K
 * thread on GPT-6's 1M tier costs the standard rate. Pass `tiers` and the
 * estimate follows that rule; without it the tier's own rate is used.
 */
export function estimateCost(threadTokens: number, tier: ContextTier, options: EstimateCostOptions = {}): number | null {
  const input = Math.max(0, Math.ceil(threadTokens));
  if (input > tier.tokens) return null;
  let band = tier;
  if (options.tiers && options.tiers.length > 0) {
    const fit = pickContextTier(options.tiers, input);
    if (fit && fit.tokens <= tier.tokens) band = fit;
  }
  const cached = Math.min(input, Math.max(0, options.cachedInputTokens ?? 0));
  return round(estimateTierCostUsd(band, { input, output: Math.max(0, options.outputTokens ?? 0), cachedInput: cached }));
}

export type TierValidation =
  | { ok: true; tier: ContextTier; tiers: ContextTier[] }
  | { ok: false; error: string; tiers: ContextTier[] };

/**
 * Whether `tokens` names one of the model's tiers exactly. Absent = the
 * default tier. Anything else is refused rather than rounded: a client that
 * asks for a window the catalogue does not offer has a stale catalogue.
 */
export function validateContextTier(model: ModelInfo, tokens: number | null | undefined, at: Date | number = Date.now()): TierValidation {
  const tiers = tiersFor(model, at);
  if (tokens === null || tokens === undefined) return { ok: true, tier: tiers[0], tiers };
  if (!Number.isInteger(tokens) || tokens <= 0) return { ok: false, error: "Context tier must be a positive integer.", tiers };
  const tier = tiers.find((t) => t.tokens === tokens);
  if (!tier) {
    return {
      ok: false,
      error: `${model.name} offers ${tiers.map((t) => t.label).join(" or ")} context, not ${formatContextTokens(tokens)}.`,
      tiers,
    };
  }
  return { ok: true, tier, tiers };
}

/** Whether a prompt of `promptTokens` fits `tier` (the proxy's guard). */
export function fitsTier(promptTokens: number, tier: ContextTier): boolean {
  return promptTokens <= tier.tokens;
}
