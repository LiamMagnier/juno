/**
 * The round trip of one folder call: the chat turn waits here while the Mac
 * runs the call, and `/api/chat/local-tools/{callId}` delivers the answer.
 *
 * In memory, on purpose. Both ends of the trip are the same process: the turn
 * that sent the `local_tool` frame holds its stream open on the backend that
 * accepted it, and production runs one backend process (`juno-backend`,
 * deploy/ecosystem.config.js). The map lives on `globalThis` because Next
 * bundles each route separately and a module-level map would be one map per
 * route bundle — the turn would wait on a map the result route never sees.
 *
 * If the backend ever runs more than one process, this becomes a table (the
 * approval receipts' polling in action-approval-store.ts is the model): a
 * result posted to a process that is not holding the turn answers `unknown`,
 * the Mac reports that, and the turn's wait ends in its timeout.
 *
 * Pure apart from timers: no `server-only`, so the tests drive it directly.
 */

export type LocalToolOutcome = "succeeded" | "failed" | "denied";

export interface LocalToolResult {
  outcome: LocalToolOutcome;
  /** What the Mac reports: the listing, the file text, the command output, or why not. */
  output: string;
}

/** The most text one result may carry back to the model. */
export const MAX_LOCAL_TOOL_OUTPUT_CHARS = 60_000;

interface Pending {
  userId: string;
  generationId: string;
  settle(result: LocalToolResult): void;
}

const KEY = Symbol.for("alevr.chat.localToolCalls");
type Registry = Map<string, Pending>;

function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  return (holder[KEY] ??= new Map());
}

export const LOCAL_TOOL_TIMEOUT_OUTPUT =
  "The Mac did not answer in time, so this call's outcome is unknown. Check the folder before trying again.";
export const LOCAL_TOOL_CANCELLED_OUTPUT = "The reply was stopped before the Mac answered.";

/**
 * Waits for the Mac's answer to `callId`. Always settles: with the result,
 * with a timeout outcome, or with a cancellation when the turn is stopped.
 */
export function awaitLocalToolResult(input: {
  callId: string;
  userId: string;
  generationId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LocalToolResult> {
  const calls = registry();
  return new Promise<LocalToolResult>((resolve) => {
    let done = false;
    const finish = (result: LocalToolResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      calls.delete(input.callId);
      resolve(result);
    };
    const onAbort = () => finish({ outcome: "failed", output: LOCAL_TOOL_CANCELLED_OUTPUT });
    const timer = setTimeout(() => finish({ outcome: "failed", output: LOCAL_TOOL_TIMEOUT_OUTPUT }), input.timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) {
      onAbort();
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    calls.set(input.callId, { userId: input.userId, generationId: input.generationId, settle: finish });
  });
}

export type LocalToolDelivery = "accepted" | "unknown";

/**
 * Hands the Mac's answer to the waiting turn. `unknown` covers a call that
 * already settled, one that never existed, and one that belongs to someone
 * else — the same answer for all three, so the route cannot be used to learn
 * which call ids are live for another account.
 */
export function deliverLocalToolResult(input: {
  callId: string;
  userId: string;
  generationId?: string;
  result: LocalToolResult;
}): LocalToolDelivery {
  const pending = registry().get(input.callId);
  if (!pending || pending.userId !== input.userId) return "unknown";
  if (input.generationId && pending.generationId !== input.generationId) return "unknown";
  pending.settle({
    outcome: input.result.outcome,
    output: input.result.output.slice(0, MAX_LOCAL_TOOL_OUTPUT_CHARS),
  });
  return "accepted";
}

/** How many calls are waiting right now (tests and diagnostics). */
export function pendingLocalToolCalls(): number {
  return registry().size;
}
