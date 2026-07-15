/**
 * Markdown -> real Office files (.docx / .xlsx / .pptx).
 *
 * Juno's models emit `<juno:artifact type="MARKDOWN">` blocks; this turns that
 * markdown into files a user can actually open. Tables become worksheets,
 * `---`/`## ` sections become slides, prose becomes a document.
 *
 * The input is model-authored, so it is assumed hostile: ragged tables, unclosed
 * fences, pipes inside code spans, mixed scripts. Nothing here may throw except
 * the single wrapped Error each builder raises, which the export route turns
 * into a 500.
 */

import "server-only";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { Workbook } from "exceljs";
import PptxGenJS from "pptxgenjs";

export type OfficeFormat = "docx" | "xlsx" | "pptx";

const OFFICE: Record<OfficeFormat, { contentType: string; extension: string }> = {
  docx: {
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: "docx",
  },
  xlsx: {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  pptx: {
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
};

export function contentTypeFor(f: OfficeFormat): string {
  return OFFICE[f].contentType;
}

export function extensionFor(f: OfficeFormat): string {
  return OFFICE[f].extension;
}

/* -------------------------------------------------------------------------- */
/* Block parsing                                                              */
/* -------------------------------------------------------------------------- */

type MarkdownTable = {
  /** Nearest preceding heading — the xlsx sheet name comes from this. */
  heading: string | null;
  header: string[];
  rows: string[][];
};

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; table: MarkdownTable }
  | { kind: "divider" };

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const DIVIDER_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET_RE = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED_RE = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;
const QUOTE_RE = /^ {0,3}>[ \t]?(.*)$/;
const SETEXT_H1_RE = /^ {0,3}=+[ \t]*$/;
const SETEXT_H2_RE = /^ {0,3}-+[ \t]*$/;

/** A single pathological table cannot be allowed to balloon the whole export. */
const MAX_TABLE_ROWS = 5000;

function startsBlock(line: string): boolean {
  return (
    line.trim() === "" ||
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    DIVIDER_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

/**
 * Split one table row on `|`.
 *
 * Backtick runs and `\|` are honoured, so ``| `a|b` |`` is one cell, not two —
 * models write pipes inside code spans constantly and a naive split shears the
 * row apart.
 */
function splitCells(line: string): string[] {
  const t = line.trim();
  const cells: string[] = [];
  let cur = "";
  let openTicks = 0;

  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (t[i + run] === "`") run++;
      // A code span closes only on a backtick run of the same length.
      if (openTicks === 0) openTicks = run;
      else if (openTicks === run) openTicks = 0;
      cur += "`".repeat(run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && openTicks === 0) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);

  // The outer pipes of `| a | b |` produce empty edge cells that aren't columns.
  if (t.startsWith("|")) cells.shift();
  if (cells.length > 0 && t.endsWith("|") && !t.endsWith("\\|")) cells.pop();

  return cells.map((c) => c.trim());
}

function isDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/**
 * Pad every row to the widest row seen.
 *
 * Widening rather than truncating: a ragged row with extra cells still carries
 * data the model meant to include, and docx requires a rectangular grid anyway.
 */
function rectangularise(header: string[], rows: string[][]): { header: string[]; rows: string[][] } {
  let width = header.length;
  for (const r of rows) width = Math.max(width, r.length);
  width = Math.max(width, 1);
  const pad = (r: string[]) => {
    const out = r.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  };
  return { header: pad(header), rows: rows.map(pad) };
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let heading: string | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = FENCE_RE.exec(lines[i]);
        // Closing fence must be the same char and at least as long as the opener.
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      // An unclosed fence simply swallows the rest of the document — same as every
      // markdown renderer, and it means we never fall through to nonsense parses.
      blocks.push({ kind: "code", lines: body });
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isDelimiterRow(lines[i + 1])) {
      const header = splitCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !FENCE_RE.test(lines[i])) {
        if (rows.length < MAX_TABLE_ROWS) rows.push(splitCells(lines[i]));
        i++;
      }
      const grid = rectangularise(header, rows);
      blocks.push({ kind: "table", table: { heading, header: grid.header, rows: grid.rows } });
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      const text = h[2];
      heading = text;
      blocks.push({ kind: "heading", level: h[1].length, text });
      i++;
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      blocks.push({ kind: "divider" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE_RE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const ordered = ORDERED_RE.exec(line);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const m = isOrdered ? ORDERED_RE.exec(lines[i]) : BULLET_RE.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i++;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    // Paragraph: accumulate lazy continuation lines.
    const para: string[] = [line];
    i++;
    let setext: number | null = null;
    while (i < lines.length) {
      const next = lines[i];
      // Setext underlines outrank the thematic-break reading of `---`, so this has
      // to be tested before startsBlock() sees it as a divider.
      if (SETEXT_H1_RE.test(next)) {
        setext = 1;
        i++;
        break;
      }
      if (SETEXT_H2_RE.test(next)) {
        setext = 2;
        i++;
        break;
      }
      if (startsBlock(next) || (isTableRow(next) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]))) {
        break;
      }
      para.push(next);
      i++;
    }
    const text = para.join(" ").trim();
    if (setext !== null) {
      heading = text;
      blocks.push({ kind: "heading", level: setext, text });
    } else if (text !== "") {
      blocks.push({ kind: "paragraph", text });
    }
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Inline parsing                                                             */
/* -------------------------------------------------------------------------- */

type RunStyle = { bold?: boolean; italics?: boolean; code?: boolean };
type InlineRun = RunStyle & { text: string };

// code span | **bold**/__bold__ | *italic*/_italic_ | [link](url) and ![img](url)
const INLINE_RE = /(`+)([\s\S]*?)\1|(\*\*|__)([\s\S]+?)\3|(\*|_)([\s\S]+?)\5|!?\[([^\]]*)\]\([^)]*\)/g;

/** Emphasis can nest, but only so far — a cap keeps adversarial `*_*_*…` bounded. */
const MAX_INLINE_DEPTH = 6;

function parseInline(src: string, style: RunStyle = {}, depth = 0): InlineRun[] {
  if (src === "") return [];
  if (depth >= MAX_INLINE_DEPTH) return [{ ...style, text: src }];

  const out: InlineRun[] = [];
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ ...style, text: src.slice(last, m.index) });
    if (m[1] !== undefined) {
      out.push({ ...style, code: true, text: m[2].trim() });
    } else if (m[3] !== undefined) {
      out.push(...parseInline(m[4], { ...style, bold: true }, depth + 1));
    } else if (m[5] !== undefined) {
      out.push(...parseInline(m[6], { ...style, italics: true }, depth + 1));
    } else {
      // Links flatten to their label; a .docx hyperlink adds nothing the reader needs.
      out.push(...parseInline(m[7] ?? "", style, depth + 1));
    }
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ ...style, text: src.slice(last) });

  return out.filter((r) => r.text !== "");
}

function stripInline(src: string): string {
  return parseInline(src)
    .map((r) => r.text)
    .join("");
}

/* -------------------------------------------------------------------------- */
/* detectFormats                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Which formats this content genuinely suits — the route offers only these.
 *
 * Deliberately conservative: a spreadsheet built from prose, or a deck built from
 * one unbroken essay, is worse than no button at all.
 */
export function detectFormats(markdown: string): OfficeFormat[] {
  if (typeof markdown !== "string" || markdown.trim() === "") return [];

  let blocks: Block[];
  try {
    blocks = parseBlocks(markdown);
  } catch {
    // Detection runs on every canvas open; a parse surprise must degrade, not 500.
    return ["docx"];
  }
  if (blocks.length === 0) return [];

  const formats: OfficeFormat[] = ["docx"];

  if (blocks.some((b) => b.kind === "table")) formats.push("xlsx");

  // Parsed blocks (not a raw text scan) so `---` and `## ` inside fenced code
  // don't advertise a deck that would come out empty.
  const hasDivider = blocks.some((b) => b.kind === "divider");
  const h2Count = blocks.filter((b) => b.kind === "heading" && b.level === 2).length;
  if (hasDivider || h2Count >= 2) formats.push("pptx");

  return formats;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * pptxgenjs's `write()` and exceljs's `writeBuffer()` are both typed loosely
 * (a union / an ArrayBuffer-ish alias) while returning a real Buffer at runtime.
 * Normalise once instead of casting at each call site.
 */
function toNodeBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new Error(`unexpected writer output: ${Object.prototype.toString.call(value)}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function cleanTitle(title: string): string {
  return typeof title === "string" ? title.trim() : "";
}

/** Flatten blocks to readable lines — the fallback body for a table-less xlsx. */
function plainLines(blocks: Block[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "heading":
        out.push(stripInline(b.text));
        break;
      case "paragraph":
        out.push(stripInline(b.text));
        break;
      case "list":
        for (const [n, item] of b.items.entries()) {
          out.push(`${b.ordered ? `${n + 1}.` : "•"} ${stripInline(item)}`);
        }
        break;
      case "quote":
        out.push(...b.lines.map((l) => `> ${stripInline(l)}`));
        break;
      case "code":
        out.push(...b.lines);
        break;
      case "table":
        out.push(b.table.header.map(stripInline).join(" | "));
        for (const r of b.table.rows) out.push(r.map(stripInline).join(" | "));
        break;
      case "divider":
        out.push("");
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* docx                                                                       */
/* -------------------------------------------------------------------------- */

const DOCX_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const MONO = "Consolas";
const ORDERED_REF = "juno-ordered";

function toTextRun(r: InlineRun): TextRun {
  return new TextRun({
    text: r.text,
    bold: r.bold,
    italics: r.italics,
    ...(r.code ? { font: MONO } : {}),
  });
}

function runsFor(text: string): TextRun[] {
  return parseInline(text).map(toTextRun);
}

function docxCell(text: string, header: boolean): TableCell {
  const runs = parseInline(text).map((r) => toTextRun(header ? { ...r, bold: true } : r));
  return new TableCell({
    children: [new Paragraph({ children: runs })],
    ...(header ? { shading: { fill: "F1F1F1" } } : {}),
  });
}

function docxTable(t: MarkdownTable): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        // Repeats the header on every page the table spills onto.
        tableHeader: true,
        children: t.header.map((h) => docxCell(h, true)),
      }),
      ...t.rows.map((row) => new TableRow({ children: row.map((c) => docxCell(c, false)) })),
    ],
  });
}

export async function toDocx(markdown: string, title: string): Promise<Buffer> {
  try {
    const blocks = parseBlocks(markdown);
    const children: (Paragraph | Table)[] = [];
    const heading = cleanTitle(title);

    // Skip the title when the body already opens with its own H1 — otherwise every
    // export leads with the same line twice.
    if (heading !== "" && !(blocks[0]?.kind === "heading" && blocks[0].level === 1)) {
      children.push(
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: heading })] })
      );
    }

    let orderedInstance = 0;

    for (const b of blocks) {
      switch (b.kind) {
        case "heading":
          children.push(
            new Paragraph({
              heading: DOCX_HEADINGS[Math.min(b.level, 6) - 1],
              children: runsFor(b.text),
            })
          );
          break;

        case "paragraph":
          children.push(new Paragraph({ children: runsFor(b.text) }));
          break;

        case "list": {
          // Every ordered list needs its own instance or Word continues the previous
          // list's count instead of restarting at 1.
          const instance = b.ordered ? orderedInstance++ : 0;
          for (const item of b.items) {
            children.push(
              new Paragraph({
                children: runsFor(item),
                ...(b.ordered
                  ? { numbering: { reference: ORDERED_REF, level: 0, instance } }
                  : { bullet: { level: 0 } }),
              })
            );
          }
          break;
        }

        case "quote":
          children.push(
            new Paragraph({
              children: parseInline(b.lines.join(" ")).map((r) => toTextRun({ ...r, italics: true })),
              indent: { left: 480 },
              border: {
                left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 12 },
              },
            })
          );
          break;

        case "code":
          for (const line of b.lines) {
            children.push(
              new Paragraph({
                // Word collapses an empty run, so a blank code line needs a space to
                // keep the block's vertical rhythm.
                children: [new TextRun({ text: line === "" ? " " : line, font: MONO })],
                spacing: { before: 0, after: 0 },
                shading: { fill: "F6F6F6" },
              })
            );
          }
          break;

        case "table":
          children.push(docxTable(b.table));
          // Two adjacent tables with nothing between them merge into one in Word.
          children.push(new Paragraph({ children: [] }));
          break;

        case "divider":
          children.push(new Paragraph({ thematicBreak: true, children: [] }));
          break;
      }
    }

    // A section with no children produces a document Word refuses to open.
    if (children.length === 0) children.push(new Paragraph({ children: [] }));

    const doc = new Document({
      title: heading || undefined,
      numbering: {
        config: [
          {
            reference: ORDERED_REF,
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } },
              },
            ],
          },
        ],
      },
      sections: [{ children }],
    });

    return await Packer.toBuffer(doc);
  } catch (err) {
    throw new Error(`Failed to build .docx from markdown: ${reason(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* xlsx                                                                       */
/* -------------------------------------------------------------------------- */

// Excel rejects these outright in a sheet name.
const SHEET_FORBIDDEN = /[:\\/?*[\]]/g;
const SHEET_NAME_MAX = 31;

function sheetName(raw: string, taken: Set<string>): string {
  let base = stripInline(raw).replace(SHEET_FORBIDDEN, " ").replace(/\s+/g, " ").trim();
  // Excel also refuses a name wrapped in apostrophes (it quotes names in formulas).
  base = base.replace(/^'+|'+$/g, "").trim();
  if (base === "") base = "Sheet";
  base = base.slice(0, SHEET_NAME_MAX).trimEnd() || "Sheet";

  // Duplicate names throw on open, and two `## Q1 Results` headings in one doc is
  // an ordinary thing for a model to write — suffix rather than fail the export.
  let name = base;
  let n = 2;
  while (taken.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = `${base.slice(0, SHEET_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

// Plain ASCII numerics only. `\d` in JS is [0-9] regardless of flags, so Eastern
// Arabic ("٣") and fullwidth ("３") digits fall through to text — which is right:
// Excel wouldn't read them as numeric either.
const NUMERIC_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// Thousands grouping in strict 3-digit runs. This assumes the en-US convention the
// models write in; "1.234" stays a decimal, never German thousands.
const GROUPED_RE = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const MAX_EXACT_DIGITS = 15;

/**
 * The one job that matters: a spreadsheet of strings is a failed export.
 *
 * Returns null for anything that isn't unambiguously a quantity.
 */
function asNumber(text: string): number | null {
  if (text === "") return null;

  let s = text;
  if (GROUPED_RE.test(s)) s = s.replace(/,/g, "");
  if (!NUMERIC_RE.test(s)) return null;

  const digits = s.replace(/^[+-]/, "");
  // "007", "00812" — a leading zero means an identifier (SKU, zip, phone ext), and
  // Excel would silently eat the zeros. Losing "007" is data corruption; keeping it
  // as text costs nothing. "0" and "0.5" are unaffected.
  if (/^0\d/.test(digits)) return null;

  // float64 holds 15 exact decimal digits; past that, storing a number rounds the
  // value. Anything that long is an account/order number, not a quantity.
  if (digits.replace(/\D/g, "").replace(/^0+/, "").length > MAX_EXACT_DIGITS) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cellValue(raw: string): string | number {
  const text = stripInline(raw);
  const n = asNumber(text);
  return n === null ? text : n;
}

/** Rough autofit — exceljs has no measure pass, so cap on the longest cell. */
function fitColumns(ws: import("exceljs").Worksheet, grid: string[][]): void {
  const width = grid[0]?.length ?? 0;
  for (let c = 0; c < width; c++) {
    let longest = 0;
    for (const row of grid) longest = Math.max(longest, (row[c] ?? "").length);
    ws.getColumn(c + 1).width = Math.min(Math.max(longest + 2, 10), 60);
  }
}

export async function toXlsx(markdown: string, title: string): Promise<Buffer> {
  try {
    const blocks = parseBlocks(markdown);
    const tables = blocks.flatMap((b) => (b.kind === "table" ? [b.table] : []));

    const wb = new Workbook();
    wb.creator = "Juno";
    const taken = new Set<string>();

    if (tables.length === 0) {
      // No tables: still hand back a readable book rather than an empty file.
      const ws = wb.addWorksheet(sheetName(cleanTitle(title) || "Document", taken));
      for (const line of plainLines(blocks)) ws.addRow([line]);
      ws.getColumn(1).width = 100;
    } else {
      for (const t of tables) {
        const ws = wb.addWorksheet(sheetName(t.heading ?? cleanTitle(title) ?? "", taken));
        const header = t.header.map(stripInline);
        ws.addRow(header);
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: "frozen", ySplit: 1 }];
        for (const row of t.rows) ws.addRow(row.map(cellValue));
        fitColumns(ws, [header, ...t.rows.map((r) => r.map(stripInline))]);
      }
    }

    return toNodeBuffer(await wb.xlsx.writeBuffer());
  } catch (err) {
    throw new Error(`Failed to build .xlsx from markdown: ${reason(err)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* pptx                                                                       */
/* -------------------------------------------------------------------------- */

type SlideLine = { text: string; bullet: boolean };

/** Past this a slide is unreadable anyway; a 1000-row table must not become 1000 bullets. */
const MAX_SLIDE_LINES = 40;

function splitSlides(blocks: Block[]): Block[][] {
  const groups: Block[][] = [];
  let cur: Block[] = [];

  if (blocks.some((b) => b.kind === "divider")) {
    for (const b of blocks) {
      if (b.kind === "divider") {
        groups.push(cur);
        cur = [];
      } else {
        cur.push(b);
      }
    }
  } else {
    for (const b of blocks) {
      // A new H2 opens a slide; anything before the first one is the intro slide.
      if (b.kind === "heading" && b.level <= 2 && cur.length > 0) {
        groups.push(cur);
        cur = [];
      }
      cur.push(b);
    }
  }
  groups.push(cur);

  return groups.filter((g) => g.length > 0);
}

function slideBody(blocks: Block[]): SlideLine[] {
  const lines: SlideLine[] = [];
  const push = (text: string, bullet: boolean) => {
    const t = text.trim();
    if (t !== "") lines.push({ text: t, bullet });
  };

  for (const b of blocks) {
    if (lines.length >= MAX_SLIDE_LINES) break;
    switch (b.kind) {
      case "heading":
        push(stripInline(b.text), false);
        break;
      case "paragraph":
        push(stripInline(b.text), false);
        break;
      case "list":
        for (const item of b.items) push(stripInline(item), true);
        break;
      case "quote":
        push(stripInline(b.lines.join(" ")), false);
        break;
      case "code":
        for (const l of b.lines) push(l, false);
        break;
      case "table":
        push(b.table.header.map(stripInline).join("  |  "), false);
        for (const r of b.table.rows) push(r.map(stripInline).join("  |  "), true);
        break;
      case "divider":
        break;
    }
  }

  if (lines.length > MAX_SLIDE_LINES) {
    lines.length = MAX_SLIDE_LINES;
    lines.push({ text: "…", bullet: false });
  }
  return lines;
}

export async function toPptx(markdown: string, title: string): Promise<Buffer> {
  try {
    const blocks = parseBlocks(markdown);
    const groups = splitSlides(blocks);
    const deckTitle = cleanTitle(title) || "Untitled";

    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.title = deckTitle;

    let added = 0;
    for (const group of groups) {
      const lead = group[0];
      const hasLeadHeading = lead?.kind === "heading";
      const slideTitle = hasLeadHeading ? stripInline(lead.text) : deckTitle;
      const body = slideBody(hasLeadHeading ? group.slice(1) : group);

      if (slideTitle.trim() === "" && body.length === 0) continue;

      const slide = pptx.addSlide();
      slide.addText(slideTitle || deckTitle, {
        x: 0.5,
        y: 0.35,
        w: 9,
        h: 0.8,
        fontSize: 28,
        bold: true,
      });
      // addText on an empty array throws; a title-only slide is legitimate.
      if (body.length > 0) {
        slide.addText(
          body.map((l) => ({ text: l.text, options: { bullet: l.bullet, breakLine: true } })),
          { x: 0.5, y: 1.4, w: 9, h: 3.8, fontSize: 14, valign: "top" }
        );
      }
      added++;
    }

    // pptxgenjs writes a corrupt file with zero slides.
    if (added === 0) {
      pptx.addSlide().addText(deckTitle, { x: 0.5, y: 2.4, w: 9, h: 1, fontSize: 32, bold: true });
    }

    return toNodeBuffer(await pptx.write({ outputType: "nodebuffer" }));
  } catch (err) {
    throw new Error(`Failed to build .pptx from markdown: ${reason(err)}`);
  }
}
