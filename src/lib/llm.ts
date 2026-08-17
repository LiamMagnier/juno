import "server-only";
import { streamAnthropic } from "@/lib/anthropic";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamOpenAIResponses } from "@/lib/openai-responses";
import { streamGeminiSearch } from "@/lib/gemini-search";
import { openUnifiedAgentToolset } from "@/lib/agent/runtime";
import type { AgentExecutionContext, AgentMode } from "@/lib/agent/types";
import { type ActiveConnector, type McpToolset, type McpToolsetContext } from "@/lib/mcp";
import { reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { normalizeProviderError } from "@/lib/provider-error";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

/** Provider-agnostic streaming: routes Anthropic to its native SDK, everything
 *  else through the OpenAI-compatible adapter. Yields text + sources + usage. */
// Each provider's native max output tokens — the real per-reply ceiling now
// that no plan imposes a smaller cap. A requested value is clamped to this so
// it never exceeds what the model itself allows. Values track each lab's
// published per-request output max; providers that enforce prompt+output ≤
// context (deepseek, mistral, qwen) are set to a context-safe fraction so a
// long conversation can't 400.
const PROVIDER_MAX_OUTPUT: Record<string, number> = {
  // Claude 4.8/Sonnet 5 allow 128k output, but only 64k without a beta header;
  // streamAnthropic adds the thinking budget separately and re-clamps the total
  // to its own 64k outputCap, so 64k is the safe header-free ceiling here.
  anthropic: 64000,
  // GPT-5.6 supports 128k output (400k context); hidden reasoning counts toward
  // this budget, so a generous ceiling avoids starving the visible answer.
  openai: 128000,
  google: 65536, // Gemini 3.x tops out at 65,536 output (thinking+answer combined)
  zhipu: 131072, // GLM-4.6: up to 128k output
  moonshot: 65536, // Kimi K2/K3 allow ~100k; 64k stays safe across the 128k-context models
  deepseek: 32768, // 64k-capable, held to a context-safe share of the 128k window
  mistral: 32768, // output bounded by prompt+output ≤ context; safe share of 256k
  xai: 65536, // Grok 4.5 caps responses ~131k; 64k is ample
  seedance: 8192, // media model — no long text output
  minimax: 131072, // MiniMax M2 allows 131k output
  mimo: 16384,
  qwen: 65536, // Qwen3 Max: 65,536 output
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
  /** Optional allowed tool IDs to restrict tool access (e.g. for Assistants). */
  allowedTools?: string[];
  /** Per-request dynamic context (date, etc.) appended AFTER each provider's
   *  stable cached prefix — never into the system prompt itself. */
  dynamicContext?: string;
  /** Stable id grouping requests that share a prompt prefix (conversation id).
   *  Used as OpenAI's prompt_cache_key to raise automatic cache hit rates. */
  cacheKey?: string;
  /** Premium "fast mode": Anthropic speed:"fast" / OpenAI service_tier:"priority".
   *  The route only sets this on models that support it. */
  fastMode?: boolean;
  /** OpenAI GPT-5.6 `reasoning.mode: "pro"` — deeper execution on the same model
   *  id. The route only sets this on models that support it. */
  proMode?: boolean;
  /**
   * Who connector tool calls are attributed to in the audit trail and in the
   * approval broker, and which conversation they belong to. Required whenever
   * `connectors` is non-empty: a tool call acting with a user's own credentials
   * that cannot be traced back to that user is precisely the call worth
   * refusing — and a receipt with no owner is one nobody can be asked to sign.
   */
  audit?: McpToolsetContext;
}): AsyncGenerator<LlmEvent> {
  const { model, system, history, signal, reasoningEffort, webSearch, dynamicContext, cacheKey, fastMode } = opts;
  const proMode = !!opts.proMode && supportsProMode(model);
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
  // Open the Unified Agent Toolset (Python, Browser, Computer + active MCP connectors)
  let toolset: McpToolset | undefined;
  if (opts.audit) {
    try {
      const agentContext: AgentExecutionContext = {
        userId: opts.audit.userId,
        sessionId: opts.audit.sessionId || `session-${Date.now()}`,
        conversationId: opts.audit.conversationId || undefined,
        mode: (opts.audit.surface as AgentMode) || "chat",
        environment: "server_sandbox",
        projectId: opts.audit.projectId || undefined,
        abortSignal: signal,
      };
      toolset = await openUnifiedAgentToolset(active, agentContext, {
        allowedToolIds: opts.allowedTools,
      });
    } catch (err) {
      console.error("[llm] error opening unified agent toolset:", err);
      toolset = undefined;
    }
  }
  try {
    if (model.provider === "anthropic") {
      yield* streamAnthropic(
        model, system, history, maxTokens, signal, reasoningEffort, webSearch,
        toolset, dynamicContext, fastMode
      );
      return;
    }
    // gpt-*-pro and Responses-only Codex snapshots aren't served on
    // /chat/completions — they take the Responses API adapter instead.
    //
    // Pro mode forces the same switch on a model that would otherwise be a
    // chat/completions model: `reasoning.mode` exists ONLY on /v1/responses, so
    // routing is not an optimisation here — sending GPT-5.6 to the compat
    // adapter with pro requested would silently drop the mode and bill a
    // standard turn the user believes was a pro one.
    if (model.provider === "openai" && (model.api === "responses" || proMode)) {
      yield* streamOpenAIResponses(
        model, system, history, maxTokens, signal, reasoningEffort, webSearch,
        toolset, dynamicContext, cacheKey, fastMode, proMode
      );
    } else {
      yield* streamOpenAICompat(
        model, system, history, maxTokens, signal, reasoningEffort, webSearch,
        toolset, dynamicContext, cacheKey, fastMode
      );
    }
  } finally {
    if (toolset) await toolset.close();
  }
}

/**
 * Turn a provider/SDK error into a clear, user-facing message.
 *
 * The judgement lives in src/lib/provider-error.ts so the health probe can
 * reuse it and so it is unit testable (this module is `server-only`). This
 * wrapper stays because five call sites want just the string — and because two
 * of them (route.ts:2458, route.ts:2535) feed it Prisma and internal errors,
 * not provider errors at all, which is exactly why the raw message must never
 * be echoed back to a user.
 *
 * The operator-facing detail is logged here rather than discarded: collapsing
 * auth and billing to one neutral sentence would otherwise erase the only
 * signal that a provider account has run dry.
 */
export function providerErrorMessage(err: unknown, providerLabel?: string): string {
  const normalized = normalizeProviderError(err, providerLabel);
  if (normalized.accountFault) {
    console.error("[provider] account fault", { detail: normalized.operatorMessage });
  }
  return normalized.userMessage;
}
