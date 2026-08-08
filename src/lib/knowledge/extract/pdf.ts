/**
 * .pdf → text blocks with real page numbers, without an npm dependency.
 *
 * There is no PDF library in this repo and adding one was not an option, so this
 * is a deliberately *narrow* parser: it reads text PDFs and it refuses, in
 * writing, to guess about everything else. What that buys is the locator —
 * "page 4" is the only citation a PDF reader can act on, and a flat text dump
 * cannot produce it.
 *
 * How it stays bounded and honest:
 *
 * - Objects are found by scanning for `N G obj`, not by trusting the xref table.
 *   Real-world PDFs have broken xrefs constantly (every incremental save is a
 *   chance to get it wrong), and a scan cannot be walked into a cycle.
 *   `/ObjStm` streams are inflated and their contained objects registered too,
 *   which is what makes PDF 1.5+ files (where the page tree usually lives inside
 *   an object stream) readable at all.
 * - Page order comes from the catalog's `/Pages` tree when it can be walked,
 *   with a visited-set against the cyclic `/Kids` a malicious file will contain.
 * - Text is reconstructed from the text matrix: show operators are grouped into
 *   lines by their y coordinate and into paragraphs by the gaps between those
 *   lines. That is where the `bbox` on each block comes from — it is measured,
 *   not invented.
 *
 * What the native parser knowingly does NOT do, and reports instead of faking:
 *
 * - No OCR in this pure parser. `extractDocument` owns the optional OCR fallback
 *   so this function stays deterministic and citable when tested in isolation.
 * - No CID font decoding beyond an embedded `/ToUnicode` CMap. A font with
 *   neither a standard encoding nor a ToUnicode map yields bytes that are glyph
 *   ids, not characters; emitting those would fill the index with convincing
 *   mojibake, so a page whose text fails the printability check is dropped and
 *   the document degrades.
 * - No encrypted files. Those are reported, not attempted.
 */

import { inflateSync, inflateRawSync } from "node:zlib";
import { BlockCollector, EXTRACT_LIMITS, type ExtractedBlock, type ExtractionResult } from "./types";

export const PDF_PARSER = "pdf";
export const PDF_PARSER_VERSION = "2-ocr1";

/** Ceilings. Every one of these is reachable from a 20 KB hand-written file. */
const MAX_OBJECTS = 100_000;
const MAX_TREE_NODES = 20_000;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_OPERATIONS = 2_000_000;

interface RawObject {
  /** Byte offset of the first byte after `obj`. */
  start: number;
  end: number;
  /** Latin-1 slice of the object body. For ObjStm members, the member text. */
  body: string;
  /** ObjStm members have no stream of their own. */
  inObjectStream: boolean;
}

/* -------------------------------------------------------------------------- */
/* Object layer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Latin-1 maps bytes 0..255 to code points 0..255, so string offsets are byte
 * offsets. Every other encoding would make `indexOf` results useless for
 * slicing the binary stream data back out.
 */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

function findObjects(source: string): Map<number, RawObject> {
  const objects = new Map<number, RawObject>();
  const pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (objects.size >= MAX_OBJECTS) break;
    const start = match.index + match[0].length;
    const end = source.indexOf("endobj", start);
    const body = source.slice(start, end < 0 ? Math.min(start + MAX_CONTENT_BYTES, source.length) : end);
    // Later definitions win: an incrementally saved PDF appends the newer
    // version of an object after the older one.
    objects.set(Number(match[1]), { start, end: end < 0 ? source.length : end, body, inObjectStream: false });
    // Objects cannot nest, so resume the scan after `endobj`. This is not an
    // optimisation: without it the regex walks *inside* compressed stream data,
    // where the bytes `12 0 obj` occur by chance often enough to overwrite a
    // real object with garbage.
    if (end >= 0) pattern.lastIndex = end + "endobj".length;
  }
  return objects;
}

