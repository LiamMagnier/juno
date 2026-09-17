/**
 * Reading a generated .xlsx back, so a sheet can be looked at without Excel.
 *
 * `work-site-preview.tsx` used to say of the three Office kinds that they were
 * "outside this milestone rather than judged: nobody has argued them either way
 * here, so they are absent". This is the argument for one of them, and it is
 * short: exceljs is already in the tree and already WROTE the file, its reader
 * is the same library, and a spreadsheet is a grid — the one document shape
 * that survives being rendered as a plain table with nothing lost that a
 * reviewer was going to check. That is not true of the other two. A .docx laid
 * out by hand is wrong wherever the document is interesting (tables, sections,
 * numbering, anything floated) and a deck without its layout is a list of
 * bullet points, so both keep the download they have.
 *
 * ── Why the file is re-read rather than the spec re-rendered ────────────────
 *
 * `buildSpreadsheet` is handed a typed spec, and it would be less work to keep
 * that spec and draw the table from it. It would also be a preview of what Juno
 * meant rather than of what it produced, which is exactly the distinction the
 * rest of this directory is built around: `validate.ts` re-opens the STORED
 * BYTES because "a verdict recorded against anything other than the stored
 * bytes is a verdict about a different file". A preview is a verdict a person
 * makes. It has to be about the same bytes the download hands them.
 *
 * ── The caps, and why they are not the sheet's own limits ───────────────────
 *
 * The builder admits 100,000 rows and 256 columns per sheet. Serialising that
 * as JSON and asking a browser to lay it out as one table is a tab that stops
 * responding, so the preview is a window onto the top-left of each sheet and
 * says how much it left out. A truncated preview that says so is useful; an
 * untruncated one that hangs is not a preview at all.
 *
 * No `import "server-only"`, for the reason the rest of this directory gives:
 * the marker would make the module unimportable from `tsx --test`, and a test
 * that cannot open the file it generated proves nothing. The import graph is
 * what keeps exceljs out of a client bundle — the only importers are the Node
 * route handler and the tests.
 */

import { Workbook } from "exceljs";

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

/**
 * One cell as the reader would see it, not as it is stored.
 *
 * Dates are the case that matters. exceljs hands back a `Date`, and
 * `String(date)` is a locale- and timezone-dependent sentence; the ISO date is
 * what the spec put in and what every reader can compare. Formulas cannot occur
 * — `buildSpreadsheet` refuses to write one, deliberately — but a workbook can
 * still arrive here having been produced by an older build, so the cached
 * result is preferred over the formula text.
 */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("result" in record) return cellText(record.result);
    if ("text" in record) return cellText(record.text);
    if ("richText" in record && Array.isArray(record.richText)) {
      return record.richText.map((part) => cellText((part as { text?: unknown }).text)).join("");
    }
    if ("hyperlink" in record) return cellText(record.hyperlink);
    // An object shape this build does not know is reported as empty rather than
    // as "[object Object]": a reader can act on a blank cell, and cannot act on
    // a cell that claims to hold a JavaScript value.
    return "";
  }
  return String(value);
}

function clip(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > PREVIEW_MAX_CELL_CHARS
    ? `${flattened.slice(0, PREVIEW_MAX_CELL_CHARS - 1)}…`
    : flattened;
}

/**
 * The top-left of every sheet in a stored workbook.
 *
 * Throws whatever exceljs throws on bytes that are not a workbook. The caller
 * is a route that already knows the difference between "this is not a
 * spreadsheet" and "Juno cannot read its own file", and swallowing the
 * distinction here would hand the reader an empty table for both.
 */
export async function buildSpreadsheetPreview(bytes: Uint8Array): Promise<SpreadsheetPreview> {
  const workbook = new Workbook();
  /*
   * The array is passed through rather than copied into an ArrayBuffer. The
   * route has already buffered these bytes once to check the hash, and a 50 MB
   * workbook must not be held twice for a preview of its first two hundred
   * rows.
   *
   * The cast is exceljs own type declaration rather than a hole here. Its
   * index.d.ts declares a module-local `interface Buffer extends ArrayBuffer`,
   * which nothing Node produces satisfies; the implementation hands whatever it
   * is given to JSZip, which reads a Uint8Array. Written through the parameter
   * type rather than a name, so a version of the library that tightens this is
   * a compile error here instead of a runtime one.
   */
  type XlsxInput = Parameters<Workbook["xlsx"]["load"]>[0];
  await workbook.xlsx.load(bytes as unknown as XlsxInput);

  const worksheets = workbook.worksheets;
  const sheets: SpreadsheetPreviewSheet[] = [];
  for (const worksheet of worksheets.slice(0, PREVIEW_MAX_SHEETS)) {
    const rowCount = worksheet.rowCount;
    const columnCount = worksheet.columnCount;
    const takeRows = Math.min(rowCount, PREVIEW_MAX_ROWS);
    const takeColumns = Math.min(columnCount, PREVIEW_MAX_COLUMNS);

    const rows: string[][] = [];
    for (let rowNumber = 1; rowNumber <= takeRows; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const cells: string[] = [];
      for (let columnNumber = 1; columnNumber <= takeColumns; columnNumber++) {
        cells.push(clip(cellText(row.getCell(columnNumber).value)));
      }
      rows.push(cells);
    }

    sheets.push({
      name: worksheet.name,
      rows,
      omittedRows: Math.max(0, rowCount - takeRows),
      omittedColumns: Math.max(0, columnCount - takeColumns),
    });
  }

  return { sheets, omittedSheets: Math.max(0, worksheets.length - sheets.length) };
}

/**
 * What a reader is told about what the preview left out.
 *
 * One sentence or none — never a row of counters. Pure and exported so the
 * wording is pinned by a test rather than by whoever last edited the component.
 */
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
