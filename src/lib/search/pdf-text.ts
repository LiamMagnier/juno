/**
 * Turning a fetched `application/pdf` into text the research engine can read.
 *
 * Until now this file did not exist and the extractor's content-type gate closed
 * on every PDF, which meant the one source class the planner is explicitly
 * prompted to chase — standards, papers, filings, government reports, the things
 * that are only ever published as a PDF — could be found by search, ranked, and
 * then dropped at the door.
 *
 * NOT `server-only`, deliberately, and for the reason url-safety.ts and fusion.ts
 * already give at length: search-engine.ts carries that marker, so anything it
 * imports which also needs to be reachable from `tsx --test` has to live outside
 * it. A PDF parser is exactly the code you want a test to exercise against real
 * bytes rather than a mock, so it lives here and search-engine.ts imports it.
 *
 * ON THE DEPENDENCY. `unpdf` is pdf.js repackaged for serverless: zero runtime
 * dependencies, MIT, ~2.5 MB on disk, no native build step, and its only peer —
 * `@napi-rs/canvas` — is optional and needed solely for rasterising pages, which
 * this module never does. The alternatives were weighed and rejected: `pdf-parse`
 * depends on `@napi-rs/canvas` outright and so drags a prebuilt binary into every
 * install; raw `pdfjs-dist` is 34 MB and expects a worker and a DOM; `mupdf` is a
 * 14 MB WASM build; `pdf-lib` writes PDFs and cannot read text out of one.
 *
 * Its package declares `engines: node >=22` while this repo declares >=20, which
 * looks like a conflict and is not one: the bundle opens by polyfilling every
 * newer global it uses (`Promise.withResolvers`, `Promise.try`, `Math.sumPrecise`,
 * `Uint8Array.prototype.toHex`, `Map.prototype.getOrInsertComputed`, `DOMMatrix`).
 * Verified by deleting all of them and extracting text anyway — which is why the
 * declared floor was not treated as a reason to pin an older version or to add a
 * polyfill here. `npm ci` on the Node 20 CI image warns EBADENGINE and installs.
 */
import { isDisallowedHost } from "./url-safety";

/**
 * Why a PDF that WAS fetched still produced no text.
 *
 * Distinct from the extractor's `unsupported_content_type`, which now means what
 * it says — a file type this build has no parser for at all. Reporting an
 * encrypted PDF as an unsupported type would be a lie the moment this module
 * landed, and the reason code is what a run's timeline and any later telemetry
 * read; "we cannot open PDFs" and "we could not open THIS PDF" have to stay
 * different answers.
 */
export type PdfFailureReason =
  | "too_large"
  | "not_a_pdf"
  | "encrypted"
  | "malformed"
  /** Parsed fine, but every page was ink: a scan with no text layer, or forms-only. */
  | "no_text_layer";

export type PdfExtraction =
  | { ok: true; text: string; title?: string; author?: string; publishedAt?: Date; links: string[]; pages: number; pagesRead: number }
  | { ok: false; reason: PdfFailureReason };

/**
 * The ceiling on bytes we will hold in memory for one document.
 *
 * This parses a file chosen by an arbitrary web page during an unattended run,
 * on a server that may be mid-way through several other runs, so the size has to
 * be decided BEFORE the bytes are resident rather than after. 12 MiB clears the
 * overwhelming majority of papers and specs; the scanned 300-page annual reports
 * above it are the ones with no text layer anyway, so the ceiling mostly refuses
 * work that would have failed after paying for it.
 */
export const MAX_PDF_BYTES = 12 * 1024 * 1024;

/**
 * The ceiling on pages parsed. Text extraction is per-page CPU work inside a
 * request, and a 900-page federal register volume would otherwise pin a worker
 * for minutes to fill a 16 000-character budget the first six pages already
 * filled. The character budget below usually bites first; this is the guard for
 * the pathological document where it does not.
 */
export const MAX_PDF_PAGES = 40;

/** Links kept from a document's annotations. Mirrors the HTML path's cap. */
const MAX_PDF_LINKS = 120;

