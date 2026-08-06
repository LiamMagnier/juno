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

/**
 * A provider described by the caller instead of by the table above.
 *
 * The table in `COMPAT_PROVIDERS` knows two labs. The website knows fourteen,
 * and its picker offers all of them — so every model outside those two failed
 * its run with `Unknown provider: <id>` at the moment the adapter was resolved,
 * before a single token. Widening the vendored table would have fixed it for a
 * day and then drifted, because the catalog it has to agree with lives in
 * `src/lib/providers.ts` and `src/lib/models.ts`, and this package is built with
 * the repository absent and cannot read either.
 *
 * So the same seam the Work tools already use: the shape lives here, the
 * catalog is injected by the caller that can see it. `scripts/work-runner.ts`
 * builds one of these per run out of the website's own provider and model
 * tables, which makes "the picker and the executor agree" a property of there
 * being one table rather than a rule somebody has to remember.
 *
 * The key is passed in rather than resolved from the environment: a caller that
 * has already read the key has also already decided the provider is configured,
 * and a second resolution here could disagree with the first.
 */
export interface ProviderSpec {
  id: string;
  name: string;
  /** `anthropic` selects the native SDK; `openai` the shared compat adapter. */
  kind: 'anthropic' | 'openai';
  apiKey: string;
  /** Required for `openai`. On `anthropic` it means "go through a proxy". */
  baseUrl?: string;
  defaultModel: string;
  models: Record<string, { label: string; capabilities: ModelCapabilities }>;
  /** Only for labs whose API defines OpenAI's top-level `reasoning_effort`. */
  reasoningEffortParam?: boolean;
  timeoutMs?: number;
}

export function createProviderFromSpec(spec: ProviderSpec): ProviderAdapter {
  if (!spec.apiKey) {
    throw new Error(`${spec.name} has no API key configured.`);
  }
  if (spec.kind === 'anthropic') {
    return new AnthropicAdapter(spec.apiKey, {
      id: spec.id,
      name: spec.name,
      defaultModel: spec.defaultModel,
      models: Object.fromEntries(
        Object.entries(spec.models).map(([id, model]) => [id, model.capabilities]),
      ),
      ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    });
  }
  if (!spec.baseUrl) {
    throw new Error(`${spec.name} is an OpenAI-compatible provider with no base URL.`);
  }
  return new OpenAICompatAdapter(
    {
      id: spec.id,
      name: spec.name,
      baseUrl: spec.baseUrl,
      // Only consulted when no explicit key is passed, and one always is.
      envVar: '',
      defaultModel: spec.defaultModel,
      models: spec.models,
      ...(spec.reasoningEffortParam ? { reasoningEffortParam: true } : {}),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    },
    { apiKey: spec.apiKey },
  );
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
