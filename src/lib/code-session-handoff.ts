import type { ClientAttachment } from "@/types/chat";

/**
 * Hand-off for the first prompt of a device Juno Code session.
 *
 * The New session screen collects the task up front, but the create contract
 * for a device session is prompt-free (POST /api/conversations only records the
 * workspace). So the prompt (and any staged attachments) rides sessionStorage,
 * keyed by conversation id, into CodeSessionView, which dispatches once the Mac
 * is reachable. sessionStorage (not a query param) keeps the task text out of
 * the URL and history.
 *
 * READ AND CLEAR ARE SEPARATE ON PURPOSE. The read used to `removeItem` as it
 * went, and the text then lived only in React state — so a reload while the
 * Mac was offline lost the instruction the composer had just promised was
 * "safe here" and would "send the moment the Mac reconnects". Now the session
 * view peeks, and clears only once `send` has returned `accepted`, which is the
 * first moment the words exist anywhere durable.
 */
export const CODE_PENDING_PROMPT_PREFIX = "juno:code:pending-prompt:";

export type PendingCodePrompt = {
  text: string;
  attachments: ClientAttachment[];
};

const keyFor = (conversationId: string) => `${CODE_PENDING_PROMPT_PREFIX}${conversationId}`;

/** Persist the first prompt (+ optional attachments) for a just-created session. */
export function setPendingCodePrompt(
  conversationId: string,
  text: string,
  attachments: ClientAttachment[] = [],
): void {
  if (typeof window === "undefined") return;
  try {
    const payload: PendingCodePrompt = {
      text: text.trim(),
      attachments: attachments.slice(0, 10),
    };
    window.sessionStorage.setItem(keyFor(conversationId), JSON.stringify(payload));
  } catch {
    /* quota / private mode — session view simply won't auto-send */
  }
}

/** Read the pending first prompt for a device session WITHOUT consuming it. */
export function peekPendingCodePrompt(conversationId: string): PendingCodePrompt | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(keyFor(conversationId));
    if (!value) return null;

    // New shape: JSON { text, attachments }.
    try {
      const parsed = JSON.parse(value) as Partial<PendingCodePrompt>;
      if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
        const attachments = Array.isArray(parsed.attachments)
          ? parsed.attachments.filter(
              (a): a is ClientAttachment =>
                !!a &&
                typeof a === "object" &&
                typeof a.id === "string" &&
                typeof a.fileName === "string" &&
                typeof a.url === "string",
            )
          : [];
        if (!parsed.text.trim() && attachments.length === 0) return null;
        return { text: parsed.text, attachments };
      }
    } catch {
      // Fall through to legacy plain-string payload.
    }

    // Legacy: bare prompt string written by older clients.
    const text = value.trim();
    return text ? { text, attachments: [] } : null;
  } catch {
    return null;
  }
}

/** Forget the pending prompt — call once the words have landed on a run. */
export function clearPendingCodePrompt(conversationId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(keyFor(conversationId));
  } catch {
    /* nothing to clear, or storage unavailable */
  }
}
