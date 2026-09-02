import type { ChatFinishReason, ClientMessage } from "@/types/chat";

/**
 * Stable fingerprint for the server-owned transcript supplied to `useChat`.
 *
 * The parent can re-render with a fresh array containing the same messages.
 * Treating that as a server update would overwrite live optimistic/streaming
 * state as soon as a generation becomes idle. The serialized value changes
 * only when the server payload itself changes.
 */
export function serverTranscriptRevision(messages: ClientMessage[]): string {
  return JSON.stringify(messages);
}

export type SettledClientMessage = ClientMessage & {
  streaming: false;
  error?: true;
  errorMessage?: string | null;
};

/** Never let a terminal provider response settle into an invisible bubble. */
export function settleClientMessage(
  message: ClientMessage,
  finishReason?: ChatFinishReason | null
): SettledClientMessage {
  const settledReason = finishReason ?? message.finishReason;
  const hasVisibleAnswer =
    message.content.trim().length > 0 ||
    (message.attachments?.length ?? 0) > 0;

  if (hasVisibleAnswer) {
    return { ...message, finishReason: settledReason, streaming: false };
  }

  const errorMessage =
    settledReason === "length"
      ? "The model used its output limit before producing an answer. Try again with lower reasoning effort or choose another model."
      : "The model finished without returning an answer. Try again or choose another model.";

  return {
    ...message,
    content: errorMessage,
    finishReason: settledReason ?? "error",
    streaming: false,
    error: true,
    errorMessage,
  };
}
