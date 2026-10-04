/**
 * The grammar of an artifact's own address, and the choice of what `/a/{id}`
 * draws.
 *
 * `/a/{id}` is the one link an artifact has (docs/design/artifacts-design/
 * 04-MERGE-PLAN.md §5.1): it carries no type, so a design and a page share it
 * and a later "Turn into" never breaks it, and it belongs to the object rather
 * than to the chat it was made in. Everything that hands out a link to an
 * artifact — search, a project's Sources, the old `/design` routes — spells it
 * the way this file does.
 *
 * Pure and isomorphic on purpose: the server page, the redirects and the tests
 * all read it, and none of them should need a database or React to do so. It
 * lives in `src/lib` rather than beside the route because its readers are not
 * all the route's: a project's Sources list, the project page and the
 * Artifacts home (`artifacts-home.ts`) link through it too, and a component
 * importing from inside an app route folder ties the two together backwards.
 */

import type { ArtifactType } from "@/lib/message-content";

/** Where `/design` sends people now: Artifacts, filtered to designs. The value
 *  is the enum, not a plural noun, because that is what the home reads from
 *  `?type=` (the Artifacts home's contract). */
export const DESIGNS_HOME = "/artifacts?type=DESIGN";

/** Where a closed or missing artifact sends people back to. */
export const ARTIFACTS_HOME = "/artifacts";

/**
 * `/a/{id}`, or `/a/{id}?v={n}` for one sealed version.
 *
 * A version is part of the address only when it is asked for: the bare link is
 * "whatever this artifact is now", which is the link worth copying.
 */
export function artifactPath(id: string, version?: number | null): string {
  const base = `/a/${encodeURIComponent(id)}`;
  return version != null ? `${base}?v=${version}` : base;
}

/**
 * The conversation the artifact was made in, with its canvas open on it.
 *
 * Keyed by the per-conversation identifier because that is the deep link the
 * chat reads today (`chat/[id]/page.tsx`); the `?a={id}` form the plan names
 * arrives with the panel rework. It carries no version: the chat opens its
 * canvas on the current one.
 */
export function chatArtifactPath(conversationId: string, identifier: string): string {
  return `/chat/${encodeURIComponent(conversationId)}?artifact=${encodeURIComponent(identifier)}`;
}

/**
 * `?v=` as a version number, or null when it does not name one.
 *
 * Only a whole, positive number is a version. Anything else — `0`, `-2`,
 * `1.5`, `3abc`, an empty value — is treated as absent rather than coerced,
 * because `parseInt("3abc")` is 3 and a link somebody mangled should show the
 * current version, not a version it happens to start with. A repeated key
 * (`?v=3&v=4`) reads the first, which is what `URLSearchParams.get` does.
 */
export function parseVersionParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^[1-9]\d{0,8}$/.test(value)) return null;
  return Number(value);
}

/**
 * The version a reader is looking at as the latest one.
 *
 * `currentVersion` names it, but the row it names has not always existed —
 * the design page has always fallen back to the highest stored version when
 * it does not (`versions.at(-1)`), and this keeps that rule rather than
 * inventing a second one.
 */
export function latestVersion(available: readonly number[], currentVersion: number): number | null {
  if (available.length === 0) return null;
  if (available.includes(currentVersion)) return currentVersion;
  return Math.max(...available);
}

/**
 * The address of one step in the version stepper.
 *
 * The latest version is always the bare `/a/{id}`, so the stepper's last step
 * lands on the same URL as every other way in — and, for a design, on the
 * editor rather than a pinned picture of the version the editor already holds.
 */
export function versionPath(id: string, version: number, latest: number): string {
  return version === latest ? artifactPath(id) : artifactPath(id, version);
}

