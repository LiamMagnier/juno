import { PRODUCT_NAME } from "@/lib/brand/names";
import { estimateCostUsd } from "@/lib/pricing";
import type { ModelInfo } from "@/lib/models";
import type { ChatFinishReason, ClientMessage, ClientSource, ReasoningEffort, StreamChunk } from "@/types/chat";

/**
 * One pane of the side-by-side comparison, as a pure state machine.
 *
 *   idle → submitting → thinking ⇄ writing → done
 *                    ↘──────────────────────→ error
 *
 * Every transition is a function of the previous state, one event and the
 * time it arrived, so the whole lifecycle is tested without React, fetch or
 * a clock (tests/compare-pane-run.test.ts). The controller feeds it.
 *
 * Honesty rules this file enforces:
 *  - Latency is MEASURED: browser wall clock from the request to the first
 *    streamed output and to the terminal frame. It includes the network.
 *  - Cost is never measured; it is priced. `usageBasis` says whether the
 *    token counts behind it are the provider's report or an estimate, and
 *    the UI and the export label it accordingly.
 *  - The served model, effort and search come from the server's `done`
 *    frame. A pane never claims a condition it only asked for.
 */

export type PaneStatus = "idle" | "submitting" | "thinking" | "writing" | "done" | "error";
export type PaneErrorAction = "upgrade" | "retry";
export type PaneUsageBasis = "reported" | "estimated";

export interface PaneRun {
  status: PaneStatus;
  content: string;
  reasoning: string;
  /** Human sentence naming the failure cause (house error style). */
  errorMessage: string | null;
  /** Which single recovery action fits the failure; null when none does. */
  errorAction: PaneErrorAction | null;
  /** The comparison (run spec) this pane answered. */
  specId: string | null;
  /** Fingerprint of the shared part of the request this pane actually sent. */
  inputFingerprint: string | null;
  /** The model the pane asked for. */
  requestedModelId: string | null;
  /** The model the server says wrote the answer (`done.message.model`). */
  servedModelId: string | null;
  /** Effort the server sent to the provider; undefined until reported. */
  appliedEffort: ReasoningEffort | null | undefined;
  /** Web search offered to the model on this run; null until reported. */
  webSearchApplied: boolean | null;
  /** Monotonic clock (ms) when the request left. */
  startedAt: number | null;
  /** How long after the comparison's first pane this pane started (ms). */
  startOffsetMs: number | null;
  /** First streamed output of any kind: reasoning text or answer text. */
  firstOutputAt: number | null;
  /** First streamed answer text. */
  firstAnswerAt: number | null;
  /** The terminal frame (done or error), or the local stop. */
  finishedAt: number | null;
  /** finishedAt − startedAt (kept for callers that read one number). */
  elapsedMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  /** Basis of the token counts and cost; null when there are none. */
  usageBasis: PaneUsageBasis | null;
  sources: ClientSource[];
  finishReason: ChatFinishReason | null;
}

export const IDLE_RUN: PaneRun = {
  status: "idle",
  content: "",
  reasoning: "",
  errorMessage: null,
  errorAction: null,
  specId: null,
  inputFingerprint: null,
  requestedModelId: null,
  servedModelId: null,
  appliedEffort: undefined,
  webSearchApplied: null,
  startedAt: null,
  startOffsetMs: null,
  firstOutputAt: null,
  firstAnswerAt: null,
  finishedAt: null,
  elapsedMs: null,
  promptTokens: null,
  completionTokens: null,
  costUsd: null,
  usageBasis: null,
  sources: [],
  finishReason: null,
};

const STREAMING_STATUSES: readonly PaneStatus[] = ["submitting", "thinking", "writing"];

export function isPaneStreaming(run: PaneRun | undefined): boolean {
  return !!run && STREAMING_STATUSES.includes(run.status);
}

/** A monotonic millisecond clock where the platform has one. */
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

// ── Durations ────────────────────────────────────────────────────────────────

function since(start: number | null, end: number | null): number | null {
  return start != null && end != null ? Math.max(0, end - start) : null;
}

/** Request → first streamed output (reasoning or answer). */
export function timeToFirstOutputMs(run: PaneRun): number | null {
  return since(run.startedAt, run.firstOutputAt);
}

