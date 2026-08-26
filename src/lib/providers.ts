/**
 * Model providers. Anthropic uses its native SDK; every other provider exposes
 * an OpenAI-compatible API, so they all share one adapter (see openai-compat.ts)
 * with a per-provider base URL + API key. A provider is "configured" when its
 * API key env var is set; models from unconfigured providers are hidden/disabled.
 */

export type Provider = "anthropic" | "openai" | "zhipu" | "moonshot" | "google" | "meta" | "deepseek" | "mistral" | "xai" | "seedance" | "minimax" | "mimo" | "qwen" | "longcat";

interface ProviderDef {
  label: string;
  apiKeyEnv: string;
  apiKeyEnvAliases?: string[];
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
  google: {
    label: "Google · Gemini",
    apiKeyEnv: "GOOGLE_API_KEY",
    apiKeyEnvAliases: ["GEMINI_API_KEY", "GEMINI_LIVE_API_KEY"],
    baseUrlEnv: "GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    kind: "openai",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  meta: {
    // Recommissioned 2026-08-06. The Llama API (api.llama.com) did shut down on
    // 2026-07-06, but the "no successor developer surface" half of that note is
    // no longer true: Meta reopened developer access on a NEW host, the Meta
    // Model API, serving the Muse Spark line (1.1 on 2026-07-09, 1.2 on
    // 2026-08-05). Still OpenAI-compatible, so the shared adapter applies.
    //
    // The key env flips to META_API_KEY — this is a different product with a
    // different credential, and LLAMA_API_KEY now names a dead service. It stays
    // an alias so a deployment that still sets it keeps working.
    label: "Meta · Muse",
    apiKeyEnv: "META_API_KEY",
    apiKeyEnvAliases: ["LLAMA_API_KEY"],
    baseUrlEnv: "META_BASE_URL",
    defaultBaseUrl: "https://api.meta.ai/v1",
    kind: "openai",
    docsUrl: "https://developer.meta.com/ai/",
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
    // xAI completed its public rebrand to SpaceXAI in July 2026 (SpaceX merger).
    label: "SpaceXAI · Grok",
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
  qwen: {
    label: "Alibaba · Qwen",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    baseUrlEnv: "QWEN_BASE_URL",
    // Alibaba Cloud Model Studio (DashScope), OpenAI-compatible mode. Use the
    // international endpoint by default; set QWEN_BASE_URL to the Beijing host
    // (…dashscope.aliyuncs.com…) for a China-region account.
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    kind: "openai",
    docsUrl: "https://bailian.console.alibabacloud.com/?apiKey=1#/api-key",
  },
  longcat: {
    label: "Meituan · LongCat",
    apiKeyEnv: "LONGCAT_API_KEY",
    baseUrlEnv: "LONGCAT_BASE_URL",
    defaultBaseUrl: "https://api.longcat.chat/openai",
    kind: "openai",
    docsUrl: "https://longcat.chat/platform/api_keys",
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
  const def = PROVIDERS[p];
  return readEnv(def.apiKeyEnv) ?? def.apiKeyEnvAliases?.map(readEnv).find(Boolean);
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
