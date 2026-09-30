import { parseStoredDesignDocument, serializeDesignDocument } from "@/lib/design/migrations";
import { DesignValidationError } from "@/lib/design/schema";

/** The artifact body's budget, the same one chat output and designs have. */
export const MAX_ARTIFACT_CONTENT_CHARS = 200_000;

/**
 * The body a whole-content save stores, or a refusal.
 *
 * A DESIGN is the one type with a schema: a whole document saved through the
 * generic route (the Mac and iPhone editors' Save) must be one the web editor
 * can open, so it is parsed and migrated like every other design read and
 * stored in the canonical serialization. Audit B2: the generic route used to
 * store any string for a design, so a native codec drift stored documents the
 * web editor refused.
 */
export function storableContent(
  type: string,
  content: string
): { ok: true; content: string } | { ok: false; error: string } {
  if (type !== "DESIGN") return { ok: true, content };
  try {
    const stored = serializeDesignDocument(parseStoredDesignDocument(content));
    if (stored.length > MAX_ARTIFACT_CONTENT_CHARS) return { ok: false, error: "This design is too large to save." };
    return { ok: true, content: stored };
  } catch (error) {
    if (error instanceof DesignValidationError) return { ok: false, error: error.message };
    throw error;
  }
}
