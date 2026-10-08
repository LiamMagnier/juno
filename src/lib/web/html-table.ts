/**
 * HTML tables as Markdown tables, so a figure keeps its row and its column.
 *
 * The linear extractor used to turn every `<td>` into a space. A pricing
 * table came out as "Price per seat $0 $12 /mo $24 /mo Contact sales": the
 * figures survived, the plans they belong to did not, and a cell spanning
 * two plans ("6,000" for Business AND Enterprise) silently belonged to one.
 * A worker quoting that line, or the writer packing it, had to guess which
 * number was whose. This module receives the cells the extractor collected
 * (it never sees markup) and lays them out on a grid: `colspan` repeats a
 * value across the columns it covers, `rowspan` carries it down, a header row
 * becomes the Markdown header, and a key/value table without one (a spec
 * sheet) becomes a "- key: value" list instead of a table whose first data
 * row pretends to be a header. Layout tables — one column, one row, or cells
 * that are paragraphs — come back as plain paragraphs, as before.
 *
 * Pure and bounded: at most `MAX_TABLE_ROWS` × `MAX_TABLE_COLUMNS` cells of
 * `MAX_CELL_CHARS` each, whatever the page declares in its span attributes.
 */

export interface TableCell {
  text: string;
  header: boolean;
  colspan: number;
  rowspan: number;
}

export interface TableRow {
  cells: TableCell[];
  /** The row sits in a `<thead>`. */
  head: boolean;
}

export const MAX_TABLE_ROWS = 300;
export const MAX_TABLE_COLUMNS = 24;
export const MAX_CELL_CHARS = 400;
/** A span attribute larger than this is a layout trick, not data. */
export const MAX_SPAN = 12;
/** Average cell length above which a "table" is page layout holding prose. */
const LAYOUT_CELL_CHARS = 220;

/** A span attribute's value, clamped to [1, MAX_SPAN]. */
export function spanOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 1 ? Math.min(n, MAX_SPAN) : 1;
}

/** One cell's text, on one line, safe inside a Markdown table. */
export function cellText(raw: string): string {
  const flat = raw
    .replace(/\s+/g, " ")
    .replace(/(?:^|\s)#{2,3}\s/g, " ")
    .trim();
  const cut = flat.length > MAX_CELL_CHARS ? `${flat.slice(0, MAX_CELL_CHARS - 1).trimEnd()}…` : flat;
  return cut.replace(/\|/g, "\\|");
}

/** The rows on a rectangular grid, spans resolved. `header[r]` says whether row r is all headers. */
function toGrid(rows: readonly TableRow[]): { grid: string[][]; headerRow: boolean[]; firstColumnHeaders: boolean } {
  const grid: string[][] = [];
  const headerRow: boolean[] = [];
  /** Column → the value still spanning down into later rows, and for how many. */
  const carry = new Map<number, { text: string; left: number }>();
  let rowHeadCount = 0;
  let dataRows = 0;
  for (const row of rows.slice(0, MAX_TABLE_ROWS)) {
    const out: string[] = [];
    let col = 0;
    const fillCarry = () => {
      for (let held = carry.get(col); held && col < MAX_TABLE_COLUMNS; held = carry.get(col)) {
        out[col] = held.text;
        held.left -= 1;
        if (held.left <= 0) carry.delete(col);
        col += 1;
      }
    };
    for (const cell of row.cells) {
      fillCarry();
      for (let k = 0; k < cell.colspan && col < MAX_TABLE_COLUMNS; k += 1, col += 1) {
        out[col] = cell.text;
        if (cell.rowspan > 1) carry.set(col, { text: cell.text, left: Math.min(cell.rowspan, MAX_TABLE_ROWS) - 1 });
      }
    }
    // Spans that reach past the row's last cell.
    for (const [at, held] of [...carry.entries()].sort((a, b) => a[0] - b[0])) {
      if (at < col || out[at] !== undefined) continue;
      out[at] = held.text;
      held.left -= 1;
      if (held.left <= 0) carry.delete(at);
    }
    const allHeaders = row.cells.length > 0 && row.cells.every((cell) => cell.header);
    headerRow.push(row.head || allHeaders);
    if (!row.head && !allHeaders) {
      dataRows += 1;
      if (row.cells[0]?.header && row.cells.slice(1).every((cell) => !cell.header)) rowHeadCount += 1;
    }
    grid.push(Array.from({ length: Math.max(out.length, 0) }, (_, i) => out[i] ?? ""));
  }
  return { grid, headerRow, firstColumnHeaders: dataRows > 0 && rowHeadCount === dataRows };
}

/**
 * The Markdown for one table, or `null` when it is page layout (the caller
 * then writes the cells as paragraphs). Leading and trailing blank lines are
 * the caller's to add.
 */
export function renderTable(rows: readonly TableRow[]): string | null {
  const kept = rows.filter((row) => row.cells.some((cell) => cell.text));
  if (kept.length === 0) return null;
  const { grid, headerRow, firstColumnHeaders } = toGrid(kept);
  const width = Math.min(MAX_TABLE_COLUMNS, Math.max(...grid.map((row) => row.length)));
  // Columns nothing ever filled are dropped (spacer cells).
  const used = Array.from({ length: width }, (_, c) => grid.some((row) => (row[c] ?? "") !== ""));
  const squared = grid.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? "").filter((_, c) => used[c]));
  const columns = used.filter(Boolean).length;
  if (columns <= 1 || squared.length <= 1) return null;
  const cells = squared.flat().filter(Boolean);
  if (cells.reduce((n, cell) => n + cell.length, 0) / Math.max(1, cells.length) > LAYOUT_CELL_CHARS) return null;

  const headerAt = headerRow.findIndex(Boolean);
  // A key/value table with no header row: a spec sheet. A list, not a table
  // whose first data row would pose as the column names.
  if (headerAt < 0 && columns === 2) {
    return squared
      .map(([key, value]) => (key && value ? `- ${key}: ${value}` : `- ${key || value}`))
      .join("\n");
  }
  let header: string[];
  let body: string[][];
  if (headerAt >= 0) {
    // Several header rows (a group row above a plan row): joined per column.
    const heads = squared.filter((_, r) => headerRow[r]);
    header = Array.from({ length: columns }, (_, c) => {
      const parts: string[] = [];
      for (const head of heads) if (head[c] && parts[parts.length - 1] !== head[c]) parts.push(head[c]!);
      return parts.join(" — ");
    });
    body = squared.filter((_, r) => !headerRow[r]);
  } else {
    header = squared[0]!;
    body = squared.slice(1);
  }
  if (body.length === 0) return null;
  // The corner cell of a row-headed table names the row labels' column.
  if (firstColumnHeaders && !header[0]) header[0] = " ";
  const line = (row: readonly string[]) => `| ${row.map((cell) => cell || " ").join(" | ")} |`;
  return [line(header), `|${" --- |".repeat(columns)}`, ...body.map(line)].join("\n");
}

/** A layout table's cells as paragraphs, in reading order. */
export function tableAsParagraphs(rows: readonly TableRow[]): string {
  return rows
    .map((row) => row.cells.map((cell) => cell.text.replace(/\\\|/g, "|")).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n\n");
}
