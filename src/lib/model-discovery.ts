import "server-only";
import type { Plan } from "@prisma/client";
import { configuredProviders, providerApiKey, providerBaseUrl, type Provider } from "@/lib/providers";
import { MODELS, prettifyModelName, guessVision, guessPlan, guessReasoning, guessCost, providerSupportsWebSearch, type ModelInfo } from "@/lib/models";

interface CacheEntry {
  at: number;
  models: ModelInfo[];
}
const cache = new Map<Provider, CacheEntry>();
const TTL = 10 * 60 * 1000; // 10 minutes
const MODEL_DISCOVERY_TIMEOUT_MS = 2500;

// Models that aren't general chat models, or that we never want to surface.
const JUNK_RE =
  /(robot|antigravity|embed|tts|whisper|audio|speech|dall|image|imagen|veo|video|moderation|rerank|guard|safety|aqa|tuning|learnlm|gemma|banana|live|realtime|computer-use|vision-?only|ocr|distill|deprecat|legacy|^ada|babbage|davinci|curie|sora|moderation)/i;

interface Family {
  label: string;
  match: RegExp;
  minPlan: Plan;
  vision: boolean;
}

// Curated "families" per provider. From the provider's real API list we keep
// only the latest model in each family, so the picker shows clean, current
// models instead of every dated snapshot and old version.
const FAMILIES: Partial<Record<Provider, Family[]>> = {
  anthropic: [
    { label: "Claude Opus", match: /opus/i, minPlan: "PRO", vision: true },
    { label: "Claude Sonnet", match: /sonnet/i, minPlan: "FREE", vision: true },
    { label: "Claude Haiku", match: /haiku/i, minPlan: "FREE", vision: true },
  ],
  openai: [
    { label: "GPT-5", match: /^gpt-5(?!.*(mini|nano))/i, minPlan: "PRO", vision: true },
    { label: "GPT-5 mini", match: /^gpt-5.*mini/i, minPlan: "FREE", vision: true },
    { label: "GPT-4o", match: /^gpt-4o$/i, minPlan: "FREE", vision: true },
    { label: "GPT-4o mini", match: /^gpt-4o-mini$/i, minPlan: "FREE", vision: true },
    { label: "o-series", match: /^o\d(?!.*mini)/i, minPlan: "PRO", vision: true },
  ],
  google: [
    { label: "Gemini Pro", match: /gemini-[\d.]+-pro/i, minPlan: "PRO", vision: true },
    { label: "Gemini Flash", match: /gemini-[\d.]+-flash(?!.*lite)/i, minPlan: "FREE", vision: true },
    { label: "Gemini Flash Lite", match: /gemini-[\d.]+-flash-lite/i, minPlan: "FREE", vision: true },
  ],
  zhipu: [
    { label: "GLM Flash", match: /glm-[\d.]+-flash/i, minPlan: "FREE", vision: false },
    { label: "GLM Air", match: /glm-[\d.]+-air/i, minPlan: "FREE", vision: false },
    { label: "GLM", match: /^glm-[\d.]+(?:-0\d+)?$/i, minPlan: "PRO", vision: false },
  ],
  moonshot: [
    { label: "Kimi", match: /kimi/i, minPlan: "PRO", vision: false },
    { label: "Moonshot", match: /^moonshot-v1-(8k|32k|128k)$/i, minPlan: "FREE", vision: false },
  ],
  deepseek: [
    { label: "DeepSeek Chat", match: /deepseek-chat/i, minPlan: "FREE", vision: false },
    { label: "DeepSeek Reasoner", match: /deepseek-reason/i, minPlan: "PRO", vision: false },
  ],
  mistral: [
    { label: "Mistral Large", match: /mistral-large/i, minPlan: "PRO", vision: false },
    { label: "Mistral Small", match: /mistral-small/i, minPlan: "FREE", vision: false },
    { label: "Magistral", match: /magistral/i, minPlan: "PRO", vision: false },
  ],
  xai: [
    { label: "Grok", match: /^grok-?\d+$/i, minPlan: "PRO", vision: true },
    { label: "Grok mini", match: /grok.*mini/i, minPlan: "FREE", vision: true },
  ],
};

const stripPrefix = (id: string) => id.replace(/^models\//i, "");

function fallbackModels(provider: Provider): ModelInfo[] {
  return Object.values(MODELS).filter((m) => m.provider === provider && m.modality === "chat");
}

async function fetchModelList(provider: Provider, url: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${provider} models ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function versionScore(bare: string): number {
  const v = bare.match(/(\d+(?:\.\d+)?)/);
  const ver = v ? parseFloat(v[1]) : 0;
  // Prefer the canonical id over dated/preview snapshots when versions tie.
  const penalty = /\d{4}-\d{2}-\d{2}|\d{6,8}|preview|exp|snapshot|latest/i.test(bare) ? 0.001 : 0;
  return ver - penalty;
}

function toModelInfo(provider: Provider, rawId: string, fam?: Family): ModelInfo {
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
    modality: "chat",
    webSearch: providerSupportsWebSearch(provider),
  };
}

function curate(provider: Provider, rawIds: string[]): ModelInfo[] {
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

async function fetchProviderModels(provider: Provider): Promise<ModelInfo[]> {
  const key = providerApiKey(provider);
  if (!key) return [];

  try {
    let rawIds: string[] = [];
    if (provider === "anthropic") {
      const data = (await fetchModelList(provider, "https://api.anthropic.com/v1/models?limit=1000", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      })) as { data?: { id: string }[] };
      rawIds = (data.data ?? []).map((m) => m.id).filter(Boolean);
    } else {
      const base = (providerBaseUrl(provider) ?? "").replace(/\/$/, "");
      const data = (await fetchModelList(provider, `${base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      })) as { data?: { id: string }[] };
      rawIds = (data.data ?? []).map((m) => m.id).filter(Boolean);
    }
    const curated = curate(provider, rawIds);
    // If curation produced nothing (unexpected id shapes), fall back to curated
    // CHAT metadata (image/video models are surfaced separately by /api/models).
    return curated.length ? curated : fallbackModels(provider);
  } catch (e) {
    const reason = e instanceof Error && e.name === "AbortError" ? "request timed out" : e instanceof Error ? e.message : String(e);
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[model-discovery] ${provider}: ${reason}. Using curated fallback.`);
    }
    return fallbackModels(provider);
  }
}

/** Curated, latest models from every configured provider's API (cached per provider). */
export async function discoverModels(): Promise<ModelInfo[]> {
  const providers = configuredProviders();
  const lists = await Promise.all(
    providers.map(async (p) => {
      const cached = cache.get(p);
      if (cached && Date.now() - cached.at < TTL) return cached.models;
      const models = await fetchProviderModels(p);
      cache.set(p, { at: Date.now(), models });
      return models;
    })
  );
  return lists.flat();
}