function dictNumber(body: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(-?\\d+(?:\\.\\d+)?)(?![\\d.]*\\s+\\d+\\s+R)`).exec(body);
  return match ? Number(match[1]) : null;
}

function dictRef(body: string, key: string): number | null {
  const match = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(body);
  return match ? Number(match[1]) : null;
}

function dictName(body: string, key: string): string | null {
  const match = new RegExp(`/${key}\\s*/([A-Za-z0-9#]+)`).exec(body);
  return match ? match[1] : null;
}

/** The text inside `/Key [ ... ]`, brackets balanced. */
function dictArray(body: string, key: string): string | null {
  const at = new RegExp(`/${key}\\s*\\[`).exec(body);
  if (!at) return null;
  let depth = 0;
  for (let i = at.index + at[0].length - 1; i < body.length; i += 1) {
    if (body[i] === "[") depth += 1;
    else if (body[i] === "]") {
      depth -= 1;
      if (depth === 0) return body.slice(at.index + at[0].length, i);
    }
  }
  return null;
}

function refsIn(text: string): number[] {
  const out: number[] = [];
  const pattern = /(\d{1,10})\s+\d{1,5}\s+R\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) out.push(Number(match[1]));
  return out;
}

/** Raw (still encoded) stream payload of an object, or null when it has none. */
function rawStream(source: string, object: RawObject, objects: Map<number, RawObject>): Uint8Array | null {
  if (object.inObjectStream) return null;
  const at = object.body.indexOf("stream");
  if (at < 0) return null;
  let dataStart = object.start + at + "stream".length;
  if (source[dataStart] === "\r") dataStart += 1;
  if (source[dataStart] === "\n") dataStart += 1;

  let length = dictNumber(object.body.slice(0, at), "Length");
  if (length === null) {
    const ref = dictRef(object.body.slice(0, at), "Length");
    if (ref !== null) {
      const target = objects.get(ref);
      const parsed = target ? Number(/^\s*(\d+)/.exec(target.body)?.[1] ?? NaN) : NaN;
      if (Number.isFinite(parsed)) length = parsed;
    }
  }

  // `/Length` is frequently wrong (hand-edited files, broken generators), so it
  // is only trusted when `endstream` actually follows where it claims.
  const endAt = source.indexOf("endstream", dataStart);
  if (length === null || length < 0 || dataStart + length > source.length) {
    if (endAt < 0) return null;
    length = endAt - dataStart;
  } else {
    const after = source.slice(dataStart + length, dataStart + length + 20);
    if (!/^\s*endstream/.test(after)) {
      if (endAt < 0) return null;
      length = endAt - dataStart;
    }
  }
  if (length > MAX_CONTENT_BYTES) return null;

  const out = Buffer.from(source.slice(dataStart, dataStart + length), "latin1");
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * Decode a stream's filter chain, or give up.
 *
 * Only Flate is supported, because it is what content streams and object
 * streams actually use. `inflateRawSync` is the fallback for the surprisingly
 * common streams that omit the zlib header.
 */
function decodeStream(body: string, raw: Uint8Array): Uint8Array | null {
  const filter = dictName(body, "Filter");
  if (!filter) return raw;
  if (filter !== "FlateDecode" && filter !== "Fl") return null;
  // A predictor rearranges the inflated bytes; not undoing it would produce
  // subtly corrupt output, which is worse than declining.
  if (/\/Predictor\s+(\d+)/.test(body) && Number(/\/Predictor\s+(\d+)/.exec(body)?.[1] ?? 1) > 1) return null;
  try {
    return new Uint8Array(inflateSync(raw));
  } catch {
    try {
      return new Uint8Array(inflateRawSync(raw));
    } catch {
      return null;
    }
  }
}

/**
 * Register the objects packed inside `/Type /ObjStm` streams.
 *
 * From PDF 1.5 on this is where non-stream objects live by default, so without
 * this step the catalog and every page dictionary are simply invisible and every
 * modern PDF looks like it has no pages.
 */
function expandObjectStreams(source: string, objects: Map<number, RawObject>): void {
  for (const object of [...objects.values()]) {
    if (object.inObjectStream || !/\/Type\s*\/ObjStm/.test(object.body)) continue;
    const raw = rawStream(source, object, objects);
    if (!raw) continue;
    const decoded = decodeStream(object.body, raw);
    if (!decoded) continue;
    const text = Buffer.from(decoded).toString("latin1");
    const count = dictNumber(object.body, "N");
    const first = dictNumber(object.body, "First");
    if (count === null || first === null || count < 0 || count > MAX_OBJECTS) continue;

    const header = text.slice(0, first).trim().split(/\s+/);
    for (let i = 0; i < count && i * 2 + 1 < header.length; i += 1) {
      const num = Number(header[i * 2]);
      const offset = Number(header[i * 2 + 1]);
      if (!Number.isFinite(num) || !Number.isFinite(offset)) continue;
      if (objects.has(num)) continue;
      const nextOffset = i + 1 < count ? Number(header[(i + 1) * 2 + 1]) : NaN;
      const bodyStart = first + offset;
      const bodyEnd = Number.isFinite(nextOffset) ? first + nextOffset : text.length;
      objects.set(num, {
        start: 0,
        end: 0,
        body: text.slice(bodyStart, bodyEnd),
        inObjectStream: true,
      });
    }
  }
}

/** Page objects in reading order, walking the catalog's page tree. */
function pagesInOrder(objects: Map<number, RawObject>): { pages: number[]; fromTree: boolean } {
  let rootRef: number | null = null;
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Catalog/.test(object.body)) continue;
    rootRef = dictRef(object.body, "Pages");
    if (rootRef !== null) break;
  }

  if (rootRef !== null) {
    const pages: number[] = [];
    const seen = new Set<number>();
    const stack: number[] = [rootRef];
    let visited = 0;
    while (stack.length && visited < MAX_TREE_NODES) {
      const num = stack.pop();
      if (num === undefined || seen.has(num)) continue;
      seen.add(num);
      visited += 1;
      const object = objects.get(num);
      if (!object) continue;
      if (/\/Type\s*\/Page\b(?!s)/.test(object.body)) {
        pages.push(num);
        continue;
      }
      const kids = dictArray(object.body, "Kids");
      if (kids) {
        // Reversed, because the stack pops in reverse insertion order and
        // `/Kids` is already in display order.
        for (const kid of refsIn(kids).reverse()) stack.push(kid);
      }
    }
    if (pages.length) return { pages, fromTree: true };
  }

  // Fallback: object number order. Usually right, never guaranteed — the caller
  // degrades the document because of it.
  const pages = [...objects.entries()]
    .filter(([, object]) => /\/Type\s*\/Page\b(?!s)/.test(object.body))
    .map(([num]) => num)
    .sort((a, b) => a - b);
  return { pages, fromTree: false };
}

