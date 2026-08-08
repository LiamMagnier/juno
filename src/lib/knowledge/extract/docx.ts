/**
 * .docx → headings, paragraphs, list items and tables.
 *
 * The awkward part of Word is the locator. A .docx stores no page numbers,
 * because pagination is a decision the *renderer* makes from the page size, the
 * fonts installed and the printer metrics — two machines can legitimately
 * disagree about what is on page 3. What Word does store is
 * `<w:lastRenderedPageBreak/>`: where the pages fell the last time it laid the
 * document out. That is a real, if stale, answer, so this parser counts those
 * markers and sets `page` only when the document actually contains them. A
 * document saved by a tool that never rendered it (which includes anything this
 * repo generates via the `docx` package) gets no page numbers at all rather than
 * invented ones — the heading breadcrumb and ordinal are the locator there.
 */

import { openOoxml, scanXml, xmlAttr } from "./ooxml";
import { BlockCollector, type ExtractedBlock, type ExtractionResult } from "./types";

export const DOCX_PARSER = "docx";
export const DOCX_PARSER_VERSION = "1";

const DOCUMENT_PART = "word/document.xml";

/** Word's built-in outline styles, plus the localized ids Word writes for them. */
function headingLevelOf(style: string | null): number | null {
  if (!style) return null;
  const normalized = style.toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "title") return 1;
  if (normalized === "subtitle") return 2;
  const match = /^heading([1-9])$/.exec(normalized);
  return match ? Number(match[1]) : null;
}

interface ParagraphState {
  runs: string[];
  style: string | null;
  numbered: boolean;
}

export async function extractDocx(input: { bytes: Uint8Array; fileName: string }): Promise<ExtractionResult> {
  const base = { parser: DOCX_PARSER, parserVersion: DOCX_PARSER_VERSION };

  const opened = await openOoxml(input.bytes);
  if (!opened.ok) return { ...base, status: "failed", blocks: [], reason: opened.reason };

  const xml = await opened.pkg.read(DOCUMENT_PART);
  if (xml === null) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This .docx has no readable document body — the file is either damaged or not a Word document.",
    };
  }

  const collector = new BlockCollector();
  // Breadcrumb stack, same shape as the markdown extractor's: a heading of level
  // L discards everything at level >= L.
  const outline: Array<{ level: number; text: string }> = [];
  const crumb = () => outline.map((h) => h.text);

  let page = 1;
  let sawPageBreak = false;

  // Table state. Word nests tables, and a nested table's rows are just more rows
  // as far as a citation is concerned, so depth is tracked but only the
  // outermost table emits — the inner one's text lands in the enclosing cell.
  let tableDepth = 0;
  let cells: string[] = [];
  let rows: string[][] = [];
  let cellParagraphs: string[] = [];

  let para: ParagraphState | null = null;
  // Only `<w:t>` counts as text. Tracked deletions live in `<w:delText>`, so
  // they are excluded for free — indexing them would let retrieval quote a
  // sentence the author already removed.
  let inText = false;

  const pushBlock = (block: Omit<ExtractedBlock, "confidence" | "path" | "page">) => {
    // `page` is attached to every block and stripped afterwards if the document
    // turned out to have no rendered page breaks at all. It cannot be decided
    // here: the first paragraph is pushed before we have seen the first break,
    // so at this point "does this document have page numbers?" is not yet known.
    collector.push({
      path: DOCUMENT_PART,
      page,
      // Verified embedded text: these are the characters the author typed.
      confidence: 1,
      ...block,
    });
  };

  const endParagraph = () => {
    if (!para) return;
    const text = para.runs.join("");
    const current = para;
    para = null;
    if (!text.trim()) return;

    if (tableDepth > 0) {
      cellParagraphs.push(text);
      return;
    }

    const level = headingLevelOf(current.style);
    if (level !== null) {
      while (outline.length && outline[outline.length - 1].level >= level) outline.pop();
      pushBlock({ type: "heading", text, heading: crumb() });
      outline.push({ level, text });
      return;
    }
    pushBlock({ type: current.numbered ? "list_item" : "paragraph", text, heading: crumb() });
  };

  scanXml(xml, (event) => {
    if (event.kind === "text") {
      if (inText && para) para.runs.push(event.text);
      return;
    }

    const name = event.name;

    if (event.kind === "open" || event.kind === "empty") {
      switch (name) {
        case "w:p":
          para = { runs: [], style: null, numbered: false };
          return;
        case "w:pStyle":
          if (para) para.style = xmlAttr(event.attrs, "w:val");
          return;
        case "w:numPr":
          if (para) para.numbered = true;
          return;
        case "w:t":
          inText = event.kind === "open";
          return;
        case "w:tab":
          if (para) para.runs.push(" ");
          return;
        case "w:br": {
          if (xmlAttr(event.attrs, "w:type") === "page") {
            sawPageBreak = true;
            page += 1;
          } else if (para) {
            para.runs.push("\n");
          }
          return;
        }
        case "w:lastRenderedPageBreak":
          sawPageBreak = true;
          page += 1;
          return;
        case "w:tbl":
          endParagraph();
          tableDepth += 1;
          if (tableDepth === 1) rows = [];
          return;
        case "w:tr":
          if (tableDepth === 1) cells = [];
          return;
        case "w:tc":
          cellParagraphs = [];
          return;
        default:
          return;
      }
    }

    // close
    switch (name) {
      case "w:t":
        inText = false;
        return;
      case "w:p":
        endParagraph();
        return;
      case "w:tc":
        if (tableDepth === 1) cells.push(cellParagraphs.join("\n").trim());
        cellParagraphs = [];
        return;
      case "w:tr":
        if (tableDepth === 1 && cells.length) rows.push(cells);
        cells = [];
        return;
      case "w:tbl": {
        tableDepth -= 1;
        if (tableDepth !== 0 || !rows.length) return;
        // One block per table, rows pipe-separated. A table split across blocks
        // loses its header row, and a header-less row is unreadable out of
        // context — which is exactly the context a retrieved block lacks.
        const text = rows.map((row) => row.join(" | ")).join("\n");
        pushBlock({ type: "table", text, heading: crumb() });
        rows = [];
        return;
      }
      default:
    }
  });
  endParagraph();

  const blocks = sawPageBreak
    ? collector.done()
    : collector.done().map((block) => {
        const withoutPage = { ...block };
        delete withoutPage.page;
        return withoutPage;
      });
  if (!blocks.length) {
    return {
      ...base,
      status: "degraded",
      blocks: [],
      reason: "This document has no text — it is probably images only, and Juno does not read text out of pictures yet.",
    };
  }

  return {
    ...base,
    status: collector.hitLimit ? "degraded" : "ok",
    blocks,
    pageCount: sawPageBreak ? page : undefined,
    reason: collector.hitLimit
      ? "This document is longer than Juno's indexing limit, so only its first part was indexed."
      : undefined,
  };
}
