/**
 * Model providers. Anthropic uses its native SDK; every other provider exposes
 * an OpenAI-compatible API, so they all share one adapter (see openai-compat.ts)
 * with a per-provider base URL + API key. A provider is "configured" when its
 * API key env var is set; models from unconfigured providers are hidden/disabled.
 */

export type Provider = "anthropic" | "openai" | "google" | "zhipu" | "moonshot" | "deepseek" | "mistral" | "xai" | "seedance" | "minimax" | "mimo";

interface ProviderDef {
  label: string;
  apiKeyEnv: string;
  baseUrlEnv?: string; // optional override (regional endpoints, proxies, Azure…)
  defaultBaseUrl?: string; // undefined => native Anthropic SDK
  kind: "anthropic" | "openai";
  docsUrl: string;
}

export const PROVIDERS: Record<Provider, ProviderDef> = {
  anthropic: {
    label: "Anthropic · Claude",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    kind: "anthropic",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI · GPT",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.openai.com/v1",
    kind: "openai",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    label: "Google · Gemini",
    apiKeyEnv: "GOOGLE_API_KEY",
    baseUrlEnv: "GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    kind: "openai",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  zhipu: {
    label: "Zhipu · GLM",
    apiKeyEnv: "ZHIPU_API_KEY",
    baseUrlEnv: "ZHIPU_BASE_URL",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    kind: "openai",
    docsUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  moonshot: {
    label: "Moonshot · Kimi",
    apiKeyEnv: "MOONSHOT_API_KEY",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    kind: "openai",
    docsUrl: "https://platform.moonshot.ai/console/api-keys",
  },
  deepseek: {
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    kind: "openai",
    docsUrl: "https://platform.deepseek.com/api_keys",
  },
  mistral: {
    label: "Mistral",
    apiKeyEnv: "MISTRAL_API_KEY",
    baseUrlEnv: "MISTRAL_BASE_URL",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    kind: "openai",
    docsUrl: "https://console.mistral.ai/api-keys",
  },
  xai: {
    label: "xAI · Grok",
    apiKeyEnv: "XAI_API_KEY",
    baseUrlEnv: "XAI_BASE_URL",
    defaultBaseUrl: "https://api.x.ai/v1",
    kind: "openai",
    docsUrl: "https://console.x.ai",
  },
  seedance: {
    label: "ByteDance · Seedance",
    apiKeyEnv: "SEEDANCE_API_KEY",
    baseUrlEnv: "SEEDANCE_BASE_URL",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    kind: "openai",
    docsUrl: "https://www.volcengine.com/docs/82379",
  },
  minimax: {
    label: "MiniMax",
    apiKeyEnv: "MINIMAX_API_KEY",
    baseUrlEnv: "MINIMAX_BASE_URL",
    defaultBaseUrl: "https://api.minimax.io/v1",
    kind: "openai",
    docsUrl: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  },
  mimo: {
    label: "MiMo · Xiaomi",
    apiKeyEnv: "MIMO_API_KEY",
    baseUrlEnv: "MIMO_BASE_URL",
    defaultBaseUrl: "https://api.xiaomimimo.com/v1",
    kind: "openai",
    docsUrl: "https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call",
  },
};

export const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];

/**
 * Read an env value defensively. `.env` parsers (dotenv/Next) strip surrounding
 * quotes, but hosting dashboards like Vercel store the value verbatim — so a key
 * pasted *with* its quotes works locally yet silently 401s in production on every
 * request. Trim whitespace and one layer of surrounding quotes so both behave the
 * same. Also strips stray CR/LF that sneak in from copy-paste.
 */
function readEnv(name?: string): string | undefined {
  if (!name) return undefined;
  const raw = process.env[name];
  if (!raw) return undefined;
  const cleaned = raw.trim().replace(/^['"]|['"]$/g, "").replace(/[\r\n]+/g, "").trim();
  return cleaned || undefined;
}

export function providerApiKey(p: Provider): string | undefined {
  return readEnv(PROVIDERS[p].apiKeyEnv);
}

export function providerBaseUrl(p: Provider): string | undefined {
  const def = PROVIDERS[p];
  return readEnv(def.baseUrlEnv) ?? def.defaultBaseUrl;
}

export function isProviderConfigured(p: Provider): boolean {
  return Boolean(providerApiKey(p));
}

export function configuredProviders(): Provider[] {
  return PROVIDER_LIST.filter(isProviderConfigured);
}
