// Max attachments per message. Shared by the composer, the library picker, and
// the /api/chat request schema so they can never disagree (a mismatch silently
// rejects the whole send).
export const MAX_ATTACHMENTS = 10;

export const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Binary office documents Juno can read but must never decode as text.
 *
 * THESE WERE REFUSED AT THE DOOR FOR NO REASON. `selectExtractor` has claimed
 * `.docx`, `.xlsx` and `.pptx` by both extension and MIME type for as long as
 * those extractors have existed, and all three read a real file correctly —
 * but `isAcceptedMime` did not list them, so the upload was rejected 415 and
 * the file picker did not even offer them. The capability was built, tested
 * and walled off: the commonest documents in professional use were the ones
 * Juno could read and would not accept.
 *
 * Kept OUT of `DOC_MIME` deliberately, because that list feeds
 * `isTextExtractable`, and a .docx is a ZIP — decoding one as UTF-8 at upload
 * time would store a column of mojibake as the file's "text" and hand it to
 * the model. Their text comes from the extractors, like a PDF's does.
 *
 * Safe to accept for the same reason a PDF is: every non-image upload is
 * stored as `application/octet-stream` with `Content-Disposition: attachment`
 * (see `planAttachmentUpload`), so none of them can ever be served back inline.
 */
export const OFFICE_MIME = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // The macro-enabled twins. Juno reads the document part and never executes
  // anything; refusing them only sends the user to re-save the same content.
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
];

// Document/text types we accept and can pass to the model. (No text/html — see below.)
export const DOC_MIME = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/javascript",
  "text/javascript",
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
];

// Types that must never be accepted: a browser would render them inline (XSS / phishing).
const BLOCKED_MIME = ["text/html", "application/xhtml+xml", "image/svg+xml"];

export function isAcceptedMime(mime: string): boolean {
  const normalized = mime.toLowerCase().split(";")[0].trim();
  if (BLOCKED_MIME.includes(normalized)) return false;
  return (
    IMAGE_MIME.includes(normalized) ||
    DOC_MIME.includes(normalized) ||
    OFFICE_MIME.includes(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/octet-stream"
  );
}

export function attachmentKind(mime: string): "IMAGE" | "FILE" {
  return IMAGE_MIME.includes(mime) ? "IMAGE" : "FILE";
}

/**
 * The real type of a document, read from its bytes rather than its label.
 *
 * WHY A PDF NEEDS SNIFFING AT ALL. `planAttachmentUpload` trusts the browser's
 * declared type for everything that is not an image, and browsers routinely
 * declare nothing: a machine with no PDF reader installed, a drag from a
 * zip, a native client posting a raw body — all send
 * `application/octet-stream`. The row is then stored with that type, and every
 * provider adapter tests `att.mimeType === "application/pdf"` before taking the
 * raw-bytes path. So a perfectly ordinary PDF, mislabelled by the sender,
 * silently lost the one path that lets Claude and Gemini read a scan. It also
 * missed `selectExtractor`'s MIME lookup, surviving only if the FILE NAME
 * happened to end in .pdf.
 *
 * Only the signature is trusted, and only to *upgrade* octet-stream — never to
 * override a sender who said something specific, and never to make a file
 * servable inline (`storedContentType` stays octet-stream regardless).
 */
export function sniffDocumentMime(bytes: Uint8Array): string | null {
  // "%PDF-" — the header every PDF opens with. A few producers emit junk
  // before it, so the check spans the leading bytes rather than just offset 0,
  // which is the same tolerance the extractor's own header check applies.
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (head.includes("%PDF-")) return "application/pdf";
  return null;
}

/** Whether we should extract and store UTF-8 text for model context. */
export function isTextExtractable(mime: string): boolean {
  return mime.startsWith("text/") || DOC_MIME.includes(mime) ? mime !== "application/pdf" : false;
}

/**
 * How many leading bytes the sniffers below need.
 *
 * The longest signature reads byte 11 (WebP's `WEBP` at offset 8, and mp4's
 * brand in the `ftyp` box), so 12 would do; 16 is the next round number and
 * leaves room for a signature that reaches a little further. It matters because
 * every caller reads exactly this much rather than the object: a 1 GB video must
 * not enter RSS just to have its content type decided.
 */
export const MIME_SNIFF_BYTES = 16;

/** Verify real image type from magic bytes — never trust the client-declared MIME. */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Verify real video type from magic bytes — mp4 (ftyp box), webm/mkv (EBML). */
export function sniffVideoMime(b: Uint8Array): string | null {
  // ISO base media (mp4 / mov): bytes 4-7 are the 'ftyp' box type.
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    // brand at bytes 8-11 — 'qt  ' => QuickTime, otherwise treat as mp4.
    const isQt = b[8] === 0x71 && b[9] === 0x74 && b[10] === 0x20 && b[11] === 0x20;
    return isQt ? "video/quicktime" : "video/mp4";
  }
  // Matroska / WebM: EBML magic 1A 45 DF A3.
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 120) || "file";
}

/*
 * The extensions ride alongside the MIME types because a browser's idea of a
 * file's type is not reliable: Windows without Office installed reports a
 * .docx as `application/octet-stream`, and a picker keyed on MIME alone greys
 * out the file the user is looking straight at.
 */
export const ACCEPT_ATTRIBUTE = [
  ...IMAGE_MIME,
  ...DOC_MIME,
  ...OFFICE_MIME,
  ".txt", ".md", ".csv", ".json", ".ts", ".tsx", ".js", ".py",
  ".docx", ".xlsx", ".pptx", ".docm", ".xlsm", ".pptm",
].join(",");
