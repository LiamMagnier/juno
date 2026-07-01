// Max attachments per message. Shared by the composer, the library picker, and
// the /api/chat request schema so they can never disagree (a mismatch silently
// rejects the whole send).
export const MAX_ATTACHMENTS = 10;

export const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"];

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
  if (BLOCKED_MIME.includes(mime)) return false;
  return (
    IMAGE_MIME.includes(mime) ||
    DOC_MIME.includes(mime) ||
    mime.startsWith("text/") ||
    mime === "application/octet-stream"
  );
}

export function attachmentKind(mime: string): "IMAGE" | "FILE" {
  return IMAGE_MIME.includes(mime) ? "IMAGE" : "FILE";
}

/** Whether we should extract and store UTF-8 text for model context. */
export function isTextExtractable(mime: string): boolean {
  return mime.startsWith("text/") || DOC_MIME.includes(mime) ? mime !== "application/pdf" : false;
}

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

export const VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime"];

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

export const ACCEPT_ATTRIBUTE = [...IMAGE_MIME, ...DOC_MIME, ".txt", ".md", ".csv", ".json", ".ts", ".tsx", ".js", ".py"].join(",");
