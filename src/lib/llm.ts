import "server-only";
import { streamAnthropic } from "@/lib/anthropic";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamOpenAIResponses } from "@/lib/openai-responses";
import { streamGeminiSearch } from "@/lib/gemini-search";
import { anthropicMcpServers, openMcpToolset, type ActiveConnector, type McpToolset } from "@/lib/mcp";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

/** Provider-agnostic streaming: routes Anthropic to its native SDK, everything
 *  else through the OpenAI-compatible adapter. Yields text + sources + usage. */
// Safe upper bound on generated tokens per provider. The requested cap (from the
// user's plan) is clamped to this so a high value never exceeds a model's own
// limit. Anthropic is kept lower because its thinking budget is added on top.
const PROVIDER_MAX_OUTPUT: Record<string, number> = {
  anthropic: 20000,
  // GPT-5.x supports far larger outputs, and hidden reasoning counts toward
  // this budget — too tight a cap starves the visible answer on high effort.
  openai: 32000,
  google: 32000,
  zhipu: 131072,
  moonshot: 16384,
  deepseek: 16384,
  mistral: 16384,
  xai: 16384,
  seedance: 8192,
  minimax: 131072,
  mimo: 16384,
  qwen: 32768,
};

/** Clamp a requested output-token cap to what the provider's models actually allow. */
export function clampMaxTokens(provider: string, requested: number): number {
  return Math.min(Math.max(1024, requested), PROVIDER_MAX_OUTPUT[provider] ?? 8192);
}

export async function* streamChat(opts: {
  model: ModelInfo;
  system: string;
  history: MessageForModel[];
  maxTokens: number;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
  /** Linked tool connectors (GitHub/Figma…) to expose to the model. */
  connectors?: ActiveConnector[];
  /** Per-request dynamic context (date, etc.) appended AFTER each provider's
   *  stable cached prefix — never into the system prompt itself. */
  dynamicContext?: string;
  /** Stable id grouping requests that share a prompt prefix (conversation id).
   *  Used as OpenAI's prompt_cache_key to raise automatic cache hit rates. */
  cacheKey?: string;
  /** Premium "fast mode": Anthropic speed:"fast" / OpenAI service_tier:"priority".
   *  The route only sets this on models that support it. */
  fastMode?: boolean;
}): AsyncGenerator<LlmEvent> {
  const { model, system, history, signal, reasoningEffort, webSearch, dynamicContext, cacheKey, fastMode } = opts;
  // On OpenAI-compatible providers, reasoning/thinking tokens count toward the
  // completion budget — a plan-sized cap can be eaten entirely by thinking,
  // truncating the answer ("length" with little or no visible text). Add an
  // effort-scaled allowance ON TOP of the plan cap (mirroring the Anthropic
  // path, where the thinking budget is added separately). Models that always
  // reason with no effort control (o-series-style, kimi-code, magistral…) reach
  // the route with a null effort but still burn thinking tokens — give them the
  // "high" allowance. Each provider's own ceiling still applies.
  const alwaysReasons = model.reasoning && !reasoningCaps(model).canDisable;
  const thinkingTier = model.provider === "anthropic" ? null : (reasoningEffort ?? (alwaysReasons ? "high" : null));
  const thinkingAllowance = thinkingTier
    ? { minimal: 2048, low: 4096, medium: 8192, high: 16384, xhigh: 24576, max: 32768 }[thinkingTier]
    : 0;
  const maxTokens = clampMaxTokens(model.provider, opts.maxTokens + thinkingAllowance);
  const active = opts.connectors ?? [];

  // Native web search uses each provider's own tool/grounding (no third party).
  if (webSearch && model.provider === "google") {
    yield* streamGeminiSearch(model, system, history, maxTokens, signal, dynamicContext);
    return;
  }
  if (model.provider === "anthropic") {
    // Claude reaches MCP servers itself via the native connector.
    yield* streamAnthropic(
      model, system, history, maxTokens, signal, reasoningEffort, webSearch,
      active.length ? anthropicMcpServers(active) : undefined, dynamicContext, fastMode
    );
    return;
  }
  // Everyone else: we open the MCP tools here and run the tool loop ourselves.
  let toolset: McpToolset | undefined;
  if (active.length) {
    try {
      toolset = await openMcpToolset(active);
    } catch {
      toolset = undefined;
    }
  }
  try {
    // gpt-*-pro and Responses-only Codex snapshots aren't served on
    // /chat/completions — they take the Responses API adapter instead.
    const streamFn = model.provider === "openai" && model.api === "responses"
      ? streamOpenAIResponses
      : streamOpenAICompat;
    yield* streamFn(model, system, history, maxTokens, signal, reasoningEffort, webSearch, toolset, dynamicContext, cacheKey, fastMode);
  } finally {
    if (toolset) await toolset.close();
  }
}

/** Turn a provider/SDK error into a clear, user-facing message. */
export function providerErrorMessage(err: unknown, providerLabel?: string): string {
  const e = err as { status?: number; message?: string; error?: { message?: string } | string };
  const errObj = typeof e?.error === "object" ? e.error : undefined;
  const raw = (errObj?.message || (typeof e?.error === "string" ? e.error : "") || e?.message || "").toString();
  const lower = raw.toLowerCase();
  const status = e?.status;
  const who = providerLabel ? `${providerLabel}` : "This model's provider";

  if (status === 401 || /invalid.*api.?key|invalid x-api-key|authentication|unauthorized/i.test(raw))
    return `${who} rejected its API key — double-check that key in your environment.`;
  if (status === 402 || /balance|insufficient|recharge|no\s*(remaining)?\s*(credit|quota|resource)|余额|充值/i.test(lower))
    return `${who} reports no remaining balance or quota. Top up that account, or pick another model.`;
  if (status === 403 || /denied|permission|not\s*allow|forbidden/i.test(lower))
    return `${who} denied access — make sure the model/API is enabled for that account.`;
  if (status === 429 || /rate.?limit|overloaded|too many/i.test(lower))
    return `${who} is busy or rate-limiting right now. Try again in a moment.`;
  if (status === 404 || /not found|does not exist|unknown model|no such model/i.test(lower))
    return `That model isn't available from ${providerLabel ?? "the provider"} right now. Pick another model.`;
  // 5xx (incl. Google's frequent 503 "no body") — a transient fault on the
  // provider's side, not the user's request. Suggest a retry instead of a raw code.
  if ((typeof status === "number" && status >= 500) || /50[0-4]|server error|unavailable|bad gateway|gateway timeout|no body|internal error/i.test(lower))
    return `${who} is temporarily unavailable (a server error on their end). Please try again in a moment.`;
  return raw ? `${who} returned an error: ${raw.slice(0, 220)}` : "Juno ran into a problem generating a response. Please try again.";
}
