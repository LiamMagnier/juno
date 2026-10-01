import type { ClientActivityEvent, ClientArtifact, ClientArtifactSuggestion } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";

/**
 * What an artifact's card, the canvas and `/a/{id}` need to decide about the
 * R1 lifecycle — Recently deleted, a held re-emit, a picture that became a
 * placeholder — as pure functions.
 *
 * Pure because the repo has no DOM test environment (00 §9): everything a
 * component would otherwise decide inline, and so could only be checked by
 * looking at it, is decided here and pinned by `tests/artifact-card-state.test.ts`.
 * The components only draw what these return.
 */

/** In Recently deleted. `deletedAt` is present only while it is. */
export function isTrashed(artifact: Pick<ClientArtifact, "deletedAt"> | null | undefined): boolean {
  return !!artifact?.deletedAt;
}

/**
 * The artifacts a chat can OPEN: everything but Recently deleted.
 *
 * The transcript keeps trashed rows (queries.ts loads them) so a card can
 * still say where its artifact went and offer it back. Everything that would
 * open one — the canvas, SessionOutputs, the `?artifact=` deep link — reads
 * this instead, because every route behind an open answers 404 for a trashed
 * row, and a canvas on a row it cannot save to is a trap.
 *
 * Returns the SAME array when nothing is trashed, which is nearly always, so
 * a memo downstream keyed on it does not churn.
 */
export function liveArtifacts(list: ClientArtifact[]): ClientArtifact[] {
  return list.some(isTrashed) ? list.filter((a) => !isTrashed(a)) : list;
}

/**
 * The suggestion a message's card carries, if any.
 *
 * A held re-emit belongs to the reply that made it: the bar goes on THAT
 * message's card and nowhere else in the transcript, so a long chat that
 * mentions the artifact ten times shows the choice once, where it was made.
 * A trashed artifact carries none — every proposal route 404s for it, and the
 * card is busy saying it is in Recently deleted.
 */
export function cardSuggestion(
  artifact: Pick<ClientArtifact, "pendingSuggestion" | "deletedAt"> | null | undefined,
  messageId: string
): ClientArtifactSuggestion | null {
  const suggestion = artifact?.pendingSuggestion;
  if (!suggestion || isTrashed(artifact)) return null;
  return suggestion.messageId === messageId ? suggestion : null;
}

/**
 * The suggestion was written against an older version than the one on screen:
 * the person (or another device) saved after Juno's reply. Applying it then
 * would put Juno's version over theirs, so the bar routes Apply through
 * Compare rather than applying blind.
 */
export function suggestionIsBehind(suggestion: Pick<ClientArtifactSuggestion, "baseVersion">, currentVersion: number): boolean {
  return suggestion.baseVersion !== currentVersion;
}

/**
 * How many pictures in `identifier` became a placeholder in this turn.
 *
 * From the NEWEST verification report that looked at the artifact, not the
 * sum of all of them: a turn that was verified, repaired and verified again
 * carries a report per pass, and counting every pass would multiply the
 * pictures. One note is one picture (chat-artifact-verification.ts).
 *
 * Reports written before notes existed have no `notes` and count as none.
 */
export function placeholderCount(
  activity: readonly ClientActivityEvent[] | null | undefined,
  identifier: string
): number {
  if (!activity || !identifier) return 0;
  for (let i = activity.length - 1; i >= 0; i--) {
    const report = activity[i]?.artifactVerification;
    if (!report) continue;
    // Arrays read defensively: this is a persisted, decrypted log, and a
    // report from an older writer must degrade to "none", never throw.
    const notes = (Array.isArray(report.notes) ? report.notes : []).filter(
      (n) => n?.identifier === identifier && n.code === "image_placeholder"
    );
    const mentions = (list: unknown) => Array.isArray(list) && list.includes(identifier);
    const looked = notes.length > 0 || mentions(report.accepted) || mentions(report.refused);
    if (looked) return notes.length;
  }
  return 0;
}

/** "1 picture became a placeholder" / "3 pictures became placeholders". */
export function placeholderNote(count: number): string | null {
  if (!Number.isFinite(count) || count < 1) return null;
  return count === 1 ? "1 picture became a placeholder" : `${count} pictures became placeholders`;
}