/** The five bytes every PDF starts with, per ISO 32000 §7.5.2. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/**
 * Whether these bytes are actually a PDF.
 *
 * The content-type header is not enough on its own in either direction: plenty
 * of servers ship PDFs as `application/octet-stream`, and a host that mislabels
 * an HTML error page as `application/pdf` would otherwise reach the parser and
 * come back as `malformed` — a failure that reads like a broken document when
 * the truth is a redirect to a login wall.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  // Some producers emit junk before the header; the spec says the header must be
  // at the start, Acrobat tolerates a small offset, and pdf.js scans for it. A
  // short scan keeps those readable without accepting an HTML page that happens
  // to mention "%PDF-" a kilobyte in.
  const window = Math.min(bytes.length - PDF_MAGIC.length, 1024);
  for (let start = 0; start <= window; start++) {
    let hit = true;
    for (let i = 0; i < PDF_MAGIC.length; i++) {
      if (bytes[start + i] !== PDF_MAGIC[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * pdf.js signals "this document is protected" by throwing a `PasswordException`
 * and "these bytes are not a document" by throwing `InvalidPDFException`, both
 * of which arrive here as plain Errors once bundled. Matching on `name` keeps
 * the two apart without importing pdf.js's exception classes into this module's
 * type surface — and anything unrecognised is reported as malformed rather than
 * guessed at.
 */
function classifyParseError(e: unknown): PdfFailureReason {
  const name = e instanceof Error ? e.name : "";
  if (name === "PasswordException") return "encrypted";
  return "malformed";
}

/** Collapses whitespace without destroying line structure. Mirrors unpdf's own
 * merge normaliser, which is not exported. */
