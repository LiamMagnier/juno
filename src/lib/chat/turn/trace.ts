import { normalizeProviderError } from "@/lib/provider-error";
import type { StreamEffect } from "@/lib/chat/stream-accumulator";
import type { ChatFinishReason } from "@/types/chat";

/*
 * THE PER-TURN TRACE (BRIEF §47).
 *
 * One record per chat turn, built here (pure, no I/O) and handed once, when
 * the turn reaches its terminal state, to a sink. The production sink
 * (trace-sink.ts) emits it through the facilities the repo already has: the
 * structured `chat.turn` log line, the in-process model performance collector
 * and the owner-only diagnostics page's ring buffer.
 *
 * REDACTION IS STRUCTURAL, NOT A FILTER. The trace type has no field that can
 * hold message text, reasoning, tool arguments, tool results, a prompt, a URL,
 * an email address or a provider's raw error message. Tool calls are recorded
 * by tool name, outcome and duration only; an error by its normalised class
 * and HTTP status. Identifiers are opaque database ids. Adding a free-text
 * field here would be a privacy change and should be reviewed as one
 * (tests/chat-turn-trace.test.ts pins the shape).
 */

export type TurnTraceSurface = "saved" | "private";
export type TurnTraceOutcome = "completed" | "partial" | "stopped" | "failed";

export interface TurnTraceToolCall {
  name: string;
  ok: boolean | null;
  durationMs: number | null;
  status: string | null;
  errorCode: string | null;
  cached: boolean;
}

export interface TurnTrace {
  /** The generation id: the run id every other record of this turn carries. */
  runId: string;
  requestId: string | null;
  accountId: string;
  conversationId: string | null;
  surface: TurnTraceSurface;
  client: string;
  /** The agent whose turn this is, when one answers. */
  agentId: string | null;
  model: string;
  provider: string;
  /** The model asked for, when routing (Auto, reroute, budget) changed it. */
  requestedModel: string | null;
  rerouted: boolean;
  reasoningEffort: string | null;
  features: {
    webSearch: boolean;
    research: boolean;
    connectors: number;
    actingTools: number;
    skill: boolean;
    artifactEdit: boolean;
    regenerate: boolean;
  };
  latency: {
    totalMs: number;
    /** First text or reasoning from the provider. Null when none arrived. */
    ttftMs: number | null;
  };
  /**
   * Provider attempts for this turn. Always 1 from the chat route: SDK
   * retries are off (anthropic.ts, openai-compat.ts) because a streamed
   * request can bill before a transport error is seen, and nothing above the
   * adapter replays a turn. Recorded so a future retry shows up here.
   */
  attempts: number;
  toolCalls: TurnTraceToolCall[];
  approvals: number;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    cacheReadTokens: number | null;
    costUsd: number | null;
  };
  finishReason: ChatFinishReason | null;
  outcome: TurnTraceOutcome | null;
  failureCode: string | null;
  error: { class: string; status: number | null; retryable: boolean } | null;
  cancellation: {
    userStopped: boolean;
    budgetHalted: boolean;
    stalled: boolean;
    shutdown: boolean;
    leaseLost: boolean;
  };
  startedAt: string;
}

export interface TurnTraceStart {
  runId: string;
  requestId: string | null;
  accountId: string;
  conversationId: string | null;
  surface: TurnTraceSurface;
  client: string;
  agentId: string | null;
  model: { id: string; provider: string };
  requestedModel: string;
  rerouted: boolean;
  reasoningEffort: string | null | undefined;
  features: TurnTrace["features"];
}

export interface TurnTraceFinish {
  finishReason: ChatFinishReason;
  outcome: TurnTraceOutcome;
  failureCode?: string | null;
  error?: unknown;
  usage?: { promptTokens?: number | null; completionTokens?: number | null; cacheReadTokens?: number | null; costUsd?: number | null };
  cancellation?: Partial<TurnTrace["cancellation"]>;
}

