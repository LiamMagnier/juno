import "server-only";
import type { FastMode } from "@/lib/pricing";
import { streamAnthropic } from "@/lib/anthropic";
import { streamGemini } from "@/lib/gemini";
import { streamOpenAICompat } from "@/lib/openai-compat";
import { streamOpenAIResponses } from "@/lib/openai-responses";
import { openUnifiedAgentToolset } from "@/lib/agent/runtime";
import type { AgentExecutionContext, AgentMode } from "@/lib/agent/types";
import { NO_RUNTIME_TOOLS } from "@/lib/chat/tool-policy";
import type { ActiveConnector, McpToolsetContext } from "@/lib/mcp";
import { createToolLoop, type ToolLoop } from "@/lib/tools/loop";
import { withNativeChatTools, type NativeChatTool } from "@/lib/tools/toolset";
import type { ChatToolset, ToolSpec } from "@/lib/tools/types";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { normalizeProviderError, type ErrorSubject } from "@/lib/provider-error";
import { noteModelNotServed } from "@/lib/model-capability";
import { providerAdapterFor } from "@/lib/provider-routing";
import { clampMaxTokens } from "@/lib/provider-limits";
import type { ModelInfo } from "@/lib/models";
import type { ReasoningEffort } from "@/types/chat";
import type { AdapterRequest } from "@/lib/llm/types";
import { undispatchedToolsetReason } from "@/lib/llm/tool-round";
import type { LlmEvent, MessageForModel, PromptCacheMode } from "@/types/llm";

export { clampMaxTokens };

/**
 * A tool the chat route builds for one turn and runs itself. Defined beside the
 * toolset it is composed into (src/lib/tools/toolset.ts); re-exported here
 * because every native tool imports it from llm.ts.
 *
 * Not a registry tool, and deliberately so: a native tool is a closure over the
 * turn it belongs to and decides for itself when a person has to be asked, so
 * the registry and its generic broker never see its calls.
 */
export type { NativeChatTool };

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
  /** Explicit prompt-cache markers (`PromptCacheMode`). Omit for chat turns. */
  promptCache?: PromptCacheMode;
  /** Premium "fast mode": Anthropic speed:"fast" / OpenAI service_tier:"priority".
   *  The route only sets this on models that support it. */
  fastMode?: FastMode;
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
  /** Tool rounds this turn may take (`ToolLoop.maxRounds`). Absent: the adapter's default. */
  maxToolRounds?: number;
  /**
   * Provider specs this turn may carry (the execution and skill lanes'
   * `run_code`, `check_run`, `use_skill`, `read_skill_file`), already granted
   * by the entitlement rows (src/lib/tools/entitlements.ts). They run behind
   * the runtime broker like the registry tools. Ignored without `audit`.
   */
  toolSpecs?: readonly ToolSpec[];
  /**
   * A tool loop the caller built and owns (the tool round-trip probe, which
   * offers its own pure test function). Used as-is: no registry, connector or
   * native toolset is opened, and streamChat does not close it.
   */
  toolLoop?: ToolLoop;
  toolset?: ChatToolset;
  batch?: AdapterRequest["batch"];
  responseSchema?: AdapterRequest["responseSchema"];
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

  const undispatchedReason = undispatchedToolsetReason({ toolset: opts.toolset, batch: opts.batch, dispatches: true });
  if (undispatchedReason) throw new Error(`[llm] refusing to run tools: ${undispatchedReason}`);

  // Open the Unified Agent Toolset (registry tools, provider specs, connectors)
  let toolset: ChatToolset | undefined;
  if (opts.audit && !opts.toolLoop) {
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
        specs: opts.toolSpecs,
      });
    } catch (err) {
      console.error("[llm] error opening unified agent toolset:", err);
      toolset = undefined;
    }
  }
  toolset = withNativeChatTools(toolset, opts.nativeTools ?? []);
  /*
   * ONE TOOL LOOP PER GENERATION, and every adapter runs its calls through it:
   * the dispatcher parses, validates, times, cancels and answers every call
   * the same way whichever provider made it (src/lib/tools/dispatch.ts), and
   * the call ids it issues are stable across a replayed round.
   */
  const tools: ToolLoop | undefined =
    opts.toolLoop ??
    (toolset && toolset.tools.length > 0 ? createToolLoop(toolset, { maxRounds: opts.maxToolRounds }) : undefined);
  try {
    // `webSearch` picks Meta's transport: its search exists only on Responses.
    const adapter = providerAdapterFor(model, proMode, { webSearch: !!webSearch });
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
          // yield* streamAnthropic(request)
          yield* streamAnthropic(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, fastMode === true, opts.systemStablePrefix, undefined, opts.promptCache
          );
          return;
        case "gemini-native":
          yield* streamGemini(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, opts.requestContext
          );
          return;
        case "openai-responses":
          // Responses-only snapshots and GPT Pro execution cannot use
          // /chat/completions; this branch preserves their reasoning controls.
          yield* streamOpenAIResponses(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, cacheKey, fastMode, proMode
          );
          return;
        case "xai-responses":
          // Grok models with Responses-API capability route through the same
          // adapter as openai-responses, pointed at xAI's base URL.
          yield* streamOpenAIResponses(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, cacheKey, fastMode, proMode
          );
          return;
        case "meta-responses":
          // A Muse Spark turn with web search on: Meta's own `web_search`
          // tool on its Responses API (the only surface that has it).
          yield* streamOpenAIResponses(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, cacheKey, fastMode, proMode
          );
          return;
        case "openai-compatible":
          yield* streamOpenAICompat(
            model, system, history, maxTokens, signal, reasoningEffort, webSearch,
            tools, dynamicContext, cacheKey, fastMode, undefined, opts.promptCache
          );
          return;
        default: {
          // TypeScript narrowing: if this compiles, every adapter has a case.
          const _exhaustive: never = adapter;
          throw new Error(`[llm] unhandled adapter: ${_exhaustive}`);
        }
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
