/**
 * OpenRouter on the user's own key (SPEC §2 BYOK): one OpenAI-compatible
 * endpoint in front of many labs, billed to the user's OpenRouter account and
 * never to Alevr. This is the pure half: reading OpenRouter's public model
 * list into picker rows, and which lab's mark a model wears.
 *
 * Model ids are `openrouter:<openrouter slug>` ("openrouter:anthropic/claude-
 * sonnet-4.5"). The agent proxy strips nothing: the engine sends the slug as
 * the request's `model` to /api/agent/openrouter/chat/completions.
 */
import { PROVIDERS, type Provider } from "@/lib/providers";
import type { ContextTier, ProviderModel } from "./contracts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** OpenRouter's model row (the fields read here). Prices are USD per token, as strings. */
export interface OpenRouterModelRow {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
}

/** OpenRouter's org slug → the lab mark Alevr draws. */
const ORG_TO_LAB: Record<string, Provider> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  "x-ai": "xai",
  deepseek: "deepseek",
  "meta-llama": "meta",
  mistralai: "mistral",
  qwen: "qwen",
  moonshotai: "moonshot",
  "z-ai": "zhipu",
  minimax: "minimax",
};

/** The lab behind an OpenRouter slug ("anthropic/claude-…" → anthropic), or null. */
export function openRouterLab(slug: string): Provider | null {
  const org = slug.split("/")[0]?.toLowerCase() ?? "";
  const lab = ORG_TO_LAB[org];
  return lab && lab in PROVIDERS ? lab : null;
}

function perMTok(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : null;
}

function tokensLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

/**
 * The rows the picker offers: text models that take tools (an agent needs
 * them), with a known price, most capable labs first then by name. `limit`
 * keeps the picker a picker; search still finds the rest by id.
 */
export function openRouterPickerModels(rows: readonly OpenRouterModelRow[], limit = 200): ProviderModel[] {
  const out: { model: ProviderModel; rank: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !r.id.includes("/") || seen.has(r.id)) continue;
    if (!(r.supported_parameters ?? []).includes("tools")) continue;
    const outputs = r.architecture?.output_modalities;
    if (outputs && !outputs.includes("text")) continue;
    const input = perMTok(r.pricing?.prompt);
    const output = perMTok(r.pricing?.completion);
    if (input === null || output === null || input < 0) continue;
    seen.add(r.id);
    const tokens = typeof r.context_length === "number" && r.context_length > 0 ? r.context_length : undefined;
    const cached = perMTok(r.pricing?.input_cache_read);
    const tier: ContextTier | undefined = tokens
      ? { tokens, label: tokensLabel(tokens), inputPerMTok: input, outputPerMTok: output, ...(cached !== null ? { cachedInputPerMTok: cached } : {}) }
      : undefined;
    const lab = openRouterLab(r.id);
    out.push({
      model: { id: `openrouter:${r.id}`, label: (r.name ?? r.id).replace(/^[^:]+:\s*/, ""), ...(tier ? { contextTiers: [tier] } : {}) },
      rank: lab === "anthropic" || lab === "openai" || lab === "google" ? 0 : lab ? 1 : 2,
    });
  }
  out.sort((a, b) => a.rank - b.rank || a.model.label.localeCompare(b.model.label));
  return out.slice(0, limit).map(({ model }, i) => (i === 0 ? { ...model, isDefault: true } : model));
}
