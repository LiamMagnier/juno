/**
 * The pdf.js reading of a PDF, for the pages the native parser could not read.
 *
 * WHY A SECOND PDF READER. `pdf.ts` is a deliberately narrow, dependency-free
 * parser, and its own header says where it stops: "No CID font decoding beyond
 * an embedded `/ToUnicode` CMap. A font with neither a standard encoding nor a
 * ToUnicode map yields bytes that are glyph ids, not characters … a page whose
 * text fails the printability check is dropped and the document degrades."
 *
 * That is not an edge case. Subset CID fonts with Identity-H encoding are what
 * LaTeX, InDesign and most PDF exporters emit, which means the class of file
 * the native parser cannot read is "technical report" — exactly the kind
 * somebody attaches and asks about. Until now such a file indexed as nothing,
 * and the only place that surfaced was the model saying it had received no
 * text.
 *
 * WHY pdf.js, AND WHY NOT A NEW DEPENDENCY. The engine that does decode those
 * fonts — cmap tables, ToUnicode, standard font metrics, encrypted-with-empty-
 * password files — is pdf.js, and this repo already ships it: `unpdf` is pdf.js
 * repackaged for serverless, already used by `lib/search/pdf-text.ts` to read
 * PDFs the research engine fetches, already held down by real-byte fixtures in
 * `tests/pdf-extraction.test.ts`. Adding `pdfjs-dist` beside it would be the
 * same engine twice, 34 MB of it, and that file's header has already written
 * out why it was rejected. So an uploaded PDF now gets the reader a fetched one
 * has had all along.
 *
 * WHERE IT SITS. `extractDocument` runs the native parser FIRST and keeps every
 * page it read: embedded text it verified is confidence 1 and carries a
 * measured bbox, which this layer cannot offer. This fills the gaps, and OCR —
 * which needs binaries or a service and is far slower — stays the last resort,
 * for pages that genuinely have no text layer at all.
 */

import { printableRatio } from "./pdf";
import { BlockCollector, EXTRACT_LIMITS, type ExtractedBlock } from "./types";

export const PDF_ENGINE = "pdfjs";
export const PDF_ENGINE_VERSION = "1";

/** Same ceiling the research reader uses; a PDF is attacker-controlled input. */
const MAX_PDF_BYTES = 32 * 1024 * 1024;

/**
 * Lines closer than this fraction of the larger line's height are one
 * paragraph; a wider gap starts a new one. The native parser makes the same
 * judgement from the text matrix — this reproduces it from pdf.js's transforms
 * so a document read by either engine breaks into comparable blocks.
 */
const PARAGRAPH_GAP_RATIO = 1.8;

export type PdfEngineOutcome =
  | { status: "ok"; blocks: ExtractedBlock[]; pages: Set<number> }
  | { status: "unavailable" | "failed"; reason: string };

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  height: number;
  eol: boolean;
}

/** One page's items, grouped into lines by baseline and lines into paragraphs. */
function paragraphsOf(items: PositionedItem[]): { text: string; y: number }[] {
  if (items.length === 0) return [];
  const lines: { y: number; height: number; parts: PositionedItem[] }[] = [];
  for (const item of items) {
    // A baseline within half a line height of an existing one is that line:
    // superscripts and inline maths sit a point or two off and must not each
    // become a row of their own.
    const tolerance = Math.max(1, item.height * 0.5);
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (line) {
      line.parts.push(item);
      line.height = Math.max(line.height, item.height);
    } else {
      lines.push({ y: item.y, height: item.height, parts: [item] });
    }
  }
  // Top of the page down. pdf.js y grows upward, like PDF user space.
  lines.sort((a, b) => b.y - a.y);

  const out: { text: string; y: number }[] = [];
  let current: string[] = [];
  let currentY = lines[0]?.y ?? 0;
  let previous: { y: number; height: number } | null = null;

  for (const line of lines) {
    line.parts.sort((a, b) => a.x - b.x);
    const text = line.parts.map((part) => part.text).join("").trim();
    if (!text) continue;
    const gap = previous ? previous.y - line.y : 0;
    const threshold = Math.max(previous?.height ?? line.height, line.height) * PARAGRAPH_GAP_RATIO;
    if (previous && gap > threshold && current.length > 0) {
      out.push({ text: current.join(" "), y: currentY });
      current = [];
      currentY = line.y;
    }
    if (current.length === 0) currentY = line.y;
    current.push(text);
    previous = { y: line.y, height: line.height };
  }
  if (current.length > 0) out.push({ text: current.join(" "), y: currentY });
  return out;
}

