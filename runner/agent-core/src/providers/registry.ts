import type { ModelCapabilities, ProviderAdapter } from './types.js';
import { AnthropicAdapter, resolveAnthropicKey } from './anthropic.js';
import { COMPAT_PROVIDERS, OpenAICompatAdapter } from './openai-compat.js';
import { resolveKey } from './credentials.js';

export interface ModelListing {
  id: string;
  label: string;
  capabilities: ModelCapabilities;
  /** Per-model gate: a provider can be available while one model isn't
   *  (e.g. Responses-only models the engine proxy can't reach yet). */
  available?: boolean;
  reason?: string;
}

export interface ProviderListing {
  id: string;
  name: string;
  /** False when no API key is resolvable; `reason` says what to configure. */
  available: boolean;
  reason?: string;
  defaultModel: string;
  models: ModelListing[];
}

/** Everything the surfaces can show in a model picker, greyed with reasons. */
export function listProviders(): ProviderListing[] {
  const listings: ProviderListing[] = [];

  const anthropicKey = resolveAnthropicKey();
  const anthropic = new AnthropicAdapter();
  listings.push({
    id: 'anthropic',
    name: 'Anthropic · Claude',
    available: Boolean(anthropicKey),
    reason: anthropicKey ? undefined : 'Set ANTHROPIC_API_KEY or add it in Settings.',
    defaultModel: anthropic.defaultModel,
    models: anthropic.models().map((m) => ({
      id: m,
      label: m,
      capabilities: anthropic.capabilities(m),
    })),
  });

  for (const config of Object.values(COMPAT_PROVIDERS)) {
    const key = resolveKey(config.id, config.envVar);
    listings.push({
      id: config.id,
      name: config.name,
      available: Boolean(key),
      reason: key ? undefined : `Set ${config.envVar} or add it in Settings.`,
      defaultModel: config.defaultModel,
      models: Object.entries(config.models).map(([id, m]) => ({
        id,
        label: m.label,
        capabilities: m.capabilities,
      })),
    });
  }

  return listings;
}

/** Instantiate an adapter, throwing a clear error when it can't work. */
export function createProvider(id: string): ProviderAdapter {
  if (id === 'anthropic') {
    if (!resolveAnthropicKey()) throw new Error('Anthropic API key is not configured.');
    return new AnthropicAdapter();
  }
  const config = COMPAT_PROVIDERS[id];
  if (!config) throw new Error(`Unknown provider: ${id}`);
  if (!resolveKey(config.id, config.envVar)) {
    throw new Error(`${config.name} API key is not configured (${config.envVar} or ~/.juno/credentials.json).`);
  }
  return new OpenAICompatAdapter(config);
}

/** First provider with a usable key — the zero-config default for surfaces. */
export function defaultProviderId(): string | undefined {
  return listProviders().find((p) => p.available)?.id;
}
