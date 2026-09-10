/**
 * Shared attachment-state language for provider adapters and chat context.
 *
 * A PDF has no flat `extractedText`, so a model that cannot receive raw PDF
 * bytes needs a truthful distinction between "the index is catching up" and
 * "Juno could not read this file". Keeping that distinction in one pure module
 * prevents four adapters from drifting into four different explanations.
 */

import { wrapUntrusted } from "@/lib/untrusted-content";

/**
 * Per-attachment ceiling on the text an adapter sends. Was the same literal
 * in four adapters; one place now, so the bound cannot drift.
 */
export const ATTACHMENT_TEXT_MAX_CHARS = 100_000;

/**
 * The model-facing rendering of an attachment's extracted text.
 *
 * Wrapped in the untrusted envelope, because a document is text Juno did not
 * author and the user did not type — a PDF from a stranger or a pasted export
 * can carry "ignore your instructions" as easily as a web page can. The
 * adapters used to send it bare, in a user turn, indistinguishable from
 * something the user wrote. The envelope is what lets the system-prompt rule
 * (`UNTRUSTED_CONTENT_RULE`) apply; the route enables that rule whenever the
 * history carries attachment text.
 */
export function attachedFileText(
  fileName: string,
  extractedText: string,
  options: { sharedEarlier?: boolean } = {}
): string {
  const heading = options.sharedEarlier
    ? `Attached file "${fileName}" (shared earlier):`
    : `Attached file "${fileName}":`;
  return `${heading}\n\n${wrapUntrusted(fileName, extractedText.slice(0, ATTACHMENT_TEXT_MAX_CHARS))}`;
}

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