export interface TurnTraceRecorder {
  /** Folds one stream effect in (tool calls, first-token time). */
  observe: (effect: StreamEffect) => void;
  noteApproval: () => void;
  /** Emits the trace once; later calls are ignored. */
  finish: (input: TurnTraceFinish) => TurnTrace | null;
  readonly finished: boolean;
}

/** Tool names come from Juno's registry or a connector's tool list: keep them short and plain. */
function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

export function createTurnTrace(
  start: TurnTraceStart,
  sink: (trace: TurnTrace) => void,
  now: () => number = Date.now
): TurnTraceRecorder {
  const startedAt = now();
  let firstTokenAt: number | null = null;
  const calls = new Map<string, TurnTraceToolCall>();
  const order: string[] = [];
  let approvals = 0;
  let done = false;

  const recorder: TurnTraceRecorder = {
    observe: (effect) => {
      if ((effect.kind === "text" || effect.kind === "reasoning") && firstTokenAt === null) firstTokenAt = now();
      if (effect.kind === "tool_call") {
        if (!calls.has(effect.callId)) order.push(effect.callId);
        calls.set(effect.callId, {
          name: safeToolName(effect.name),
          ok: null,
          durationMs: null,
          status: null,
          errorCode: null,
          cached: false,
        });
      } else if (effect.kind === "tool_result") {
        const call = calls.get(effect.callId);
        if (!call) return;
        call.ok = effect.ok;
        call.durationMs = typeof effect.durationMs === "number" ? Math.round(effect.durationMs) : null;
        call.status = effect.status ?? null;
        call.errorCode = effect.errorCode ?? null;
        call.cached = !!effect.cached;
      }
    },
    noteApproval: () => {
      approvals += 1;
    },
    finish: (input) => {
      if (done) return null;
      done = true;
      const end = now();
      const normalized = input.error !== undefined && input.outcome === "failed" ? normalizeProviderError(input.error) : null;
      const trace: TurnTrace = {
        runId: start.runId,
        requestId: start.requestId,
        accountId: start.accountId,
        conversationId: start.conversationId,
        surface: start.surface,
        client: start.client,
        agentId: start.agentId,
        model: start.model.id,
        provider: start.model.provider,
        requestedModel: start.requestedModel !== start.model.id ? start.requestedModel : null,
        rerouted: start.rerouted,
        reasoningEffort: start.reasoningEffort ?? null,
        features: start.features,
        latency: {
          totalMs: Math.max(0, end - startedAt),
          ttftMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
        },
        attempts: 1,
        toolCalls: order.map((id) => calls.get(id)!),
        approvals,
        usage: {
          promptTokens: input.usage?.promptTokens ?? null,
          completionTokens: input.usage?.completionTokens ?? null,
          cacheReadTokens: input.usage?.cacheReadTokens ?? null,
          costUsd: input.usage?.costUsd ?? null,
        },
        finishReason: input.finishReason,
        outcome: input.outcome,
        failureCode: input.failureCode ?? null,
        error: normalized ? { class: normalized.class, status: normalized.status, retryable: normalized.retryable } : null,
        cancellation: {
          userStopped: false,
          budgetHalted: false,
          stalled: false,
          shutdown: false,
          leaseLost: false,
          ...input.cancellation,
        },
        startedAt: new Date(startedAt).toISOString(),
      };
      try {
        sink(trace);
      } catch {
        // Observability must never be the reason a turn fails.
      }
      return trace;
    },
    get finished() {
      return done;
    },
  };
  return recorder;
}

/** A turn's usage, in the trace's shape: counts and cost only. */
export function traceUsage(
  usage: { totalInput: number; output: number; cost: number },
  acc: { tokens: { promptTokens?: number; cacheReadTokens?: number } }
): TurnTraceFinish["usage"] {
  return {
    promptTokens: usage.totalInput || acc.tokens.promptTokens || null,
    completionTokens: usage.output || null,
    cacheReadTokens: acc.tokens.cacheReadTokens ?? null,
    costUsd: usage.cost || null,
  };
}