/* -------------------------------------------------------------------------- */
/* Content stream text                                                         */
/* -------------------------------------------------------------------------- */

interface TextRun {
  text: string;
  x: number;
  y: number;
  size: number;
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

/** PDF literal string: `(a \(b\) c)` with escapes and octal. */
function decodeLiteral(source: string, start: number): { text: string; next: number } {
  let depth = 1;
  let out = "";
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const esc = source[i + 1];
      i += 2;
      if (esc === "n") out += "\n";
      else if (esc === "r") out += "\r";
      else if (esc === "t") out += "\t";
      else if (esc === "b") out += "\b";
      else if (esc === "f") out += "\f";
      else if (esc === "\n") continue;
      else if (esc >= "0" && esc <= "7") {
        let octal = esc;
        while (octal.length < 3 && source[i] >= "0" && source[i] <= "7") {
          octal += source[i];
          i += 1;
        }
        out += String.fromCharCode(parseInt(octal, 8));
      } else out += esc;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { text: out, next: i + 1 };
    }
    out += ch;
    i += 1;
  }
  return { text: out, next: i };
}

function decodeHex(source: string, start: number): { text: string; next: number } {
  const end = source.indexOf(">", start);
  const digits = (end < 0 ? source.slice(start) : source.slice(start, end)).replace(/[^0-9a-fA-F]/g, "");
  // An even count of 4-hex-digit groups is the Identity-H signature. Treating
  // those bytes as single characters is what produces the classic "every other
  // character is a NUL" garbage, so they are decoded as UTF-16BE code units.
  const wide = digits.length % 4 === 0 && digits.length > 0;
  let out = "";
  const step = wide ? 4 : 2;
  for (let i = 0; i + step <= digits.length; i += step) {
    out += String.fromCharCode(parseInt(digits.slice(i, i + step), 16));
  }
  return { text: out, next: end < 0 ? source.length : end + 1 };
}

