/**
 * Whether a produced deliverable may be handed to a user.
 *
 * Three separate rules live here because they answer the same question and a
 * caller that applies one without the others has answered it wrongly:
 *
 *  1. `enforceByteCap` — is it within the per-kind ceiling in `domain.ts`.
 *  2. `assertSafeBundlePath` — can every entry in a bundle be written to disk
 *     without landing outside the directory the user extracted it into.
 *  3. `validateDeliverable` — does the file actually open. Not "did the builder
 *     return bytes": a .docx whose `word/document.xml` is missing is a
 *     non-empty Buffer that Word refuses, and a builder that swallowed an
 *     exception mid-way produces exactly that. The only proof that a
 *     deliverable is real is re-opening it with a reader that had no part in
 *     writing it, which is what every branch below does.
 *
 * `WorkArtifact.validatedAt` is set from this verdict and from nothing else. A
 * deliverable that has not passed here is shown as unvalidated rather than
 * offered for download as though it were fine, because the failure a user
 * cannot recover from is the one where a report they forwarded to someone else
 * turns out not to open.
 *
 * `validateDeliverable` never throws. A validator that throws leaves the caller
 * unable to distinguish "this file is broken" from "the validator is broken",
 * and the safe reading of that ambiguity — refuse to mark it validated — is
 * exactly what a returned `ok: false` already says, with a problem attached
 * that names which of the two happened.
 *
 * Deliberately free of `server-only`, Prisma and any request context, for the
 * same reason `src/lib/work/digests.ts` is: the cloud runner, the route
 * handlers and `tests/work-deliverables.test.ts` all need to run these checks,
 * and a check that can only be exercised against a live deployment is a check
 * that is exercised once, by hand, on the day it is written.
 */

import { Workbook } from "exceljs";
import JSZip from "jszip";
import { z } from "zod";
import { ARTIFACT_MAX_BYTES, type WorkArtifactKind } from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

/**
 * Why a deliverable could not be produced.
 *
 * A code rather than a message match, because the route has to answer three
 * different HTTP statuses from these — a bad spec is the caller's 400, an
 * oversized result is a 413 that must quote the ceiling, and a builder that
 * threw is Juno's 500 — and deciding that from a substring of an error message
 * is how a reworded message silently turns a client bug into a server error.
 */
export const DELIVERABLE_ERROR_CODES = [
  /** The spec is internally inconsistent: a ragged table, a duplicate sheet. */
  "invalid_spec",
  /** A bundle entry name would escape the directory it is extracted into. */
  "unsafe_path",
  /** The produced file is past the per-kind ceiling in `domain.ts`. */
  "too_large",
  /** A generator library failed. Juno's problem, not the caller's. */
  "build_failed",
] as const;

export type DeliverableErrorCode = (typeof DELIVERABLE_ERROR_CODES)[number];

export class DeliverableError extends Error {
  readonly code: DeliverableErrorCode;

