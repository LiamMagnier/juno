/**
 * The thumbs-up burst plays once per browser session.
 *
 * Swell is the receipt that a rating landed, and it plays every time. The six
 * particles were the flourish on top, and a flourish on every answer of a
 * long session stops being a thank-you and becomes a tic. So the first
 * thumbs-up of a session bursts and the rest only swell. A thumbs-down never
 * celebrates at all (message-feedback.tsx).
 *
 * `sessionStorage` when it is readable, so a reload inside one session does
 * not earn a second burst; a module flag when it is not (private windows,
 * blocked storage), so the rule still holds for the page's life.
 */

export const BURST_SESSION_KEY = "juno.feedback-burst";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

let spentInMemory = false;

function sessionStore(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/**
 * True exactly once per session: the caller that gets `true` plays the burst.
 * `storage` is injectable for tests.
 */
export function claimFeedbackBurst(storage: StorageLike | null = sessionStore()): boolean {
  if (spentInMemory) return false;
  spentInMemory = true;
  try {
    if (storage?.getItem(BURST_SESSION_KEY)) return false;
    storage?.setItem(BURST_SESSION_KEY, "1");
  } catch {
    // Storage refused: the in-memory flag above already holds the line.
  }
  return true;
}

/** Test seam: forget the in-memory flag. */
export function resetFeedbackBurstForTests(): void {
  spentInMemory = false;
}
