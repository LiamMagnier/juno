import { BlockCollector, EXTRACT_LIMITS, type ExtractionResult } from "./types";

/**
 * .rtf → text blocks, because the alternative was indexing control words.
 *
 * WHAT THIS REPLACES. RTF has no extractor, so it fell through to the text
 * extractor's `mime.startsWith("text/")` arm — RTF *is* ASCII, so nothing
 * objected — and the index filled with `\fonttbl`, `\colortbl`, `\pard\plain`
 * and the rest. A document that read as fluent prose in any word processor
 * reached the model as its own markup. Worse, whether that happened at all was
 * a coin flip: macOS reports `text/rtf` and was accepted; Linux and Windows
 * report `application/rtf` and were refused 415. The same file, two verdicts.
 *
 * WHY A HAND-WRITTEN STRIPPER AND NOT A LIBRARY. RTF's grammar is small and
 * almost entirely irrelevant here: groups in braces, control words beginning
 * with a backslash, and literal text. Everything this needs is the last of the
 * three, plus enough of the first two to know what to throw away. The
 * dependency it would otherwise take on is not worth a hundred lines.
 */

export const RTF_PARSER = "rtf";
export const RTF_PARSER_VERSION = "1";

/**
 * Groups whose contents are metadata, not document text.
 *
 * These are `\*\` destinations plus the header tables. Skipping them is what
 * separates "the document said X" from a font list: `\fonttbl` alone can be
 * several kilobytes of typeface names that read exactly like prose to an
 * index and mean nothing to a reader.
 */
const SKIPPED_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "revtbl", "rsidtbl", "generator", "info", "pict", "object", "themedata",
  "colorschememapping", "latentstyles", "datastore", "xmlnstbl", "filetbl",
  "upr", "fchars", "lchars", "mmathPr",
]);

/**
 * The 0x80–0x9F range of Windows-1252, which is where RTF keeps punctuation.
 *
 * `\'hh` is a byte in the document's codepage, and the codepage is almost
 * always cp1252. Those bytes are C1 control characters in Latin-1, so decoding
 * them naively turns a euro sign into an invisible control code and a curly
 * apostrophe into nothing — on precisely the European and typographic
 * documents where they appear most.
 */
const CP1252_HIGH: Record<number, string> = {
  0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026",
  0x86: "\u2020", 0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160",
  0x8b: "\u2039", 0x8c: "\u0152", 0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019",
  0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014",
  0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a", 0x9c: "\u0153",
  0x9e: "\u017e", 0x9f: "\u0178",
};

/** Control words that are whitespace rather than formatting. */
const BREAKS: Record<string, string> = {
  par: "\n",
  line: "\n",
  sect: "\n\n",
  page: "\n\n",
  tab: "\t",
  cell: "\t",
  row: "\n",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  emdash: "—",
  endash: "–",
  bullet: "•",
  nbsp: " ",
};

/**
 * Unwrap RTF to the text a reader would see.
 *
 * Exported for its own test: this is the part with all the judgement in it,
 * and it is pure.
 */
export function rtfToText(rtf: string): string {
  let out = "";
  let index = 0;
  // One entry per open brace: whether everything inside it is being discarded.
  const skipDepth: boolean[] = [];
  let skipping = 0;

  const limit = Math.min(rtf.length, EXTRACT_LIMITS.maxPartBytes);
  while (index < limit) {
    const char = rtf[index];

    if (char === "{") {
      skipDepth.push(false);
      index += 1;
      continue;
    }
    if (char === "}") {
      if (skipDepth.pop() && skipping > 0) skipping -= 1;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = rtf[index + 1];
      /*
       * A backslash at end of line IS a line break — it is how TextEdit and
       * Word end a paragraph, and it is not a control word, so the control
       * word regex below never matched it. Every paragraph of such a document
       * ran into the next one: "Quarterly ReportRevenue rose to...".
       */
      if (next === "\n" || next === "\r") {
        if (!skipping) out += "\n";
        index += next === "\r" && rtf[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      // `\\`, `\{`, `\}` — an escaped literal, not a control word.
      if (next === "\\" || next === "{" || next === "}") {
        if (!skipping) out += next;
        index += 2;
        continue;
      }
      // `\'hh` — a byte in the document's codepage.
      if (next === "'") {
        const hex = rtf.slice(index + 2, index + 4);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          const code = parseInt(hex, 16);
          if (!skipping) out += CP1252_HIGH[code] ?? String.fromCharCode(code);
          index += 4;
          continue;
        }
      }
      // `\*\destination` — a group this reader is meant to ignore wholesale.
      if (next === "*") {
        if (skipDepth.length) skipDepth[skipDepth.length - 1] = true;
        skipping += 1;
        index += 2;
        continue;
      }

      const match = /^\\([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      const word = match[1];
      const parameter = match[2];
      index += match[0].length;

      if (word === "u" && parameter) {
        // `\uN` is a signed 16-bit code unit, optionally followed by a
        // fallback character that must not be emitted as well.
        const code = Number(parameter);
        if (!skipping) out += String.fromCharCode(code < 0 ? code + 65536 : code);
        if (rtf[index] === "?") index += 1;
        continue;
      }
      if (SKIPPED_DESTINATIONS.has(word.toLowerCase())) {
        if (skipDepth.length) skipDepth[skipDepth.length - 1] = true;
        skipping += 1;
        continue;
      }
      if (!skipping && word in BREAKS) out += BREAKS[word];
      continue;
    }

    if (!skipping && char !== "\r" && char !== "\n") out += char;
    index += 1;
  }

  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractRtf(input: { bytes: Uint8Array; fileName: string }): ExtractionResult {
  const base = { parser: RTF_PARSER, parserVersion: RTF_PARSER_VERSION };
  // latin1, not utf8: RTF is a 7-bit format that escapes everything above it
  // as `\'hh`, and decoding as UTF-8 mangles those bytes before they can be
  // un-escaped.
  const source = Buffer.from(input.bytes).toString("latin1");
  if (!source.startsWith("{\\rtf")) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This file is not RTF — it does not start with an RTF header.",
    };
  }

  const text = rtfToText(source);
  if (!text) {
    return { ...base, status: "degraded", blocks: [], reason: "This RTF file contains no readable text." };
  }

  const collector = new BlockCollector();
  let line = 1;
  for (const paragraph of text.split(/\n{2,}/)) {
    const body = paragraph.trim();
    const lines = paragraph.split("\n").length;
    if (body) {
      collector.push({
        type: "paragraph",
        text: body,
        // RTF has no page geometry a reader can rely on, so the locator is the
        // line range — the same one the text extractor cites for source files.
        path: input.fileName,
        lineStart: line,
        lineEnd: line + lines - 1,
        heading: [],
        confidence: 1,
      });
    }
    line += lines + 1;
  }

  const blocks = collector.done();
  if (!blocks.length) {
    return { ...base, status: "degraded", blocks: [], reason: "This RTF file contains no readable text." };
  }
  return { ...base, status: "ok", blocks };
}
