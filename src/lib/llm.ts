import "server-only";
import { streamAnthropic } from "@/lib/anthropic";
import { streamGemini } from "@/lib/gemini";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamOpenAIResponses } from "@/lib/openai-responses";
import { openUnifiedAgentToolset } from "@/lib/agent/runtime";
import type { AgentExecutionContext, AgentMode } from "@/lib/agent/types";
import { NO_RUNTIME_TOOLS } from "@/lib/chat/tool-policy";
import {
  type ActiveConnector,
  type McpToolset,
  type McpToolsetContext,
} from "@/lib/mcp";
import { createLoopController, defaultLoopBudget, type LoopController } from "@/lib/llm/loop";
import { legacyChatToolset, undispatchedToolsetReason } from "@/lib/llm/tool-round";
import type { AdapterRequest } from "@/lib/llm/types";
import type { ChatToolset, NativeChatTool } from "@/lib/tools/types";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { normalizeProviderError, type ErrorSubject } from "@/lib/provider-error";
import { noteModelNotServed } from "@/lib/model-capability";
import { providerAdapterFor } from "@/lib/provider-routing";
import { clampMaxTokens } from "@/lib/provider-limits";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { LlmEvent, MessageForModel } from "@/types/llm";

export { clampMaxTokens };

/**
 * A tool the chat route builds for one turn and runs itself.
 *
 * Declared in `src/lib/tools/types.ts` now, beside the rest of the tool
 * contract, so modules that must stay free of `server-only` can name it.
 * Re-exported here for the callers that already import it from this file.
 */
export type { NativeChatTool };

/**
 * The turn's toolset with the native tools added after everything it already
 * carries.
 *
 * Composed here rather than inside `openUnifiedAgentToolset`, so the registry
 * and its broker never see these calls, and so a toolset that failed to open
 * still leaves the native tools usable instead of taking them down with it.
 * Native tools are dispatched first by name; every other name falls through to
 * the toolset exactly as before.
 */
function withNativeTools(base: McpToolset | undefined, native: readonly NativeChatTool[]): McpToolset | undefined {
  if (native.length === 0) return base;
  const byName = new Map(native.map((entry) => [entry.tool.function.name, entry]));
  return {
    tools: [...(base?.tools ?? []), ...native.map((entry) => entry.tool)],
    labelFor: (toolName) => byName.get(toolName)?.label ?? base?.labelFor(toolName) ?? toolName,
    accessFor: (toolName) => byName.get(toolName)?.access ?? base?.accessFor(toolName) ?? "unknown",
    execute: (toolName, args, signal, callId) => {
      const entry = byName.get(toolName);
      if (entry) return entry.execute(args, signal);
      if (base) return base.execute(toolName, args, signal, callId);
      const text = `Unknown tool: ${toolName}`;
      return Promise.resolve({ text, body: text, ok: false });
    },
    close: async () => {
      if (base) await base.close();
    },
  };
}

