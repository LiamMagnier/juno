import type { Plan } from "@prisma/client";
import { PROVIDERS, PROVIDER_LIST, type Provider } from "@/lib/providers";
import { DISCOVERED, UNAVAILABLE } from "@/lib/models.generated";

// Canonical model id is "provider:providerModel" (e.g. "anthropic:claude-opus-4-8").
export type ModelId = string;

export type CostTier = 1 | 2 | 3; // relative: $ cheap → $$$ expensive

export type Modality = "chat" | "image" | "video";

/**
 * Lifecycle status, verified against official provider docs (see docs/models.md
 * for sources + audit dates):
 *  - current    — latest active generation of its family; recommended.
 *  - legacy     — still API-supported but superseded within its family.
 *  - deprecated — provider-announced retirement date; selectable with a warning.
 * Retired models (no longer callable) are NOT registered — they live in
 * RETIRED_MODELS below and silently migrate to their replacement.
 */
export type ModelStatus = "current" | "legacy" | "deprecated";

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
  status?: ModelStatus; // set on every curated entry; discovered models default to "current"
  family?: string; // product family (sonnet, gpt, veo…) — one current per family per modality
  /** Human-readable warning for deprecated models ("Retires Aug 5, 2026 — use …"). */
  deprecationNote?: string;
  contextWindow?: number;
  /** Kept in sync with status for existing consumers (true when not current). */
  legacy?: boolean;
}

// NOTE: these regexes + guess functions are declared BEFORE the registry
// because it is built at module load and calls guessReasoning/guessCost
// (avoids a temporal-dead-zone "before initialization" crash).
const VISION_RE = /(4o|gpt-5|gpt-4\.1|gemini|claude|minimax-m3|kimi-k2\.[5-9]|vision|vl|pixtral|maverick|scout|llava|glm-5v|-image)/i;
const FREE_RE = /(flash|mini|nano|lite|haiku|air|small|8b|14b|free|highspeed|v4-flash)/i;
const EXPENSIVE_RE = /(opus|fable|mythos|gpt-5\.\d-pro|^o\d|-o\d|large|grok-4|reasoner|ultra|max\b|405b|magistral-medium|v4-pro)/i;
const CHEAP_RE = /(flash|mini|nano|lite|air|small|haiku|8b|tiny|turbo|free)/i;
const REASONING_RE =
  /(fable|mythos|reasoner|thinking|^o\d|-o\d|gpt-5|magistral|deepseek-(r|v4)|[-/]r1|qwq|claude-(opus|sonnet|haiku-4)|minimax-m[2-9]|glm-(4\.[6-9]|[5-9])|gemini-[2-9]\.[5-9]|gemini-[3-9]|grok-(4|build)|kimi-k2)/i;

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

interface ModelDef {
  provider: Provider;
  id: string; // provider model id, EXACTLY as the provider API expects it
  name: string;
  description: string;
  minPlan: Plan;
  modality?: Modality; // default chat
  status: ModelStatus;
  family: string;
  vision?: boolean;
  reasoning?: boolean; // default: guessed from the id
  cost?: CostTier; // default: guessed from the id
  contextWindow?: number;
  deprecationNote?: string;
}

function def(d: ModelDef): ModelInfo {
  const modality = d.modality ?? "chat";
  return {
    id: `${d.provider}:${d.id}`,
    provider: d.provider,
    providerModel: d.id,
    name: d.name,
    description: d.description,
    minPlan: d.minPlan,
    vision: d.vision ?? false,
    reasoning: d.reasoning ?? (modality === "chat" ? guessReasoning(d.id) : false),
    cost: d.cost ?? guessCost(d.id),
    modality,
    webSearch: modality === "chat" ? providerSupportsWebSearch(d.provider) : false,
    status: d.status,
    family: d.family,
    deprecationNote: d.deprecationNote,
    contextWindow: d.contextWindow,
    legacy: d.status !== "current",
  };
}

/**
 * Curated registry — verified against official provider docs on 2026-07-01
 * (sources + per-model notes in docs/models.md; `npm run validate:models`
 * checks invariants). Live discovery (model-discovery.ts) adds whatever else
 * each provider's API exposes with guessed metadata.
 */
