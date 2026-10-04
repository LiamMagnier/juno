/**
 * A1 addresses, columns and ranges.
 *
 * Columns and rows are 1-based everywhere in this module, the way a person and
 * Excel count them. Bounds are Excel's own, so an address that is valid here is
 * one Excel will open.
 */

export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;

export interface CellAddress {
  col: number;
  row: number;
}

export interface RangeAddress {
  start: CellAddress;
  end: CellAddress;
}

/** 1 -> A, 27 -> AA. */
export function columnLetter(col: number): string {
  let n = col;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** A -> 1, AA -> 27. Returns NaN for anything that is not letters. */
export function columnNumber(letters: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return Number.NaN;
  let n = 0;
  for (const char of letters.toUpperCase()) n = n * 26 + (char.charCodeAt(0) - 64);
  return n;
}

const CELL_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

/** "B3" / "$B$3" -> { col: 2, row: 3 }, or null when it is not an in-bounds address. */
export function parseCell(text: string): CellAddress | null {
  const match = CELL_RE.exec(text.trim());
  if (!match) return null;
  const col = columnNumber(match[1]);
  const row = Number(match[2]);
  if (!Number.isFinite(col) || col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return null;
  return { col, row };
}

export function cellKey(address: CellAddress): string {
  return `${columnLetter(address.col)}${address.row}`;
}

/** "A1:B3" (either corner order) -> normalised range; a single cell is a 1x1 range. */
export function parseRange(text: string): RangeAddress | null {
  const parts = text.trim().split(":");
  if (parts.length > 2) return null;
  const a = parseCell(parts[0]);
  const b = parts.length === 2 ? parseCell(parts[1]) : a;
  if (!a || !b) return null;
  return normalizeRange({ start: a, end: b });
}

export function normalizeRange(range: RangeAddress): RangeAddress {
  return {
    start: { col: Math.min(range.start.col, range.end.col), row: Math.min(range.start.row, range.end.row) },
    end: { col: Math.max(range.start.col, range.end.col), row: Math.max(range.start.row, range.end.row) },
  };
}

export function rangeKey(range: RangeAddress): string {
  const a = cellKey(range.start);
  const b = cellKey(range.end);
  return a === b ? a : `${a}:${b}`;
}

export function rangeSize(range: RangeAddress): number {
  return (range.end.col - range.start.col + 1) * (range.end.row - range.start.row + 1);
}

export function inRange(address: CellAddress, range: RangeAddress): boolean {
  return (
    address.col >= range.start.col &&
    address.col <= range.end.col &&
    address.row >= range.start.row &&
    address.row <= range.end.row
  );
}

/** Every address in the range, row by row. */
export function* eachCell(range: RangeAddress): Generator<CellAddress> {
  for (let row = range.start.row; row <= range.end.row; row++) {
    for (let col = range.start.col; col <= range.end.col; col++) yield { col, row };
  }
}

/** A sheet name as a formula writes it: quoted when it is not a plain identifier. */
export function quoteSheetName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !parseCell(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * "Model!B2:B13", "'Q1 plan'!A1", "B3" -> sheet name (or null for the current
 * sheet) and range. Used for chart ranges and defined names, which are stored
 * as text.
 */
export function parseQualifiedRange(text: string): { sheet: string | null; range: RangeAddress } | null {
  const trimmed = text.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang === -1) {
    const range = parseRange(trimmed);
    return range ? { sheet: null, range } : null;
  }
  let sheet = trimmed.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  const range = parseRange(trimmed.slice(bang + 1));
  if (!sheet || !range) return null;
  return { sheet, range };
}

export function qualifiedRange(sheet: string | null, range: RangeAddress, absolute = false): string {
  const corner = (address: CellAddress) =>
    absolute ? `$${columnLetter(address.col)}$${address.row}` : cellKey(address);
  const body =
    range.start.col === range.end.col && range.start.row === range.end.row
      ? corner(range.start)
      : `${corner(range.start)}:${corner(range.end)}`;
  return sheet ? `${quoteSheetName(sheet)}!${body}` : body;
}
