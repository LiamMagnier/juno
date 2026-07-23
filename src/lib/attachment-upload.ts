import { attachmentKind, isAcceptedMime, isTextExtractable, sanitizeFileName, sniffImageMime } from "@/lib/uploads";

/**
 * The decision of what an uploaded file *is* and how it may be stored.
 *
 * This was inline in `/api/upload`, and the native `/api/v1/attachments` route
 * needed exactly the same rules. Duplicating them would have meant two places
 * that each decide whether a file is safe to serve back — and the interesting
 * failure is not that one of them is wrong today, it is that only one of them
 * gets fixed later.
 *
 * Every rule here is a security rule, not a formatting preference:
 *
 * - The client's declared MIME is a hint, never a decision. Images are
 *   identified by magic bytes and stored under the *sniffed* type.
 * - Anything that is not a verified image is stored as
 *   `application/octet-stream` with an attachment disposition, so uploaded
 *   HTML, SVG or JavaScript can never be rendered inline by the storage host.
 *   That is what prevents stored XSS and phishing through attachment URLs.
 * - HEIC/HEIF is deliberately absent from the accepted set. Apple clients
 *   transcode to JPEG before uploading; accepting HEIC would mean shipping a
 *   decoder or storing something the web cannot display.
 */
export type AttachmentUploadRejection =
  | { code: "unsupported_media_type"; status: 415; message: string }
  | { code: "payload_too_large"; status: 413; message: string };

export interface AttachmentUploadPlan {
  /** Sanitized, never the raw client-supplied name. */
  fileName: string;
  kind: "IMAGE" | "FILE";
  /** What the database records — the sniffed type for images. */
  storedMime: string;
  /** The Content-Type the object is stored under. */
  storedContentType: string;
  /** `undefined` only for verified images, so thumbnails can render inline. */
  contentDisposition: string | undefined;
  extractedText: string | null;
}

export function planAttachmentUpload(input: {
  declaredMime: string;
  fileName: string;
  size: number;
  bytes: Uint8Array;
  maxUploadMb: number;
}): { ok: true; plan: AttachmentUploadPlan } | { ok: false; error: AttachmentUploadRejection } {
  const declaredMime = input.declaredMime || "application/octet-stream";

  if (!isAcceptedMime(declaredMime)) {
    return {
      ok: false,
      error: {
        code: "unsupported_media_type",
        status: 415,
        message: `Unsupported file type: ${declaredMime || "unknown"}.`,
      },
    };
  }

  const maxBytes = input.maxUploadMb * 1024 * 1024;
  if (input.size > maxBytes) {
    return {
      ok: false,
      error: {
        code: "payload_too_large",
        status: 413,
        message: `File is too large. Your plan allows up to ${input.maxUploadMb} MB.`,
      },
    };
  }

  const fileName = sanitizeFileName(input.fileName || "file");
  let kind = attachmentKind(declaredMime);
  let storedContentType = "application/octet-stream";
  let storedMime = declaredMime;
  let contentDisposition: string | undefined = `attachment; filename="${fileName}"`;

  if (kind === "IMAGE") {
    const sniffed = sniffImageMime(input.bytes);
    if (!sniffed) {
      return {
        ok: false,
        error: {
          code: "unsupported_media_type",
          status: 415,
          message: "That file isn't a valid image.",
        },
      };
    }
    storedContentType = sniffed;
    storedMime = sniffed;
    kind = "IMAGE";
    contentDisposition = undefined;
  }

  let extractedText: string | null = null;
  if (isTextExtractable(storedMime) && input.size < 1_000_000) {
    try {
      extractedText = new TextDecoder("utf-8", { fatal: false })
        .decode(input.bytes)
        .slice(0, 200_000);
    } catch {
      extractedText = null;
    }
  }

  return {
    ok: true,
    plan: { fileName, kind, storedMime, storedContentType, contentDisposition, extractedText },
  };
}