/**
 * Fold a server copy of an artifact into the one a surface already holds.
 *
 * The payload is the truth with ONE exception. `pendingSuggestion` is added by
 * the serializer only when the read asked for it (ARTIFACT_CLIENT_INCLUDE) and
 * one is waiting, so an ABSENT key cannot tell "none waiting" from "this route
 * did not look". A person's save does not touch suggestions, so a save
 * response that did not look must not erase one that is still waiting. The
 * three states therefore mean:
 *
 *   undefined   unknown: keep what the surface had
 *   null        known to be gone (applied, dismissed, resolved elsewhere)
 *   an object   this one is waiting
 *
 * `deletedAt` follows the payload outright: every route that returns a live
 * row returns one without it, and a restore must clear it.
 */
export function mergeArtifactUpdate(prev: ClientArtifact | null | undefined, next: ClientArtifact): ClientArtifact {
  if (next.pendingSuggestion !== undefined || !prev?.pendingSuggestion || prev.id !== next.id) return next;
  return { ...next, pendingSuggestion: prev.pendingSuggestion };
}

/**
 * The server's copy after `suggestionId` was applied, dismissed or found
 * already resolved: that suggestion is gone for certain. A NEWER one the
 * server reports (a later reply held another) is kept.
 */
export function withSuggestionResolved(artifact: ClientArtifact, suggestionId: string): ClientArtifact {
  const waiting = artifact.pendingSuggestion;
  if (waiting && waiting.id !== suggestionId) return artifact;
  return { ...artifact, pendingSuggestion: null };
}

/** What a proposal action came back as, for the bar and the dialog to act on. */
export type SuggestionOutcome =
  | { kind: "applied"; artifact: ClientArtifact }
  | { kind: "dismissed"; artifact: ClientArtifact }
  /** The artifact moved on since the person looked; the suggestion still waits. */
  | { kind: "stale"; artifact: ClientArtifact | null }
  /** Applied or dismissed already (another tab, another device). */
  | { kind: "resolved"; artifact: ClientArtifact | null }
  /** The artifact is in Recently deleted, or the proposal went with its message. */
  | { kind: "gone" }
  | { kind: "error" };

function artifactIn(body: unknown): ClientArtifact | null {
  if (!body || typeof body !== "object") return null;
  const artifact = (body as { artifact?: unknown }).artifact;
  if (!artifact || typeof artifact !== "object") return null;
  const a = artifact as Partial<ClientArtifact>;
  return typeof a.id === "string" && typeof a.currentVersion === "number" ? (artifact as ClientArtifact) : null;
}

/**
 * `POST /api/artifacts/[id]/restore` → `{ artifact }` (§3B), or null when the
 * answer is not a restored artifact. Idempotent on the server, so a second
 * press on a card that already came back reads the same.
 */
export function restoredArtifact(status: number, body: unknown): ClientArtifact | null {
  if (status < 200 || status >= 300) return null;
  const artifact = artifactIn(body);
  return artifact && !isTrashed(artifact) ? artifact : null;
}

