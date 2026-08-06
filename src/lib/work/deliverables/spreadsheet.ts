/**
 * Typed spreadsheet specs -> a real .xlsx.
 *
 * The one thing that matters in a spreadsheet is that numbers are numbers. A
 * workbook whose figures are strings looks correct, sums to nothing, and is
 * discovered to be useless by whoever tries to chart it.
 *
 * `src/lib/office-export.ts` gets there by inference: `asNumber()` decides
 * whether a markdown cell is a quantity, and it has to guard leading zeros
 * (a SKU), sixteen-digit values (an order number) and thousands separators to
 * avoid corrupting identifiers into floats. Every one of those guards is a
 * heuristic that is right most of the time. Here there is nothing to infer —
 * the spec says `3` or it says `"007"`, and the two are different types before
 * they ever reach exceljs. That is why this is not a fork of office-export's
 * xlsx builder: the interesting half of that builder is the inference, and the
 * inference is the part a typed spec deletes rather than reuses. It stays in
 * place, unchanged, for the markdown path it was written for.
 *
 * String cells are written as strings, never as formulas, so a value that
 * begins with `=`, `+` or `@` stays the text it was — the spec has no way to
 * express a formula, which is deliberate: a generated formula is code the user
 * did not write executing in their spreadsheet.
 */

import { Workbook, type Worksheet } from "exceljs";
import { z } from "zod";
import { DeliverableError } from "@/lib/work/deliverables/validate";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Excel's own hard limit on the characters in one cell. */
const MAX_CELL_CHARS = 32_767;
/** Excel's own hard limit on a sheet name. */
const SHEET_NAME_MAX = 31;
const MAX_COLUMNS = 256;
const MAX_ROWS = 100_000;
const MAX_SHEETS = 64;

/** Excel rejects these outright in a sheet name. */
const SHEET_NAME_ALLOWED = /^[^:\\/?*[\]]+$/;

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/**
 * One cell, typed.
 *
 * `null` is an empty cell and is distinct from `""`: a blank in a numeric
 * column must not become a zero-length string, because Excel then treats the
 * column as text and every aggregate over it silently returns nothing.
 *
 * A date arrives as `{ date }` rather than as a string, for the same reason a
 * number arrives as a number. "2026-03-04" written into a cell is text on a
 * machine set to US format and a date on one set to ISO, and a workbook that
 * sorts correctly for the person who made it and wrongly for the person who
 * receives it is the worst version of this bug.
 */
export const cellValueSchema = z.union([
  z.string().max(MAX_CELL_CHARS),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.object({ date: z.string().datetime() }),
]);

export type CellValue = z.infer<typeof cellValueSchema>;

/**
 * How a column is displayed. The stored value is unaffected.
 *
 * Presentation is per column rather than per cell because a column whose cells
 * disagree about their format is a column no reader can scan, and because the
 * format is a property of what the column means, not of one row's value.
 */
export const COLUMN_FORMATS = ["text", "number", "integer", "currency", "percent", "date"] as const;
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];

const NUMBER_FORMATS: Record<ColumnFormat, string | null> = {
  text: "@",
  number: "#,##0.00",
  integer: "#,##0",
  currency: '"$"#,##0.00',
  percent: "0.0%",
  date: "yyyy-mm-dd",
};

export const spreadsheetColumnSchema = z.object({
  header: z.string().trim().min(1).max(200),
  format: z.enum(COLUMN_FORMATS).optional(),
  /** Character width. Omitted means "fit to the widest value seen". */
  width: z.number().int().min(4).max(200).optional(),
});

export const spreadsheetSheetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(SHEET_NAME_MAX)
    .regex(SHEET_NAME_ALLOWED, "A sheet name cannot contain : \\ / ? * [ or ]"),
  columns: z.array(spreadsheetColumnSchema).min(1).max(MAX_COLUMNS),
  rows: z.array(z.array(cellValueSchema)).max(MAX_ROWS),
  /** Keeps the header visible while scrolling. On by default because it always should be. */
  freezeHeader: z.boolean().optional(),
});

export type SpreadsheetSheetSpec = z.infer<typeof spreadsheetSheetSchema>;

export const spreadsheetSpecSchema = z.object({
  kind: z.literal("spreadsheet"),
  title: z.string().trim().min(1).max(300),
  sheets: z.array(spreadsheetSheetSchema).min(1).max(MAX_SHEETS),
});

export type SpreadsheetSpec = z.infer<typeof spreadsheetSpecSchema>;

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * pptxgenjs's `write()` and exceljs's `writeBuffer()` are both typed loosely
 * while returning a real Buffer at runtime. Normalised once rather than cast at
 * each call site — the same helper office-export.ts keeps for the same reason,
 * duplicated here only because that module does not export it and this
 * milestone may not edit it.
 */