  constructor(code: DeliverableErrorCode, message: string) {
    super(message);
    this.name = "DeliverableError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Bytes as a person would write them, for a message a user has to act on. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * The cap message for a kind, or null when it fits.
 *
 * The ceiling is quoted rather than the file being truncated. A truncated
 * .xlsx is not a smaller spreadsheet, it is a corrupt one; a truncated .docx is
 * a file Word declines to open. Even for the one format where truncation would
 * technically survive it — markdown — a report that silently stops halfway is
 * worse than no report, because nothing in it says it is incomplete.
 */
export function byteCapProblem(kind: WorkArtifactKind, byteSize: number): string | null {
  const cap = ARTIFACT_MAX_BYTES[kind];
  if (byteSize <= cap) return null;
  return (
    `The generated ${kind} came to ${formatBytes(byteSize)}, past the ${formatBytes(cap)} ` +
    `ceiling for a ${kind}. Nothing was truncated — a partial file of this type does not ` +
    `open — so reduce the content and generate it again.`
  );
}

export function enforceByteCap(kind: WorkArtifactKind, byteSize: number): void {
  const problem = byteCapProblem(kind, byteSize);
  if (problem) throw new DeliverableError("too_large", problem);
}

// ---------------------------------------------------------------------------
// Bundle entry paths
// ---------------------------------------------------------------------------

/**
 * How deep a generated bundle may nest, and how long one entry name may be.
 *
 * Both are archive-bomb bounds rather than aesthetic ones: a path of ten
 * thousand segments is a denial of service against whatever unzips it, and some
 * extractors fail in interesting ways rather than boring ones when a name gets
 * long enough.
 */
const MAX_BUNDLE_PATH_CHARS = 180;
const MAX_BUNDLE_PATH_SEGMENTS = 8;

/**
 * The characters a generated bundle entry may use.
 *
 * An allowlist, and a narrow one. These paths are written by Juno, not chosen
 * by a user, so nothing is lost by refusing spaces, colons, wildcards and every
 * non-ASCII script — and what is gained is that the same name means the same
 * file on APFS, NTFS and ext4, where normalisation, case folding and reserved
 * characters otherwise disagree.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `..`, `...`, `....` — a name made only of dots is never a real file. */
const ALL_DOTS = /^\.+$/;
const DRIVE_LETTER = /^[A-Za-z]:/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Why this entry name is unsafe, or null when it is fine.
 *
 * The traversal case is the reason this exists, and it is worth being precise
 * about what goes wrong: a zip entry named `../../../.ssh/authorized_keys`
 * is written by a naive extractor to exactly that path relative to the
 * extraction directory, which is to say outside it. Refusing at bundling time
 * as well as at validation time is deliberate — a bundle Juno produced should
 * never contain such an entry in the first place, and discovering it only when
 * somebody validates a file that has already been downloaded is discovering it
 * too late.
 *
 * Backslashes are refused rather than normalised because a Windows extractor
 * reads `..\..\x` as traversal while a POSIX one reads it as one oddly-named
 * file, and a rule that depends on which machine opens the archive is not a
 * rule.
 */
export function bundlePathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "An entry name must be a non-empty string.";
  if (path.length > MAX_BUNDLE_PATH_CHARS) {
    return `Entry name is longer than ${MAX_BUNDLE_PATH_CHARS} characters: ${path.slice(0, 60)}…`;
  }
  if (CONTROL_CHARS.test(path)) return `Entry name contains a control character: ${JSON.stringify(path)}`;
  if (path.includes("\\")) return `Entry name contains a backslash, which is a path separator on Windows: ${path}`;
  if (path.startsWith("/")) return `Entry name is absolute: ${path}`;
  if (DRIVE_LETTER.test(path)) return `Entry name carries a drive letter: ${path}`;

  const segments = path.split("/");
  if (segments.length > MAX_BUNDLE_PATH_SEGMENTS) {
    return `Entry name nests deeper than ${MAX_BUNDLE_PATH_SEGMENTS} directories: ${path}`;
  }
  for (const segment of segments) {
    if (segment === "") return `Entry name has an empty path segment: ${path}`;
    if (ALL_DOTS.test(segment)) return `Entry name would escape the bundle directory: ${path}`;
    if (!SAFE_SEGMENT.test(segment)) {
      return `Entry name segment "${segment}" is not a plain relative file name: ${path}`;
    }
  }
  return null;
}

export function isSafeBundlePath(path: unknown): boolean {
  return bundlePathProblem(path) === null;
}

export function assertSafeBundlePath(path: unknown): void {
  const problem = bundlePathProblem(path);
  if (problem) throw new DeliverableError("unsafe_path", problem);
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Where a deliverable's content came from.
 *
 * Declared here, below every generator, for two reasons. It belongs with the
 * other rules about whether a file can be trusted — a table of figures with no
 * source is not a smaller problem than a file that will not open, it is a
 * bigger one — and it has to sit under both the generators (a report renders
 * its own citations into its body) and the envelope that stores it on
 * `WorkArtifactVersion.provenance`, which rules out declaring it in either.
 */
export const PROVENANCE_KINDS = [
  /** A public page that was fetched and read. */
  "web_page",
  /** A record from a linked connector: an email, a row, a ticket. */
  "connector_record",
  /** A file the run was granted access to and read. */
  "file",
  /** Something the user said, in the goal or in an answer. */
  "user_input",
  /** Derived by the run from other entries rather than read anywhere. */
  "computed",
] as const;

export type ProvenanceKind = (typeof PROVENANCE_KINDS)[number];

/** How many sources one version may cite. Past this it is a bibliography. */
export const MAX_PROVENANCE_ENTRIES = 200;

export const provenanceEntrySchema = z.object({
  kind: z.enum(PROVENANCE_KINDS),
  /** What a reader is shown: a page title, a file's display name, a subject. */
  label: z.string().trim().min(1).max(300),
  /** Present for `web_page`, and for any source with a stable address. */
  url: z.string().url().max(2_000).optional(),
  /**
   * The opaque identity of a non-web source — a connector record id, a grant
   * id. Never a filesystem path: `serializeGrantForRemote`'s rule applies here
   * too, and a provenance list is rendered in every client there is.
   */
  ref: z.string().trim().min(1).max(400).optional(),
  retrievedAt: z.string().datetime().optional(),
});

export type ProvenanceEntry = z.infer<typeof provenanceEntrySchema>;

// ---------------------------------------------------------------------------
// Validation verdicts
// ---------------------------------------------------------------------------

/**
 * Stamped into every verdict and stored with it.
 *
 * A verdict recorded in June under one set of checks and read in December under
 * another is only interpretable if the row says which checks it passed. Without
 * this, tightening the site scan silently re-labels every previously validated
 * bundle as having passed the new rule.
 */
export const DELIVERABLE_VALIDATOR = "juno.work.deliverables.validate.v1";

/** Facts a validator proved by re-opening the file. All optional by kind. */
export interface DeliverableValidationDetails {
  /** Worksheet names, in book order, as the reader reported them. */
  sheets?: string[];
  /** Row count per worksheet, aligned with `sheets`. */
  rowCounts?: number[];
  slideCount?: number;
  paragraphCount?: number;
  characterCount?: number;
  headingCount?: number;
  entryCount?: number;
  /** Entry names, capped — enough to see what is in a bundle, not a manifest. */
  entryNames?: string[];
}

export interface DeliverableValidation {
  ok: boolean;
  /** Which build's rules produced this verdict. See `DELIVERABLE_VALIDATOR`. */
  validator: string;
  checkedAt: string;
  kind: WorkArtifactKind;
  byteSize: number;
  /** What re-opening the file proved, in plain language, for the UI to cite. */
  observations: string[];
  /** Why it failed. Empty when `ok`. */
  problems: string[];
  details: DeliverableValidationDetails;
}

/** How many entry names a bundle verdict carries. A manifest is not a verdict. */
const MAX_LISTED_ENTRIES = 200;
/** Total HTML a site scan reads back. Past this the scan reports what it saw. */
const MAX_SCANNED_HTML_BYTES = 4 * 1024 * 1024;

interface Verdict {
  observations: string[];
  problems: string[];
  details: DeliverableValidationDetails;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-opens a produced deliverable and reports what it found.
 *
 * Every branch uses a reader that did not write the file: exceljs parses the
 * workbook it never built, JSZip walks the OOXML container the docx/pptx
 * libraries produced, and the markdown path decodes bytes with a strict UTF-8
 * decoder. That independence is the whole value — a self-check written inside a
 * builder passes for exactly the same reason the builder produced the file.
 */
export async function validateDeliverable(
  kind: WorkArtifactKind,
  bytes: Buffer,
  options: { now?: Date } = {}
): Promise<DeliverableValidation> {
  const byteSize = bytes.byteLength;
  const base = {
    validator: DELIVERABLE_VALIDATOR,
    checkedAt: (options.now ?? new Date()).toISOString(),
    kind,
    byteSize,
  };

  const cap = byteCapProblem(kind, byteSize);
  if (cap) {
    return { ...base, ok: false, observations: [], problems: [cap], details: {} };
  }
  if (byteSize === 0) {
    return { ...base, ok: false, observations: [], problems: ["The file is empty."], details: {} };
  }

  let verdict: Verdict;
  try {
    verdict = await inspect(kind, bytes);
  } catch (err) {
    // A reader that threw has proved nothing, and the honest verdict is the
    // same one a malformed file gets: not validated, with the reason attached.
    verdict = {
      observations: [],
      problems: [`The validator could not read the file back: ${reason(err)}`],
      details: {},
    };
  }

  return {
    ...base,
    ok: verdict.problems.length === 0,
    observations: verdict.observations,
    problems: verdict.problems,
    details: verdict.details,
  };
}

function inspect(kind: WorkArtifactKind, bytes: Buffer): Promise<Verdict> {
  switch (kind) {
    case "document":
      return inspectDocx(bytes);
    case "spreadsheet":
      return inspectXlsx(bytes);
    case "presentation":
      return inspectPptx(bytes);
    case "report":
      return Promise.resolve(inspectMarkdown(bytes));
    case "site":
      return inspectZip(bytes, { site: true });
    case "bundle":
    case "archive":
      return inspectZip(bytes, { site: false });
    case "pdf":
    case "image":
      return Promise.resolve(inspectHeaderOnly(kind, bytes));
  }
}

// ---------------------------------------------------------------------------
// OOXML containers
// ---------------------------------------------------------------------------

/** `<w:p>` and `<w:p …>` both open a paragraph; `<w:pPr>` must not count. */
const DOCX_PARAGRAPH = /<w:p(?=[ />])/g;
const DOCX_TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
const PPTX_SLIDE = /^ppt\/slides\/slide\d+\.xml$/;

/** The five entities an OOXML text node may carry. Enough to count characters. */
function decodeXmlText(raw: string): string {
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function inspectDocx(bytes: Buffer): Promise<Verdict> {
  const zip = await JSZip.loadAsync(bytes);
  const problems: string[] = [];
  const observations: string[] = [];

  if (!zip.file("[Content_Types].xml")) {
    problems.push("The container has no [Content_Types].xml, so it is not an OOXML package.");
  }
  const main = zip.file("word/document.xml");
  if (!main) {
    // The specific failure this catches: a builder that threw after packing the
    // relationship parts leaves a zip that looks like a .docx to a file
    // manager and opens to an error in Word.
    return {
      observations,
      problems: [...problems, "The package has no word/document.xml, so there is no document to read."],
      details: {},
    };
  }

  const xml = await main.async("string");
  const paragraphCount = xml.match(DOCX_PARAGRAPH)?.length ?? 0;
  let text = "";
  for (const match of xml.matchAll(DOCX_TEXT)) text += decodeXmlText(match[1]);

  if (!xml.includes("<w:body")) problems.push("word/document.xml has no <w:body>.");
  if (paragraphCount === 0) problems.push("The document part contains no paragraphs.");

  observations.push(
    `Unzipped the package and read word/document.xml: ${paragraphCount} paragraphs, ` +
      `${text.length} characters of text.`
  );
  return { observations, problems, details: { paragraphCount, characterCount: text.length } };
}

async function inspectPptx(bytes: Buffer): Promise<Verdict> {
  const zip = await JSZip.loadAsync(bytes);
  const problems: string[] = [];
  const slides = Object.keys(zip.files).filter((name) => PPTX_SLIDE.test(name));

  if (!zip.file("ppt/presentation.xml")) {
    problems.push("The package has no ppt/presentation.xml, so it is not a presentation.");
  }
  if (slides.length === 0) {
    // pptxgenjs writes a structurally valid but unopenable file when a deck
    // ends up with no slides, which is why this is checked rather than assumed.
    problems.push("The presentation contains no slides.");
  }

  return {
    observations: [`Unzipped the package and counted ${slides.length} slide parts.`],
    problems,
    details: { slideCount: slides.length },
  };
}

/**
 * exceljs ships `declare interface Buffer extends ArrayBuffer {}` in its own
 * .d.ts. That merges into the global `Buffer` interface and leaves a genuine
 * Node Buffer unassignable to the parameter of the library's own `load()`.
 * Casting to the declared parameter type rather than to `any` keeps the call
 * checked in every other respect — the method still has to exist and still has
 * to take one argument.
 */
type XlsxLoadInput = Parameters<Workbook["xlsx"]["load"]>[0];

async function inspectXlsx(bytes: Buffer): Promise<Verdict> {
  const workbook = new Workbook();
  // exceljs parses the whole book, so this is a genuine open rather than a
  // container check: a corrupt sharedStrings or a broken sheet relationship
  // fails here and would fail identically in Excel.
  await workbook.xlsx.load(bytes as unknown as XlsxLoadInput);

  const sheets = workbook.worksheets.map((sheet) => sheet.name);
  const rowCounts = workbook.worksheets.map((sheet) => sheet.rowCount);
  const problems: string[] = [];
  if (sheets.length === 0) problems.push("The workbook has no worksheets.");

  return {
    observations: [
      `Opened the workbook with a reader that did not write it: ${sheets.length} sheet(s) — ` +
        `${sheets.join(", ")}.`,
    ],
    problems,
    details: { sheets, rowCounts },
  };
}

// ---------------------------------------------------------------------------
// Zip bundles
// ---------------------------------------------------------------------------

/**
 * Markup a generated bundle must never contain.
 *
 * This is a self-check on the site generator's escaping, not a sanitiser. The
 * generator builds every page from typed blocks and escapes all of it, so a
 * literal `<script` reaching the output means the escaping was bypassed
 * somewhere, and that is precisely the moment a bundle must stop being
 * previewable. Anchors to remote pages are deliberately allowed — a report's
 * citations are links — while remote *subresources* are not, because those
 * execute or style with the page's privileges.
 */
const UNSAFE_MARKUP: readonly { pattern: RegExp; problem: string }[] = [
  { pattern: /<script\b/i, problem: "a <script> element" },
  { pattern: /<iframe\b/i, problem: "an <iframe>" },
  { pattern: /<object\b|<embed\b/i, problem: "an <object> or <embed>" },
  { pattern: /\son[a-z]+\s*=/i, problem: "an inline event handler attribute" },
  { pattern: /javascript:/i, problem: "a javascript: URL" },
  { pattern: /<link\b[^>]*href\s*=\s*["']?(?:https?:)?\/\//i, problem: "a remote stylesheet" },
  { pattern: /<img\b[^>]*src\s*=\s*["']?(?:https?:)?\/\//i, problem: "a remote image" },
  { pattern: /@import\b/i, problem: "a CSS @import" },
];

async function inspectZip(bytes: Buffer, options: { site: boolean }): Promise<Verdict> {
  const zip = await JSZip.loadAsync(bytes);
  const problems: string[] = [];
  const observations: string[] = [];
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const entryNames = entries.map((entry) => entry.name);

  for (const entry of entries) {
    // `unsafeOriginalName`, not `name`. JSZip resolves `..` out of entry names
    // as it loads, so `name` for an entry stored as `../../evil.sh` reads back
    // as `evil.sh` — which is JSZip protecting itself and would hide the
    // attack from this check entirely. The stored bytes are what another
    // extractor will read, so the stored name is what is judged.
    const stored = entry.unsafeOriginalName ?? entry.name;
    const problem = bundlePathProblem(stored);
    // Reported once per bad entry rather than aborting, so a user is told
    // everything wrong with the archive instead of the first thing.
    if (problem) problems.push(`Refused entry: ${problem}`);
  }

  observations.push(`Listed ${entries.length} entries; checked every stored name for traversal.`);

  if (options.site) {
    if (!entryNames.includes("index.html")) {
      problems.push("A site bundle has no index.html, so there is nothing to open.");
    }
    let scanned = 0;
    for (const entry of entries) {
      if (!entry.name.endsWith(".html") && !entry.name.endsWith(".css")) continue;
      if (scanned >= MAX_SCANNED_HTML_BYTES) {
        observations.push(`Stopped scanning markup after ${formatBytes(scanned)}.`);
        break;
      }
      const text = await entry.async("string");
      scanned += text.length;
      for (const rule of UNSAFE_MARKUP) {
        if (rule.pattern.test(text)) problems.push(`${entry.name} contains ${rule.problem}.`);
      }
    }
    if (problems.length === 0) {
      observations.push("No script, inline handler, iframe or remote subresource in any page.");
    }
  }

  return {
    observations,
    problems,
    details: { entryCount: entryNames.length, entryNames: entryNames.slice(0, MAX_LISTED_ENTRIES) },
  };
}

// ---------------------------------------------------------------------------
// Text and header-only kinds
// ---------------------------------------------------------------------------

const MARKDOWN_HEADING = /^ {0,3}#{1,6}\s/gm;

function inspectMarkdown(bytes: Buffer): Verdict {
  // `fatal: true` is the point: a report assembled from bytes spliced at a
  // multi-byte boundary decodes to replacement characters under the lenient
  // decoder and looks fine, and this refuses it instead.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const problems: string[] = [];
  if (text.trim() === "") problems.push("The report is blank.");
  if (text.includes("\u0000")) problems.push("The report contains a NUL byte, so it is not text.");

  const headingCount = text.match(MARKDOWN_HEADING)?.length ?? 0;
  return {
    observations: [
      `Decoded ${bytes.byteLength} bytes as strict UTF-8: ${text.length} characters, ` +
        `${headingCount} headings.`,
    ],
    problems,
    details: { characterCount: text.length, headingCount },
  };
}

const PDF_MAGIC = "%PDF-";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The two kinds this milestone has no generator and no parser for.
 *
 * The header check is worth doing — it catches an HTML error page saved with a
 * .pdf name — but it is emphatically not a validation, and reporting it as one
 * would put `validatedAt` on a file nobody has opened. So the verdict is
 * `ok: false` with the reason stated, which shows the artifact as unvalidated:
 * accurate, and visibly a gap rather than a silent pass.
 */
function inspectHeaderOnly(kind: "pdf" | "image", bytes: Buffer): Verdict {
  const observations: string[] = [];
  const problems: string[] = [];

  if (kind === "pdf") {
    const header = bytes.subarray(0, PDF_MAGIC.length).toString("latin1");
    if (header === PDF_MAGIC) observations.push("The file starts with a %PDF- header.");
    else problems.push("The file does not start with a %PDF- header, so it is not a PDF.");
  } else {
    if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      observations.push("The file starts with a PNG signature.");
    } else {
      problems.push("The file does not start with a PNG signature.");
    }
  }

  problems.push(
    `This build has no ${kind} parser, so the file has only been checked at its header. ` +
      `It is recorded as unvalidated rather than passed.`
  );
  return { observations, problems, details: {} };
}