/**
 * Read a PDF with pdf.js, emitting one block per paragraph with its real page.
 *
 * `skipPages` is what the native parser already read: those pages are not read
 * again, because verified embedded text outranks anything produced here and
 * duplicating it would put the same sentence in the index twice.
 *
 * Never throws. A file this engine cannot open is an outcome (`failed`), for
 * the same reason every extractor in this directory returns rather than raises:
 * one bad upload must not take out the ingest worker.
 */
export async function extractPdfWithEngine(input: {
  bytes: Uint8Array;
  fileName: string;
  skipPages?: ReadonlySet<number>;
  maxPages?: number;
}): Promise<PdfEngineOutcome> {
  if (input.bytes.byteLength > MAX_PDF_BYTES) {
    return { status: "unavailable", reason: "The file is larger than the PDF reader's ceiling." };
  }

  let getDocumentProxy: typeof import("unpdf").getDocumentProxy;
  try {
    // Imported here, not at module scope: unpdf bundles the whole of pdf.js and
    // a static import would put ~1.6 MB in the server graph of every route that
    // transitively touches ingest, PDF or no PDF. The research reader makes the
    // same call for the same reason.
    ({ getDocumentProxy } = await import("unpdf"));
  } catch (e) {
    return { status: "unavailable", reason: `The PDF reader could not be loaded: ${String(e)}` };
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // `verbosity: 0`: pdf.js narrates every recoverable repair it makes
    // ("Warning: Indexing all PDF objects"), and an ingest worker reading a
    // batch of scraped PDFs would otherwise turn the server log into pdf.js's.
    pdf = await getDocumentProxy(input.bytes, { verbosity: 0 });
  } catch (e) {
    const message = String(e);
    return {
      status: "failed",
      reason: /password/i.test(message)
        ? "The PDF is encrypted and cannot be read without its password."
        : "The PDF could not be opened by the PDF reader.",
    };
  }

  const collector = new BlockCollector();
  const pages = new Set<number>();
  const limit = Math.min(pdf.numPages, input.maxPages ?? EXTRACT_LIMITS.maxSections);

  for (let page = 1; page <= limit; page++) {
    if (input.skipPages?.has(page)) continue;
    let items: PositionedItem[];
    try {
      const rendered = await pdf.getPage(page);
      const content = await rendered.getTextContent();
      items = content.items.flatMap((item) => {
        if (!("str" in item) || typeof item.str !== "string" || !item.str) return [];
        // `transform` is [a, b, c, d, e, f]; e/f are the device-space origin of
        // the run and `d` its vertical scale, which is the only height pdf.js
        // reports for text that has no explicit height.
        const transform = (item as { transform?: number[] }).transform ?? [];
        const height = (item as { height?: number }).height || Math.abs(transform[3] ?? 0) || 10;
        return [{
          text: item.str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          height,
          eol: Boolean((item as { hasEOL?: boolean }).hasEOL),
        }];
      });
    } catch {
      // One damaged page is one missing page, not a failed document.
      continue;
    }
    if (items.length === 0) continue;
    /*
     * THE SAME PRINTABILITY BAR THE NATIVE PARSER APPLIES, and it is not
     * belt-and-braces: pdf.js is more willing than the native parser to hand
     * back *something* for a font it cannot map — a run of undecodable glyph
     * ids comes out as control characters and private-use code points, which
     * look like blank space in a terminal and like text to an index. Verified
     * against a fixture whose subset font has no `/ToUnicode` at all: without
     * this the page indexed as a paragraph of invisible characters, which is
     * worse than indexing nothing, because nothing is honest.
     */
    const pageText = items.map((item) => item.text).join("");
    if (printableRatio(pageText) < 0.8) continue;
    let wrote = false;
    for (const paragraph of paragraphsOf(items)) {
      collector.push({
        type: "paragraph",
        text: paragraph.text,
        page,
        path: input.fileName,
        heading: [],
        /*
         * 0.9, not 1. Confidence 1 is reserved for characters the NATIVE parser
         * read straight out of the content stream and verified. This text is
         * also the author's — it is not OCR and it is not guessed — but it
         * comes through a font-decoding layer with its own fallbacks, and
         * retrieval should prefer the verified reading of the same page where
         * both exist. It sits far above OCR, which is a reconstruction.
         */
        confidence: 0.9,
      });
      wrote = true;
    }
    if (wrote) pages.add(page);
  }

  const blocks = collector.done();
  if (blocks.length === 0) {
    return { status: "failed", reason: "The PDF reader found no text layer on the pages it read." };
  }
  return { status: "ok", blocks, pages };
}