/** Request → first answer text. */
export function timeToFirstAnswerMs(run: PaneRun): number | null {
  return since(run.startedAt, run.firstAnswerAt);
}

/** Request → terminal frame. */
export function totalMs(run: PaneRun): number | null {
  return since(run.startedAt, run.finishedAt);
}

// ── Transitions ──────────────────────────────────────────────────────────────

export function startRun(input: {
  at: number;
  specId: string;
  requestedModelId: string;
  inputFingerprint: string;
  startOffsetMs: number;
}): PaneRun {
  return {
    ...IDLE_RUN,
    status: "submitting",
    specId: input.specId,
    requestedModelId: input.requestedModelId,
    inputFingerprint: input.inputFingerprint,
    startedAt: input.at,
    startOffsetMs: Math.max(0, input.startOffsetMs),
  };
}

function finished(run: PaneRun, at: number): Pick<PaneRun, "finishedAt" | "elapsedMs"> {
  return { finishedAt: at, elapsedMs: since(run.startedAt, at) };
}

function firstOutput(run: PaneRun, at: number): Pick<PaneRun, "firstOutputAt"> {
  return { firstOutputAt: run.firstOutputAt ?? at };
}

export interface PaneFailure {
  message: string;
  action: PaneErrorAction | null;
}

/** The request failed or the stream broke. Whatever streamed stays on the pane. */
export function failRun(run: PaneRun, failure: PaneFailure, at: number): PaneRun {
  return {
    ...run,
    status: "error",
    errorMessage: failure.message,
    errorAction: failure.action,
    ...finished(run, at),
    finishReason: run.finishReason ?? "error",
  };
}

/**
 * Stopped locally (the cancel endpoint could not confirm, or the pane was
 * abandoned). A partial answer is kept and closed out as stopped; with
 * nothing streamed the pane says so.
 */
export function abortRun(run: PaneRun, at: number): PaneRun {
  if (run.content) return { ...run, status: "done", ...finished(run, at), finishReason: "user_stopped" };
  return {
    ...run,
    status: "error",
    errorMessage: "Stopped before the model answered.",
    errorAction: "retry",
    ...finished(run, at),
    finishReason: "user_stopped",
  };
}

export interface PaneCost {
  usd: number;
  basis: PaneUsageBasis;
}

/**
 * The price of one answer, and what it rests on.
 *
 * The server prices the exact streamed usage (cache buckets and tool fees
 * included); `applied.usageBasis` says whether those counts were reported by
 * the provider. A server that does not say is treated as an estimate. Without
 * a server figure the client prices the token counts at list rates, which
 * is always an estimate (no cache split, no tool fees).
 */
export function resolvePaneCost(
  message: Pick<ClientMessage, "costUsd" | "promptTokens" | "completionTokens" | "applied">,
  model: ModelInfo | undefined
): PaneCost | null {
  if (typeof message.costUsd === "number" && Number.isFinite(message.costUsd) && message.costUsd > 0) {
    return { usd: message.costUsd, basis: message.applied?.usageBasis === "reported" ? "reported" : "estimated" };
  }
  const input = message.promptTokens ?? 0;
  const output = message.completionTokens ?? 0;
  if (model && (input > 0 || output > 0)) {
    const usd = estimateCostUsd(model, { input, output });
    if (usd > 0) return { usd, basis: "estimated" };
  }
  return null;
}

/** Basis of the token counts on a done message (independent of whether a cost exists). */
function tokenBasis(message: Pick<ClientMessage, "promptTokens" | "completionTokens" | "applied">): PaneUsageBasis | null {
  if (message.promptTokens == null && message.completionTokens == null) return null;
  return message.applied?.usageBasis === "reported" ? "reported" : "estimated";
}

/**
 * Fold one stream frame into the pane.
 *
 * `resolveModel` prices a done frame that carries no server cost. Frames that
 * carry nothing for a pane (meta, ping, title, ...) return the run unchanged.
 */