/**
 * Walk a content stream and return every shown string with the position the text
 * matrix put it at. Positions are what let the caller rebuild lines and
 * paragraphs; without them a two-column page interleaves into nonsense.
 */
function runsOfContent(content: string): { runs: TextRun[]; sawTextOperator: boolean } {
  const runs: TextRun[] = [];
  let textMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  let lineMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let fontSize = 12;
  let sawTextOperator = false;

  const stack: Array<string | number> = [];
  let arrayDepth = 0;
  let pendingArrayText = "";

  const show = (text: string) => {
    if (!text) return;
    runs.push({
      text,
      x: textMatrix[4],
      y: textMatrix[5],
      size: Math.abs(fontSize * (textMatrix[3] || 1)),
    });
  };

  let i = 0;
  let operations = 0;
  while (i < content.length && operations < MAX_OPERATIONS) {
    operations += 1;
    const ch = content[i];

    if (ch === "(") {
      const literal = decodeLiteral(content, i + 1);
      i = literal.next;
      if (arrayDepth > 0) pendingArrayText += literal.text;
      else stack.push(literal.text);
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const hex = decodeHex(content, i + 1);
      i = hex.next;
      if (arrayDepth > 0) pendingArrayText += hex.text;
      else stack.push(hex.text);
      continue;
    }
    if (ch === "[") {
      arrayDepth += 1;
      pendingArrayText = "";
      i += 1;
      continue;
    }
    if (ch === "]") {
      arrayDepth = Math.max(0, arrayDepth - 1);
      stack.push(pendingArrayText);
      i += 1;
      continue;
    }
    if (ch === "<" || ch === ">") {
      // A dictionary inside a content stream (inline image, marked content):
      // skipped wholesale, it carries no shown text.
      i += 2;
      continue;
    }
    if (/[\s/]/.test(ch)) {
      if (ch === "/") {
        const name = /^\/([^\s/[\]<>()]*)/.exec(content.slice(i));
        i += name ? name[0].length : 1;
        continue;
      }
      i += 1;
      continue;
    }

    const numberMatch = /^-?\d*\.?\d+/.exec(content.slice(i));
    if (numberMatch && /[\d.\-]/.test(ch)) {
      const value = Number(numberMatch[0]);
      i += numberMatch[0].length;
      if (arrayDepth > 0) {
        // Kerning, in thousandths of an em. A large negative shift is the
        // typesetter's way of writing a space; without this, whole paragraphs
        // arrive as one runtogetherword.
        if (value <= -120) pendingArrayText += " ";
      } else {
        stack.push(value);
      }
      continue;
    }

    const opMatch = /^[A-Za-z'"*]+/.exec(content.slice(i));
    if (!opMatch) {
      i += 1;
      continue;
    }
    const op = opMatch[0];
    i += op.length;
    const num = (back: number): number => {
      const value = stack[stack.length - back];
      return typeof value === "number" ? value : 0;
    };
    const str = (back: number): string => {
      const value = stack[stack.length - back];
      return typeof value === "string" ? value : "";
    };

    switch (op) {
      case "BT":
        sawTextOperator = true;
        textMatrix = [1, 0, 0, 1, 0, 0];
        lineMatrix = [1, 0, 0, 1, 0, 0];
        break;
      case "Tf":
        fontSize = num(1);
        break;
      case "TL":
        leading = num(1);
        break;
      case "Td":
        lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
        textMatrix = [...lineMatrix] as Matrix;
        break;
      case "TD":
        leading = -num(1);
        lineMatrix = multiply([1, 0, 0, 1, num(2), num(1)], lineMatrix);
        textMatrix = [...lineMatrix] as Matrix;
        break;
      case "Tm":
        lineMatrix = [num(6), num(5), num(4), num(3), num(2), num(1)];
        textMatrix = [...lineMatrix] as Matrix;
        break;
      case "T*":
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = [...lineMatrix] as Matrix;
        break;
      case "Tj":
      case "TJ":
        sawTextOperator = true;
        show(str(1));
        break;
      case "'":
        sawTextOperator = true;
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = [...lineMatrix] as Matrix;
        show(str(1));
        break;
      case '"':
        sawTextOperator = true;
        lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix);
        textMatrix = [...lineMatrix] as Matrix;
        show(str(1));
        break;
      default:
        break;
    }
    stack.length = 0;
  }

  return { runs, sawTextOperator };
}

