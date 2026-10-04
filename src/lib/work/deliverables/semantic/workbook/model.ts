/**
 * The semantic workbook (BRIEF §29, Spreadsheet).
 *
 * Sheets of typed cells, real formulas, number formats, defined names, tables
 * with filters, frozen panes and charts bound to ranges. Stored as JSON in an
 * artifact version; computed by `engine.ts`; edited by `ops.ts`; exported and
 * imported by `xlsx.ts`.
 *
 * THE INJECTION RULE. A cell is a formula only when it is written as one —
 * `{ "f": "=SUM(B2:B5)" }` — never because its text happens to start with
 * "=". A plain string is text, always, whether the model wrote it, a person
 * typed it or an imported file carried it as a string. That is what keeps a
 * scraped value like `=HYPERLINK("http://evil", "x")` from becoming code in
 * somebody's workbook, and the formula language itself is closed
 * (`formula.ts`) so even an explicit formula can only compute.
 */

import { z } from "zod";
import {
  SemanticError,
  describeIssues,
  nextId,
} from "@/lib/work/deliverables/semantic/shared";
import {
  MAX_COL,
  MAX_ROW,
  cellKey,
  columnNumber,
  parseCell,
  parseQualifiedRange,
  rangeSize,
} from "@/lib/work/deliverables/semantic/workbook/address";
import {
  FormulaSyntaxError,
  functionsUsed,
  isSupportedFunction,
  parseFormula,
  printFormula,
  walk,
  type Node,
  type Scalar,
} from "@/lib/work/deliverables/semantic/workbook/formula";
import { dateToSerial, resolveFormat } from "@/lib/work/deliverables/semantic/workbook/format";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const WORKBOOK_LIMITS = {
  sheets: 64,
  cells: 200_000,
  cellChars: 32_767,
  charts: 32,
  tables: 32,
  names: 512,
  /** The largest range one formula reference may span; keeps a dependency graph finite. */
  rangeCells: 250_000,
} as const;

const SHEET_NAME = z
  .string()
  .trim()
  .min(1)
  .max(31)
  .regex(/^[^:\\/?*[\]]+$/, "A sheet name cannot contain : \\ / ? * [ or ]")
  .refine((name) => !name.startsWith("'") && !name.endsWith("'"), "A sheet name cannot start or end with an apostrophe");

const NAME = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/, "A name starts with a letter and uses letters, digits, _ or .")
  .refine((name) => !parseCell(name) && !/^(TRUE|FALSE)$/i.test(name), "A name cannot look like a cell or a boolean");

// ---------------------------------------------------------------------------
// Stored form
// ---------------------------------------------------------------------------

const scalarSchema = z.union([z.string().max(WORKBOOK_LIMITS.cellChars), z.number().finite(), z.boolean(), z.null()]);

/**
 * One stored cell.
 *  v       the value (text, number, boolean) — for a formula, nothing: the engine computes it
 *  f       a formula in canonical form, without "="
 *  t       "date": `v` is an Excel date serial
 *  fmt     an Excel number format code (`format.ts`)
 *  bold    header emphasis
 *  opaque  an IMPORTED formula this build cannot compute (an unsupported
 *          function); `f` is kept verbatim and `v` holds the file's cached
 *          value, so a roundtrip loses nothing and nothing pretends to compute it.
 */
export const storedCellSchema = z.object({
  v: scalarSchema.optional(),
  f: z.string().min(1).max(8_192).optional(),
  t: z.literal("date").optional(),
  fmt: z.string().max(64).optional(),
  bold: z.boolean().optional(),
  opaque: z.literal(true).optional(),
});
export type StoredCell = z.infer<typeof storedCellSchema>;

export const CHART_TYPES = ["bar", "column", "line", "pie", "area"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const chartSchema = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(CHART_TYPES),
  title: z.string().max(200).optional(),
  /** A range, qualified or on the chart's own sheet: "A2:A13", "Model!A2:A13". */
  categories: z.string().min(2).max(120),
  series: z
    .array(z.object({ name: z.string().max(120).optional(), values: z.string().min(2).max(120) }))
    .min(1)
    .max(12),
  /** Top-left cell and size in columns/rows. */
  anchor: z.object({
    cell: z.string().max(12),
    cols: z.number().int().min(2).max(30).default(8),
    rows: z.number().int().min(4).max(60).default(16),
  }),
});
export type WorkbookChart = z.infer<typeof chartSchema>;

export const FILTER_OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "nonempty"] as const;