/** The versions either side of the one on screen, for `‹ v3 ›`. */
export function adjacentVersions(
  available: readonly number[],
  version: number
): { previous: number | null; next: number | null } {
  const sorted = [...new Set(available)].sort((a, b) => a - b);
  const index = sorted.indexOf(version);
  if (index < 0) return { previous: null, next: null };
  return {
    previous: index > 0 ? sorted[index - 1] : null,
    next: index < sorted.length - 1 ? sorted[index + 1] : null,
  };
}

/**
 * What `/a/{id}` draws, decided before anything is read beyond the version
 * numbers.
 *
 *  - `missing`: the artifact has no stored version at all. There is nothing to
 *    draw, and a 404 is truer than an empty frame.
 *  - `redirect`: the URL names something this page will not show as asked, so
 *    it moves to the address of what it will show. Two cases. A `?v=` that no
 *    longer exists goes to the bare link rather than quietly drawing another
 *    version under an address that names this one. A design asked for at its
 *    latest version goes to the bare link too, because the latest version of a
 *    design is the editor, and an editor sitting under `?v=5` would, after one
 *    edit, be a v6 document at an address that a reload reads as "show me v5".
 *  - `editor`: a design at its latest version, drawn by the design editor.
 *  - `read`: everything else — every other type, and a design's older
 *    versions — drawn read-only at `version`, with `latest` for the "Viewing
 *    v3 · Back to latest" bar.
 *
 * An older design version is a picture, not the editor in read-only mode: the
 * editor's Export and history act on the document the editor holds, and the
 * one on the server is the head. A picture cannot be mistaken for the thing
 * you are editing.
 */
export type ArtifactView =
  | { kind: "missing" }
  | { kind: "redirect"; to: string }
  | { kind: "editor"; version: number }
  | { kind: "read"; version: number; latest: number };

export function resolveArtifactView(input: {
  id: string;
  type: ArtifactType;
  available: readonly number[];
  currentVersion: number;
  requested: number | null;
}): ArtifactView {
  const latest = latestVersion(input.available, input.currentVersion);
  if (latest === null) return { kind: "missing" };

  const { requested } = input;
  if (requested !== null && !input.available.includes(requested)) {
    return { kind: "redirect", to: artifactPath(input.id) };
  }

  const version = requested ?? latest;
  if (input.type === "DESIGN") {
    if (version !== latest) return { kind: "read", version, latest };
    return requested !== null ? { kind: "redirect", to: artifactPath(input.id) } : { kind: "editor", version };
  }
  return { kind: "read", version, latest };
}

/**
 * What the header calls each type: the noun a person uses, never the enum.
 *
 * These are the registry's nouns (04-MERGE-PLAN.md §2.3) — SVG is an Image,
 * Markdown is a Doc, HTML and React are both an App — so the header says what
 * the thing is rather than what it is stored as. They move into the registry
 * (`src/lib/artifact-kinds.ts`) when it exists, with the other label maps.
 */
export const ARTIFACT_NOUN: Record<ArtifactType, string> = {
  DESIGN: "Design",
  HTML: "App",
  REACT: "App",
  CODE: "Code",
  MERMAID: "Diagram",
  SPREADSHEET: "Spreadsheet",
  DOCUMENT: "Document",
  PRESENTATION: "Deck",
  SVG: "Image",
  MARKDOWN: "Doc",
};

/**
 * A project's artifacts, as its page shows them.
 *
 * `/api/artifacts?projectId=` answers the project's own artifacts (an artifact
 * carries its own `projectId` and follows its chat when the chat moves). The
 * page narrows the ones that still have a chat to the chats it has on screen,
 * so a chat moved out of the project while the page is open takes its
 * artifacts with it without a refetch. One with no chat (made outside one, or
 * its chat was deleted) is the project's by its own `projectId` alone, and
 * stays.
 */
export function madeInConversations<T extends { conversationId: string | null }>(
  items: readonly T[],
  conversationIds: Iterable<string>
): T[] {
  const ids = new Set(conversationIds);
  return items.filter((item) => item.conversationId === null || ids.has(item.conversationId));
}
