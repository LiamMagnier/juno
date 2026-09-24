/**
 * Keeping a design artifact's envelope in step with what its editor committed.
 *
 * The chat canvas shows a design through two readers at once: the editor,
 * which holds the live document, and the envelope around it — the version
 * rail, the Code tab, Copy and Download — which reads `ClientArtifact`. After
 * every acknowledged transaction the store has done one of two things
 * (`commitTransaction`, `src/lib/design/store.ts`): folded the change into the
 * newest checkpoint, rewriting that row's body in place, or given it a
 * checkpoint of its own at the next version. The envelope has to say the same.
 *
 * It records the committed document itself, serialized exactly as the store
 * serializes it, so the body on the client is the body in the database. The
 * canvas used to record a new checkpoint with an empty body and nothing at all
 * for a fold: the editor was then handed "" to parse, and Copy, Download and
 * the Code tab showed an empty or out-of-date document until a reload.
 */

import { serializeDesignDocument } from "@/lib/design/migrations";
import type { DesignDocument } from "@/lib/design/types";
import type { ClientArtifact } from "@/types/chat";

/**
 * The envelope after the store acknowledged `document` as `version`.
 *
 * A reply for a version older than the one the envelope already has is a
 * reply that lost a race with a newer one; the envelope is returned unchanged
 * rather than moved backwards.
 */
export function recordCommittedDesign(
  artifact: ClientArtifact,
  version: number,
  document: DesignDocument,
  now: Date = new Date()
): ClientArtifact {
  if (version < artifact.currentVersion) return artifact;

  const content = serializeDesignDocument(document);
  const at = now.toISOString();
  const folded = artifact.versions.some((v) => v.version === version);
  const versions = folded
    ? artifact.versions.map((v) => (v.version === version ? { ...v, content } : v))
    : [...artifact.versions, { version, content, origin: "edit" as const, createdAt: at }];

  return { ...artifact, currentVersion: version, content, versions, updatedAt: at };
}
