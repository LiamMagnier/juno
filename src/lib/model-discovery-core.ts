/**
 * Pure, environment-agnostic parts of live model discovery — shared by the
 * server route (model-discovery.ts, which adds "server-only" + caching) and
 * the sync CLI (scripts/sync-models.ts). Keep this module free of Next.js /
 * server-only imports so scripts can run it under tsx.
 */
import type { Plan } from "@prisma/client";
import { providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";
import { MODELS, prettifyModelName, guessVision, guessPlan, guessReasoning, guessCost, providerSupportsWebSearch, type ModelInfo } from "@/lib/models";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 2500;

// Models that aren't general chat models, or that we never want to surface.
export const JUNK_RE =
  /(robot|antigravity|embed|tts|whisper|audio|speech|dall|image|imagen|veo|video|moderation|rerank|guard|safety|aqa|tuning|learnlm|gemma|banana|live|realtime|computer-use|vision-?only|ocr|distill|deprecat|legacy|^ada|babbage|davinci|curie|sora|moderation)/i;

export interface Family {
  label: string;
  match: RegExp;
  minPlan: Plan;
  vision: boolean;
}

// Curated "families" per provider. From the provider's real API list we keep
// only the latest model in each family, so the picker shows clean, current
// models instead of every dated snapshot and old version.
export const FAMILIES: Partial<Record<Provider, Family[]>> = {
  anthropic: [
    { label: "Claude Fable", match: /fable/i, minPlan: "PRO", vision: true },
    { label: "Claude Mythos", match: /mythos/i, minPlan: "PRO", vision: true },
    { label: "Claude Opus", match: /opus/i, minPlan: "PRO", vision: true },
    { label: "Claude Sonnet", match: /sonnet/i, minPlan: "FREE", vision: true },
    { label: "Claude Haiku", match: /haiku/i, minPlan: "FREE", vision: true },
  ],
  openai: [
    { label: "GPT-5.5 Pro", match: /^gpt-5\.5-pro/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.5", match: /^gpt-5\.5(?!-)/i, minPlan: "PRO", vision: true },
    { label: "GPT-5.4 Mini", match: /^gpt-5\.4-mini/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.4 Nano", match: /^gpt-5\.4-nano/i, minPlan: "FREE", vision: true },
    { label: "GPT-5.4", match: /^gpt-5\.4(?!-)/i, minPlan: "PRO", vision: true },
  ],
  google: [
    { label: "Gemini Flash-Lite", match: /gemini-[\d.]+-flash-lite/i, minPlan: "FREE", vision: true },
    { label: "Gemini Flash", match: /gemini-[\d.]+-flash(?!-lite)/i, minPlan: "FREE", vision: true },
    { label: "Gemini Pro", match: /gemini-[\d.]+-pro/i, minPlan: "PRO", vision: true },
  ],
  zhipu: [
    { label: "GLM Flash", match: /glm-[\d.]+-flash/i, minPlan: "FREE", vision: false },
    { label: "GLM Turbo", match: /^glm-[\d.]+-turbo$/i, minPlan: "PRO", vision: false },
    { label: "GLM Vision", match: /^glm-[\d.]+v(-turbo)?$/i, minPlan: "PRO", vision: true },
    { label: "GLM", match: /^glm-[\d.]+(?:-0\d+)?$/i, minPlan: "PRO", vision: false },
  ],
  moonshot: [
    { label: "Kimi Code High-Speed", match: /kimi-k[\d.]+-code-highspeed/i, minPlan: "PRO", vision: false },
    { label: "Kimi Code", match: /kimi-k[\d.]+-code(?!-)/i, minPlan: "PRO", vision: false },
    { label: "Kimi", match: /^kimi-k[\d.]+$/i, minPlan: "PRO", vision: true },
    { label: "Moonshot v1", match: /^moonshot-v1-(8k|32k|128k)$/i, minPlan: "FREE", vision: false },
  ],
  deepseek: [
    { label: "DeepSeek V4 Pro", match: /deepseek-v4-pro/i, minPlan: "PRO", vision: false },
    { label: "DeepSeek V4 Flash", match: /deepseek-v4-flash/i, minPlan: "FREE", vision: false },
  ],
  mistral: [
    { label: "Mistral Medium", match: /^mistral-medium/i, minPlan: "PRO", vision: true },
    { label: "Mistral Large", match: /^mistral-large/i, minPlan: "PRO", vision: true },
    { label: "Mistral Small", match: /^mistral-small/i, minPlan: "FREE", vision: true },
    { label: "Codestral", match: /^codestral(?!.*embed)/i, minPlan: "PRO", vision: false },
    { label: "Ministral", match: /^ministral-14b/i, minPlan: "FREE", vision: false },
  ],
  xai: [
    { label: "Grok 4.3", match: /^grok-4\.3/i, minPlan: "PRO", vision: true },
    { label: "Grok Build", match: /^grok-build/i, minPlan: "PRO", vision: true },
    { label: "Grok Multi-Agent", match: /multi-agent/i, minPlan: "PRO", vision: true },
  ],
  minimax: [
    { label: "MiniMax M3", match: /^minimax-m3$/i, minPlan: "PRO", vision: true },
    { label: "MiniMax Highspeed", match: /^minimax-m[\d.]+-highspeed$/i, minPlan: "FREE", vision: false },
  ],
  mimo: [
    { label: "MiMo V2.5 Pro", match: /^mimo-v2\.5-pro$/i, minPlan: "PRO", vision: true },
    { label: "MiMo Flash", match: /^mimo-v[\d.]+-flash$/i, minPlan: "FREE", vision: false },
  ],
};

export const stripPrefix = (id: string) => id.replace(/^models\//i, "");

async function fetchModelList(provider: Provider, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${provider} models ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Raw model-id list from the provider's live API (Anthropic uses its native
 *  endpoint; everyone else is OpenAI-compatible GET /models). Throws on
 *  missing key, HTTP error, or timeout — callers decide how to degrade. */
export async function fetchProviderModelIds(provider: Provider, timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<string[]> {
  const key = providerApiKey(provider);
  if (!key) throw new Error(`${provider}: API key not configured`);

  if (provider === "anthropic") {
    const data = (await fetchModelList(provider, "https://api.anthropic.com/v1/models?limit=1000", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    }, timeoutMs)) as { data?: { id: string }[] };
    return (data.data ?? []).map((m) => m.id).filter(Boolean);
  }
  const base = (providerBaseUrl(provider) ?? "").replace(/\/$/, "");
  const data = (await fetchModelList(provider, `${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  }, timeoutMs)) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id).filter(Boolean);
}

export function versionScore(bare: string): number {
  const v = bare.match(/(\d+(?:\.\d+)?)/);
  const ver = v ? parseFloat(v[1]) : 0;
  // Prefer the canonical id over dated/preview snapshots when versions tie.
  const penalty = /\d{4}-\d{2}-\d{2}|\d{6,8}|preview|exp|snapshot|latest/i.test(bare) ? 0.001 : 0;
  return ver - penalty;
}

export function toModelInfo(provider: Provider, rawId: string, fam?: Family): ModelInfo {
  const id = `${provider}:${rawId}`;
  const known = MODELS[id];
  return {
    id,
    provider,
    providerModel: rawId,
    name: prettifyModelName(rawId), // real model name with version (e.g. "GLM 5.2")
    minPlan: fam?.minPlan ?? known?.minPlan ?? guessPlan(rawId),
    vision: fam?.vision ?? known?.vision ?? guessVision(rawId),
    reasoning: known?.reasoning ?? guessReasoning(rawId),
    cost: known?.cost ?? guessCost(rawId),
    modality: known?.modality ?? "chat",
    webSearch: providerSupportsWebSearch(provider),
    legacy: known?.legacy,
  };
}

export function curate(provider: Provider, rawIds: string[]): ModelInfo[] {
  const items = rawIds.map((raw) => ({ raw, bare: stripPrefix(raw) })).filter((x) => !JUNK_RE.test(x.bare));
  const families = FAMILIES[provider];

  if (!families) {
    const seen = new Set<string>();
    return items
      .filter((x) => (seen.has(x.bare) ? false : (seen.add(x.bare), true)))
      .slice(0, 12)
      .map((x) => toModelInfo(provider, x.raw));
  }

  const out: ModelInfo[] = [];
  const used = new Set<string>();
  for (const fam of families) {
    const matches = items.filter((x) => fam.match.test(x.bare) && !used.has(x.raw));
    if (!matches.length) continue;
    const latest = matches.sort((a, b) => versionScore(b.bare) - versionScore(a.bare) || a.bare.length - b.bare.length)[0];
    used.add(latest.raw);
    out.push(toModelInfo(provider, latest.raw, fam));
  }
  return out;
}
