/**
 * Shared attachment-state language for provider adapters and chat context.
 *
 * A PDF has no flat `extractedText`, so a model that cannot receive raw PDF
 * bytes needs a truthful distinction between "the index is catching up" and
 * "Juno could not read this file". Keeping that distinction in one pure module
 * prevents four adapters from drifting into four different explanations.
 */

const PENDING_STATES = new Set(["queued", "indexing", "extracting", "ocr"]);
const UNAVAILABLE_STATES = new Set(["failed", "skipped"]);

export function isAttachmentParserPending(state: string | null | undefined): boolean {
  return PENDING_STATES.has(state ?? "");
}

export function isAttachmentParserUnavailable(state: string | null | undefined): boolean {
  return UNAVAILABLE_STATES.has(state ?? "");
}

export function pdfAttachmentFallbackNote(parserState: string | null | undefined): string {
  if (isAttachmentParserPending(parserState)) {
    return "This PDF is still being indexed; its text is not available to this model yet. Do not claim to have read it.";
  }
  if (isAttachmentParserUnavailable(parserState)) {
    return "Juno could not index this PDF, and this model does not receive raw PDF bytes. Do not invent its contents.";
  }
  return "This model does not receive raw PDF bytes. Use any retrieved passages above; if none are present, say that you cannot verify the file's contents.";
}
