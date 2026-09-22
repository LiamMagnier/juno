import { Workbook } from "exceljs";
import type { ReaderBlock, ReaderSheet } from "@/lib/documents/reader-types";

/**
 * The reading view's pure half: extracted blocks → what the viewer draws, and
 * a workbook → grids. No database and no storage, so the shapes a real .docx,
 * .pptx and .xlsx produce can be asserted on in-process (see
 * tests/document-viewer.test.ts); `reader.ts` does the fetching around it.
 */

/** Blocks sent to a reading view. A 300-page report is ~6,000; past this it is a corpus. */
export const MAX_BLOCKS = 8_000;
/** Characters sent, so one pathological document cannot be a 40 MB response. */
const MAX_CHARS = 1_500_000;
const SHEET_LIMITS = { sheets: 12, rows: 1_000, columns: 60 } as const;

export function toReaderBlocks(
  rows: Array<{
    type: string;
    text: string;
    page?: number | null;
    slide?: number | null;
    sheet?: string | null;
    cellRange?: string | null;
    heading?: string[] | null;
  }>,
): { blocks: ReaderBlock[]; truncated: boolean } {
  const blocks: ReaderBlock[] = [];
  let chars = 0;
  let truncated = false;
  for (const row of rows) {
    if (blocks.length >= MAX_BLOCKS || chars >= MAX_CHARS) {
      truncated = true;
      break;
    }
    // A formula cell is indexed twice — as its row and again as
    // "B7 = SUM(…) → 42" so it is findable. On a page that second copy is noise.
    if (row.type === "table_cell") continue;
    const text = row.text;
    if (!text.trim()) continue;
    chars += text.length;
    blocks.push({
      type: row.type as ReaderBlock["type"],
      text,
      ...(row.page != null ? { page: row.page } : {}),
      ...(row.slide != null ? { slide: row.slide } : {}),
      ...(row.sheet ? { sheet: row.sheet } : {}),
      // The breadcrumb is the headings ABOVE this one, so its depth is the level.
      ...(row.type === "heading" ? { level: Math.min((row.heading?.length ?? 0) + 1, 6) } : {}),
    });
  }
  return { blocks, truncated };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).replace(/\s+$/, "");
}

/**
 * A workbook as grids of displayed values, bounded on every axis.
 *
 * `cell.text` is what the spreadsheet SHOWS — the formatted number, the cached
 * formula result — which is what a person reading it expects to see and to
 * quote. Trailing empty rows and columns are trimmed so a sheet with one
 * table in its corner is not drawn as a thousand empty cells.
 */
export async function readSheets(bytes: Uint8Array): Promise<{ sheets: ReaderSheet[]; truncated: boolean } | null> {
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  } catch {
    return null;
  }
  const sheets: ReaderSheet[] = [];
  let truncated = workbook.worksheets.length > SHEET_LIMITS.sheets;
  for (const sheet of workbook.worksheets.slice(0, SHEET_LIMITS.sheets)) {
    const rows: string[][] = [];
    let width = 0;
    const lastRow = Math.min(sheet.actualRowCount ? sheet.rowCount : 0, SHEET_LIMITS.rows);
    if (sheet.rowCount > SHEET_LIMITS.rows) truncated = true;
    for (let r = 1; r <= lastRow; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      const cellCount = Math.min(row.cellCount, SHEET_LIMITS.columns);
      if (row.cellCount > SHEET_LIMITS.columns) truncated = true;
      for (let c = 1; c <= cellCount; c++) {
        let text = "";
        try {
          text = cellText(row.getCell(c).text);
        } catch {
          text = "";
        }
        cells.push(text);
      }
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      width = Math.max(width, cells.length);
      rows.push(cells);
    }
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    sheets.push({ name: sheet.name, rows: rows.map((cells) => [...cells, ...Array(width - cells.length).fill("")]) });
  }
  return { sheets, truncated };
}

