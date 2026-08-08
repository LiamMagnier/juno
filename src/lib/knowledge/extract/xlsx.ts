/**
 * .xlsx → one block per row, plus one block per formula cell.
 *
 * A spreadsheet is the format where the locator matters most, because a number
 * on its own is never an answer: "34" is worthless, "Revenue!B2 = A2*2 → 34" is
 * citable. So every block here carries the sheet name and an A1 range, and
 * formula cells are indexed a second time with their formula text — that is how
 * "where does the total come from?" becomes findable at all.
 *
 * Rows are prefixed with their column headers ("Quarter: Q1 | Total: 34") for
 * the same reason a Word table is kept whole: a retrieved row arrives without
 * the header row above it, and an unlabelled row of numbers cannot be read.
 *
 * `exceljs` does the reading. It is already a dependency (`src/lib/office-export.ts`
 * writes workbooks with it) and it resolves the two things a hand-rolled
 * SpreadsheetML reader gets wrong first: the shared-string table, and the cached
 * result stored alongside a formula.
 */

import { Workbook } from "exceljs";
import { openOoxml } from "./ooxml";
import { BlockCollector, EXTRACT_LIMITS, type ExtractionResult } from "./types";

export const XLSX_PARSER = "xlsx";
export const XLSX_PARSER_VERSION = "1";

/** Rows read per sheet. Past this a workbook is a database, not a document. */
const MAX_ROWS_PER_SHEET = 5_000;

function columnOf(address: string): string {
  return address.replace(/\d+$/, "");
}

export async function extractXlsx(input: { bytes: Uint8Array; fileName: string }): Promise<ExtractionResult> {
  const base = { parser: XLSX_PARSER, parserVersion: XLSX_PARSER_VERSION };

  // Checked before exceljs sees the bytes purely for the error message: exceljs
  // reports a legacy .xls or an encrypted workbook as an unhelpful zip error,
  // and "save it as an unprotected .xlsx" is something a user can act on.
  const opened = await openOoxml(input.bytes);
  if (!opened.ok) return { ...base, status: "failed", blocks: [], reason: opened.reason };
  if (!opened.pkg.names.includes("xl/workbook.xml")) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This file is a ZIP archive but not a workbook — it has no xl/workbook.xml part.",
    };
  }

  const workbook = new Workbook();
  try {
    // `.slice()` copies into a buffer whose byteOffset is 0. Passing
    // `bytes.buffer` directly would hand exceljs the *whole* backing store when
    // the upload arrived as a view into a larger read buffer.
    await workbook.xlsx.load(input.bytes.slice().buffer as ArrayBuffer);
  } catch (error) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: `This workbook could not be read: ${error instanceof Error ? error.message : "the file is unreadable"}.`,
    };
  }

  const collector = new BlockCollector();
  let sheets = 0;
  let truncatedRows = false;
  let missingResults = 0;

  for (const sheet of workbook.worksheets) {
    if (sheets >= EXTRACT_LIMITS.maxSections) {
      truncatedRows = true;
      break;
    }
    sheets += 1;
    const sheetName = sheet.name;
    // Column letter → header text, learned from the first row that has content.
    const headers = new Map<string, string>();
    let sawHeaderRow = false;
    let rowsRead = 0;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rowsRead >= MAX_ROWS_PER_SHEET) {
        truncatedRows = true;
        return;
      }
      rowsRead += 1;

      const parts: string[] = [];
      const addresses: string[] = [];

      row.eachCell({ includeEmpty: false }, (cell) => {
        const address = String(cell.address);
        const displayed = String(cell.text ?? "").trim();
        const formula = typeof cell.formula === "string" ? cell.formula : null;

        if (formula) {
          // The cached result is what the spreadsheet *shows*. A workbook saved
          // by a tool that does not evaluate formulas has none, and claiming a
          // value we did not read would be the worst possible failure here.
          const hasResult = cell.result !== undefined && cell.result !== null && displayed !== "";
          if (!hasResult) missingResults += 1;
          collector.push({
            type: "table_cell",
            text: hasResult ? `${address} = ${formula} → ${displayed}` : `${address} = ${formula} (no calculated value stored)`,
            sheet: sheetName,
            cellRange: address,
            heading: [sheetName],
            confidence: 1,
          });
        }

        if (!displayed) return;
        addresses.push(address);
        const header = sawHeaderRow ? headers.get(columnOf(address)) : undefined;
        parts.push(header ? `${header}: ${displayed}` : displayed);
        if (!sawHeaderRow) headers.set(columnOf(address), displayed);
      });

      if (!addresses.length) return;
      const cellRange =
        addresses.length === 1 ? addresses[0] : `${addresses[0]}:${addresses[addresses.length - 1]}`;
      collector.push({
        type: "table",
        text: parts.join(" | "),
        sheet: sheetName,
        cellRange,
        heading: [sheetName],
        confidence: 1,
      });
      sawHeaderRow = true;
    });
  }

  const blocks = collector.done();
  if (!blocks.length) {
    return {
      ...base,
      status: "degraded",
      blocks: [],
      pageCount: sheets,
      reason: sheets
        ? "Every sheet in this workbook is empty, so there was nothing to index."
        : "This workbook has no sheets.",
    };
  }

  const truncated = truncatedRows || collector.hitLimit;
  const reason = truncated
    ? "This workbook is larger than Juno's indexing limit, so only its first rows were indexed."
    : missingResults > 0
      ? `${missingResults} formula${missingResults === 1 ? "" : "s"} in this workbook have no calculated value stored, so only the formula itself was indexed. Open and re-save the file in Excel or Numbers to fix that.`
      : undefined;

  return { ...base, status: reason ? "degraded" : "ok", blocks, pageCount: sheets, reason };
}
