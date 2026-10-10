/**
 * Table and value parsing for the official pages `models:sync` reads.
 *
 * Every lab publishes its prices and lifecycle as a table, in one of three
 * shapes: a Markdown pipe table, an HTML <table> (often with rowspans) inside
 * a Markdown file, or a JSX `rows={[...]}` literal. These helpers turn each
 * into the same `Table` so the per-lab parsers only decide which column means
 * what. Nothing here guesses: a cell that does not read cleanly as a price or
 * a date comes back `null`, and the caller records the field as unverified.
 */

export interface Table {
  /** The nearest Markdown heading above the table ("" when none). */
  heading: string;
  headers: string[];
  rows: string[][];
}

/** Collapse Markdown/HTML decoration to the plain text a reader sees. */
export function cellText(raw: string): string {
  return raw
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "") // tags only: "<= 200k ... >" is text
    .replace(/\{\/\*.*?\*\/\}/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](href) -> label
    .replace(/~~[^~]*~~/g, "") // struck-through (superseded) values
    .replace(/\\([$<>*_|\\])/g, "$1")
    .replace(/\^\\?\*+\^|\^[^^]*\^/g, "") // ^*^ footnote marks
    .replace(/\*\*|__|`/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map(cellText);
}

const SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Every Markdown pipe table in `text`, with the heading it sits under. */
export function parseMarkdownTables(text: string): Table[] {
  const lines = text.split(/\r?\n/);
  const tables: Table[] = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) {
      heading = cellText(h[1]);
      continue;
    }
    if (!line.trim().startsWith("|") || !SEPARATOR_RE.test(lines[i + 1] ?? "")) continue;
    const headers = splitPipeRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) rows.push(splitPipeRow(lines[j]));
    tables.push({ heading, headers, rows });
    i = j - 1;
  }
  return tables;
}

/**
 * Every HTML <table> in `text`, rowspans and colspans expanded so each row has
 * one cell per column. `heading` is the last Markdown heading before it.
 */
export function parseHtmlTables(text: string): Table[] {
  const tables: Table[] = [];
  const re = /<table[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index);
    const headingMatch = [...before.matchAll(/^\s*#{1,6}\s+(.*)$/gm)].pop();
    const heading = headingMatch ? cellText(headingMatch[1]) : "";
    const html = m[0];
    const rowHtml = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => r[0]);
    const grid: string[][] = [];
    const pending: Map<number, { text: string; left: number }> = new Map();
    let headers: string[] = [];
    for (const tr of rowHtml) {
      const cells = [...tr.matchAll(/<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi)];
      const isHeader = cells.length > 0 && cells.every((c) => c[1].toLowerCase() === "th");
      const row: string[] = [];
      let col = 0;
      const take = () => {
        while (pending.has(col)) {
          const p = pending.get(col)!;
          row[col] = p.text;
          p.left -= 1;
          if (p.left <= 0) pending.delete(col);
          col++;
        }
      };
      for (const c of cells) {
        take();
        const attrs = c[2];
        const text = cellText(c[3]);
        // HTML `rowspan="2"` and JSX `rowSpan={2}` alike.
        const rowspan = Number(attrs.match(/rowspan\s*=\s*["'{]?(\d+)/i)?.[1] ?? 1);
        const colspan = Number(attrs.match(/colspan\s*=\s*["'{]?(\d+)/i)?.[1] ?? 1);
        for (let k = 0; k < colspan; k++) {
          row[col] = text;
          if (rowspan > 1) pending.set(col, { text, left: rowspan - 1 });
          col++;
        }
      }
      take();
      if (isHeader && headers.length === 0) headers = row;
      else grid.push(row.map((x) => x ?? ""));
    }
    tables.push({ heading, headers, rows: grid });
  }
  return tables;
}

/** JSX `columns={[{ title: ... }]} rows={[[...], ...]}` tables (Kimi's DocTable). */
export function parseJsxDocTables(text: string): Table[] {
  const tables: Table[] = [];
  const re = /<DocTable([\s\S]*?)\]\}\s*\/>/g; // "</>" inside cells also contains "/>"
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[1];
    const before = text.slice(0, m.index);
    const headingMatch = [...before.matchAll(/^\s*#{1,6}\s+(.*)$/gm)].pop();
    const headers = [...body.matchAll(/title:\s*"([^"]*)"/g)].map((t) => t[1]);
    const rowsBlock = body.slice(body.indexOf("rows={"));
    const rows = [...rowsBlock.matchAll(/^\s*\[(.*)\],?\s*$/gm)].map((r) =>
      splitTopLevel(r[1]).map((cell) =>
        cellText(cell.replace(/<>\{"\$"\}/g, "$").replace(/<\/?>/g, "").replace(/^"|"$/g, ""))
      )
    );
    tables.push({ heading: headingMatch ? cellText(headingMatch[1]) : "", headers, rows });
  }
  return tables;
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && s[i - 1] !== "\\") inStr = !inStr;
    if (!inStr) {
      if (ch === "<" || ch === "{" || ch === "[") depth++;
      if (ch === ">" || ch === "}" || ch === "]") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Index of the first header matching `re`, or -1. */
export function col(table: Table, re: RegExp): number {
  return table.headers.findIndex((h) => re.test(h));
}

/**
 * A USD amount per 1M tokens from a cell: "$0.10 / MTok", "\$1.4", "$2.00".
 * Returns null for anything that is not exactly one plain dollar figure at the
 * start of the cell ("Free", "-", "From $0.10", "$0.75 through ...").
 */
export function usd(cell: string | undefined): number | null {
  if (cell == null) return null;
  const s = cellText(cell);
  const m = s.match(/^\$\s?(\d+(?:\.\d+)?)(?:\s*(?:\/\s*(?:MTok|M tokens|1M tokens)|per 1M tokens))?\s*$/i);
  return m ? Number(m[1]) : null;
}

/** Every dollar figure in a cell, in order. */
export function allUsd(cell: string): number[] {
  return [...cellText(cell).matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
}

/** "Free" / "Free of charge" — a published zero, as opposed to a missing price. */
export function isFree(cell: string | undefined): boolean {
  return cell != null && /^free( of charge)?$/i.test(cellText(cell));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * A calendar date as "YYYY-MM-DD" from the spellings the labs use:
 * "October 7, 2026", "Oct 23, 2026", "2026-10-21", "October 21,2026",
 * "2026.10.21", "10/31/2026" (Mistral, US order). Null when it cannot tell.
 */
export function isoDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = cellText(raw);
  let m = s.match(/\b(\d{4})[-.](\d{1,2})[-.](\d{1,2})\b/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})\b/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase().slice(0, 3)];
    if (mon) return `${m[3]}-${String(mon).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  m = s.match(/\b(\d{1,2}):(\d{2}),?\s+([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/);
  if (m) {
    const mon = MONTHS[m[3].toLowerCase().slice(0, 3)];
    if (mon) return `${m[5]}-${String(mon).padStart(2, "0")}-${m[4].padStart(2, "0")}`;
  }
  m = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
}

/** "1M tokens" / "1,048,576 tokens" / "500k" / "1,050,000 context window" -> tokens. */
export function tokenCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = cellText(raw).replace(/,/g, "");
  const m = s.match(/(\d+(?:\.\d+)?)\s*([KkMm])?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]?.toLowerCase();
  return unit === "m" ? Math.round(n * 1_000_000) : unit === "k" ? Math.round(n * 1_000) : Math.round(n);
}

/** Shift a YYYY-MM-DD date by `days` (UTC, no Date parsing of local time). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}
