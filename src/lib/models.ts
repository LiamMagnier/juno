import type { Plan } from "@prisma/client";
import { PROVIDER_LIST, type Provider } from "@/lib/providers";

// Canonical model id is "provider:providerModel" (e.g. "anthropic:claude-opus-4-8").
export type ModelId = string;

export type CostTier = 1 | 2 | 3; // relative: $ cheap → $$$ expensive

export type Modality = "chat" | "image" | "video";

export interface ModelInfo {
  id: string;
  provider: Provider;
  providerModel: string; // the id sent to the provider API
  name: string;
  description?: string;
  minPlan: Plan;
  vision: boolean;
  reasoning: boolean; // supports a "thinking"/reasoning effort
  cost: CostTier;
  modality: Modality; // chat (text) · image · video
  webSearch: boolean; // can search the web + cite sources (chat models)
}

// NOTE: these regexes + guess functions are declared BEFORE `curated()`/`CURATED`
// because that array is built at module load and calls guessReasoning/guessCost
// (avoids a temporal-dead-zone "before initialization" crash).
const VISION_RE = /(4o|gpt-5|gpt-4\.1|o[134]\b|gemini|claude|vision|vl|pixtral|maverick|scout|llava)/i;
const FREE_RE = /(flash|mini|nano|lite|haiku|air|small|8b|free|^glm-4\.5)/i;
const EXPENSIVE_RE = /(opus|gpt-5(?!.*(mini|nano))|^o\d|-o\d|large|grok-?\d|reasoner|ultra|max\b|405b|magistral-medium)/i;
const CHEAP_RE = /(flash|mini|nano|lite|air|small|haiku|8b|tiny|turbo|free)/i;
const REASONING_RE =
  /(reasoner|thinking|^o\d|-o\d|gpt-5|magistral|deepseek-r|[-/]r1|qwq|claude-(opus|sonnet)|glm-(4\.6|[5-9])|gemini-[2-9]\.[5-9]|gemini-[3-9]|grok-[3-9])/i;

export function guessVision(providerModel: string): boolean {
  return VISION_RE.test(providerModel);
}
export function guessPlan(providerModel: string): Plan {
  return FREE_RE.test(providerModel) ? "FREE" : "PRO";
}
export function guessCost(providerModel: string): CostTier {
  if (EXPENSIVE_RE.test(providerModel)) return 3;
  if (CHEAP_RE.test(providerModel)) return 1;
  return 2;
}
export function guessReasoning(providerModel: string): boolean {
  return REASONING_RE.test(providerModel);
}

// Providers whose chat models can search the web natively (their own tool /
// grounding — no third-party search service).
const WEB_SEARCH_PROVIDERS = new Set<Provider>(["anthropic", "google", "xai"]);
export function providerSupportsWebSearch(p: Provider): boolean {
  return WEB_SEARCH_PROVIDERS.has(p);
}

function curated(
  provider: Provider,
  providerModel: string,
  name: string,
  description: string,
  minPlan: Plan,
  vision: boolean
): ModelInfo {
  return {
    id: `${provider}:${providerModel}`,
    provider,
    providerModel,
    name,
    description,
    minPlan,
    vision,
    reasoning: guessReasoning(providerModel),
    cost: guessCost(providerModel),
    modality: "chat",
    webSearch: providerSupportsWebSearch(provider),
  };
}

/** Image / video generation models — grouped by lab in the picker. */
function gen(
  provider: Provider,
  providerModel: string,
  name: string,
  description: string,
  minPlan: Plan,
  modality: Modality,
  cost: CostTier
): ModelInfo {
  return { id: `${provider}:${providerModel}`, provider, providerModel, name, description, minPlan, vision: false, reasoning: false, cost, modality, webSearch: false };
}

// Curated metadata for well-known models (nice names + correct vision/plan).
// Live discovery (see model-discovery.ts) adds whatever else each provider's
// API actually exposes; anything not listed here gets sensible guessed metadata.
const CURATED: ModelInfo[] = [
  curated("anthropic", "claude-opus-4-8", "Claude Opus 4.8", "Most capable — deep reasoning & code.", "PRO", true),
  curated("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6", "Fast and capable for everyday tasks.", "FREE", true),
  curated("openai", "gpt-4o", "GPT-4o", "Fast, multimodal OpenAI model.", "FREE", true),
  curated("google", "gemini-2.5-flash", "Gemini 2.5 Flash", "Fast, efficient Gemini.", "FREE", true),
  curated("google", "gemini-2.5-pro", "Gemini 2.5 Pro", "Google's most capable Gemini.", "PRO", true),
  curated("zhipu", "glm-4.5-flash", "GLM-4.5 Flash", "Fast, low-cost GLM.", "FREE", false),
  curated("zhipu", "glm-4.6", "GLM-4.6", "Zhipu's flagship GLM.", "PRO", false),
  curated("zhipu", "glm-5.2", "GLM-5.2", "Z.AI's thinking model with long-context reasoning.", "PRO", false),
  curated("moonshot", "kimi-k2", "Kimi K2", "Long-context agentic model.", "PRO", false),
  curated("deepseek", "deepseek-chat", "DeepSeek Chat", "Fast general-purpose model.", "FREE", false),
  curated("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", "Strong reasoning model.", "PRO", false),
  curated("mistral", "mistral-large-latest", "Mistral Large", "Mistral's flagship.", "PRO", false),
  curated("mistral", "mistral-small-latest", "Mistral Small", "Fast, low-cost Mistral.", "FREE", false),
  curated("xai", "grok-4", "Grok 4", "xAI's flagship Grok.", "PRO", true),
];

