/**
 * "Your turn: take control", carried from the picture-in-picture to the
 * overlay it opens.
 *
 * The PiP and the overlay are siblings that only share `onOpen` through the
 * chat view, and that view opens the overlay in watch. Rather than thread a
 * mode through it, the PiP leaves an intent here just before it opens the
 * overlay, and the overlay takes it once on open: straight into control,
 * with the question that asked for it pinned, so Hand back answers that one.
 *
 * Module state, single-use and short-lived: an intent nobody takes within a
 * few seconds (the overlay never opened) is dropped, so a later ordinary
 * open is never turned into a takeover.
 */

export interface ComputerControlIntent {
  agentId: string;
  /** The open question that asked the person to take over, when the PiP saw one. */
  questionId: string | null;
  at: number;
}

/** How long an intent waits for the overlay to take it. */
export const CONTROL_INTENT_TTL_MS = 5_000;

let pending: ComputerControlIntent | null = null;

/** Leaves the intent for `agentId`'s overlay. Replaces any earlier one. */
export function requestComputerControl(agentId: string, questionId: string | null, now = Date.now()): void {
  pending = { agentId, questionId, at: now };
}

/** Takes the intent for `agentId`, once; null when there is none, it is someone else's, or it went stale. */
export function takeComputerControlIntent(agentId: string, now = Date.now()): ComputerControlIntent | null {
  const intent = pending;
  if (!intent) return null;
  if (now - intent.at > CONTROL_INTENT_TTL_MS) {
    pending = null;
    return null;
  }
  if (intent.agentId !== agentId) return null;
  pending = null;
  return intent;
}

/** Test seam. */
export function resetComputerControlIntentForTest(): void {
  pending = null;
}
