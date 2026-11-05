import { runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";
import type { AlevrRuntimeTarget } from "@/lib/artifact-ai/protocol";

/**
 * Who may use an artifact's AI and storage, and whose account pays.
 *
 * Two ways in, matching the two kinds of page that run a preview's scripts:
 *
 *   { artifactId }  the owner's own surfaces (canvas, chat card, `/a/{id}`).
 *                   The artifact must be the signed-in viewer's own and live
 *                   (`ownedArtifactWhere`); a stranger's id is the same
 *                   not_found as an id that never existed.
 *   { shareToken }  a shared or published link. The token is the capability,
 *                   resolved the way the share page resolves it (a live share
 *                   of an untrashed artifact, else a live publication), and
 *                   ONLY while public previews run scripts at all
 *                   (`publicShareProfile() === "public"`): with the static
 *                   profile no script on that page can be calling.
 *
 * Either way the viewer is the account that is billed and whose storage is
 * read: `viewerId`, never the artifact's owner. The owner's id is not part of
 * the answer, so nothing downstream can bill it by mistake.
 *
 * Only artifacts that run as an app (HTML, React) have the bridge; a call
 * about a document, an image or a design is "unavailable".
 *
 * Pure apart from the injected lookups, so the ownership rules are tested
 * without a database (tests/artifact-ai.test.ts).
 */

export interface RuntimeArtifactRow {
  id: string;
  type: ArtifactType;
  language: string | null;
}

export interface RuntimeAccessDeps {
  /** The viewer's own live artifact, or null. */
  findOwnedArtifact(viewerId: string, artifactId: string): Promise<RuntimeArtifactRow | null>;
  /** The artifact behind a live share or publication token, or null. */
  findLinkedArtifact(token: string): Promise<RuntimeArtifactRow | null>;
  /** Whether shared pages run preview scripts (JUNO_PREVIEW_ORIGIN_PUBLIC). */
  publicScriptsEnabled(): boolean;
}

export type RuntimeAccess =
  | { ok: true; artifactId: string; viewerId: string; via: "owner" | "link" }
  | { ok: false; status: 404 | 409; code: "unavailable"; error: string };

const NOT_FOUND: RuntimeAccess = { ok: false, status: 404, code: "unavailable", error: "This artifact is not available." };

/** Whether an artifact of this type and language runs as an app with the bridge. */
export function runsWithBridge(type: ArtifactType, language: string | null): boolean {
  const rt = runtimeFor(type, language);
  return rt.mode === "web" && (rt.lang === "tsx" || rt.lang === "jsx" || rt.lang === "html");
}

export async function resolveRuntimeAccess(
  viewerId: string,
  target: AlevrRuntimeTarget,
  deps: RuntimeAccessDeps
): Promise<RuntimeAccess> {
  let row: RuntimeArtifactRow | null;
  let via: "owner" | "link";
  if ("artifactId" in target) {
    row = await deps.findOwnedArtifact(viewerId, target.artifactId);
    via = "owner";
  } else {
    if (!deps.publicScriptsEnabled()) {
      return { ok: false, status: 409, code: "unavailable", error: "Apps on shared links cannot use AI or storage yet." };
    }
    row = await deps.findLinkedArtifact(target.shareToken);
    via = "link";
  }
  if (!row) return NOT_FOUND;
  if (!runsWithBridge(row.type, row.language)) {
    return { ok: false, status: 409, code: "unavailable", error: "Only HTML and React artifacts can use AI and storage." };
  }
  return { ok: true, artifactId: row.id, viewerId, via };
}