export function toNodeBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  throw new DeliverableError(
    "build_failed",
    `Unexpected writer output: ${Object.prototype.toString.call(value)}`
  );
}

function isDateCell(value: CellValue): value is { date: string } {
  return typeof value === "object" && value !== null && "date" in value;
}

/**
 * The exceljs value for a typed cell.
 *
 * `null` is passed through as null so exceljs leaves the cell genuinely empty
 * rather than writing an empty string into it.
 */
function toCellValue(value: CellValue): string | number | boolean | Date | null {
  return isDateCell(value) ? new Date(value.date) : value;
}

/** Rough autofit — exceljs has no measure pass, so cap on the longest value. */
function fitColumn(sheet: Worksheet, index: number, header: string, rows: CellValue[][]): number {
  let longest = header.length;
  for (const row of rows) {
    const value = row[index];
    const text =
      value === null || value === undefined
        ? ""
        : isDateCell(value)
          ? value.date.slice(0, 10)
          : String(value);
    longest = Math.max(longest, text.length);
  }
  const width = Math.min(Math.max(longest + 2, 10), 60);
  sheet.getColumn(index + 1).width = width;
  return width;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the .xlsx bytes for a validated spec.
 *
 * Two cross-field rules are enforced here rather than in the schema, because
 * both are about how parts of the spec relate and both must refuse rather than
 * repair. A duplicate sheet name makes Excel refuse the whole workbook at open
 * time, and quietly suffixing it — which office-export.ts does, correctly, for
 * markdown headings it did not choose — would hand back a workbook whose sheets
 * are not the ones the caller believes it addressed. A row of the wrong width
 * puts values under the wrong headings, which is worse than an error because it
 * looks like data.
 */
export async function buildSpreadsheet(spec: SpreadsheetSpec): Promise<Buffer> {
  const seen = new Set<string>();
  for (const sheet of spec.sheets) {
    // Excel compares sheet names case-insensitively, so "Q1" and "q1" collide.
    const key = sheet.name.toLowerCase();
    if (seen.has(key)) {
      throw new DeliverableError(
        "invalid_spec",
        `Two sheets are both named "${sheet.name}". Excel refuses a workbook with duplicate ` +
          `sheet names, and renaming one for you would move data to a sheet you did not ask for.`
      );
    }
    seen.add(key);
    if (sheet.name.startsWith("'") || sheet.name.endsWith("'")) {
      throw new DeliverableError(
        "invalid_spec",
        `Sheet name "${sheet.name}" starts or ends with an apostrophe, which Excel reserves for ` +
          `quoting sheet names in formulas.`
      );
    }
    for (const [index, row] of sheet.rows.entries()) {
      if (row.length !== sheet.columns.length) {
        throw new DeliverableError(
          "invalid_spec",
          `Sheet "${sheet.name}" row ${index + 1} has ${row.length} cells but declares ` +
            `${sheet.columns.length} columns. Rows are not padded, because a padded row files ` +
            `its values under the wrong headings.`
        );
      }
    }
  }

  try {
    const workbook = new Workbook();
    workbook.creator = "Juno";
    workbook.title = spec.title;
    workbook.created = new Date();

    for (const sheet of spec.sheets) {
      const worksheet = workbook.addWorksheet(sheet.name);
      worksheet.addRow(sheet.columns.map((column) => column.header));
      worksheet.getRow(1).font = { bold: true };
      if (sheet.freezeHeader !== false) {
        worksheet.views = [{ state: "frozen", ySplit: 1 }];
      }

      for (const row of sheet.rows) worksheet.addRow(row.map(toCellValue));

      for (const [index, column] of sheet.columns.entries()) {
        const worksheetColumn = worksheet.getColumn(index + 1);
        if (column.width !== undefined) worksheetColumn.width = column.width;
        else fitColumn(worksheet, index, column.header, sheet.rows);

        const format = column.format ? NUMBER_FORMATS[column.format] : null;
        // Applied from row 2 down so the bold header keeps the General format;
        // a header under a currency format renders as text Excel has tried and
        // failed to read as money.
        if (format) {
          for (let rowNumber = 2; rowNumber <= sheet.rows.length + 1; rowNumber++) {
            worksheet.getCell(rowNumber, index + 1).numFmt = format;
          }
        }
      }
    }

    return toNodeBuffer(await workbook.xlsx.writeBuffer());
  } catch (err) {
    if (err instanceof DeliverableError) throw err;
    throw new DeliverableError("build_failed", `Could not build the .xlsx: ${reason(err)}`);
  }
}