export const tableSchema = z.object({
  id: z.string().min(1).max(40),
  name: NAME,
  /** Header row included. */
  range: z.string().min(2).max(40),
  filters: z
    .array(
      z.object({
        column: z.string().regex(/^[A-Z]{1,3}$/),
        op: z.enum(FILTER_OPS),
        value: z.union([z.string().max(200), z.number().finite()]).optional(),
      })
    )
    .max(16)
    .default([]),
});
export type WorkbookTable = z.infer<typeof tableSchema>;

export const sheetSchema = z.object({
  name: SHEET_NAME,
  cells: z.record(z.string(), storedCellSchema),
  columns: z.record(z.string(), z.object({ width: z.number().min(2).max(120).optional() })).default({}),
  freeze: z.object({ rows: z.number().int().min(0).max(100), cols: z.number().int().min(0).max(30) }).default({ rows: 0, cols: 0 }),
  tables: z.array(tableSchema).max(WORKBOOK_LIMITS.tables).default([]),
  charts: z.array(chartSchema).max(WORKBOOK_LIMITS.charts).default([]),
});
export type WorkbookSheet = z.infer<typeof sheetSchema>;

export const workbookSchema = z.object({
  kind: z.literal("spreadsheet"),
  version: z.literal(1),
  title: z.string().trim().min(1).max(300),
  sheets: z.array(sheetSchema).min(1).max(WORKBOOK_LIMITS.sheets),
  /** Defined names -> qualified range ("Assumptions!$B$3"). */
  names: z.record(z.string(), z.string().max(120)).default({}),
});
export type WorkbookModel = z.infer<typeof workbookSchema>;

// ---------------------------------------------------------------------------
// Authoring form
// ---------------------------------------------------------------------------

/**
 * What the model (or a person, or an import) may write for one cell:
 *   12 · "Revenue" · true · null
 *   { "f": "=B2*B3", "fmt": "currency" }
 *   { "v": 0.075, "fmt": "percent" }
 *   { "date": "2026-03-31" }
 * A string is text even when it starts with "=".
 */
export const cellInputSchema = z.union([
  scalarSchema,
  z.object({
    v: scalarSchema.optional(),
    f: z.string().min(1).max(8_192).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    fmt: z.string().max(64).optional(),
    bold: z.boolean().optional(),
    opaque: z.literal(true).optional(),
    t: z.literal("date").optional(),
  }),
]);
export type CellInput = z.infer<typeof cellInputSchema>;

const authoringSheetSchema = z.object({
  name: SHEET_NAME,
  /** Convenience: a block of rows written from A1 down. */
  rows: z.array(z.array(cellInputSchema)).max(10_000).optional(),
  cells: z.record(z.string(), cellInputSchema).optional(),
  columns: z.record(z.string(), z.object({ width: z.number().min(2).max(120).optional() })).optional(),
  freeze: z.object({ rows: z.number().int().min(0).max(100).optional(), cols: z.number().int().min(0).max(30).optional() }).optional(),
  tables: z.array(tableSchema.extend({ id: z.string().min(1).max(40).optional() })).max(WORKBOOK_LIMITS.tables).optional(),
  charts: z
    .array(
      chartSchema.extend({
        id: z.string().min(1).max(40).optional(),
        anchor: z
          .object({
            cell: z.string().max(12),
            cols: z.number().int().min(2).max(30).optional(),
            rows: z.number().int().min(4).max(60).optional(),
          })
          .optional(),
      })
    )
    .max(WORKBOOK_LIMITS.charts)
    .optional(),
});

