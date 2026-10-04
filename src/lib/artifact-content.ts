import { serializeDesignDocument } from "@/lib/design/migrations";
import { checkDesignDocumentSave } from "@/lib/design/document-save";
import { canonicalSemanticBody, isSemanticArtifactType } from "@/lib/work/deliverables/semantic";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";

/** The artifact body's budget, the same one chat output and designs have. */
export const MAX_ARTIFACT_CONTENT_CHARS = 200_000;

/**
 * The body a whole-content save stores, or a refusal.
 *
 * A DESIGN is the one type with a schema: a whole document saved through the
 * generic route (the Mac and iPhone editors' Save, and a restore) must be one
 * the web editor can open, so it passes `checkDesignDocumentSave` — the parser
 * and migrations every design read applies — and is stored in the canonical
 * serialization. Audit B2: the generic route used to store any string for a
 * design, so a native codec drift stored documents the web editor refused.
 */
export function storableContent(
  type: string,
  content: string
): { ok: true; content: string } | { ok: false; error: string; issues: string[] } {
  if (isSemanticArtifactType(type)) {
    // A workbook, document or deck saved whole (a restore, a client's Save)
    // must be a model the engines can open, stored canonically.
    try {
      const stored = canonicalSemanticBody(type, content);
      if (stored.length > MAX_ARTIFACT_CONTENT_CHARS) return { ok: false, error: "This artifact is too large to save.", issues: [] };
      return { ok: true, content: stored };
    } catch (error) {
      const message = error instanceof SemanticError ? error.message : "The body could not be read.";
      return { ok: false, error: message, issues: [message] };
    }
  }
  if (type !== "DESIGN") return { ok: true, content };
  const check = checkDesignDocumentSave(content);
  if (!check.ok) return check;
  const stored = serializeDesignDocument(check.document);
  if (stored.length > MAX_ARTIFACT_CONTENT_CHARS) return { ok: false, error: "This design is too large to save.", issues: [] };
  return { ok: true, content: stored };
}
