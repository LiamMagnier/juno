/**
 * The contract every structured extractor answers in.
 *
 * `extractedText` (see `src/lib/attachment-upload.ts`) already gives the model a
 * flat UTF-8 blob for small text files. That blob cannot be cited: it has no
 * page, no sheet, no line range, so an answer built from it can only say "your
 * file said X" and never "page 4 said X". This layer sits *beside* it and
 * produces blocks that each carry a locator, which is the whole reason it
 * exists.
 *
 * Two rules hold for every extractor in this directory:
 *
 * - They are pure: bytes in, blocks out. No database, no network, no clock.
 *   That is what makes them testable, and the fixtures in
 *   `tests/knowledge-extract.test.ts` are built in-process because of it.
 * - They do not throw. A file that cannot be parsed is a *result*
 *   (`status: "degraded"` with a reason a person can act on), not an exception.
 *   Uploads come from the open internet; a malformed ZIP central directory must
 *   downgrade one document, not take out the ingest worker.
 */

/** Matches the `type` values enumerated in KnowledgeBlock's schema comment. */
export type KnowledgeBlockType =
  | "paragraph"
  | "heading"
  | "list_item"
  | "table"
  | "table_cell"
  | "slide_title"
  | "speaker_notes"
  | "code"
  | "caption"
  | "image";

/**
 * One citable unit of a document, shaped to be written straight into
 * KnowledgeBlock.
 *
 * Exactly which locator fields are set depends on the format, and that is the
 * point: a PDF citation says "page 4", a workbook citation says "Revenue!B7",
 * a source file says "config.yaml:12-19". A block with no locator at all is a
 * bug in its extractor, not an acceptable output.
 */
export interface ExtractedBlock {
  type: KnowledgeBlockType;
  text: string;
  /** 1-based page, for formats that have a fixed page geometry (PDF). */
  page?: number;
  /** 1-based slide index. */
  slide?: number;
  /** Worksheet name, exactly as the workbook spells it. */
  sheet?: string;
  /** A1-style range: a single cell ("B7") or a span ("A1:C1"). */
  cellRange?: string;
  /** File-ish path: the source file name, or the OOXML part the block came from. */
  path?: string;
  /** 1-based, inclusive line range within `path`. */
  lineStart?: number;
  lineEnd?: number;
  /** Enclosing headings, outermost first. Empty when the format has no outline. */
  heading: string[];
  /** [x, y, w, h] in page units, only when the parser actually knows it. */
  bbox?: number[];
  /**
   * 0..1. Verified embedded text is 1 — we read the characters the author
   * stored. Anything reconstructed or guessed must say so with a lower number,
   * so retrieval can prefer text we are sure about.
   */
  confidence: number;
}

/**
 * `ok` means every block we expected is here. `degraded` means we produced
 * something usable but knowingly incomplete — a scanned PDF with no text layer,
 * a workbook whose formulas have no cached results — and `reason` explains it in
 * words that belong in a UI. `failed` means we produced nothing.
 */
export type ExtractionStatus = "ok" | "degraded" | "failed";

export interface ExtractionResult {
  /** Extractor id, recorded on the document so a parser fix can find its victims. */
  parser: string;
  parserVersion: string;
  status: ExtractionStatus;
  blocks: ExtractedBlock[];
  pageCount?: number;
  /** Present whenever status is not "ok". Written to KnowledgeDocument.error. */
  reason?: string;
}

/**
 * Ceilings shared by every extractor.
 *
 * These are not tuning knobs, they are the blast radius. An uploaded file is
 * attacker-controlled: a 40 KB ZIP can expand to gigabytes, a PDF can declare a
 * million pages, a "text" file can be one 200 MB line. Every loop below is
 * bounded by one of these, and hitting a bound degrades the document instead of
 * exhausting the process.
 */
export const EXTRACT_LIMITS = {
  /** Total characters kept across all blocks of one document. */
  maxTotalChars: 2_000_000,
  /** Characters kept in a single block. Longer text is cut with an ellipsis. */
  maxBlockChars: 20_000,
  /** Blocks kept per document. */
  maxBlocks: 20_000,
  /** Pages / slides / sheets walked per document. */
  maxSections: 2_000,
  /** Bytes any single decompressed part may occupy (ZIP bomb ceiling). */
  maxPartBytes: 64 * 1024 * 1024,
} as const;

/** Collapse the whitespace OOXML and PDF layout leave behind, without trimming meaning. */
export function normalizeBlockText(text: string): string {
  return stripUnstorableCharacters(text)
    .replace(/[\t\f\v\u00a0]+/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\s+$/gm, "")
    .trim();
}

/**
 * Characters Postgres will not store, removed before anything tries.
 *
 * THE CRASH THIS FIXES, VERBATIM FROM PRODUCTION:
 *
 *   invalid byte sequence for encoding "UTF8": 0x00
 *   at prisma.knowledgeBlock.createMany()
 *
 * A Postgres `text` column cannot hold a NUL byte — not escaped, not encoded,
 * at all — and a document extractor is exactly where NUL comes from. A PDF
 * with a broken font map yields glyph ids rather than characters; an RTF
 * `\'00` escape is a literal NUL; a mislabelled binary decoded as UTF-8 is
 * full of them. Any one of those killed the whole `createMany`, so a single
 * bad byte anywhere in a 200-page report meant NOT ONE block of it was
 * stored, and the document came back as if nothing had been read.
 *
 * Stripped here, in the one funnel every extractor already passes through, so
 * no extractor has to remember — the same reason the size ceilings live in
 * `BlockCollector` rather than in nine separate modules.
 *
 * The lone surrogates matter for the same reason and are easy to miss: they
 * are legal in a JavaScript string and illegal in UTF-8, so a text run cut
 * between the halves of an emoji is rejected by the driver with a different
 * message and the same outcome.
 */
export function stripUnstorableCharacters(text: string): string {
  return (
    text
      // NUL and the C0 controls that are not whitespace. \t \n \r are kept:
      // they are layout, and the normaliser above decides their fate.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      // Unpaired surrogates — legal in JS, not encodable as UTF-8.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
      .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
  );
}

/**
 * Accumulates blocks under `EXTRACT_LIMITS`, so no extractor has to re-implement
 * the bounds (and so none of them can forget to).
 *
 * Empty text is dropped rather than stored: a KnowledgeBlock with no text is a
 * retrieval result that can never be right, and OOXML is full of empty runs.
 */
export class BlockCollector {
  private readonly blocks: ExtractedBlock[] = [];
  private chars = 0;
  private truncated = false;

  push(block: ExtractedBlock): void {
    if (this.blocks.length >= EXTRACT_LIMITS.maxBlocks || this.chars >= EXTRACT_LIMITS.maxTotalChars) {
      this.truncated = true;
      return;
    }
    const text = normalizeBlockText(block.text);
    if (!text) return;
    const clipped =
      text.length > EXTRACT_LIMITS.maxBlockChars
        ? `${text.slice(0, EXTRACT_LIMITS.maxBlockChars)}…`
        : text;
    this.chars += clipped.length;
    this.blocks.push({ ...block, text: clipped });
  }

  get length(): number {
    return this.blocks.length;
  }

  /** True when a ceiling stopped us — the caller must degrade rather than claim `ok`. */
  get hitLimit(): boolean {
    return this.truncated;
  }

  done(): ExtractedBlock[] {
    return this.blocks;
  }
}