const authoringWorkbookSchema = z.object({
  kind: z.literal("spreadsheet").optional(),
  version: z.literal(1).optional(),
  title: z.string().trim().min(1).max(300),
  sheets: z.array(authoringSheetSchema).min(1).max(WORKBOOK_LIMITS.sheets),
  names: z.record(z.string(), z.string().max(120)).optional(),
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** A date string -> Excel serial at UTC midnight. */
export function isoDateToSerial(iso: string): number {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new SemanticError("invalid_model", `"${iso}" is not a date`);
  return dateToSerial(date);
}

const formulaCache = new Map<string, Node>();

/** Parse a stored formula (memoised; stored formulas are canonical). */
export function formulaAst(formula: string): Node {
  let node = formulaCache.get(formula);
  if (!node) {
    node = parseFormula(formula);
    if (formulaCache.size > 20_000) formulaCache.clear();
    formulaCache.set(formula, node);
  }
  return node;
}

/**
 * Check a formula against the workbook and return its canonical text.
 * Throws SemanticError("invalid_formula") with a sentence a person can act on.
 */
export function canonicalFormula(
  formula: string,
  context: { sheetNames: ReadonlySet<string>; names: ReadonlySet<string> }
): string {
  let node: Node;
  try {
    node = parseFormula(formula);
  } catch (error) {
    const detail = error instanceof FormulaSyntaxError ? error.message : String(error);
    throw new SemanticError("invalid_formula", `"${formula}" is not a valid formula: ${detail}`);
  }
  const unknown = functionsUsed(node).filter((fn) => !isSupportedFunction(fn));
  if (unknown.length) {
    throw new SemanticError("invalid_formula", `"${formula}" uses ${unknown.join(", ")}, which this workbook does not compute`);
  }
  walk(node, (n) => {
    if ((n.k === "ref" || n.k === "range") && n.sheet !== null && !context.sheetNames.has(n.sheet.toLowerCase())) {
      throw new SemanticError("invalid_formula", `"${formula}" refers to a sheet named "${n.sheet}" that does not exist`);
    }
    if (n.k === "range") {
      const size = rangeSize({ start: n.start, end: n.end });
      if (size > WORKBOOK_LIMITS.rangeCells) {
        throw new SemanticError("invalid_formula", `"${formula}" spans ${size} cells, above ${WORKBOOK_LIMITS.rangeCells}`);
      }
    }
    if (n.k === "name" && !context.names.has(n.name.toLowerCase())) {
      throw new SemanticError("invalid_formula", `"${formula}" uses the name "${n.name}", which is not defined`);
    }
  });
  return printFormula(node);
}

/** One authoring cell -> its stored form, or null for an empty cell. */
export function toStoredCell(
  input: CellInput,
  context: { sheetNames: ReadonlySet<string>; names: ReadonlySet<string> },
  where: string
): StoredCell | null {
  if (input === null) return null;
  if (typeof input !== "object") return { v: input };
  const out: StoredCell = {};
  if (input.fmt !== undefined) {
    const fmt = resolveFormat(input.fmt);
    if (!fmt) throw new SemanticError("invalid_model", `${where}: "${input.fmt}" is not a number format this workbook supports`);
    if (fmt !== "General") out.fmt = fmt;
  }
  if (input.bold) out.bold = true;
  if (input.f !== undefined) {
    if (input.opaque) {
      out.f = input.f.replace(/^=/, "");
      out.opaque = true;
      if (input.v !== undefined) out.v = input.v;
    } else {
      out.f = canonicalFormula(input.f, context);
    }
  } else if (input.date !== undefined) {
    out.v = isoDateToSerial(input.date);
    out.t = "date";
    out.fmt ??= "yyyy-mm-dd";
  } else if (input.v !== undefined && input.v !== null) {
    out.v = input.v;
    if (input.t === "date" && typeof input.v === "number") out.t = "date";
  }
  if (out.f === undefined && out.v === undefined && !out.fmt && !out.bold) return null;
  return out;
}

function checkRange(text: string, where: string, sheetNames: ReadonlySet<string>): void {
  const parsed = parseQualifiedRange(text);
  if (!parsed) throw new SemanticError("invalid_model", `${where}: "${text}" is not a range`);
  if (parsed.sheet !== null && !sheetNames.has(parsed.sheet.toLowerCase())) {
    throw new SemanticError("invalid_model", `${where}: "${text}" refers to a sheet that does not exist`);
  }
}

/**
 * Untrusted JSON (the model's authoring form, an import, or a stored body) ->
 * a validated workbook with every id assigned and every formula canonical.
 */
export function normalizeWorkbook(input: unknown): WorkbookModel {
  const parsed = authoringWorkbookSchema.safeParse(input);
  if (!parsed.success) throw new SemanticError("invalid_model", describeIssues(parsed.error.issues));
  const raw = parsed.data;

  const sheetNames = new Set<string>();
  for (const sheet of raw.sheets) {
    const key = sheet.name.toLowerCase();
    if (sheetNames.has(key)) throw new SemanticError("invalid_model", `Two sheets are both named "${sheet.name}"`);
    sheetNames.add(key);
  }

  const names: Record<string, string> = {};
  for (const [name, ref] of Object.entries(raw.names ?? {})) {
    const nameCheck = NAME.safeParse(name);
    if (!nameCheck.success) throw new SemanticError("invalid_model", `"${name}" is not a valid name`);
    const target = parseQualifiedRange(ref);
    if (!target || target.sheet === null) {
      throw new SemanticError("invalid_model", `The name "${name}" must point at a sheet-qualified range, like Assumptions!B3`);
    }
    if (!sheetNames.has(target.sheet.toLowerCase())) {
      throw new SemanticError("invalid_model", `The name "${name}" points at a sheet that does not exist`);
    }
    names[name] = ref;
  }
  if (Object.keys(names).length > WORKBOOK_LIMITS.names) throw new SemanticError("too_large", "Too many defined names");
  const context = { sheetNames, names: new Set(Object.keys(names).map((n) => n.toLowerCase())) };

  let total = 0;
  const chartIds: string[] = [];
  const tableIds: string[] = [];
  const sheets: WorkbookSheet[] = raw.sheets.map((sheet) => {
    const cells: Record<string, StoredCell> = {};
    const put = (address: string, input: CellInput) => {
      const parsedAddress = parseCell(address);
      if (!parsedAddress) throw new SemanticError("invalid_model", `${sheet.name}: "${address}" is not a cell address`);
      const key = cellKey(parsedAddress);
      const stored = toStoredCell(input, context, `${sheet.name}!${key}`);
      if (stored) cells[key] = stored;
      else delete cells[key];
    };
    sheet.rows?.forEach((row, r) => row.forEach((value, c) => put(cellKey({ col: c + 1, row: r + 1 }), value)));
    for (const [address, value] of Object.entries(sheet.cells ?? {})) put(address, value);
    total += Object.keys(cells).length;

    const columns: WorkbookSheet["columns"] = {};
    for (const [letter, spec] of Object.entries(sheet.columns ?? {})) {
      const col = columnNumber(letter);
      if (!(col >= 1 && col <= MAX_COL)) throw new SemanticError("invalid_model", `${sheet.name}: "${letter}" is not a column`);
      columns[letter.toUpperCase()] = spec;
    }

    const tables: WorkbookTable[] = (sheet.tables ?? []).map((table) => {
      checkRange(table.range, `${sheet.name} table ${table.name}`, sheetNames);
      if (parseQualifiedRange(table.range)!.sheet !== null) {
        throw new SemanticError("invalid_model", `Table ${table.name} must use a range on its own sheet`);
      }
      const id = table.id ?? nextId("t", [...tableIds]);
      tableIds.push(id);
      return { id, name: table.name, range: table.range.toUpperCase(), filters: table.filters ?? [] };
    });

    const charts: WorkbookChart[] = (sheet.charts ?? []).map((chart) => {
      checkRange(chart.categories, `${sheet.name} chart`, sheetNames);
      chart.series.forEach((series) => checkRange(series.values, `${sheet.name} chart series`, sheetNames));
      const id = chart.id ?? nextId("ch", [...chartIds]);
      chartIds.push(id);
      const anchorCell = chart.anchor?.cell ?? "H2";
      if (!parseCell(anchorCell)) throw new SemanticError("invalid_model", `Chart anchor "${anchorCell}" is not a cell`);
      return {
        id,
        type: chart.type,
        ...(chart.title ? { title: chart.title } : {}),
        categories: chart.categories,
        series: chart.series.map((series) => ({ ...(series.name ? { name: series.name } : {}), values: series.values })),
        anchor: { cell: anchorCell.toUpperCase(), cols: chart.anchor?.cols ?? 8, rows: chart.anchor?.rows ?? 16 },
      };
    });

    return {
      name: sheet.name,
      cells,
      columns,
      freeze: { rows: sheet.freeze?.rows ?? 0, cols: sheet.freeze?.cols ?? 0 },
      tables,
      charts,
    };
  });
  if (total > WORKBOOK_LIMITS.cells) throw new SemanticError("too_large", `${total} cells is above ${WORKBOOK_LIMITS.cells}`);
  if (new Set(chartIds).size !== chartIds.length) throw new SemanticError("invalid_model", "Two charts share an id");
  if (new Set(tableIds).size !== tableIds.length) throw new SemanticError("invalid_model", "Two tables share an id");

  return { kind: "spreadsheet", version: 1, title: raw.title, sheets, names };
}

export function serializeWorkbook(model: WorkbookModel): string {
  return JSON.stringify(model);
}

export function findSheet(model: WorkbookModel, name: string): WorkbookSheet | undefined {
  const key = name.trim().toLowerCase();
  return model.sheets.find((sheet) => sheet.name.toLowerCase() === key);
}

/** The used extent of a sheet: highest row and column holding anything. */
export function sheetExtent(sheet: WorkbookSheet): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const key of Object.keys(sheet.cells)) {
    const address = parseCell(key);
    if (!address) continue;
    rows = Math.max(rows, address.row);
    cols = Math.max(cols, address.col);
  }
  return { rows: Math.min(rows, MAX_ROW), cols: Math.min(cols, MAX_COL) };
}

export type { Scalar };
