import "server-only";
import { streamAnthropic } from "@/lib/anthropic";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamGeminiSearch } from "@/lib/gemini-search";
import type { ModelInfo } from "@/lib/models";
import type { LlmEvent, MessageForModel } from "@/types/llm";

/** Provider-agnostic streaming: routes Anthropic to its native SDK, everything
 *  else through the OpenAI-compatible adapter. Yields text + sources + usage. */
export type ReasoningEffort = "low" | "medium" | "high";

export function streamChat(opts: {
  model: ModelInfo;
  system: string;
  history: MessageForModel[];
  maxTokens: number;
  signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
}): AsyncGenerator<LlmEvent> {
  const { model, system, history, maxTokens, signal, reasoningEffort, webSearch } = opts;
  // Native web search uses each provider's own tool/grounding (no third party).
  if (webSearch && model.provider === "google") {
    return streamGeminiSearch(model, system, history, maxTokens, signal);
  }
  return model.provider === "anthropic"
    ? streamAnthropic(model, system, history, maxTokens, signal, reasoningEffort, webSearch)
    : streamOpenAICompat(model, system, history, maxTokens, signal, reasoningEffort, webSearch);
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
  return raw ? `${who} returned an error: ${raw.slice(0, 220)}` : "Juno ran into a problem generating a response. Please try again.";
}
