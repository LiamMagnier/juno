/**
 * What `/api/agent/[...path]` decides before it forwards a Code engine call
 * (Alevr Code v2 SPEC §2 BYOK, §4 context tiers). Pure, so every branch is
 * tested without a database or a provider.
 *
 * Two request headers, both optional, so every client that predates them
 * keeps today's behaviour exactly:
 *
 *  - `x-alevr-context-tokens: <n>` — the context tier the run chose (a
 *    `ContextTier.tokens` from the catalogue). Validated against the model's
 *    tiers; a prompt that does not fit is refused with 413 so the client
 *    compacts instead of silently crossing into a pricier band.
 *  - `x-alevr-billing: auto | alevr | byok` — whose key pays. `auto` (the
 *    default) uses the user's own key when they stored a working one for that
 *    lab, and Alevr's otherwise; `alevr` always uses Alevr's; `byok` requires
 *    the user's key and refuses rather than fall back to spending Alevr's.
 *
 * A call on the user's key is never written to ApiSpend and never checked
 * against the plan, the month's budget or the usage windows: Alevr is not
 * paying for it. It is still rate limited, and its usage is recorded in
 * ProviderKeyUsage for the user's own analytics.
 */
import type { ModelInfo } from "@/lib/models";
import { estimateGenerationCostUsd, normalizeUsage } from "@/lib/pricing";
import { isByokProvider, type ByokProvider } from "@/lib/code-v2/contracts";
import { defaultTierFor, fitsTier, formatContextTokens, priceDelta, validateContextTier, type ContextTier } from "@/lib/code-v2/context-tiers";

export const CONTEXT_TIER_HEADER = "x-alevr-context-tokens";
export const BILLING_HEADER = "x-alevr-billing";
/** Response header naming whose key served the call: "alevr" | "byok". */
export const KEY_SOURCE_HEADER = "x-alevr-key-source";

export type BillingPreference = "auto" | "alevr" | "byok";

export type Refusal = { ok: false; status: number; body: { error: string; code: string; [k: string]: unknown } };

export function parseBillingPreference(raw: string | null): BillingPreference | null {
  if (raw === null || raw.trim() === "") return "auto";
  const v = raw.trim().toLowerCase();
  return v === "auto" || v === "alevr" || v === "byok" ? v : null;
}

export type KeySourceDecision = { ok: true; source: "alevr" } | { ok: true; source: "byok"; provider: ByokProvider } | Refusal;

/** Whose key serves this call. `hasUserKey` = the user stored a working key for `provider`. */
export function chooseKeySource(input: { preference: BillingPreference; provider: string; hasUserKey: boolean }): KeySourceDecision {
  const { preference, provider, hasUserKey } = input;
  if (preference === "alevr") return { ok: true, source: "alevr" };
  if (!isByokProvider(provider)) {
    if (preference === "byok") {
      return { ok: false, status: 400, body: { error: "Your own key can't be used with this provider yet.", code: "BYOK_UNSUPPORTED_PROVIDER" } };
    }
    return { ok: true, source: "alevr" };
  }
  if (hasUserKey) return { ok: true, source: "byok", provider };
  if (preference === "byok") {
    return {
      ok: false,
      status: 409,
      body: { error: "No working API key is connected for this provider. Add one in Settings → Connections.", code: "BYOK_KEY_MISSING", provider },
    };
  }
  return { ok: true, source: "alevr" };
}

/** `undefined` = header absent; `null` = present but not a positive integer. */
export function parseContextTierHeader(raw: string | null): number | undefined | null {
  if (raw === null || raw.trim() === "") return undefined;
  const v = raw.trim();
  if (!/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
}

export type TierDecision =
  | {
      ok: true;
      /** Null when no tier was requested: the proxy behaves exactly as before. */
      tier: ContextTier | null;
      /** The requested tier's price over the default tier's, for the output cap. */
      inputMultiplier: number;
      outputMultiplier: number;
    }
  | Refusal;

/**
 * Validate a requested tier against the catalogue and the prompt's size.
 * `promptChars` is the request's text length; at four characters a token it
 * is a floor on the prompt (code tokenizes denser), so a 413 here is never a
 * false alarm on a prompt that really fits.
 */
export function checkRequestedTier(input: {
  model: ModelInfo | null;
  requested: number | undefined | null;
  promptChars: number;
  at?: Date | number;
}): TierDecision {
  const { model, requested, promptChars } = input;
  if (requested === undefined) return { ok: true, tier: null, inputMultiplier: 1, outputMultiplier: 1 };
  if (requested === null) {
    return { ok: false, status: 400, body: { error: "The context tier must be a positive whole number of tokens.", code: "CONTEXT_TIER_INVALID" } };
  }
  if (!model) {
    return { ok: false, status: 400, body: { error: "This model isn't in the catalogue, so it has no context tiers.", code: "CONTEXT_TIER_UNKNOWN_MODEL" } };
  }
  const v = validateContextTier(model, requested, input.at);
  if (!v.ok) {
    return { ok: false, status: 400, body: { error: v.error, code: "CONTEXT_TIER_UNAVAILABLE", tiers: v.tiers } };
  }
  const promptTokens = Math.ceil(Math.max(0, promptChars) / 4);
  if (!fitsTier(promptTokens, v.tier)) {
    return {
      ok: false,
      status: 413,
      body: {
        error: `This thread is larger than the ${formatContextTokens(v.tier.tokens)} context you chose. Compact it or pick a larger window.`,
        code: "CONTEXT_TIER_EXCEEDED",
        tierTokens: v.tier.tokens,
        promptTokensAtLeast: promptTokens,
      },
    };
  }
  const delta = priceDelta(v.tier, defaultTierFor(model, input.at));
  return { ok: true, tier: v.tier, inputMultiplier: delta.inputMultiplier, outputMultiplier: delta.outputMultiplier };
}

/** Per-token rates (micro-USD) scaled to the chosen tier, for `affordableOutputTokens`. */
export function tierScaledRates(
  rates: { input: number; output: number },
  decision: { inputMultiplier: number; outputMultiplier: number },
): { input: number; output: number } {
  return { input: rates.input * decision.inputMultiplier, output: rates.output * decision.outputMultiplier };
}

/** What a BYOK call adds to the user's analytics, priced at list (an estimate, never a charge). */
export function byokUsageFromMeter(
  model: ModelInfo | null,
  provider: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    reasoningTokens?: number;
    totalTokens?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    webSearchRequests?: number;
    promptChars?: number;
    completionChars?: number;
    reasoningChars?: number;
    fastMode: boolean;
  },
): { inputTokens: number; outputTokens: number; cachedTokens: number; estCostMicroUsd: number } {
  if (!model) {
    const n = normalizeUsage(provider, { input: usage.promptTokens, output: usage.completionTokens, cacheRead: usage.cacheRead });
    return { inputTokens: n.totalInput, outputTokens: n.output, cachedTokens: n.cacheRead, estCostMicroUsd: 0 };
  }
  const billed = estimateGenerationCostUsd(model, usage);
  const n = normalizeUsage(model.provider, {
    input: billed.promptTokens,
    output: billed.completionTokens,
    cacheRead: billed.cacheRead,
    cacheWrite: usage.cacheWrite,
    cacheWrite5m: usage.cacheWrite5m,
    cacheWrite1h: usage.cacheWrite1h,
  });
  return {
    inputTokens: n.totalInput,
    outputTokens: n.output,
    cachedTokens: n.cacheRead,
    estCostMicroUsd: Math.round(billed.costUsd * 1_000_000),
  };
}
