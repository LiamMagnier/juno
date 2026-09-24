import type { ChatFinishReason, ClientArtifact, ClientMessage } from "@/types/chat";

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

/**
 * Fold one settled turn's artifacts into the chat's list, as the server just
 * wrote them.
 *
 * Keyed by identifier: the server keeps one row per identifier per
 * conversation and appends to it across edits and regenerates, so a returned
 * artifact replaces the entry it updates and keeps its id (an open canvas
 * looks it up by id). Any other entry still pinned to `messageId` was
 * detached by the server — a regenerated answer that no longer emits it — so
 * it is detached here too rather than left claiming an answer it is not in.
 * Nothing is removed: the server removed nothing.
 */
export function applyTurnArtifacts(
  current: ClientArtifact[],
  incoming: ClientArtifact[],
  messageId: string
): ClientArtifact[] {
  const returned = new Set(incoming.map((a) => a.identifier));
  const stale = current.some((a) => a.messageId === messageId && !returned.has(a.identifier));
  if (incoming.length === 0 && !stale) return current;
  const map = new Map(
    current.map((a) => [
      a.identifier,
      a.messageId === messageId && !returned.has(a.identifier) ? { ...a, messageId: null } : a,
    ])
  );
  for (const a of incoming) map.set(a.identifier, a);
  return Array.from(map.values());
}

/**
 * The server's side of an edit, mirrored: the answers after the edited
 * message are deleted, and their artifacts stay, detached, with every version
 * and share link.
 */
export function detachArtifactsFromMessages(
  current: ClientArtifact[],
  messageIds: ReadonlySet<string>
): ClientArtifact[] {
  if (!current.some((a) => a.messageId && messageIds.has(a.messageId))) return current;
  return current.map((a) => (a.messageId && messageIds.has(a.messageId) ? { ...a, messageId: null } : a));
}
