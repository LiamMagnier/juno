/**
 * What a voice call says when it cannot start, stops, or ends.
 *
 * The rule (voice audit §4.6): no provider ids, HTTP codes or raw provider
 * text on screen. The call used to show "budget_exceeded" (the token route's
 * code, with the route's own sentence beside it unread), "Couldn't start
 * gemini: …" and "gemini closed (1011): …". Callers log the raw detail to the
 * console; the screen gets a sentence that says what happened and what to do.
 */

const BUDGET = "Voice is paused: you’ve used this period’s voice budget.";
const UNREACHABLE = "Couldn’t reach voice. Check your connection, then try again.";

/** A refusal from `/api/voice/relay-token`: its `error` (a code or a sentence) and optional `message`. */
export function voiceStartErrorCopy(code: string | undefined, message?: string): string {
  if (message?.trim()) return message.trim();
  if (!code) return UNREACHABLE;
  if (code === "budget_exceeded") return BUDGET;
  if (code === "Unauthorized") return "Sign in again to start a voice call.";
  // A sentence the route already wrote (the plan gate, the rate limit) stands.
  if (/\s/.test(code) && /[.!?]$/.test(code)) return code;
  return UNREACHABLE;
}

/** An `error` frame from the relay, as the person should read it. */
export function voiceErrorCopy(raw: string, modelName: string | null): string {
  const voice = modelName ?? "This voice";
  if (/budget/i.test(raw)) return BUDGET;
  if (/time limit|session[- ]limit/i.test(raw)) return "This call reached its time limit. Start a new call to continue.";
  if (/^couldn'?t start|not configured|unknown provider|unavailable/i.test(raw)) {
    return `${voice} isn’t available right now. Try again, or pick another voice.`;
  }
  if (/closed \(\d+\)|stopped|disconnect/i.test(raw)) return `${voice} stopped responding. Try again.`;
  return "Voice stopped. Try again.";
}

/**
 * Why a call ended, when the person did not end it themselves. A provider's
 * hard cap (Gemini Live: 15 minutes) used to end the call with no reason on
 * screen; `session.closed` carried one that nothing read.
 */
export function voiceEndedCopy(reason: string | null, modelName: string | null, maxSessionSec: number | null): string | null {
  if (!reason || reason === "client") return null;
  if (reason === "session-limit") {
    const minutes = maxSessionSec && maxSessionSec > 0 ? Math.round(maxSessionSec / 60) : null;
    return modelName && minutes
      ? `Ended: calls with ${modelName} last up to ${minutes} minutes.`
      : "Ended: this call reached its time limit.";
  }
  if (reason === "budget") return "Ended: you’ve used this period’s voice budget.";
  return "The call ended.";
}

/**
 * The last minute of a capped call, said before the cap ends it: "1 min left"
 * from 60 s, then the seconds from 30 s. Null outside that minute, for an
 * uncapped provider, and once the cap has passed (the close says the rest).
 */
export function voiceLimitWarning(startedAtMs: number | null, maxSessionSec: number | null, nowMs: number): string | null {
  if (startedAtMs == null || !maxSessionSec || maxSessionSec <= 0) return null;
  const leftMs = startedAtMs + maxSessionSec * 1000 - nowMs;
  if (leftMs <= 0 || leftMs > 60_000) return null;
  return leftMs > 30_000 ? "1 min left in this call" : `${Math.ceil(leftMs / 1000)} s left in this call`;
}
