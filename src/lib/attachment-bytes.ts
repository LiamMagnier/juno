import { providerAdapterFor } from "@/lib/provider-routing";
import type { ModelInfo } from "@/lib/models";

/**
 * When an adapter may inline a document's raw bytes, and when it must not.
 *
 * THE TWO FAILURES THIS SITS BETWEEN. Anthropic and Gemini accept a raw PDF as
 * a first-class content block and rasterise every page internally alongside
 * the text layer — which is why a scanned document "just works" there and why
 * inlining the bytes is the single most valuable thing an adapter can do with
 * a PDF. But not one of the four adapters checked the file's SIZE before
 * base64-ing it into the request, and base64 adds a third on top: a 40 MB PDF
 * becomes ~53 MB of request body and the provider rejects the whole turn. The
 * user loses the answer, not just the attachment.
 *
 * So: inline when it will fit, fall back to extracted text when it will not,
 * and say which happened. A turn that quietly drops a document is the thing
 * worth engineering against.
 */

/**
 * The ceiling on a document inlined into one request.
 *
 * TWELVE MEGABYTES, AND THE ARITHMETIC IS THE WHOLE JUSTIFICATION. Base64
 * inflates by a third, and the binding constraint is not Anthropic's own
 * 32 MB Messages limit but BEDROCK'S 20 MB, since the same model served from
 * a different place must not fail. 12 MB encodes to ~16 MB, which clears
 * Bedrock with 4 MB left for the conversation, the system prompt and the
 * retrieved passages that share the request.
 *
 * The first draft of this constant was 24 MB, reasoned from Anthropic's limit
 * alone — which is to say it was set at exactly the ceiling it had to stay
 * under, and would have failed on the turn where the history got long. The
 * test below does the multiplication rather than trusting the comment.
 */
export const MAX_INLINE_DOCUMENT_BYTES = 12 * 1024 * 1024;

/** Whether these bytes are small enough to ride inside the request. */
export function canInlineDocument(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= MAX_INLINE_DOCUMENT_BYTES;
}

/**
 * What to tell the model about a document too large to send.
 *
 * It names the tool that can still read it, because "this file was too large"
 * on its own invites the model to answer from the filename — which is the
 * failure the note exists to prevent.
 */
export function oversizeDocumentNote(fileName: string, byteLength: number, hasText: boolean): string {
  const mb = (byteLength / (1024 * 1024)).toFixed(1);
  return hasText
    ? `[The file "${fileName}" is ${mb} MB, too large to send whole, so its extracted text is included above instead of the original. Use read_document if you need a part of it that is not shown.]`
    : `[The file "${fileName}" is ${mb} MB, too large to send whole, and no text could be extracted from it. Use read_document to read it, or inspect_image to look at a page. Do not describe its contents until you have.]`;
}

/**
 * Whether this model will be handed the document itself, not just its text.
 *
 * WHY THE ROUTE HAS TO KNOW. The chat route lists every attachment whose
 * parser state is `failed` or `skipped` under "## Attached files that could
 * not be indexed", with the instruction "no readable document text was
 * produced. Do not invent contents". On Claude and Gemini that paragraph is
 * addressed to a model THAT IS LOOKING AT THE PAGES — the adapter inlined the
 * raw PDF two blocks earlier. So the one case where the product works best,
 * a scan read by vision, was the case where the system prompt told the model
 * to distrust what it could see and refuse to describe it. The user got "I
 * cannot read this document" about a document the model had in front of it.
 *
 * Derived from the adapter, not from a list of provider names, so a model that
 * moves between adapters cannot drift away from the truth.
 */
export function providerReceivesDocumentBytes(
  model: Pick<ModelInfo, "provider" | "api" | "vision">,
  proMode = false,
): boolean {
  const adapter = providerAdapterFor(model, proMode);
  if (adapter === "anthropic-native" || adapter === "gemini-native") return true;
  // Responses carries a PDF as `input_file`, which rides the same vision
  // stack — a model without it gets nothing from the bytes.
  if (adapter === "openai-responses") return model.vision;
  // Chat Completions across thirteen different vendors: no document part that
  // can be relied on, so the text is genuinely all there is.
  return false;
}

/**
 * Whether a stored attachment is a PDF, by type OR by name.
 *
 * The adapters all tested `mimeType === "application/pdf"` and nothing else,
 * so a PDF a browser declared as `application/octet-stream` skipped the
 * raw-bytes path entirely. Uploads now sniff the signature
 * (`sniffDocumentMime`), which fixes it going forward; this covers the rows
 * already in the database, where the type was recorded before that existed.
 */
export function isPdfAttachment(attachment: { mimeType: string; fileName: string }): boolean {
  const mime = attachment.mimeType.toLowerCase().split(";")[0].trim();
  if (mime === "application/pdf") return true;
  return mime === "application/octet-stream" && /\.pdf$/i.test(attachment.fileName);
}
