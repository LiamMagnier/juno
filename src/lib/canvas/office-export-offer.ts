/**
 * Whether the canvas's More menu offers the Office exports (Word, Excel,
 * PowerPoint), and in what state.
 *
 * Those files are built on the server from the artifact's latest SAVED
 * version (GET /api/artifacts/:id/export). Two things on screen can differ
 * from that, and in both the file would silently not be what the reader is
 * looking at:
 *
 *   - an older version is open: no offer at all (the long-standing rule);
 *   - the latest version has an unsaved edit in the editor: the formats stay
 *     listed but disabled, under a line that says to save first. Offered as
 *     before, "Word document" downloaded the version WITHOUT the edit, while
 *     "Download source" one row up carried it — two exports of one canvas
 *     that disagreed, and the reader's own words missing from the one meant
 *     to be sent on.
 */
export type OfficeExportOffer = "none" | "save-first" | "ready";

export function officeExportOffer(input: { formats: number; isLatest: boolean; dirty: boolean }): OfficeExportOffer {
  if (input.formats === 0 || !input.isLatest) return "none";
  return input.dirty ? "save-first" : "ready";
}

/** The line above the disabled formats while an edit is unsaved. */
export const OFFICE_EXPORT_SAVE_FIRST_NOTE = "Save version to export your edit";
