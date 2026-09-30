import { mergeArtifactUpdate } from "@/lib/artifact-card-state";
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
 * One artifact came back from a route that changed it — a save, a restore
 * from Recently deleted, a suggestion applied or dismissed — so it takes its
 * place in the chat's list.
 *
 * By id, not identifier: the id is the artifact's identity, and the entry
 * keeps its position so the transcript's cards and an open canvas do not
 * shuffle. An id the list does not hold is ignored rather than appended: a
 * route answering for an artifact this chat never had is not a reason to
 * give the chat a new one.
 *
 * The fold is `mergeArtifactUpdate`, so a save response that did not read
 * suggestions leaves a waiting one in place, and a restore clears `deletedAt`.
 * Returns the same list when nothing matched, so a no-op sets no state.
 */
export function replaceArtifactById(current: ClientArtifact[], next: ClientArtifact): ClientArtifact[] {
  const index = current.findIndex((a) => a.id === next.id);
  if (index === -1) return current;
  const out = current.slice();
  out[index] = mergeArtifactUpdate(current[index], next);
  return out;
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

/**
 * The artifact an `<juno:artifact>` tag in `message` refers to.
 *
 * Usually the one row with that identifier. When a re-emission changed the
 * type, the server gave the identifier to a new artifact and moved the old one
 * to `{identifier}~{id tail}` (see `retiredIdentifier`). A tag written before
 * that change must still open what it made, so among the rows that have held
 * the identifier, the one this message created wins; otherwise the newest one
 * that existed when the message was written.
 */
export function resolveArtifactTag(
  byIdentifier: ReadonlyMap<string, ClientArtifact>,
  identifier: string,
  message: Pick<ClientMessage, "id" | "createdAt">
): ClientArtifact | undefined {
  const current = byIdentifier.get(identifier);
  const held: ClientArtifact[] = [];
  for (const [key, artifact] of byIdentifier) {
    if (key.startsWith(`${identifier}~`)) held.push(artifact);
  }
  if (held.length === 0) return current;
  if (current) held.push(current);
  const own = held.find((a) => a.messageId === message.id);
  if (own) return own;
  const writtenAt = Date.parse(message.createdAt);
  const byAge = held.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let pick = byAge[0];
  for (const a of byAge) if (Date.parse(a.createdAt) <= writtenAt) pick = a;
  return pick;
}