export function artifactRestoreUrl(artifactId: string): string {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/restore`;
}

/**
 * Read a proposal route's answer (§3C): 200 `{ artifact }`, 409
 * `{ error: "stale" | "resolved", artifact }`, 404 when the artifact is
 * trashed or the proposal is gone. The artifacts that come back are already
 * marked for `mergeArtifactUpdate`: a resolution clears the suggestion, a
 * stale answer leaves it unknown so the surface keeps it.
 */
export function suggestionOutcome(
  action: "apply" | "dismiss",
  status: number,
  body: unknown,
  suggestionId: string
): SuggestionOutcome {
  const artifact = artifactIn(body);
  if (status >= 200 && status < 300) {
    if (!artifact) return { kind: "error" };
    const resolved = withSuggestionResolved(artifact, suggestionId);
    return action === "apply" ? { kind: "applied", artifact: resolved } : { kind: "dismissed", artifact: resolved };
  }
  if (status === 404) return { kind: "gone" };
  if (status === 409) {
    const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
    if (error === "resolved") {
      return { kind: "resolved", artifact: artifact ? withSuggestionResolved(artifact, suggestionId) : null };
    }
    if (error === "stale") {
      // Left as the server sent it: `pendingSuggestion` absent means "keep".
      return { kind: "stale", artifact };
    }
  }
  return { kind: "error" };
}

/**
 * The words for each outcome, in one place so the card, the canvas and
 * `/a/{id}` say the same thing (§3C). Null where the surface says nothing.
 */
export function suggestionToast(
  action: "apply" | "dismiss",
  outcome: SuggestionOutcome
): { tone: "success" | "error"; message: string } | null {
  switch (outcome.kind) {
    case "applied":
      return { tone: "success", message: `Applied as v${outcome.artifact.currentVersion}.` };
    case "dismissed":
      return { tone: "success", message: "Suggestion dismissed." };
    case "stale":
      return { tone: "error", message: "This changed since the suggestion was made. Compare again before applying." };
    case "resolved":
      return { tone: "error", message: "This suggestion was already applied or dismissed." };
    case "gone":
      return { tone: "error", message: "This suggestion is no longer available." };
    case "error":
      return {
        tone: "error",
        message: action === "apply" ? "Couldn’t apply the suggestion." : "Couldn’t dismiss the suggestion.",
      };
  }
}

/** `GET …/proposals/[proposalId]` (§3C). Content is null for a DESIGN. */
export interface SuggestionComparison {
  proposal: {
    id: string;
    baseVersion: number;
    summary: string;
    status: "PENDING" | "APPLIED" | "DISCARDED" | "STALE";
    createdAt: string;
    type: string;
    title: string;
    content: string | null;
  };
  current: { version: number; content: string | null };
}

const PROPOSAL_STATUSES = new Set(["PENDING", "APPLIED", "DISCARDED", "STALE"]);

/** The comparison, or null when the body is not one (so the dialog says so). */
export function readSuggestionComparison(body: unknown): SuggestionComparison | null {
  if (!body || typeof body !== "object") return null;
  const { proposal, current } = body as { proposal?: Record<string, unknown>; current?: Record<string, unknown> };
  if (!proposal || !current) return null;
  if (typeof proposal.id !== "string" || typeof proposal.baseVersion !== "number") return null;
  if (typeof proposal.status !== "string" || !PROPOSAL_STATUSES.has(proposal.status)) return null;
  if (typeof current.version !== "number") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    proposal: {
      id: proposal.id,
      baseVersion: proposal.baseVersion,
      summary: text(proposal.summary) ?? "",
      status: proposal.status as SuggestionComparison["proposal"]["status"],
      createdAt: text(proposal.createdAt) ?? "",
      type: text(proposal.type) ?? "",
      title: text(proposal.title) ?? "",
      content: text(proposal.content),
    },
    current: { version: current.version, content: text(current.content) },
  };
}

/**
 * What the comparison has to warn about before Apply, if anything.
 *
 *   "resolved"  no longer PENDING: nothing to apply, and the words say why.
 *   "behind"    the artifact moved past the version Juno wrote against;
 *               applying replaces the newer version (which stays in history).
 */
export function comparisonNotice(
  view: SuggestionComparison
): { kind: "resolved"; message: string } | { kind: "behind"; message: string } | null {
  const { proposal, current } = view;
  if (proposal.status !== "PENDING") {
    const what =
      proposal.status === "APPLIED"
        ? "was already applied"
        : proposal.status === "DISCARDED"
          ? "was dismissed"
          : "was replaced by a newer one";
    return { kind: "resolved", message: `This suggestion ${what}.` };
  }
  if (proposal.baseVersion !== current.version) {
    return {
      kind: "behind",
      message: `This changed after ${PRODUCT_NAME} suggested it (v${proposal.baseVersion} → v${current.version}). Applying replaces v${current.version}, which stays in history.`,
    };
  }
  return null;
}

/** The proposal routes, so every surface builds the same URLs. */
export function suggestionUrl(
  artifactId: string,
  suggestionId: string,
  action?: "apply" | "dismiss" | "poster"
): string {
  const base = `/api/artifacts/${encodeURIComponent(artifactId)}/proposals/${encodeURIComponent(suggestionId)}`;
  return action ? `${base}/${action}` : base;
}
