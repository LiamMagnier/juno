import "server-only";
import { configuredProviders, providerApiKey, type Provider } from "@/lib/providers";
import { MODELS, type ModelInfo } from "@/lib/models";
import { curate, fetchProviderModelIds } from "@/lib/model-discovery-core";

interface CacheEntry {
  at: number;
  models: ModelInfo[];
}
const cache = new Map<Provider, CacheEntry>();
const TTL = 10 * 60 * 1000; // 10 minutes

function fallbackModels(provider: Provider): ModelInfo[] {
  return Object.values(MODELS).filter((m) => m.provider === provider && m.modality === "chat");
}

async function fetchProviderModels(provider: Provider): Promise<ModelInfo[]> {
  if (!providerApiKey(provider)) return [];

  try {
    const rawIds = await fetchProviderModelIds(provider);
    const discovered = curate(provider, rawIds);
    // The verified registry always wins; discovery only contributes genuinely
    // new models (a dated snapshot of a curated model would otherwise show up
    // as a same-name duplicate, e.g. claude-haiku-4-5-20251001 vs the alias).
    const curatedModelsForProvider = Object.values(MODELS).filter(
      (m) => m.provider === provider && m.modality === "chat"
    );
    const curatedNames = new Set(curatedModelsForProvider.map((m) => m.name.toLowerCase()));
    const combinedMap = new Map<string, ModelInfo>();
    for (const m of discovered) {
      if (!curatedNames.has(m.name.toLowerCase())) combinedMap.set(m.id, m);
    }
    for (const m of curatedModelsForProvider) combinedMap.set(m.id, m);
    const finalModels = Array.from(combinedMap.values());
    return finalModels.length ? finalModels : fallbackModels(provider);
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
