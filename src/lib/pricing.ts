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

function baseRate(model: ModelInfo): { input: number; output: number } {
  const pm = model.providerModel.toLowerCase();
  switch (model.provider) {
    case "anthropic":
      if (pm.includes("opus")) return { input: 15, output: 75 };
      if (pm.includes("haiku")) return { input: 0.8, output: 4 };
      return { input: 3, output: 15 }; // sonnet-class
    case "openai":
      if (/^o\d/.test(pm) || pm.includes("-o1") || pm.includes("-o3")) return { input: 15, output: 60 };
      if (pm.includes("nano")) return { input: 0.1, output: 0.4 };
      if (pm.includes("mini")) return { input: 0.25, output: 2 };
      if (pm.includes("gpt-5")) return { input: 1.25, output: 10 };
      if (pm.includes("gpt-4.1")) return { input: 2, output: 8 };
      if (pm.includes("gpt-4o")) return { input: 2.5, output: 10 };
      return { input: 2.5, output: 10 };
    case "google":
      if (pm.includes("pro")) return { input: 1.25, output: 10 };
      return { input: 0.3, output: 2.5 }; // flash-class
    case "meta":
      if (pm.includes("max")) return { input: 3, output: 12 };
      if (pm.includes("flash")) return { input: 0.2, output: 0.8 };
      return { input: 0.8, output: 3 }; // muse-spark
    case "deepseek":
      if (pm.includes("reason")) return { input: 0.55, output: 2.19 };
      return { input: 0.27, output: 1.1 };
    case "zhipu":
      if (pm.includes("flash") || pm.includes("air")) return { input: 0.1, output: 0.1 };
      return { input: 0.6, output: 2.2 };
    case "moonshot":
      return { input: 0.6, output: 2.5 };
    case "mistral":
      if (pm.includes("large")) return { input: 2, output: 6 };
      return { input: 0.2, output: 0.6 };
    case "xai":
      return { input: 3, output: 15 };
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