// Image & video generation models. Grouped by lab in the picker; each runs
// through /api/generate (not the chat stream). Hidden unless the lab's key is set.
const GENERATIVE: ModelInfo[] = [
  // —— Image ——
  gen("openai", "gpt-image-1", "GPT Image", "OpenAI's image model — crisp text & detail.", "PRO", "image", 3),
  gen("google", "gemini-2.5-flash-image", "Nano Banana", "Gemini 2.5 Flash image — fast, editable.", "PRO", "image", 2),
  gen("xai", "grok-2-image", "Grok Image", "xAI image generation.", "PRO", "image", 2),
  gen("zhipu", "glm-image", "GLM-Image", "Zhipu's GLM image model.", "PRO", "image", 2),
  gen("zhipu", "cogview-4", "CogView 4", "Zhipu's CogView image model.", "PRO", "image", 2),
  // —— Video ——
  gen("google", "veo-3.0-generate-001", "Veo 3", "Google text-to-video with audio.", "MAX", "video", 3),
  gen("seedance", "seedance-1-0-pro-250528", "Seedance 1.0 Pro", "ByteDance cinematic text-to-video.", "MAX", "video", 3),
  gen("zhipu", "cogvideox-3", "CogVideoX", "Zhipu text-to-video.", "MAX", "video", 3),
];

export const GEN_MODELS: ModelInfo[] = GENERATIVE;

// —— Voice input (speech-to-text) models ——
// Not part of the chat/gen registries; used only by voice mode + the ASR route.
// id "browser" means the on-device Web Speech API; others are "<provider>:<model>".
export interface VoiceInputModel {
  id: string;
  label: string;
  description: string;
  provider: Provider | null;
  providerModel: string | null;
}

export const VOICE_INPUT_MODELS: VoiceInputModel[] = [
  {
    id: "zhipu:glm-asr-2512",
    label: "GLM-ASR-2512",
    description: "Zhipu server-side speech recognition — multilingual, high accuracy.",
    provider: "zhipu",
    providerModel: "glm-asr-2512",
  },
  {
    id: "browser",
    label: "Browser (on-device)",
    description: "Instant, private, on-device recognition. Chrome & Edge only.",
    provider: null,
    providerModel: null,
  },
];

/** Resolve a stored voice-input id to a model (falls back to the first entry). */
export function resolveVoiceInput(id: string | null | undefined): VoiceInputModel {
  return VOICE_INPUT_MODELS.find((m) => m.id === id) ?? VOICE_INPUT_MODELS[0];
}

export const MODELS: Record<string, ModelInfo> = Object.fromEntries(
  [...CURATED, ...GENERATIVE].map((m) => [m.id, m])
);
// Initial client list is chat-only; image/video models load via /api/models
// (only for labs whose key is set), avoiding a flash of unconfigured providers.
export const MODEL_LIST: ModelInfo[] = CURATED;

// Legacy bare ids (stored before namespacing) -> namespaced id.
const LEGACY_ALIAS: Record<string, string> = Object.fromEntries(CURATED.map((m) => [m.providerModel, m.id]));

export const DEFAULT_MODEL: ModelId = "anthropic:claude-sonnet-4-6";

function isProvider(p: string): p is Provider {
  return (PROVIDER_LIST as string[]).includes(p);
}

export function parseModelRef(id: string): { provider: Provider; providerModel: string } | null {
  if (id.includes(":")) {
    const idx = id.indexOf(":");
    const provider = id.slice(0, idx);
    const providerModel = id.slice(idx + 1);
    if (!isProvider(provider) || !providerModel) return null;
    return { provider, providerModel };
  }
  const alias = LEGACY_ALIAS[id];
  if (alias) {
    const idx = alias.indexOf(":");
    return { provider: alias.slice(0, idx) as Provider, providerModel: alias.slice(idx + 1) };
  }
  return null;
}

export function prettifyModelName(providerModel: string): string {
  let s = providerModel.replace(/^models\//i, ""); // Gemini ids come as "models/gemini-…"
  // Strip trailing date / snapshot / channel suffixes (possibly several stacked).
  let prev: string;
  do {
    prev = s;
    s = s.replace(/[-_](\d{4}-\d{2}-\d{2}|\d{4,8}|latest|preview|exp|beta|snapshot|hd)$/i, "");
  } while (s !== prev);
  return s
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (/^(gpt|glm|vl)$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) || /^o\d+$/i.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
    .replace(/\b(\d)\s+(\d)\b/g, "$1.$2") // dash-versions like "4 1" -> "4.1"
    .replace(/\bDeepseek\b/g, "DeepSeek")
    .trim();
}

/** Build a ModelInfo for any id — curated metadata if known, else guessed. */
export function resolveModel(id: string): ModelInfo | null {
  const ref = parseModelRef(id);
  if (!ref) return null;
  const canonical = `${ref.provider}:${ref.providerModel}`;
  const known = MODELS[canonical];
  if (known) return known;
  return {
    id: canonical,
    provider: ref.provider,
    providerModel: ref.providerModel,
    name: prettifyModelName(ref.providerModel),
    minPlan: guessPlan(ref.providerModel),
    vision: guessVision(ref.providerModel),
    reasoning: guessReasoning(ref.providerModel),
    cost: guessCost(ref.providerModel),
    modality: "chat",
    webSearch: providerSupportsWebSearch(ref.provider),
  };
}

export function getModel(id: string): ModelInfo | undefined {
  return resolveModel(id) ?? undefined;
}

export function isModelId(value: string): boolean {
  return parseModelRef(value) !== null;
}

/** Max tokens to generate per response (bigger so artifacts don't truncate). */
export const MAX_OUTPUT_TOKENS = 8192;
