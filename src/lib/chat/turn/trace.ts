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
    /** From the trace's start (just before the turn runs) to its end. */
    totalMs: number;
    /**
     * First text or reasoning from the provider, from the trace's start. Null
     * when none arrived. Starts after the route has built the turn (history,
     * memory, context, tools, prompt), so it leaves that preparation out:
     * see `serverPrepMs` and `requestTtftMs`.
     */
    ttftMs: number | null;
    /**
     * Server preparation: from the request reaching the chat route to the
     * provider request going out (after the connectors opened). Null when no
     * provider request was made (a research hand-off, a refusal) or the route
     * did not stamp its start.
     */
    serverPrepMs: number | null;
    /**
     * What the person waited for: from the request reaching the chat route to
     * the first text or reasoning. Null when either end is missing.
     */
    requestTtftMs: number | null;
  };
  /**
   * Route-level provider attempts for this turn: 1, or 2 when the provider
   * rejected the first request before any byte arrived and the turn asked
   * once more (pre-stream-retry.ts; `noteRetry`). The SDKs themselves run
   * with retries off (a streamed request can bill before a transport error is
   * seen). Gemini's own retry below this line, also before any byte of the
   * stream (gemini-network.ts: retryable statuses only, at most 4 attempts,
   * Retry-After honoured, abortable), is logged there as
   * `gemini_request_failed` and not counted here.
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
  /**
   * When the request reached the chat route (epoch ms, the trace's clock),
   * stamped at route entry. Absent: `serverPrepMs` and `requestTtftMs` are null.
   */
  requestStartedAt?: number | null;
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
  /**
   * The turn asked the provider again before its first byte
   * (pre-stream-retry.ts). `model` when Auto moved the turn to another
   * model: the trace then names that one, and says it was rerouted.
   */
  noteRetry: (model?: { id: string; provider: string }) => void;
  /**
   * The provider request is going out (streamChat's `onProviderRequest`, or
   * the smoke provider starting). Only the first call counts: a retry's
   * request is not the end of the preparation.
   */
  noteProviderCall: () => void;
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
  let providerCallAt: number | null = null;
  const requestStartedAt =
    typeof start.requestStartedAt === "number" && Number.isFinite(start.requestStartedAt) ? start.requestStartedAt : null;
  /** Milliseconds from the route's stamp to `at`; null when either is missing. */
  const sinceRequest = (at: number | null) => (at === null || requestStartedAt === null ? null : Math.max(0, at - requestStartedAt));
  const calls = new Map<string, TurnTraceToolCall>();
  const order: string[] = [];
  let approvals = 0;
  let attempts = 1;
  /** The model that answers: the start's, unless a retry moved the turn. */
  let answering = start.model;
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
    noteRetry: (model) => {
      attempts += 1;
      if (model) answering = { id: model.id, provider: model.provider };
    },
    noteProviderCall: () => {
      if (providerCallAt === null && !done) providerCallAt = now();
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
        model: answering.id,
        provider: answering.provider,
        requestedModel: start.requestedModel !== answering.id ? start.requestedModel : null,
        rerouted: start.rerouted || answering.id !== start.model.id,
        reasoningEffort: start.reasoningEffort ?? null,
        features: start.features,
        latency: {
          totalMs: Math.max(0, end - startedAt),
          ttftMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
          serverPrepMs: sinceRequest(providerCallAt),
          requestTtftMs: sinceRequest(firstTokenAt),
        },
        attempts,
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

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  /** How many turns had the number. */
  n: number;
}

export interface TurnLatencySummary {
  serverPrepMs: LatencyPercentiles | null;
  requestTtftMs: LatencyPercentiles | null;
  ttftMs: LatencyPercentiles | null;
}

/** Nearest-rank p50 and p95 of the numbers given; null when there are none. */
export function latencyPercentiles(values: readonly number[]): LatencyPercentiles | null {
  const sorted = values.filter((value) => typeof value === "number" && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { p50: Math.round(rank(0.5)), p95: Math.round(rank(0.95)), n: sorted.length };
}

/**
 * p50 and p95 of the three waits over a set of traces: server preparation
 * (route entry to the provider request), the person's wait to the first
 * token, and the provider-side first token the trace has always logged.
 * A trace without a number (no provider request, no token) is left out.
 */
export function summarizeTurnLatency(traces: readonly Pick<TurnTrace, "latency">[]): TurnLatencySummary {
  const pick = (read: (latency: Partial<TurnTrace["latency"]>) => number | null | undefined) =>
    latencyPercentiles(traces.flatMap((trace) => {
      const value = read(trace.latency ?? {});
      return typeof value === "number" ? [value] : [];
    }));
  return {
    serverPrepMs: pick((latency) => latency.serverPrepMs),
    requestTtftMs: pick((latency) => latency.requestTtftMs),
    ttftMs: pick((latency) => latency.ttftMs),
  };
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
