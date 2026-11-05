/**
 * The pure rules behind routing telemetry: how a turn's ending maps onto the
 * state the router learns from, which endings say nothing about the model,
 * and how a turn's timings are measured. Client-safe (no `server-only`, no
 * Prisma), so unit tests and the eval harness can import them without the
 * react-server condition. `telemetry-store.ts` re-exports every one of them.
 */

export type CompletionState = "completed" | "partial" | "failed" | "stopped";

/** Map a turn's finish reason onto the four states the router learns from. */
export function completionStateFor(finishReason: string | null | undefined, persistedPartial: boolean): CompletionState {
  if (finishReason === "user_stopped") return "stopped";
  if (finishReason === "stop" || finishReason === "tool_calls" || !finishReason) return persistedPartial ? "partial" : "completed";
  return persistedPartial ? "partial" : "failed";
}

/** How a turn ended that the model had no part in (see `endingSaysNothingAboutModel`). */
export interface PlatformEnding {
  /** The process drained for a restart mid-stream (finish reason "error"). */
  shutdown?: boolean;
  /** Another process took over the durable receipt (finish reason "error"). */
  leaseLost?: boolean;
  /** The account's own budget ceiling halted the stream (finish reason "user_stopped"). */
  budgetHalted?: boolean;
}

/**
 * True when a turn's ending was caused by the platform, not by the model or
 * the reader: a deploy draining the process, a lost receipt lease, the
 * account's budget halting the stream. Such a turn writes NO outcome row. As
 * a row it read as "failed" or "stopped", which `outcomeSucceeded` counts
 * against the model — so every deploy made the models that happened to be
 * streaming look worse, and Auto learned to avoid them for it.
 */
export function endingSaysNothingAboutModel(ending: PlatformEnding | null | undefined): boolean {
  return !!ending && (!!ending.shutdown || !!ending.leaseLost || !!ending.budgetHalted);
}

/** The slice of a finished turn trace (chat/turn/trace.ts) the outcome row reads. */
export interface TracedLatency {
  latency: { totalMs: number; ttftMs: number | null };
}

/**
 * The outcome row's two timings, from ONE start. The turn trace is opened by
 * the chat route before the turn runs and measures both the first token and
 * the whole turn from that moment, so when it finished they come from it
 * together: time to first token can never exceed the turn's own length. Mixing
 * the trace's first token with a later start (`runTurn`'s own clock) once
 * stored a first token at 65 ms on a 49 ms turn. Without a trace (it was
 * already finished elsewhere, or threw), the turn's own clock gives the length
 * and the first token is unknown rather than guessed.
 */
export function outcomeTimings(
  trace: TracedLatency | null | undefined,
  turnStartedAt: number,
  now: number = Date.now()
): { latencyMs: number; firstTokenMs: number | null } {
  if (trace) {
    const latencyMs = Math.max(0, trace.latency.totalMs);
    const ttft = trace.latency.ttftMs;
    return { latencyMs, firstTokenMs: ttft == null ? null : Math.min(Math.max(0, ttft), latencyMs) };
  }
  return { latencyMs: Math.max(0, now - turnStartedAt), firstTokenMs: null };
}
