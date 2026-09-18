/**
 * The SHAPE of a spreadsheet preview, with no reader behind it.
 *
 * This file exists for one reason: `spreadsheet-preview.ts` opens with
 * `import { Workbook } from "exceljs"`, and a `"use client"` component was
 * importing the preview TYPE and one string helper from it. Types vanish at
 * compile time but the module specifier does not, so the bundler followed the
 * edge and pulled exceljs — 911 KB raw, ~256 KB gzipped, a Node workbook WRITER
 * — into the browser bundle of /chat, where nothing can ever call it.
 *
 * It was the single largest chunk the app shipped. The comment in the reader
 * even claims that "the only importers are the Node route handlers" is what
 * keeps exceljs out of the client — true when it was written, and quietly
 * false once a preview component wanted the type.
 *
 * So the contract lives here, importable from anywhere, and the reader keeps
 * the dependency to itself. `spreadsheet-preview.ts` re-exports all of it, so
 * every existing import still resolves; the client one points here directly.
 */

/** How many sheets a preview carries. Beyond this it names the rest. */
export const PREVIEW_MAX_SHEETS = 8;
/** Rows per sheet, header included. */
export const PREVIEW_MAX_ROWS = 200;
/** Columns per sheet. */
export const PREVIEW_MAX_COLUMNS = 40;
/**
 * Characters per cell in the preview.
 *
 * Far below Excel's own 32,767. A cell holding a page of text is legitimate in
 * the file and unreadable in a table row, and sending a hundred of them is how
 * a "preview" becomes a larger download than the document.
 */
export const PREVIEW_MAX_CELL_CHARS = 200;

export interface SpreadsheetPreviewSheet {
  name: string;
  /** Cells as text, already truncated. Ragged rows are padded by the renderer. */
  rows: string[][];
  /** Rows in the sheet beyond the ones carried here. */
  omittedRows: number;
  /** Columns in the sheet beyond the ones carried here. */
  omittedColumns: number;
}

export interface SpreadsheetPreview {
  sheets: SpreadsheetPreviewSheet[];
  /** Sheets in the workbook beyond the ones carried here. */
  omittedSheets: number;
}

/** "12 more rows and 3 more columns in the file." — or null when nothing was cut. */
export function describePreviewOmissions(sheet: SpreadsheetPreviewSheet): string | null {
  const parts: string[] = [];
  if (sheet.omittedRows > 0) {
    parts.push(sheet.omittedRows === 1 ? "1 more row" : `${sheet.omittedRows} more rows`);
  }
  if (sheet.omittedColumns > 0) {
    parts.push(
      sheet.omittedColumns === 1 ? "1 more column" : `${sheet.omittedColumns} more columns`
    );
  }
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} in the file. Download it to see everything.`;
}
