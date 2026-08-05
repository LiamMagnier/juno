/**
 * One terminal-state model for a generation.
 *
 * A chat turn could end in five places in the route — the success path, the
 * partial-save path, the failure path, the persistence-failure path inside it,
 * and the outer catch that wraps the whole stream — and each computed the
 * finish reason, the durable receipt's failure code and the refund decision
 * from scratch. They agreed by inspection rather than by construction, and the
 * private branch had its own fourth copy that omitted the canvas condition.
 *
 * The rules are subtle enough to be worth stating once:
 *
 *  - A stall is checked FIRST. Aborting the controller makes the SDK throw its
 *    own user-abort error, so without this a wedged provider is recorded and
 *    shown as though the user had pressed Stop.
 *  - A budget halt is a stop, not a failure. The user is told, the partial
 *    answer is kept, and they are billed for what was produced — exactly like
 *    pressing Stop.
 *  - A partial answer is saved only when there is something to save AND the
 *    ending was a stop or a dropped connection. Anything else lost the turn.
 *  - A canvas edit never saves a partial: its output is a patch protocol, and
 *    half a patch applied to a user's artifact is worse than no answer.
 *  - The message is refunded unless the user stopped it themselves.
 */
import { classifyErrorFinishReason, generationFailureCode } from "@/lib/chat-responses";
import type { ChatFinishReason } from "@/types/chat";

export const LEASE_EXPIRED_FAILURE_CODE = "GENERATION_LEASE_EXPIRED";
export const PERSISTENCE_FAILED_FAILURE_CODE = "GENERATION_PERSISTENCE_FAILED";
export const INTERNAL_ERROR_FAILURE_CODE = "GENERATION_INTERNAL_ERROR";
export const START_FAILED_FAILURE_CODE = "GENERATION_START_FAILED";

export interface TerminalSignals {
  /** The provider went silent long enough for the watchdog to fire. */
  stalled: boolean;
  /** The mid-stream budget ceiling aborted the provider. */
  budgetHalted: boolean;
  /** The explicit cancel endpoint was called for this generation. */
  userStopped: boolean;
  /** The durable first-submission lease is no longer owned by this process. */
  leaseLost: boolean;
  /** Whatever the stream threw. */
  error: unknown;
}

export interface PartialOutput {
  hasText: boolean;
  hasReasoning: boolean;
  /** This turn is a canvas edit, whose partial output is never persisted. */
  artifactEdit: boolean;
}

export interface TerminalState {
  finishReason: ChatFinishReason;
  /** Recorded on the durable receipt when the turn ends without an answer. */
  failureCode: string;
  /** Save what was produced instead of discarding it. */
  persistsPartial: boolean;
  /** Give the consumed message back. */
  refunds: boolean;
}

/** The finish reason alone, for callers that only need to classify. */
export function terminalFinishReason(signals: TerminalSignals): ChatFinishReason {
  if (signals.stalled) return "error";
  if (signals.budgetHalted || signals.userStopped) return "user_stopped";
  return classifyErrorFinishReason(signals.error);
}

/**
 * The failure code for a terminal state, with a caller-chosen fallback.
 *
 * A lost lease outranks every other explanation: the row this process was going
 * to write is already owned by someone else, so whatever else went wrong is not
 * the thing worth recording.
 */
export function terminalFailureCode(leaseLost: boolean, fallback: string): string {
  return leaseLost ? LEASE_EXPIRED_FAILURE_CODE : fallback;
}

export function resolveTerminalState(signals: TerminalSignals, output: PartialOutput): TerminalState {
  const finishReason = terminalFinishReason(signals);
  const persistsPartial =
    !output.artifactEdit &&
    (finishReason === "user_stopped" || finishReason === "network_error") &&
    (output.hasText || output.hasReasoning);
  return {
    finishReason,
    failureCode: terminalFailureCode(signals.leaseLost, generationFailureCode(finishReason)),
    persistsPartial,
    // A user who stopped their own generation keeps the charge: the work was
    // done and, when there is any output at all, they get to keep it too.
    refunds: !persistsPartial && finishReason !== "user_stopped",
  };
}