export function applyChunk(
  run: PaneRun,
  chunk: StreamChunk,
  at: number,
  resolveModel: (id: string) => ModelInfo | undefined = () => undefined
): PaneRun {
  switch (chunk.type) {
    case "activity": {
      const kind = chunk.event.kind;
      // Keyed on `kind`, never on an English title (INV-28). A search row of
      // any kind means search was offered to this model.
      const searched = kind === "search" ? { webSearchApplied: true } : {};
      if (kind === "reasoning") return { ...run, ...searched, status: run.status === "writing" ? run.status : "thinking" };
      if (kind === "write") return { ...run, ...searched, status: "writing" };
      return { ...run, ...searched, status: run.status === "submitting" ? "thinking" : run.status };
    }
    case "reasoning":
      return {
        ...run,
        ...firstOutput(run, at),
        status: run.status === "writing" ? run.status : "thinking",
        reasoning: run.reasoning + chunk.text,
      };
    case "delta":
      return {
        ...run,
        ...firstOutput(run, at),
        firstAnswerAt: run.firstAnswerAt ?? at,
        status: "writing",
        content: run.content + chunk.text,
      };
    case "sources":
      return { ...run, sources: chunk.sources };
    case "done": {
      const message = chunk.message;
      const servedModelId = message.model ?? null;
      const cost = resolvePaneCost(message, resolveModel(servedModelId ?? run.requestedModelId ?? ""));
      const applied = message.applied;
      return {
        ...run,
        status: "done",
        content: message.content || run.content,
        reasoning: message.reasoning ?? run.reasoning,
        ...finished(run, at),
        servedModelId,
        // Auto's receipt carries the effort it chose when `applied` is absent.
        appliedEffort: applied ? applied.reasoningEffort : message.routing ? message.routing.effort : run.appliedEffort,
        webSearchApplied: applied ? applied.webSearch : run.webSearchApplied,
        promptTokens: message.promptTokens ?? null,
        completionTokens: message.completionTokens ?? null,
        costUsd: cost?.usd ?? null,
        usageBasis: cost?.basis ?? tokenBasis(message),
        sources: message.sources ?? run.sources,
        finishReason: chunk.finishReason ?? message.finishReason ?? "stop",
      };
    }
    case "error":
      return {
        ...run,
        status: "error",
        errorMessage: chunk.message,
        errorAction: "retry",
        ...finished(run, at),
        finishReason: chunk.finishReason ?? "error",
      };
    default:
      return run;
  }
}

// ── Error mapping ────────────────────────────────────────────────────────────

export const DROPPED_MESSAGE = "The connection dropped before this model finished. Run it again.";
export const OFFLINE_MESSAGE = `Couldn’t reach ${PRODUCT_NAME}. Check your connection, then run it again.`;

/** A machine code such as "budget_exceeded" is not a sentence anyone should read. */
function isMachineCode(text: string): boolean {
  return /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(text) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(text);
}

function readable(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && !isMachineCode(text) ? text : null;
}

/**
 * A refused /api/chat request, as one pane's failure. Machine-readable
 * refusals (402 budget_exceeded) carry the sentence in `message`; plain ones
 * keep it in `error`. Upgrading is offered only where it fixes the refusal:
 * an unverified email is a 402 too, and no plan clears it.
 */
export function failureFromResponse(status: number, body: unknown): PaneFailure {
  const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sentence = readable(data.message) ?? readable(data.error);
  const code = typeof data.code === "string" ? data.code : null;
  if (status === 402) {
    if (code === "EMAIL_UNVERIFIED") {
      return { message: sentence ?? "Confirm your email address, then run it again.", action: "retry" };
    }
    return { message: sentence ?? "You’ve reached your plan’s limit for now.", action: "upgrade" };
  }
  if (status === 401) return { message: "You’re signed out. Sign in again, then run it again.", action: null };
  if (status === 429) return { message: sentence ?? "Too many requests at once. Wait a moment, then run it again.", action: "retry" };
  if (status === 503) return { message: sentence ?? "This model is unavailable right now. Try again shortly.", action: "retry" };
  if (status >= 500) return { message: sentence ?? `The server hit an error (${status}). Run it again.`, action: "retry" };
  return { message: sentence ?? `The request was refused (${status}).`, action: "retry" };
}

/** A thrown fetch or read, as one pane's failure. */
export function failureFromException(err: unknown): PaneFailure {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // Browsers report an unreachable server as a TypeError with a vendor phrase.
  if ((err instanceof TypeError && /fetch|network|load failed/i.test(message)) || /networkerror|failed to fetch/i.test(message)) {
    return { message: OFFLINE_MESSAGE, action: "retry" };
  }
  return { message: message.trim() || "Something went wrong. Run it again.", action: "retry" };
}
