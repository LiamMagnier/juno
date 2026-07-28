/**
 * Model providers. Anthropic uses its native SDK; every other provider exposes
 * an OpenAI-compatible API, so they all share one adapter (see openai-compat.ts)
 * with a per-provider base URL + API key. A provider is "configured" when its
 * API key env var is set; models from unconfigured providers are hidden/disabled.
 */

export type Provider = "anthropic" | "openai" | "zhipu" | "moonshot" | "google" | "meta" | "deepseek" | "mistral" | "xai" | "seedance" | "minimax" | "mimo" | "qwen" | "longcat" | "modal";

interface ProviderDef {
  label: string;
  apiKeyEnv: string;
  apiKeyEnvAliases?: string[];
  baseUrlEnv?: string; // optional override (regional endpoints, proxies, Azure…)
  defaultBaseUrl?: string; // undefined => native Anthropic SDK
  kind: "anthropic" | "openai";
  docsUrl: string;
  /**
   * Extra request headers, as header name → env var holding its value. For
   * providers that don't authenticate with a plain `Authorization: Bearer`
   * (Modal signs requests with a Modal-Key/Modal-Secret proxy-token pair).
   */
  extraHeaderEnvs?: Record<string, string>;
  /**
   * Extra env vars that must ALSO be set before the provider counts as usable.
   * For Modal the endpoint URLs are derived from the workspace name, so a key
   * without it resolves to nothing.
   */
  requiredEnvs?: string[];
  /**
   * Serves other labs' weights rather than making its own. Hosts are real
   * providers (own key, own base URL, own billing) but they are NOT labs, so
   * they get no lab rail of their own — their models file under the lab that
   * trained them, which is where anyone looking for Kimi will actually look.
   */
  host?: boolean;
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
    baseUrlEnv: "GOOGLE_BASE_URL",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    kind: "openai",
    docsUrl: "https://aistudio.google.com/apikey",
  },
  meta: {
    label: "Meta · Llama",
    apiKeyEnv: "LLAMA_API_KEY",
    apiKeyEnvAliases: ["META_API_KEY"],
    baseUrlEnv: "META_BASE_URL",
    defaultBaseUrl: "https://api.llama.com/compat/v1",
    kind: "openai",
    docsUrl: "https://llama.developer.meta.com/",
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
  modal: {
    // Modal is the one provider that does NOT have a single base URL: it serves
    // one OpenAI-compatible endpoint PER model, each on its own host. So the
    // per-model `endpoint` name in the catalog is what resolves to a URL (see
    // modalEndpointUrl); MODAL_BASE_URL is only a manual override for a model
    // whose host doesn't follow the standard shape.
    //
    // Auth is a proxy-token PAIR (`modal workspace proxy-tokens create`), not a
    // bearer key: MODAL_KEY is the wk-… id and MODAL_SECRET the ws-… secret.
    // MODAL_KEY doubles as the SDK's apiKey so the client constructs cleanly;
    // the headers below are what Modal actually checks.
    label: "Modal",
    apiKeyEnv: "MODAL_KEY",
    baseUrlEnv: "MODAL_BASE_URL",
    kind: "openai",
    docsUrl: "https://modal.com/docs/guide/endpoints",
    extraHeaderEnvs: { "Modal-Key": "MODAL_KEY", "Modal-Secret": "MODAL_SECRET" },
    requiredEnvs: ["MODAL_WORKSPACE"],
    host: true,
  },
};

/**
 * URL of one Modal endpoint, from the name shown by `modal endpoint list`.
 *
 * Modal mints these as `<workspace>--ep-<name>-server.<region>.modal.direct`,
 * so the whole fleet derives from the workspace name and adding a model to the
 * catalog costs one line instead of another env var per endpoint. Region is
 * Modal's `--routing-region`, which defaults to us-west.
 */
export function modalEndpointUrl(endpoint: string): string | undefined {
  const workspace = readEnv("MODAL_WORKSPACE");
  if (!workspace) return undefined;
  const region = readEnv("MODAL_REGION") ?? "us-west";
  return `https://${workspace}--ep-${endpoint}-server.${region}.modal.direct/v1`;
}

export const PROVIDER_LIST = Object.keys(PROVIDERS) as Provider[];

/** Providers that actually train models — the "AI Labs" rail, hosts excluded. */
export const LAB_LIST = PROVIDER_LIST.filter((p) => !PROVIDERS[p].host);

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

/**
 * Non-bearer auth headers, resolved from env. Empty for every provider that
 * authenticates with the API key alone.
 */
export function providerHeaders(p: Provider): Record<string, string> {
  const entries = Object.entries(PROVIDERS[p].extraHeaderEnvs ?? {});
  const out: Record<string, string> = {};
  for (const [header, envVar] of entries) {
    const value = readEnv(envVar);
    if (value) out[header] = value;
  }
  return out;
}

export function isProviderConfigured(p: Provider): boolean {
  const def = PROVIDERS[p];
  if (!providerApiKey(p)) return false;
  // A half-configured provider is worse than an absent one: its models show up
  // selectable and then every send fails. Require the whole credential set.
  if (!(def.requiredEnvs ?? []).every((name) => readEnv(name))) return false;
  const required = Object.keys(def.extraHeaderEnvs ?? {});
  const present = providerHeaders(p);
  return required.every((h) => present[h]);
}

export function configuredProviders(): Provider[] {
  return PROVIDER_LIST.filter(isProviderConfigured);
}