function normalize(pages: string[]): string {
  return pages
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A PDF `/Info` date is `D:YYYYMMDDHHmmSS…`, which `Date.parse` cannot read. */
function parsePdfDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(raw.trim());
  if (!m) return Number.isFinite(Date.parse(String(raw))) ? new Date(String(raw)) : undefined;
  const iso = `${m[1]}-${m[2] ?? "01"}-${m[3] ?? "01"}T${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

/**
 * Extract text (and outbound links) from PDF bytes, bounded on every axis.
 *
 * `maxChars` is the caller's character budget; the page loop stops as soon as it
 * is met, so a long document costs the pages that were actually read and not one
 * more. Never throws: a malformed or protected file is a typed `ok: false`,
 * because this runs inside the research engine's READ stage, where an exception
 * takes down the whole round rather than one source.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: { maxChars: number; signal?: AbortSignal }
): Promise<PdfExtraction> {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, reason: "too_large" };
  if (!looksLikePdf(bytes)) return { ok: false, reason: "not_a_pdf" };

  /*
   * Imported here, not at module scope, because unpdf bundles the whole of pdf.js
   * — 1.6 MB of it — and a static import puts that in the server graph of every
   * route that transitively touches the search stack, PDF or no PDF. A research
   * run reads far more HTML pages than PDFs; this keeps the cost on the pages
   * that incur it.
   */
  const { getDocumentProxy } = await import("unpdf");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // `verbosity: 0` because pdf.js narrates recoverable damage to the console
    // ("Warning: Indexing all PDF objects"), and a research run reading a dozen
    // scraped PDFs turned the server log into pdf.js's log.
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch (e) {
    return { ok: false, reason: classifyParseError(e) };
  }

  try {
    const totalPages = pdf.numPages;
    const limit = Math.min(totalPages, MAX_PDF_PAGES);
    const pageTexts: string[] = [];
    const links: string[] = [];
    const seenLinks = new Set<string>();
    let chars = 0;

    for (let n = 1; n <= limit; n++) {
      // The caller's timebox is an AbortSignal, and nothing inside a CPU-bound
      // parse loop observes one on its own — an aborted run would otherwise keep
      // a worker busy on pages nobody is waiting for. Between pages is the only
      // place we can honour it, and it is granular enough to matter.
      if (options.signal?.aborted) break;

      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      // pdf.js emits marked-content markers alongside text items; those carry no
      // `str` at all, and `item.str` on a real item can legitimately be "".
      const text = content.items
        .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("");
      pageTexts.push(text);
      chars += text.length;

      /*
       * A PDF's outbound links live in link annotations, not in the text, so the
       * hop stage would see a bibliography as unlinked prose without this. Read
       * inside the page loop rather than through unpdf's `extractLinks`, which
       * walks every page of the document with no ceiling — the exact unbounded
       * work this function exists to avoid.
       */
      if (links.length < MAX_PDF_LINKS) {
        try {
          for (const annotation of await page.getAnnotations({ intent: "display" })) {
            const href = (annotation as { url?: unknown }).url;
            if (typeof href !== "string" || seenLinks.has(href)) continue;
            // The same guard the HTML path applies: a fetched document is an
            // untrusted party handing us URLs, and these reach fetch().
            if (isDisallowedHost(href)) continue;
            seenLinks.add(href);
            links.push(href);
            if (links.length >= MAX_PDF_LINKS) break;
          }
        } catch {
          // A damaged annotation dictionary must not cost us the page's text,
          // which is the part the run actually needs.
        }
      }

      if (chars >= options.maxChars) break;
    }

    const text = normalize(pageTexts);
    // A scan is a perfectly valid PDF full of images, and it parses without
    // complaint — so "no text" is a distinct outcome from "would not parse", and
    // reporting it as malformed would send a user looking for a broken file.
    if (!text) return { ok: false, reason: "no_text_layer" };

    let title: string | undefined;
    let author: string | undefined;
    let publishedAt: Date | undefined;
    try {
      const info = (await pdf.getMetadata()).info as Record<string, unknown>;
      // Producers routinely leave `/Title` as the source filename
      // ("Microsoft Word - draft7.docx"), which is worse than the URL the caller
      // already has, so an empty or extension-shaped title is left undefined.
      const rawTitle = typeof info.Title === "string" ? info.Title.trim() : "";
      if (rawTitle && !/\.(docx?|pdf|indd|tex|pptx?)$/i.test(rawTitle)) title = rawTitle;
      const rawAuthor = typeof info.Author === "string" ? info.Author.trim() : "";
      if (rawAuthor) author = rawAuthor;
      publishedAt = parsePdfDate(info.CreationDate);
    } catch {
      // Metadata is a bonus; a document whose /Info dictionary is broken still
      // has text worth returning.
    }

    return {
      ok: true,
      text: text.slice(0, options.maxChars),
      title,
      author,
      publishedAt,
      links,
      pages: totalPages,
      pagesRead: pageTexts.length,
    };
  } catch (e) {
    return { ok: false, reason: classifyParseError(e) };
  } finally {
    /*
     * pdf.js caches every parsed page, font and image on the loading task and
     * keeps them until the task is destroyed. Without this a run that reads six
     * PDFs holds all six documents' object graphs to the end of the process,
     * which is how a long-lived research worker grows until it is OOM-killed.
     */
    try {
      await pdf.loadingTask?.destroy();
    } catch {
      // Destroying an already-failed task throws; there is nothing left to free.
    }
  }
}

// ---------------------------------------------------------------------------
// The two decisions the fetch path makes ABOUT a PDF, before there is a PDF to
// parse: whether a response is one at all, and how many of its bytes we are
// willing to hold. They live here rather than beside the fetch in
// search-engine.ts for the reason that module's header already gives — it is
// `server-only`, so anything inside it is out of reach of `tsx --test`, and a
// size ceiling nothing exercises is a size ceiling that quietly stops holding.
// ---------------------------------------------------------------------------

/** Content types that assert nothing beyond "these are bytes". */
const GENERIC_BINARY_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/download"]);

/**
 * Whether a response should be handed to the PDF parser.
 *
 * The header alone is not a reliable test. Static hosts and object stores serve
 * papers as `application/octet-stream` constantly — preprint mirrors and agency
 * document stores among them — and those are precisely the primary sources a run
 * wants, so the URL's extension is allowed to break the tie when the type is
 * absent or deliberately generic. It is never allowed to override a type that
 * says something specific: a `.pdf` path answering with `text/html` is a login
 * wall or a landing page, and the HTML path reads those correctly.
 *
 * The bytes get the final say downstream via `looksLikePdf`; this only decides
 * which door to knock on.
 */
export function responseIsPdf(baseType: string, url: string): boolean {
  if (baseType === "application/pdf" || baseType === "application/x-pdf") return true;
  if (!GENERIC_BINARY_TYPES.has(baseType)) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * `res.arrayBuffer()` was the obvious call and is the wrong one here: it buffers
 * whatever the far end sends before anything can object, so a research run
 * pointed at a 2 GB scan — by a search result, i.e. by a party we do not control
 * — allocates all of it and only then gets told it was too big. Streaming and
 * stopping at the limit means the ceiling costs what it claims to cost.
 *
 * `Content-Length` is consulted first purely as a shortcut; it is a hint from the
 * same untrusted party, so the running total is what actually enforces the bound.
 */
export async function readBodyBounded(res: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > limit ? null : buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    // Without this the connection is held open by an unread body when we bail
    // early, and undici's pool runs out of sockets after a few oversized files.
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
