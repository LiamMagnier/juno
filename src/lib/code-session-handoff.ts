/**
 * Hand-off for the first prompt of a device Juno Code session.
 *
 * The New session screen collects the task up front, but the create contract
 * for a device session is prompt-free (POST /api/conversations only records the
 * workspace). So the prompt rides sessionStorage, keyed by conversation id, into
 * CodeSessionView, which dispatches it once the Mac is reachable. sessionStorage
 * (not a query param) keeps the task text out of the URL and history.
 */
export const CODE_PENDING_PROMPT_PREFIX = "juno:code:pending-prompt:";

/** Read + clear the pending first prompt for a device session (one-shot). */
export function takePendingCodePrompt(conversationId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const key = `${CODE_PENDING_PROMPT_PREFIX}${conversationId}`;
    const value = window.sessionStorage.getItem(key);
    if (value) window.sessionStorage.removeItem(key);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}
