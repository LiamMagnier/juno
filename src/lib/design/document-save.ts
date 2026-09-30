/**
 * The check a whole design document passes before the generic artifact save
 * stores it (audit artifacts.md, B2).
 *
 * The editor writes through validated transactions (src/lib/design/store.ts),
 * but `POST /api/artifacts/[id]` appends any body as a new version — and that
 * is the route restore uses, and the one Mac and iPhone save a design through.
 * A body stored there that the editor cannot parse opens as "This design can't
 * be opened" on every platform, which reads as data loss. So a design body is
 * held to exactly what every design read applies — `parseStoredDesignDocument`,
 * the parser behind the editor route, the poster and the public link — and a
 * document that reads today saves exactly as before.
 *
 * Pure and free of `server-only`, so the tests read it directly.
 */

import { parseStoredDesignDocument } from "@/lib/design/migrations";
import { DesignValidationError } from "@/lib/design/schema";

export type DesignSaveCheck = { ok: true } | { ok: false; error: string; issues: string[] };

export function checkDesignDocumentSave(content: string): DesignSaveCheck {
  try {
    parseStoredDesignDocument(content);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof DesignValidationError)) throw error;
    return { ok: false, error: `This design can't be saved: ${error.message}`, issues: error.issues };
  }
}