/**
 * Is this text, or is it glyph indices wearing a text costume?
 *
 * A CID-keyed font with no `/ToUnicode` map hands us byte pairs that index into
 * the font, not Unicode. They decode into control characters and private-use
 * code points at a rate real prose never reaches, and indexing them would put
 * confident nonsense in front of the model. 0.8 is well clear of real text
 * (which sits above 0.98 even with heavy punctuation) and well clear of glyph
 * soup (which rarely clears 0.4).
 */
function printableRatio(text: string): number {
  if (!text.length) return 1;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127 && !(code >= 0xe000 && code <= 0xf8ff))) {
      printable += 1;
    }
  }
  return printable / [...text].length;
}

interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
}

/** Group runs sharing a baseline into lines, in reading order. */
function linesOf(runs: TextRun[]): Line[] {
  const lines: Line[] = [];
  for (const run of runs) {
    const last = lines[lines.length - 1];
    // Half a line height of vertical slack absorbs superscripts and the small
    // baseline jitter that kerned runs produce.
    if (last && Math.abs(last.y - run.y) <= Math.max(1, run.size * 0.4)) {
      const gap = run.x - (last.x + last.text.length * run.size * 0.5);
      last.text += gap > run.size * 0.25 && !/\s$/.test(last.text) ? ` ${run.text}` : run.text;
      continue;
    }
    lines.push({ text: run.text, x: run.x, y: run.y, size: run.size });
  }
  return lines;
}

/** Split lines into paragraphs wherever the vertical gap jumps. */
function paragraphsOf(lines: Line[]): Line[][] {
  if (!lines.length) return [];
  const gaps = lines.slice(1).map((line, index) => Math.abs(lines[index].y - line.y)).filter((g) => g > 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  // The LOWER median. With an even number of gaps the upper one is the outlier
  // we are trying to detect: a page of two body lines and one paragraph break
  // has gaps [14, 60], and picking 60 as "typical" makes the whole page one
  // paragraph — the exact case this function exists to split.
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const threshold = median > 0 ? median * 1.6 : Infinity;

  const paragraphs: Line[][] = [[lines[0]]];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = Math.abs(lines[i - 1].y - lines[i].y);
    if (gap > threshold) paragraphs.push([lines[i]]);
    else paragraphs[paragraphs.length - 1].push(lines[i]);
  }
  return paragraphs;
}

/* -------------------------------------------------------------------------- */

