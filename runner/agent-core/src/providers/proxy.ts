import type { ModelCapabilities, ProviderAdapter } from './types.js';
import type { ProviderListing } from './registry.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatAdapter } from './openai-compat.js';

/**
 * Backend-proxy providers: instead of per-user API keys, requests route
 * through the Juno backend's authenticated /api/agent/<provider> proxy with
 * the user's session cookie — the same server-side keys the website uses,
 * so Code usage lands in the same account and counts toward the same limits.
 *
 * A surface (the Mac app) supplies the catalog + cookie over the local
 * socket via `configure_backend`; provider ids take the form `backend/<id>`.
 */
export interface BackendCatalogModel {
  /** Backend provider id, e.g. "zhipu" — the path segment under /api/agent. */
  provider: string;
  providerName?: string;
  /** Wire protocol the proxy speaks for this provider. */
  kind: 'anthropic' | 'openai';
  model: string;
  label: string;
  available: boolean;
  reason?: string;
  vision?: boolean;
  contextWindow?: number;
}

export interface BackendConfig {
  /** e.g. https://chat.liams.dev/api/agent (no trailing slash) */
  baseUrl: string;
  /** Full Cookie header value carrying the signed-in session. */
  cookie: string;
  /**
   * Bearer credential, used instead of the cookie when set — e.g. the Cloud
   * Code runner authenticates every proxy call with a short-lived per-task
   * token rather than a session cookie. Format: the full header value,
   * e.g. "Bearer cct_…". Keep in sync with the vendored copy in juno/runner.
   */
  authorization?: string;
  models: BackendCatalogModel[];
}

export const BACKEND_PROVIDER_PREFIX = 'backend/';

function capsFor(entry: BackendCatalogModel): ModelCapabilities {
  return {
    tools: true,
    vision: entry.vision ?? true,
    computerUse: false,
    reasoningLevels: [],
    maxContext: entry.contextWindow ?? 200_000,
    streaming: true,
    mcp: false,
  };
}

export function proxyProviderListings(config: BackendConfig): ProviderListing[] {
  const byProvider = new Map<string, BackendCatalogModel[]>();
  for (const model of config.models) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return [...byProvider.entries()].map(([providerId, models]) => {
    const availableModels = models.filter((m) => m.available);
    return {
      id: BACKEND_PROVIDER_PREFIX + providerId,
      name: models[0]?.providerName ?? providerId,
      available: availableModels.length > 0,
      reason: availableModels.length > 0 ? undefined : (models[0]?.reason ?? 'Not configured on the server.'),
      defaultModel: (availableModels[0] ?? models[0])?.model ?? '',
      models: models.map((m) => ({
        id: m.model,
        label: m.label,
        capabilities: capsFor(m),
        available: m.available,
        reason: m.reason,
      })),
    };
  });
}

export function createProxyProvider(config: BackendConfig, backendProviderId: string): ProviderAdapter {
  const providerId = backendProviderId.startsWith(BACKEND_PROVIDER_PREFIX)
    ? backendProviderId.slice(BACKEND_PROVIDER_PREFIX.length)
    : backendProviderId;
  const entries = config.models.filter((m) => m.provider === providerId);
  if (entries.length === 0) {
    throw new Error(`The backend catalog has no models for provider "${providerId}".`);
  }
  const base = `${config.baseUrl.replace(/\/+$/, '')}/${providerId}`;
  const headers: Record<string, string> = config.authorization
    ? { Authorization: config.authorization }
    : { Cookie: config.cookie };
  const id = BACKEND_PROVIDER_PREFIX + providerId;
  const defaultModel = (entries.find((m) => m.available) ?? entries[0]).model;
  const models = Object.fromEntries(
    entries.map((m) => [m.model, { label: m.label, capabilities: capsFor(m) }]),
  );

  if (entries[0].kind === 'anthropic') {
    // Anthropic SDK appends /v1/messages, which is exactly the proxy's allowed path.
    return new AnthropicAdapter(undefined, {
      id,
      baseURL: base,
      headers,
      models: Object.fromEntries(entries.map((m) => [m.model, capsFor(m)])),
      defaultModel,
    });
  }
  return new OpenAICompatAdapter(
    {
      id: providerId,
      name: entries[0].providerName ?? providerId,
      baseUrl: base,
      envVar: '',
      defaultModel,
      models,
    },
    { apiKey: 'proxy', headers, id },
  );
}
