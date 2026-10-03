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
  // OpenDocument — what LibreOffice, OpenOffice and Google Docs' "download as
  // ODF" produce. Underneath it is the same shape as a .docx: a ZIP with an
  // XML document inside, which is why one extractor reads all three kinds.
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  // Both RTF spellings, so the verdict stops depending on the sender's OS.
  "application/rtf",
  "text/rtf",
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

/**
 * The same refusal, keyed on the name.
 *
 * `BLOCKED_MIME` alone is a gate anyone can walk around: a browser that
 * reports `text/plain` for a `.html` — or a caller that simply says so — used
 * to sail past it on the `startsWith("text/")` arm. The rule is about the
 * FILE, so it has to be enforced on the evidence that survives a wrong label.
 */
const BLOCKED_EXTENSIONS = new Set(["html", "htm", "xhtml", "svg", "svgz"]);

/**
 * Extensions Juno can read, as the evidence of last resort.
 *
 * WHY THE GATE NEEDED THIS AT ALL. `isAcceptedMime` judged on the MIME type
 * and `selectExtractor` judges on the extension, so the two disagreed on
 * exactly the files people upload most: a `.sql` from a Mac arrives as
 * `text/plain` and is accepted, while the same `.sql` from a Linux desktop
 * arrives as `application/sql` and is refused 415. The gate's verdict for
 * identical bytes depended on the uploading machine's MIME database. Every
 * entry below is a format `textFlavor` or `selectExtractor` already reads —
 * this widens nothing except the set of machines that can send them.
 */
const READABLE_EXTENSIONS = new Set([
  // Prose and data
  "txt", "text", "log", "md", "markdown", "mdx", "csv", "tsv", "json", "jsonc",
  "xml", "yaml", "yml", "toml", "ini", "rtf",
  // Code — the same list `textFlavor` claims
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
  "css", "scss", "less", "gradle", "graphql", "proto",
  // Documents with a real extractor
  "pdf", "docx", "docm", "xlsx", "xlsm", "pptx", "pptm",
  "odt", "ods", "odp", "fodt",
]);

/** The extension, lowercased, or "" for a name that has none. */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

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

/**
 * Whether this upload is accepted — judged on the type AND the name.
 *
 * The type is the weaker signal and always was: `planAttachmentUpload` stores
 * every non-image as `application/octet-stream` on purpose, and senders label
 * files inconsistently across operating systems. So a file whose EXTENSION
 * Juno can read is accepted even when its declared type is one this gate has
 * never heard of — which is what stops the answer depending on which machine
 * the person happened to be sitting at.
 *
 * The blocklist is not weakened by this: it is checked on both the type and
 * the name, so a `.html` declared `text/plain` is now refused where it used to
 * slip through the `startsWith("text/")` arm.
 */
export function isAcceptedUpload(fileName: string, mime: string): boolean {
  const extension = extensionOf(fileName);
  if (BLOCKED_EXTENSIONS.has(extension)) return false;
  if (isAcceptedMime(mime)) return true;
  return READABLE_EXTENSIONS.has(extension);
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

/** The 4-byte ISO-BMFF box type at bytes 4-7, or null. */
function isoBoxType(b: Uint8Array): string | null {
  if (b.length < 8) return null;
  return String.fromCharCode(b[4], b[5], b[6], b[7]);
}

/** The major brand of an ISO-BMFF `ftyp` box (bytes 8-11), or null. */
function isoMajorBrand(b: Uint8Array): string | null {
  if (b.length < 12 || isoBoxType(b) !== "ftyp") return null;
  return String.fromCharCode(b[8], b[9], b[10], b[11]);
}

/*
 * HEIF-family still images share the mp4 container (an `ftyp` box), so a sniff
 * that reads "ftyp => video" files an iPhone photo or an AVIF as a video. They
 * are images: AVIF is displayable everywhere current; HEIC only in Safari.
 */
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1"]);

/** AVIF still/sequence image, by its `ftyp` brand. */
export function sniffAvifMime(b: Uint8Array): string | null {
  const brand = isoMajorBrand(b);
  return brand && AVIF_BRANDS.has(brand) ? "image/avif" : null;
}

/** HEIC/HEIF image (Safari-only in browsers), by its `ftyp` brand. */
export function isHeifImage(b: Uint8Array): boolean {
  const brand = isoMajorBrand(b);
  return Boolean(brand && HEIF_BRANDS.has(brand));
}

/**
 * QuickTime files written before `ftyp` existed (and some editors' exports
 * still) open with a movie atom instead: `moov`, `mdat`, `wide`, `free`,
 * `skip` or `pnot` at bytes 4-7.
 */
const LEGACY_QT_ATOMS = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

/** Verify real video type from magic bytes — mp4 (ftyp box), mov, webm/mkv (EBML). */
export function sniffVideoMime(b: Uint8Array): string | null {
  const brand = isoMajorBrand(b);
  if (brand) {
    // An ftyp box whose brand names a still image is not a video.
    if (AVIF_BRANDS.has(brand) || HEIF_BRANDS.has(brand)) return null;
    // 'qt  ' => QuickTime, otherwise treat as mp4 (isom, mp41/42, M4V , dash…).
    return brand === "qt  " ? "video/quicktime" : "video/mp4";
  }
  // The leading byte is the high byte of the atom's 32-bit size, so 0 for any
  // atom under 16 MB — which also keeps a text file that happens to read
  // "....free" at bytes 4-7 from being called a movie.
  const box = isoBoxType(b);
  if (box && b[0] === 0 && LEGACY_QT_ATOMS.has(box)) return "video/quicktime";
  // Matroska / WebM: EBML magic 1A 45 DF A3.
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}

/**
 * The Content-Type to SERVE a sniffed video with, for `<video src>`.
 *
 * A QuickTime file is the same ISO-BMFF container as mp4, and the H.264/HEVC +
 * AAC inside is what decides whether it plays. But Firefox refuses a response
 * labelled `video/quicktime` outright ("HTTP Content-Type not supported")
 * without looking at the bytes, so a .mov from a Mac screen recording played in
 * Safari and Chrome and stayed a black box everywhere else. Labelled mp4, every
 * browser that can decode the codecs plays it.
 */
export function playbackVideoMime(sniffed: string): string {
  return sniffed === "video/quicktime" ? "video/mp4" : sniffed;
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
  // Every readable extension, so the picker, drag-and-drop and paste give the
  // SAME answer. They did not: the picker listed eight extensions and greyed
  // out .go, .rs, .java, .swift and the rest, while drag and paste applied no
  // filter at all and the server took them happily. One file, three verdicts,
  // depending only on how you put it in.
  ...[...READABLE_EXTENSIONS].map((extension) => `.${extension}`),
].join(",");