/**
 * Provider-agnostic streaming: routes each model to its adapter
 * (`providerAdapterFor`) and yields the provider-neutral `LlmEvent`s — text,
 * reasoning, tool acts, sources, usage after every request, `round_end` at every
 * model step (SPEC §2.9, §5.0).
 */
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
  /**
   * Tools the route built for this turn (see `NativeChatTool`). Offered after
   * the connector and registry tools, and only on the saved path: the route
   * decides whether a turn may carry one, and private turns never do.
   */
  nativeTools?: readonly NativeChatTool[];
  /*
   * The reworked tool loop's options (SPEC §5.0). `connectors`, `allowedTools`,
   * `audit` and `nativeTools` above are DEPRECATED: they still open the old
   * toolset when no `toolset` is passed, until the route switches (WS9a).
   */
  /**
   * The turn's opened toolset (`openChatToolset`); replaces
   * `connectors`/`allowedTools`/`audit`/`nativeTools`. The caller opened it,
   * so the caller closes it.
   */
  toolset?: ChatToolset;
  /**
   * Present iff `toolset` is: the dispatcher's context for this turn. A
   * `toolset` without it is refused — its calls would skip the broker.
   */
  batch?: AdapterRequest["batch"];
  /** The turn's round budget. Defaults to `defaultLoopBudget` (10 with a `toolset`, 1 with nothing). */
  loop?: LoopController;
  /** Structured output for a tool-less call (the research planner). */
  responseSchema?: AdapterRequest["responseSchema"];
}): AsyncGenerator<LlmEvent> {
  const { model, system, history, signal, reasoningEffort, webSearch, dynamicContext, cacheKey, fastMode } = opts;
  const proMode = !!opts.proMode && supportsProMode(model);
  const adapter = providerAdapterFor(model, proMode);
  // The adapters that take the whole `AdapterRequest`, and so run tools through
  // the dispatcher and honour `responseSchema`. The Responses and compat
  // adapters are still called positionally below (WS3b converts them).
  const takesRequest = adapter === "anthropic-native" || adapter === "gemini-native";
  // A toolset the route opened authorises nothing itself — its broker, audit
  // and dedupe are the dispatcher's ports (SPEC §3.3, §4.2) — so a request that
  // would run it any other way is refused before anything is opened or sent.
  const refusal = undispatchedToolsetReason({ toolset: opts.toolset, batch: opts.batch, dispatches: takesRequest });
  if (refusal) throw new Error(`[llm] refusing to run tools: ${refusal} (${model.id}, ${adapter})`);
  if (opts.responseSchema && !takesRequest) {
    // Unconstrained, not wrong: the one caller (the research planner) validates
    // what comes back and retries (SPEC §9.5). Logged so the gap is visible.
    console.warn("[llm] responseSchema is not applied on this adapter yet", { model: model.id, adapter });
  }
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
  // The model's OWN window, not just the lab ceiling. Several providers
  // enforce prompt + max_tokens <= context, so a lab-wide budget handed to
  // that lab's small sibling asks for more output than the model can hold —
  // `glm-4.6` was being offered 131,072 tokens of reply inside a
  // 128,000-token window. getModelMetrics resolves the registry's
  // contextWindow first and falls back to a family rule, so discovered models
  // get a real number rather than none.
  const maxTokens = clampMaxTokens(
    model.provider,
    opts.maxTokens + thinkingAllowance,
    getModelMetrics(model).contextTokens,
  );
  const active = opts.connectors ?? [];

  // The DEPRECATED path: open the Unified Agent Toolset (runtime tools + active
  // MCP connectors) from the old options, only when the caller did not pass
  // the turn's opened toolset. Removed with those options (WS9a).
  let toolset: McpToolset | undefined;
  if (opts.audit && !opts.toolset) {
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
  if (!opts.toolset) toolset = withNativeTools(toolset, opts.nativeTools ?? []);
  const legacyTools = !!toolset && toolset.tools.length > 0;
  const loop =
    opts.loop ??
    createLoopController({
      budget: defaultLoopBudget({
        toolset: !!opts.toolset,
        legacyTools,
        webSearch: !!webSearch,
        structured: !!opts.responseSchema,
      }),
    });
  // One request shape for every adapter (SPEC §5.0). The old toolset rides in
  // it seen through the new contract; with no `batch`, the adapters run it the
  // way they always did — it authorises its own calls — and the reworked
  // dispatcher runs only the toolset the route opened.
  const request: AdapterRequest = {
    model,
    system,
    systemStablePrefix: opts.systemStablePrefix,
    history,
    maxTokens,
    signal,
    reasoningEffort,
    webSearch: !!webSearch,
    toolset: opts.toolset ?? (legacyTools && toolset ? legacyChatToolset(toolset) : undefined),
    batch: opts.toolset ? opts.batch : undefined,
    loop,
    dynamicContext,
    cacheKey,
    fastMode,
    proMode,
    requestContext: opts.requestContext,
    responseSchema: opts.responseSchema,
  };
  // What the adapters not yet on `AdapterRequest` take positionally.
  const positionalToolset: McpToolset | undefined = opts.toolset ?? toolset;
  try {
    // Every provider call in the product funnels through the switch below, so
    // this is the one place that learns what a live request discovered. The
    // only verdict taken is `not_found`, and taking it is what stops a retired
    // or not-yet-shipped model id failing every message forever — see
    // `noteModelNotServed`. Never awaited and never allowed to throw: the
    // original provider error is what the caller must see.
    const bench = (err: unknown) => {
      void noteModelNotServed(model, err).catch(() => undefined);
    };
    try {
      switch (adapter) {
        case "anthropic-native":
          yield* streamAnthropic(request);
          return;
        case "gemini-native":
          yield* streamGemini(request);
          return;
        case "openai-compatible":
          yield* streamOpenAICompat(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            positionalToolset, dynamicContext, cacheKey, fastMode
          );
          return;
        case "openai-responses":
        default:
          // Responses-only snapshots and GPT Pro execution cannot use
          // /chat/completions; this branch preserves their reasoning controls.
          // Every other Responses-served adapter lands here too.
          yield* streamOpenAIResponses(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            positionalToolset, dynamicContext, cacheKey, fastMode, proMode
          );
          return;
      }
    } catch (err) {
      bench(err);
      throw err;
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
export function providerErrorMessage(err: unknown, subject?: ErrorSubject): string {
  const normalized = normalizeProviderError(err, subject);
  if (normalized.accountFault) {
    // ONE LINE, and the string is passed directly rather than wrapped in an
    // object. `console.error("...", { detail })` pretty-prints the object
    // across several lines once it is long enough, which puts the status and
    // the provider's own words on a DIFFERENT line from the words an operator
    // greps for. `pm2 logs | grep "account fault"` then returns a column of
    // bare `{` and tells you nothing — which is exactly how this was found.
    // `operatorMessage` is already formatted as
    // `[provider · model] class status=NNN <raw>`.
    console.error(`[provider] account fault ${normalized.operatorMessage}`);
  }
  return normalized.userMessage;
}
