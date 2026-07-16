import type { ModelInfo } from "@/lib/models";

/**
 * Rough per-model token pricing so the app can show an estimated $ cost per
 * message. Rates are USD per 1,000,000 tokens and are approximate public list
 * prices — always shown to the user as an estimate ("~$0.01"), never as billing.
 */
export interface TokenRate {
  input: number;
  output: number;
  cacheRead: number; // cost of a cached-input token (read hit)
  cacheWrite: number; // cost of writing an input token into the cache
}

/** Raw usage as reported by a provider stream (conventions differ, see below). */
export interface RawUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Provider token conventions reconciled into one additive shape. */
export interface NormalizedUsage {
  totalInput: number; // full prompt size, cache included
  freshInput: number; // input billed at the full input rate
  cacheRead: number;
  cacheWrite: number;
  output: number;
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
  const cacheWrite = Math.max(0, u.cacheWrite ?? 0);
  const output = Math.max(0, u.output ?? 0);
  if (provider === "anthropic") {
    return { totalInput: input + cacheRead + cacheWrite, freshInput: input, cacheRead, cacheWrite, output };
  }
  // OpenAI-compatible: prompt_tokens already includes cacheRead.
  const freshInput = Math.max(0, input - cacheRead);
  return { totalInput: input, freshInput, cacheRead, cacheWrite, output };
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

/** Full rate incl. cache multipliers (Anthropic: read 0.1x / write 1.25x). */
export function tokenRate(model: ModelInfo): TokenRate {
  const { input, output } = baseRate(model);
  if (model.provider === "anthropic") {
    return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
  }
  if (model.provider === "zhipu") {
    // Z.ai bills GLM cached input at $0.26 vs $1.40 fresh (GLM-5.2) ≈ 0.186x;
    // cache storage is currently free, so writes cost the plain input rate.
    return { input, output, cacheRead: input * 0.186, cacheWrite: input };
  }
  if (model.provider === "openai" && model.providerModel.toLowerCase().includes("gpt-5.6")) {
    // GPT-5.6 family: 90% cached-input discount ($0.50/$0.25/$0.10 vs
    // $5/$2.50/$1); cache writes bill at 1.25x the uncached input rate.
    return { input, output, cacheRead: input * 0.1, cacheWrite: input * 1.25 };
  }
  // Others: cached input is typically a fraction of full; writes carry no premium.
  return { input, output, cacheRead: input * 0.25, cacheWrite: input };
}

/** Estimated USD cost of one generation. Returns 0 when usage is unknown. */
export function estimateCostUsd(model: ModelInfo, u: RawUsage): number {
  const n = normalizeUsage(model.provider, u);
  const r = tokenRate(model);
  const cost = (n.freshInput * r.input + n.cacheRead * r.cacheRead + n.cacheWrite * r.cacheWrite + n.output * r.output) / 1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}