export function extractPdf(input: { bytes: Uint8Array; fileName: string }): ExtractionResult {
  const base = { parser: PDF_PARSER, parserVersion: PDF_PARSER_VERSION };
  const bytes = input.bytes;

  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This file is not a PDF — it does not start with a PDF header.",
    };
  }

  const source = latin1(bytes);
  // `/Encrypt` is a trailer key. Looking for it in the whole file would false-
  // positive on the bytes of any compressed stream, so only the trailer region
  // is checked — that is where a real encrypted document declares itself.
  const trailerAt = source.lastIndexOf("trailer");
  const trailer = trailerAt >= 0 ? source.slice(trailerAt) : source.slice(-4096);
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(trailer)) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This PDF is password-protected, so its text cannot be read. Remove the password and upload it again.",
    };
  }

  const objects = findObjects(source);
  if (!objects.size) {
    return { ...base, status: "failed", blocks: [], reason: "This PDF contains no readable objects — the file is damaged." };
  }
  try {
    expandObjectStreams(source, objects);
  } catch {
    // A malformed object stream costs us the objects inside it, nothing more.
  }

  const { pages, fromTree } = pagesInOrder(objects);
  if (!pages.length) {
    return { ...base, status: "failed", blocks: [], reason: "This PDF has no pages that Juno could read." };
  }

  const collector = new BlockCollector();
  const limited = pages.slice(0, EXTRACT_LIMITS.maxSections);
  let pagesUnreadable = 0;

  for (let index = 0; index < limited.length; index += 1) {
    const page = index + 1;
    const object = objects.get(limited[index]);
    if (!object) continue;

    const contentRefs = (() => {
      const direct = dictRef(object.body, "Contents");
      if (direct !== null) return [direct];
      const array = dictArray(object.body, "Contents");
      return array ? refsIn(array) : [];
    })();

    let content = "";
    for (const ref of contentRefs) {
      const stream = objects.get(ref);
      if (!stream) continue;
      const raw = rawStream(source, stream, objects);
      if (!raw) continue;
      const decoded = decodeStream(stream.body, raw);
      if (!decoded) {
        pagesUnreadable += 1;
        continue;
      }
      content += `\n${Buffer.from(decoded).toString("latin1")}`;
      if (content.length > MAX_CONTENT_BYTES) break;
    }
    if (!content) continue;

    const { runs, sawTextOperator } = runsOfContent(content);
    if (!runs.length) {
      // A page that draws only images is the signature of a scan.
      if (!sawTextOperator) pagesUnreadable += 1;
      continue;
    }
    const joined = runs.map((r) => r.text).join("");
    if (printableRatio(joined) < 0.8) {
      pagesUnreadable += 1;
      continue;
    }

    for (const paragraph of paragraphsOf(linesOf(runs))) {
      const text = paragraph.map((line) => line.text).join(" ");
      const xs = paragraph.map((l) => l.x);
      const ys = paragraph.map((l) => l.y);
      const height = paragraph[0].size;
      const block: ExtractedBlock = {
        type: "paragraph",
        text,
        page,
        path: input.fileName,
        heading: [],
        // Measured from the text matrix: [x, y, w, h] in PDF points, y at the
        // top of the block. Approximate in width because glyph advances are not
        // resolved, which is why nothing downstream should highlight with it —
        // it is a "roughly here on the page" hint.
        bbox: [
          Math.min(...xs),
          Math.max(...ys) + height,
          Math.max(...xs) - Math.min(...xs) + text.length * height * 0.5,
          Math.max(...ys) - Math.min(...ys) + height,
        ],
        // Read verbatim out of the content stream; nothing here was recognized
        // from an image.
        confidence: 1,
      };
      collector.push(block);
    }
  }

  const blocks = collector.done();
  if (!blocks.length) {
    return {
      ...base,
      status: "degraded",
      blocks: [],
      pageCount: pages.length,
      reason:
        pagesUnreadable > 0
          ? "This PDF has no text layer — it looks like a scan or an export of images. Juno cannot read text out of pictures yet, so nothing was indexed."
          : "No text could be read from this PDF.",
    };
  }

  const reasons: string[] = [];
  if (pagesUnreadable > 0) {
    reasons.push(
      `${pagesUnreadable} of ${limited.length} page${limited.length === 1 ? "" : "s"} had no readable text layer and were skipped — those pages are probably scans.`
    );
  }
  if (!fromTree) {
    reasons.push("This PDF's page tree could not be read, so page numbers follow the file's internal order and may not match the printed page numbers.");
  }
  if (pages.length > limited.length || collector.hitLimit) {
    reasons.push("This PDF is longer than Juno's indexing limit, so only its first pages were indexed.");
  }

  return {
    ...base,
    status: reasons.length ? "degraded" : "ok",
    blocks,
    pageCount: pages.length,
    reason: reasons.length ? reasons.join(" ") : undefined,
  };
}
