/*
 * In-page news about an artifact, for lists that loaded it on their own.
 *
 * The artifact menu renames, copies, restores and deletes from wherever it is
 * drawn — the artifact's page, a Library row, the design workspace — and a
 * Library list fetched in the browser does not hear `router.refresh()`. It
 * listens for this instead and reloads, so a rename shows in the row it was
 * made from.
 *
 * `juno:open-artifact` asks the chat on screen to open one of its artifacts in
 * the canvas (the research reader's "Open in canvas"). The chat marks the
 * detail `opened` when it did, so the caller can fall back to the artifact's
 * own page when no chat on screen has it.
 */

export const ARTIFACT_CHANGED_EVENT = "juno:artifact-changed";
export const OPEN_ARTIFACT_EVENT = "juno:open-artifact";

export interface ArtifactChangedDetail {
  id: string;
  kind: "created" | "updated" | "deleted";
  title?: string;
}

export interface OpenArtifactDetail {
  conversationId: string | null;
  identifier: string;
  /** Set by the chat that opened it. */
  opened?: boolean;
}

export function announceArtifactChanged(detail: ArtifactChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ArtifactChangedDetail>(ARTIFACT_CHANGED_EVENT, { detail }));
}

/** Asks the chat on screen to open the artifact in its canvas. True when one did. */
export function requestOpenArtifact(conversationId: string | null, identifier: string): boolean {
  if (typeof window === "undefined") return false;
  const detail: OpenArtifactDetail = { conversationId, identifier };
  window.dispatchEvent(new CustomEvent<OpenArtifactDetail>(OPEN_ARTIFACT_EVENT, { detail }));
  return detail.opened === true;
}
