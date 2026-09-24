/*
 * What the two OpenAI-wire adapters (Responses and Chat Completions) tell the
 * model about an attachment they cannot hand over as-is. English, and in a
 * `*.prompt.ts` file so the i18n extractor never harvests it (INV-29,
 * SPEC §10.5). Both adapters send these exact words.
 */

/** An image from an earlier turn, no longer re-sent so the cached prefix stays small. */
export function imageSharedEarlierNote(fileName: string): string {
  return `[Image "${fileName}" shared earlier in the conversation.]`;
}

/** A PDF with no text layer (a scan), sent as its first pages rendered to images. */
export function scannedPdfPagesNote(fileName: string, pages: number): string {
  return `[The PDF "${fileName}" has no text layer, so the first ${pages} page${pages === 1 ? "" : "s"} follow as images. Read them as the document itself. Use read_document or inspect_image for anything beyond them.]`;
}

/** A PDF whose pages could not be rendered either: the parser's own reason. */
export function unreadablePdfNote(fileName: string, mimeType: string, fallback: string): string {
  return `[Attached file "${fileName}" (${mimeType}) — ${fallback}]`;
}

/** Any other file the model gets only the name of, with why when there is a reason. */
export function attachedFileNote(fileName: string, mimeType: string, reason?: string): string {
  return `[Attached file "${fileName}" (${mimeType})${reason ? ` — ${reason}` : ""}.]`;
}

/** The reason given for an image sent to a model without vision. */
export const NO_VISION_REASON = "this model cannot view images";

/** Storage failed for this attachment. */
export function attachmentUnavailableNote(fileName: string): string {
  return `[Attachment "${fileName}" could not be loaded.]`;
}
