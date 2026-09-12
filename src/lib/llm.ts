import "server-only";
import { streamAnthropic } from "@/lib/anthropic";
import { streamGemini } from "@/lib/gemini";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamOpenAIResponses } from "@/lib/openai-responses";
import { openUnifiedAgentToolset } from "@/lib/agent/runtime";
import type { AgentExecutionContext, AgentMode } from "@/lib/agent/types";
import { NO_RUNTIME_TOOLS } from "@/lib/chat/tool-policy";
import { type ActiveConnector, type McpToolset, type McpToolsetContext } from "@/lib/mcp";
import { reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { normalizeProviderError } from "@/lib/provider-error";
import { providerAdapterFor } from "@/lib/provider-routing";
import { clampMaxTokens } from "@/lib/provider-limits";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export { clampMaxTokens };

/** Provider-agnostic streaming: routes Anthropic to its native SDK, everything
 *  else through the OpenAI-compatible adapter. Yields text + sources + usage. */
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
  /**
   * Which of Juno's own runtime tools (`browser_agent`…) this turn may carry.
   * OPT-IN: omitted means none. The registry one layer down reads an absent
   * allowlist as "everything", which is how the browser tool ended up attached
   * to every saved chat turn with no toggle — see `chat/tool-policy.ts`.
   */
  allowedTools?: string[];
  /** Per-request dynamic context (date, etc.) appended AFTER each provider's
   *  stable cached prefix — never into the system prompt itself. */
  dynamicContext?: string;
  /** Stable id grouping requests that share a prompt prefix (conversation id).
   *  Used as OpenAI's prompt_cache_key to raise automatic cache hit rates. */
  cacheKey?: string;
  /**
   * The leading part of `system` that is identical for every user on the same
   * feature toggles (`buildSystemPromptSections().stable`). Providers with
   * explicit breakpoints cache it as its own tier, so the per-user tail that
   * follows can change without re-writing the rules. Must be a byte prefix
   * of `system`; anything else is ignored.
   */
  systemStablePrefix?: string;
  /** Premium "fast mode": Anthropic speed:"fast" / OpenAI service_tier:"priority".
   *  The route only sets this on models that support it. */
  fastMode?: boolean;
  /** OpenAI GPT-5.6 `reasoning.mode: "pro"` — deeper execution on the same model
   *  id. The route only sets this on models that support it. */
  proMode?: boolean;
  /** Safe correlation metadata for provider diagnostics; never prompt text. */
  requestContext?: { requestId?: string | null; generationId?: string | null; conversationId?: string | null };
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
        onApprovalRequest: opts.audit.onApprovalRequest,
        abortSignal: signal,
      };
      toolset = await openUnifiedAgentToolset(active, agentContext, {
        // Never `undefined`: that is the registry's "all tools" value.
        allowedToolIds: opts.allowedTools ?? [...NO_RUNTIME_TOOLS],
      });
    } catch (err) {
      console.error("[llm] error opening unified agent toolset:", err);
      toolset = undefined;
    }
  }
  try {
    const adapter = providerAdapterFor(model, proMode);
    switch (adapter) {
      case "anthropic-native":
        yield* streamAnthropic(
          model, system, history, maxTokens, signal, reasoningEffort, webSearch,
          toolset, dynamicContext, fastMode, opts.systemStablePrefix
        );
        return;
      case "gemini-native":
        yield* streamGemini(
          model, system, history, maxTokens, signal, reasoningEffort, webSearch,
          toolset, dynamicContext, opts.requestContext
        );
        return;
      case "openai-responses":
        // Responses-only snapshots and GPT Pro execution cannot use
        // /chat/completions; this branch preserves their reasoning controls.
        yield* streamOpenAIResponses(
          model, system, history, maxTokens, signal, reasoningEffort, webSearch,
          toolset, dynamicContext, cacheKey, fastMode, proMode
        );
        return;
      case "openai-compatible":
        yield* streamOpenAICompat(
          model, system, history, maxTokens, signal, reasoningEffort, webSearch,
          toolset, dynamicContext, cacheKey, fastMode
        );
        return;
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