const CURATED: ModelInfo[] = [
  // —— Anthropic ——
  def({ provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", family: "fable", status: "current", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_000_000, description: "Anthropic's frontier model — deepest reasoning, long-horizon agents." }),
  def({ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8", family: "opus", status: "current", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_000_000, description: "Most capable Opus — complex agentic coding and hard tasks." }),
  def({ provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", family: "sonnet", status: "current", minPlan: "FREE", vision: true, cost: 2, contextWindow: 1_000_000, description: "Best speed-to-intelligence balance — near-Opus quality for everyday work." }),
  def({ provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", family: "haiku", status: "current", minPlan: "FREE", vision: true, reasoning: true, cost: 1, contextWindow: 200_000, description: "Fastest, most cost-effective Claude — great for high-volume tasks." }),
  def({ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", family: "sonnet", status: "legacy", minPlan: "FREE", vision: true, cost: 2, contextWindow: 1_000_000, description: "Previous-generation Sonnet, superseded by Sonnet 5." }),
  def({ provider: "anthropic", id: "claude-opus-4-7", name: "Claude Opus 4.7", family: "opus", status: "legacy", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_000_000, description: "Previous-generation Opus." }),
  def({ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", family: "opus", status: "legacy", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_000_000, description: "Older Opus generation." }),
  def({ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", family: "opus", status: "legacy", minPlan: "PRO", vision: true, cost: 3, contextWindow: 200_000, description: "Older Opus, 200K context." }),
  def({ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", family: "sonnet", status: "legacy", minPlan: "FREE", vision: true, cost: 2, contextWindow: 200_000, description: "Older Sonnet, 200K context." }),
  def({ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1", family: "opus", status: "deprecated", minPlan: "PRO", vision: true, cost: 3, contextWindow: 200_000, description: "Deprecated by Anthropic.", deprecationNote: "Retires Aug 5, 2026 — use Claude Opus 4.8" }),

  // —— OpenAI ——
  def({ provider: "openai", id: "gpt-5.5", name: "GPT-5.5", family: "gpt", status: "current", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_050_000, description: "OpenAI's flagship — complex reasoning, agents, and long context." }),
  def({ provider: "openai", id: "gpt-5.5-pro", name: "GPT-5.5 Pro", family: "gpt-pro", status: "current", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_050_000, description: "Pro-tier reasoning for the hardest problems — quality over latency." }),
  def({ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", family: "gpt-value", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 1_050_000, description: "Affordable frontier tier for coding and professional work." }),
  def({ provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 Mini", family: "gpt-mini", status: "current", minPlan: "FREE", vision: true, cost: 1, contextWindow: 400_000, description: "OpenAI's strongest mini — fast, cheap coding and subagents." }),
  def({ provider: "openai", id: "gpt-5.4-nano", name: "GPT-5.4 Nano", family: "gpt-nano", status: "current", minPlan: "FREE", vision: true, cost: 1, description: "Cheapest, lowest-latency tier for high-volume simple tasks." }),
  def({ provider: "openai", id: "gpt-5.4-pro", name: "GPT-5.4 Pro", family: "gpt-pro", status: "legacy", minPlan: "PRO", vision: true, cost: 3, description: "Previous pro-tier reasoning model — use GPT-5.5 Pro." }),
  def({ provider: "openai", id: "gpt-5", name: "GPT-5", family: "gpt", status: "deprecated", minPlan: "PRO", vision: true, cost: 2, description: "First GPT-5 release.", deprecationNote: "Retires Dec 11, 2026 — use GPT-5.5" }),
  def({ provider: "openai", id: "gpt-5-mini", name: "GPT-5 Mini", family: "gpt-mini", status: "deprecated", minPlan: "FREE", vision: true, cost: 1, description: "Early GPT-5 mini.", deprecationNote: "Retires Dec 11, 2026 — use GPT-5.4 Mini" }),
  def({ provider: "openai", id: "o3", name: "OpenAI o3", family: "o-series", status: "deprecated", minPlan: "PRO", vision: true, reasoning: true, cost: 3, description: "o-series reasoning model.", deprecationNote: "Retires Dec 11, 2026 — use GPT-5.5" }),
  def({ provider: "openai", id: "o3-mini", name: "OpenAI o3-mini", family: "o-series-mini", status: "deprecated", minPlan: "PRO", reasoning: true, cost: 1, description: "Fast o-series reasoning.", deprecationNote: "Retires Oct 23, 2026 — use GPT-5.4 Mini" }),
  def({ provider: "openai", id: "o1", name: "OpenAI o1", family: "o-series", status: "deprecated", minPlan: "PRO", vision: true, reasoning: true, cost: 3, contextWindow: 200_000, description: "Early reasoning model, two generations behind.", deprecationNote: "Deprecated by OpenAI — use GPT-5.5" }),
  def({ provider: "openai", id: "gpt-4o", name: "GPT-4o", family: "gpt-4o", status: "deprecated", minPlan: "FREE", vision: true, cost: 2, contextWindow: 128_000, description: "Classic multimodal GPT-4o.", deprecationNote: "Retires Oct 23, 2026 — use GPT-5.5" }),
  def({ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o Mini", family: "gpt-4o-mini", status: "deprecated", minPlan: "FREE", vision: true, cost: 1, contextWindow: 128_000, description: "Small GPT-4o tier.", deprecationNote: "Deprecated by OpenAI — use GPT-5.4 Mini" }),
  def({ provider: "openai", id: "gpt-4-turbo", name: "GPT-4 Turbo", family: "gpt-4", status: "deprecated", minPlan: "PRO", vision: true, cost: 2, description: "Legacy GPT-4 flagship.", deprecationNote: "Retires Oct 23, 2026 — use GPT-5.5" }),
  def({ provider: "openai", id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", family: "gpt-3.5", status: "deprecated", minPlan: "FREE", cost: 1, description: "Legacy fast model.", deprecationNote: "Retires Oct 23, 2026 — use GPT-5.4 Mini" }),

  // —— Google ——
  def({ provider: "google", id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", family: "flash", status: "current", minPlan: "FREE", vision: true, cost: 2, contextWindow: 1_048_576, description: "Google's GA flagship — frontier performance at Flash speed." }),
  def({ provider: "google", id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", family: "pro", status: "current", minPlan: "PRO", vision: true, cost: 3, contextWindow: 1_048_576, description: "Highest Gemini intelligence — complex reasoning and hard coding (preview)." }),
  def({ provider: "google", id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite", family: "flash-lite", status: "current", minPlan: "FREE", vision: true, cost: 1, description: "High-volume, low-latency, cost-sensitive tier." }),
  def({ provider: "google", id: "gemini-3-flash-preview", name: "Gemini 3 Flash", family: "flash", status: "legacy", minPlan: "FREE", vision: true, cost: 1, description: "Previous Flash generation (preview), superseded by 3.5 Flash." }),
  def({ provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", family: "pro", status: "deprecated", minPlan: "PRO", vision: true, cost: 3, description: "2.5-generation Pro.", deprecationNote: "Retires Oct 16, 2026 — use Gemini 3.1 Pro" }),
  def({ provider: "google", id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", family: "flash", status: "deprecated", minPlan: "FREE", vision: true, cost: 1, description: "2.5-generation Flash.", deprecationNote: "Retires Oct 16, 2026 — use Gemini 3.5 Flash" }),

  // —— Zhipu / Z.AI ——
  def({ provider: "zhipu", id: "glm-5.2", name: "GLM-5.2", family: "glm", status: "current", minPlan: "PRO", cost: 2, contextWindow: 1_000_000, description: "Z.AI's flagship — frontier reasoning and 1M-token context." }),
  def({ provider: "zhipu", id: "glm-5-turbo", name: "GLM-5 Turbo", family: "glm-turbo", status: "current", minPlan: "PRO", cost: 2, contextWindow: 200_000, description: "Fast, low-latency tier of the GLM-5 generation." }),
  def({ provider: "zhipu", id: "glm-5v-turbo", name: "GLM-5V Turbo", family: "glm-v", status: "current", minPlan: "PRO", vision: true, cost: 2, description: "Latest GLM vision-language model — image understanding." }),
  def({ provider: "zhipu", id: "glm-4.7-flash", name: "GLM-4.7 Flash", family: "glm-flash", status: "current", minPlan: "FREE", cost: 1, contextWindow: 200_000, description: "Current free-tier GLM — capable and completely free." }),
  def({ provider: "zhipu", id: "glm-5.1", name: "GLM-5.1", family: "glm", status: "legacy", minPlan: "PRO", cost: 2, contextWindow: 200_000, description: "Previous GLM flagship." }),
  def({ provider: "zhipu", id: "glm-5", name: "GLM-5", family: "glm", status: "legacy", minPlan: "PRO", cost: 2, contextWindow: 200_000, description: "First 5-series GLM." }),
  def({ provider: "zhipu", id: "glm-4.7", name: "GLM-4.7", family: "glm", status: "legacy", minPlan: "PRO", cost: 1, contextWindow: 200_000, description: "Cheaper previous-generation workhorse." }),
  def({ provider: "zhipu", id: "glm-4.6", name: "GLM-4.6", family: "glm", status: "legacy", minPlan: "PRO", cost: 1, description: "Older 4.x generation." }),
  def({ provider: "zhipu", id: "glm-4.6v", name: "GLM-4.6V", family: "glm-v", status: "legacy", minPlan: "FREE", vision: true, cost: 1, description: "Previous-generation vision model." }),
  def({ provider: "zhipu", id: "glm-4.5-flash", name: "GLM-4.5 Flash", family: "glm-flash", status: "legacy", minPlan: "FREE", cost: 1, contextWindow: 128_000, description: "Older free-tier model." }),

  // —— Moonshot / Kimi ——
  def({ provider: "moonshot", id: "kimi-k2.6", name: "Kimi K2.6", family: "kimi", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 262_144, description: "Kimi flagship — multimodal (image + video input) with toggleable thinking." }),
  def({ provider: "moonshot", id: "kimi-k2.7-code", name: "Kimi K2.7 Code", family: "kimi-code", status: "current", minPlan: "PRO", cost: 2, contextWindow: 262_144, description: "Strongest Kimi coding model — always-on thinking, agentic coding." }),
  def({ provider: "moonshot", id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code High-Speed", family: "kimi-code-highspeed", status: "current", minPlan: "PRO", cost: 3, contextWindow: 262_144, description: "K2.7 Code served at ~180 tok/s for latency-sensitive agent loops." }),
  def({ provider: "moonshot", id: "kimi-k2.5", name: "Kimi K2.5", family: "kimi", status: "legacy", minPlan: "FREE", vision: true, cost: 1, contextWindow: 262_144, description: "Cheaper multimodal Kimi, superseded by K2.6." }),
  def({ provider: "moonshot", id: "moonshot-v1-128k", name: "Moonshot v1 128K", family: "moonshot-v1", status: "legacy", minPlan: "FREE", cost: 2, contextWindow: 131_072, description: "Legacy long-context text model." }),

  // —— DeepSeek ——
  def({ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "v4-flash", status: "current", minPlan: "FREE", cost: 1, contextWindow: 1_000_000, description: "Fast, very cheap default — near-Pro reasoning at a third of the cost." }),
  def({ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "v4-pro", status: "current", minPlan: "PRO", cost: 2, contextWindow: 1_000_000, description: "DeepSeek flagship — hardest reasoning and complex agent tasks." }),
  def({ provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat", family: "v4-flash", status: "deprecated", minPlan: "FREE", cost: 1, contextWindow: 1_000_000, description: "Legacy alias routing to V4 Flash.", deprecationNote: "Retires Jul 24, 2026 — use DeepSeek V4 Flash" }),
  def({ provider: "deepseek", id: "deepseek-reasoner", name: "DeepSeek Reasoner", family: "v4-flash", status: "deprecated", minPlan: "PRO", reasoning: true, cost: 1, contextWindow: 1_000_000, description: "Legacy alias routing to V4 Flash (thinking).", deprecationNote: "Retires Jul 24, 2026 — use DeepSeek V4 Flash" }),

  // —— Mistral ——
  def({ provider: "mistral", id: "mistral-medium-latest", name: "Mistral Medium 3.5", family: "medium", status: "current", minPlan: "PRO", vision: true, reasoning: true, cost: 2, contextWindow: 262_144, description: "Mistral's frontier multimodal model — agentic work with reasoning effort." }),
  def({ provider: "mistral", id: "mistral-large-latest", name: "Mistral Large 3", family: "large", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 262_144, description: "Open-weight multimodal flagship at a very low price." }),
  def({ provider: "mistral", id: "mistral-small-latest", name: "Mistral Small 4", family: "small", status: "current", minPlan: "FREE", vision: true, reasoning: true, cost: 1, contextWindow: 262_144, description: "Cost-efficient hybrid — instruct, reasoning, and vision in one." }),
  def({ provider: "mistral", id: "codestral-latest", name: "Codestral", family: "codestral", status: "current", minPlan: "PRO", cost: 1, contextWindow: 262_144, description: "Low-latency code completion and fill-in-the-middle." }),
  def({ provider: "mistral", id: "ministral-14b-latest", name: "Ministral 3 14B", family: "ministral", status: "current", minPlan: "FREE", cost: 1, description: "Small dense model — strong cost/performance for high volume." }),
  def({ provider: "mistral", id: "magistral-medium-2509", name: "Magistral Medium", family: "magistral", status: "deprecated", minPlan: "PRO", reasoning: true, cost: 3, description: "Dedicated reasoning line, folded into Medium 3.5.", deprecationNote: "Retires Jul 31, 2026 — use Mistral Medium 3.5" }),
  def({ provider: "mistral", id: "devstral-2512", name: "Devstral 2", family: "devstral", status: "deprecated", minPlan: "PRO", cost: 2, contextWindow: 262_144, description: "Code-agent model, superseded.", deprecationNote: "Deprecated May 2026 — use Mistral Medium 3.5" }),

  // —— xAI / Grok ——
  def({ provider: "xai", id: "grok-4.3", name: "Grok 4.3", family: "grok", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 1_000_000, description: "xAI's recommended flagship — chat, coding, and agentic tool calling." }),
  def({ provider: "xai", id: "grok-build-0.1", name: "Grok Build 0.1", family: "grok-build", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 256_000, description: "Fast agentic coding — successor to Grok Code Fast." }),
  def({ provider: "xai", id: "grok-4.20-multi-agent-0309", name: "Grok 4.20 Multi-Agent", family: "grok-multi-agent", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 1_000_000, description: "Parallel multi-agent deep research (beta)." }),
  def({ provider: "xai", id: "grok-4.20-0309-reasoning", name: "Grok 4.20 (Reasoning)", family: "grok", status: "legacy", minPlan: "PRO", vision: true, reasoning: true, cost: 2, contextWindow: 1_000_000, description: "Previous flagship reasoning Grok." }),
  def({ provider: "xai", id: "grok-4.20-0309-non-reasoning", name: "Grok 4.20", family: "grok", status: "legacy", minPlan: "PRO", vision: true, reasoning: false, cost: 2, contextWindow: 1_000_000, description: "Low-latency non-thinking Grok 4.20." }),

  // —— MiniMax ——
  def({ provider: "minimax", id: "MiniMax-M3", name: "MiniMax M3", family: "m", status: "current", minPlan: "PRO", vision: true, cost: 2, contextWindow: 1_000_000, description: "Frontier coding and agentic work — 1M context, multimodal input." }),
  def({ provider: "minimax", id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed", family: "m-highspeed", status: "current", minPlan: "FREE", cost: 2, contextWindow: 204_800, description: "Fastest MiniMax text tier for low-latency agent loops." }),
  def({ provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax M2.7", family: "m", status: "legacy", minPlan: "PRO", cost: 1, contextWindow: 204_800, description: "Agentic coding without 1M context — superseded by M3." }),
  def({ provider: "minimax", id: "MiniMax-M2.5", name: "MiniMax M2.5", family: "m", status: "legacy", minPlan: "FREE", cost: 1, contextWindow: 204_800, description: "Older agentic model." }),
];

/** Image / video generation models — grouped by lab in the picker; each runs
 *  through /api/generate (not the chat stream). Hidden unless the lab's key is set. */
const GENERATIVE: ModelInfo[] = [
  // —— Image ——
  def({ provider: "openai", id: "gpt-image-2", name: "GPT Image 2", family: "gpt-image", status: "current", modality: "image", minPlan: "PRO", cost: 3, description: "OpenAI's state-of-the-art image generation and editing." }),
  def({ provider: "openai", id: "gpt-image-1", name: "GPT Image 1", family: "gpt-image", status: "deprecated", modality: "image", minPlan: "PRO", cost: 2, description: "Previous OpenAI image model.", deprecationNote: "Retires Oct 23, 2026 — use GPT Image 2" }),
  def({ provider: "google", id: "gemini-3-pro-image", name: "Nano Banana Pro", family: "gemini-image-pro", status: "current", modality: "image", minPlan: "PRO", cost: 3, description: "Premium image generation — complex composition, text rendering, 4K." }),
  def({ provider: "google", id: "gemini-3.1-flash-image", name: "Nano Banana 2", family: "gemini-image-flash", status: "current", modality: "image", minPlan: "PRO", cost: 2, description: "Workhorse image generation — 4K, references, Search grounding." }),
  def({ provider: "google", id: "gemini-3.1-flash-lite-image", name: "Nano Banana 2 Lite", family: "gemini-image-lite", status: "current", modality: "image", minPlan: "FREE", cost: 1, description: "Fastest, cheapest image generation for rapid ideation." }),
  def({ provider: "google", id: "gemini-2.5-flash-image", name: "Nano Banana", family: "gemini-image-flash", status: "deprecated", modality: "image", minPlan: "PRO", cost: 2, description: "Pioneer Gemini image model.", deprecationNote: "Retires Oct 2, 2026 — use Nano Banana 2" }),
  def({ provider: "google", id: "imagen-4.0-generate-001", name: "Imagen 4", family: "imagen", status: "deprecated", modality: "image", minPlan: "PRO", cost: 2, description: "Last of the Imagen line.", deprecationNote: "Retires Aug 17, 2026 — use Nano Banana 2" }),
  def({ provider: "xai", id: "grok-imagine-image-quality", name: "Grok Imagine (Quality)", family: "imagine-image", status: "current", modality: "image", minPlan: "PRO", cost: 2, description: "xAI's recommended image model — generation and editing." }),
  def({ provider: "xai", id: "grok-imagine-image", name: "Grok Imagine (Fast)", family: "imagine-image-fast", status: "current", modality: "image", minPlan: "PRO", cost: 1, description: "Fast, low-cost image tier." }),
  def({ provider: "zhipu", id: "glm-image", name: "GLM Image", family: "glm-image", status: "current", modality: "image", minPlan: "PRO", cost: 2, description: "Z.AI's flagship image model — posters and in-image text." }),
  def({ provider: "zhipu", id: "cogview-4", name: "CogView-4", family: "cogview", status: "legacy", modality: "image", minPlan: "PRO", cost: 1, description: "Older Zhipu image model." }),
  def({ provider: "minimax", id: "image-01", name: "MiniMax Image-01", family: "image", status: "current", modality: "image", minPlan: "PRO", cost: 2, description: "Fine-grained text-to-image with reference support." }),

  // —— Video ——
  def({ provider: "google", id: "veo-3.1-generate-preview", name: "Veo 3.1", family: "veo", status: "current", modality: "video", minPlan: "MAX", cost: 3, description: "Cinematic video with native synchronized audio, up to 4K." }),
  def({ provider: "google", id: "veo-3.1-fast-generate-preview", name: "Veo 3.1 Fast", family: "veo-fast", status: "current", modality: "video", minPlan: "MAX", cost: 2, description: "Faster, cheaper Veo tier." }),
  def({ provider: "google", id: "gemini-omni-flash-preview", name: "Gemini Omni Flash", family: "gemini-omni", status: "current", modality: "video", minPlan: "MAX", cost: 2, description: "Conversational video generation and editing (preview)." }),
  def({ provider: "xai", id: "grok-imagine-video", name: "Grok Imagine Video", family: "imagine-video", status: "current", modality: "video", minPlan: "MAX", cost: 2, description: "Text-, image-, and video-to-video generation." }),
  def({ provider: "xai", id: "grok-imagine-video-1.5", name: "Grok Imagine Video 1.5", family: "imagine-video-15", status: "current", modality: "video", minPlan: "MAX", cost: 3, description: "Higher-fidelity image-to-video (preview)." }),
  def({ provider: "seedance", id: "dreamina-seedance-2-0-260128", name: "Seedance 2.0", family: "seedance", status: "current", modality: "video", minPlan: "MAX", cost: 3, description: "ByteDance flagship — multimodal references, native audio, up to 4K." }),
  def({ provider: "seedance", id: "dreamina-seedance-2-0-fast-260128", name: "Seedance 2.0 Fast", family: "seedance-fast", status: "current", modality: "video", minPlan: "MAX", cost: 2, description: "Faster, cheaper Seedance 2.0 tier." }),
  def({ provider: "seedance", id: "dreamina-seedance-2-0-mini-260615", name: "Seedance 2.0 Mini", family: "seedance-mini", status: "current", modality: "video", minPlan: "MAX", cost: 1, description: "Cheapest Seedance tier with draft modes." }),
  def({ provider: "seedance", id: "seedance-1-5-pro-251215", name: "Seedance 1.5 Pro", family: "seedance", status: "legacy", modality: "video", minPlan: "MAX", cost: 3, description: "First Seedance with synchronized audio." }),
  def({ provider: "seedance", id: "seedance-1-0-pro-250528", name: "Seedance 1.0 Pro", family: "seedance", status: "legacy", modality: "video", minPlan: "MAX", cost: 3, description: "Silent-video generation, two generations back." }),
  def({ provider: "zhipu", id: "cogvideox-3", name: "CogVideoX", family: "cogvideox", status: "current", modality: "video", minPlan: "MAX", cost: 3, description: "Zhipu text-to-video, up to 4K." }),
  def({ provider: "minimax", id: "MiniMax-Hailuo-2.3", name: "Hailuo 2.3", family: "hailuo", status: "current", modality: "video", minPlan: "MAX", cost: 3, description: "MiniMax text/image-to-video with strong motion." }),
  def({ provider: "minimax", id: "MiniMax-Hailuo-2.3-Fast", name: "Hailuo 2.3 Fast", family: "hailuo-fast", status: "current", modality: "video", minPlan: "MAX", cost: 2, description: "Low-latency image-to-video tier." }),
  def({ provider: "minimax", id: "MiniMax-Hailuo-02", name: "Hailuo 02", family: "hailuo", status: "legacy", modality: "video", minPlan: "MAX", cost: 3, description: "Previous-generation Hailuo." }),
];

// —— Generated-sync merge (src/lib/models.generated.ts, written by scripts/sync-models.ts) ——

const UNAVAILABLE_IDS = new Set(UNAVAILABLE);
const CURATED_IDS = new Set([...CURATED, ...GENERATIVE].map((m) => m.id));
// Same dedup rule as live discovery: a curated model name always wins.
const CURATED_CHAT_NAME_KEYS = new Set(CURATED.map((m) => `${m.provider}:${m.name.toLowerCase()}`));

/** Auto-discovered models: dumb {provider,id,name} records from the generated
 *  file get full (guessed) metadata here, pending hand-curation. */
const DISCOVERED_MODELS: ModelInfo[] = DISCOVERED.filter(
  (d) => !CURATED_IDS.has(`${d.provider}:${d.id}`) && !CURATED_CHAT_NAME_KEYS.has(`${d.provider}:${d.name.toLowerCase()}`)
).map((d) => ({
  id: `${d.provider}:${d.id}`,
  provider: d.provider,
  providerModel: d.id,
  name: d.name,
  description: `New ${PROVIDERS[d.provider].label.split("·")[0].trim()} model, auto-discovered — metadata estimated pending curation.`,
  minPlan: guessPlan(d.id),
  vision: guessVision(d.id),
  reasoning: guessReasoning(d.id),
  cost: guessCost(d.id),
  modality: "chat",
  webSearch: providerSupportsWebSearch(d.provider),
  status: "current",
  family: d.id, // its own family — never competes with curated "current" slots
  legacy: false,
}));

/** Raw curated lists (UNAVAILABLE entries included) — for scripts/validation. */
export const CURATED_CHAT_MODELS: readonly ModelInfo[] = CURATED;
export const CURATED_GEN_MODELS: readonly ModelInfo[] = GENERATIVE;

export const GEN_MODELS: ModelInfo[] = GENERATIVE.filter((m) => !UNAVAILABLE_IDS.has(m.id));

/**
 * How a provider's image models can edit an existing image (client-safe —
 * no server-only imports):
 *  - "mask"   — supports a pixel mask marking the region to edit.
 *  - "prompt" — reference-style edits only; the region is conveyed in the prompt.
 *  - "none"   — the provider can't edit images.
 */
export type ImageEditSupport = "mask" | "prompt" | "none";

const IMAGE_EDIT_SUPPORT: Partial<Record<Provider, ImageEditSupport>> = {
  openai: "mask",
  xai: "mask",
  zhipu: "mask",
  google: "mask",
  minimax: "prompt",
};

export function imageEditSupport(provider: Provider): ImageEditSupport {
  return IMAGE_EDIT_SUPPORT[provider] ?? "none";
}

/**
 * Models that are NO LONGER CALLABLE (provider-retired) or never existed under
 * that id. Stored ids silently migrate to the replacement so old settings,
 * conversations, and links keep working. Verified per docs/models.md.
 */
export const RETIRED_MODELS: Record<string, ModelId> = {
  // Anthropic — Claude 3.x line fully retired.
  "anthropic:claude-3-5-sonnet-20241022": "anthropic:claude-sonnet-5",
  "anthropic:claude-3-5-sonnet-20240620": "anthropic:claude-sonnet-5",
  "anthropic:claude-3-5-haiku-20241022": "anthropic:claude-haiku-4-5",
  "anthropic:claude-3-opus-20240229": "anthropic:claude-opus-4-8",
  "anthropic:claude-3-sonnet-20240229": "anthropic:claude-sonnet-5",
  "anthropic:claude-3-haiku-20240307": "anthropic:claude-haiku-4-5",
  // OpenAI — retired ids + ids that never existed in the API.
  "openai:gpt-5.5-thinking": "openai:gpt-5.5", // ChatGPT product name, never an API id
  "openai:gpt-5.5-mini": "openai:gpt-5.4-mini", // never existed; current mini is 5.4
  "openai:o1-preview": "openai:gpt-5.5", // shut down 2025-07-28
  "openai:o1-mini": "openai:gpt-5.4-mini", // shut down 2025-10-27
  "openai:dall-e-3": "openai:gpt-image-2", // shut down 2026-05-12
  "openai:dall-e-2": "openai:gpt-image-2", // shut down 2026-05-12
  // Google — marketing names listed as chat models + retired Imagen/Veo ids.
  "google:nano-banana-pro": "google:gemini-3.5-flash", // was mis-listed as a chat model
  "google:nano-banana-2": "google:gemini-3.5-flash", // was mis-listed as a chat model
  "google:imagen-3.0-generate-002": "google:gemini-3.1-flash-image", // shut down 2025-11-10
  "google:imagen-3.0-fast-002": "google:gemini-3.1-flash-lite-image", // id never existed; line retired
  "google:veo-3.0-generate-001": "google:veo-3.1-generate-preview", // shut down 2026-06-30
  "google:veo-2.0": "google:veo-3.1-generate-preview", // wrong id + shut down 2026-06-30
  // Zhipu
  "zhipu:glm-4-plus": "zhipu:glm-5.2", // absent from all current Z.AI/bigmodel listings
  // Moonshot — the whole kimi-k2 (K2.0) series was discontinued 2026-05-25.
  "moonshot:kimi-k2": "moonshot:kimi-k2.6",
  // DeepSeek — coder merged into chat back in 2024; id no longer valid.
  "deepseek:deepseek-coder": "deepseek:deepseek-v4-flash",
  // xAI — May 15, 2026 retirement wave + ids that never existed.
  "xai:grok-4": "xai:grok-4.3",
  "xai:grok-2": "xai:grok-4.3",
  "xai:grok-beta": "xai:grok-4.3",
  "xai:grok-3": "xai:grok-4.3",
  "xai:grok-3-image": "xai:grok-imagine-image-quality", // never existed
  "xai:grok-2-image": "xai:grok-imagine-image-quality", // retired 2026-02-28 (real id grok-2-image-1212)
};

/** Map a stored/legacy model id to its living replacement (identity if fine). */
export function migrateModelId(id: ModelId): ModelId {
  return RETIRED_MODELS[id] ?? id;
}

const ALL_CURATED_BY_ID = new Map([...CURATED, ...GENERATIVE].map((m) => [m.id, m]));

/** Sync-pruned (UNAVAILABLE) ids keep resolving: route to the current model of
 *  the same provider+family, else DEFAULT_MODEL, so stored ids never dangle. */
function migrateUnavailableId(id: ModelId): ModelId {
  if (!UNAVAILABLE_IDS.has(id)) return id;
  const dead = ALL_CURATED_BY_ID.get(id);
  if (dead) {
    const heir = [...CURATED, ...GENERATIVE].find(
      (m) =>
        m.provider === dead.provider &&
        m.family === dead.family &&
        m.modality === dead.modality &&
        m.status === "current" &&
        !UNAVAILABLE_IDS.has(m.id)
    );
    if (heir) return heir.id;
  }
  return DEFAULT_MODEL;
}

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
  [...CURATED, ...GENERATIVE, ...DISCOVERED_MODELS]
    .filter((m) => !UNAVAILABLE_IDS.has(m.id))
    .map((m) => [m.id, m])
);
// Initial client list is chat-only; image/video models load via /api/models
// (only for labs whose key is set), avoiding a flash of unconfigured providers.
export const MODEL_LIST: ModelInfo[] = [...CURATED.filter((m) => !UNAVAILABLE_IDS.has(m.id)), ...DISCOVERED_MODELS];

// Legacy bare ids (stored before namespacing) -> namespaced id.
const LEGACY_ALIAS: Record<string, string> = Object.fromEntries(CURATED.map((m) => [m.providerModel, m.id]));

export const DEFAULT_MODEL: ModelId = "anthropic:claude-sonnet-5";

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

/** Build a ModelInfo for any id — curated metadata if known, else guessed.
 *  Retired and sync-pruned (UNAVAILABLE) ids transparently resolve to their
 *  replacement so stale settings never route to a dead provider id. */
export function resolveModel(id: string): ModelInfo | null {
  const ref = parseModelRef(id);
  if (!ref) return null;
  const canonical = migrateUnavailableId(migrateModelId(`${ref.provider}:${ref.providerModel}`));
  const known = MODELS[canonical];
  if (known) return known;
  const migrated = parseModelRef(canonical);
  if (!migrated) return null;
  return {
    id: canonical,
    provider: migrated.provider,
    providerModel: migrated.providerModel,
    name: prettifyModelName(migrated.providerModel),
    minPlan: guessPlan(migrated.providerModel),
    vision: guessVision(migrated.providerModel),
    reasoning: guessReasoning(migrated.providerModel),
    cost: guessCost(migrated.providerModel),
    modality: "chat",
    webSearch: providerSupportsWebSearch(migrated.provider),
    status: "current",
    legacy: false,
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
