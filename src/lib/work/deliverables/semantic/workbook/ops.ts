/**
 * Semantic workbook edits — the operations the chat model (and the canvas)
 * call instead of regenerating a table.
 *
 * "Increase the conversion assumption to 7.5% and update the charts" is ONE
 * operation here: `setCell` on the assumption (by address or by its defined
 * name). Every formula that reads it, and every chart bound to those
 * formulas, follows from the engine; nothing else in the stored model moves.
 *
 * All-or-nothing: operations run against a clone and the first failure throws
 * a SemanticError carrying its 1-based index, so a half-applied batch can
 * never be stored. A formula edit that would create a cycle is refused here,
 * before it can be stored, by building the engine over the result.
 */

import { z } from "zod";
import {
  SemanticError,
  cloneModel,
  nextId,
  type SemanticOpResult,
} from "@/lib/work/deliverables/semantic/shared";
import {
  cellKey,
  columnLetter,
  columnNumber,
  eachCell,
  parseCell,
  parseQualifiedRange,
  parseRange,
  qualifiedRange,
  type CellAddress,
  type RangeAddress,
} from "@/lib/work/deliverables/semantic/workbook/address";
import { WorkbookEngine, cellId, type CellId } from "@/lib/work/deliverables/semantic/workbook/engine";
import {
  dropSheetReferences,
  isError,
  offsetRelative,
  parseFormula,
  printFormula,
  renameSheetReferences,
  shiftReferences,
  type Node,
  type Value,
} from "@/lib/work/deliverables/semantic/workbook/formula";
import { resolveFormat } from "@/lib/work/deliverables/semantic/workbook/format";
import {
  CHART_TYPES,
  FILTER_OPS,
  canonicalFormula,
  cellInputSchema,
  findSheet,
  normalizeWorkbook,
  toStoredCell,
  type CellInput,
  type WorkbookChart,
  type WorkbookModel,
  type WorkbookSheet,
} from "@/lib/work/deliverables/semantic/workbook/model";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const sheet = z.string().min(1).max(31);
const cell = z.string().min(1).max(255);
const range = z.string().min(2).max(40);
const column = z.string().regex(/^[A-Za-z]{1,3}$/);
const plainValue = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]);

const seriesSchema = z.object({ name: z.string().max(120).optional(), values: z.string().min(2).max(120) });
const filterSchema = z.object({
  column,
  op: z.enum(FILTER_OPS),
  value: z.union([z.string().max(200), z.number().finite()]).optional(),
});

export const workbookOpSchema = z.discriminatedUnion("op", [
  /** A value. A string is text even when it starts with "=": use setFormula for a formula. */
  z.object({
    op: z.literal("setCell"),
    sheet,
    cell,
    value: plainValue,
    format: z.string().max(64).optional(),
  }),
  z.object({ op: z.literal("setFormula"), sheet, cell, formula: z.string().min(1).max(8_192), format: z.string().max(64).optional() }),
  /** A block of cells from `start`, row by row; objects may carry {"f": "=…"}. */
  z.object({ op: z.literal("setCells"), sheet, start: cell, values: z.array(z.array(cellInputSchema)).min(1).max(2_000) }),
  z.object({ op: z.literal("clearRange"), sheet, range }),
  z.object({ op: z.literal("setFormat"), sheet, range, format: z.string().min(1).max(64) }),
  z.object({ op: z.literal("setBold"), sheet, range, bold: z.boolean() }),
  z.object({ op: z.literal("insertRows"), sheet, before: z.number().int().min(1), count: z.number().int().min(1).max(10_000).default(1) }),
  z.object({ op: z.literal("deleteRows"), sheet, start: z.number().int().min(1), count: z.number().int().min(1).max(10_000).default(1) }),
  z.object({ op: z.literal("insertColumns"), sheet, before: column, count: z.number().int().min(1).max(500).default(1) }),
  z.object({ op: z.literal("deleteColumns"), sheet, start: column, count: z.number().int().min(1).max(500).default(1) }),
  z.object({
    op: z.literal("sortRange"),
    sheet,
    range,
    column,
    direction: z.enum(["asc", "desc"]).default("asc"),
    header: z.boolean().default(true),
  }),
  z.object({ op: z.literal("setFreeze"), sheet, rows: z.number().int().min(0).max(100), cols: z.number().int().min(0).max(30) }),
  z.object({ op: z.literal("setColumnWidth"), sheet, column, width: z.number().min(2).max(120) }),
  z.object({ op: z.literal("addSheet"), name: sheet, rows: z.array(z.array(cellInputSchema)).max(10_000).optional() }),
  z.object({ op: z.literal("renameSheet"), from: sheet, to: sheet }),
  z.object({ op: z.literal("deleteSheet"), name: sheet }),
  z.object({ op: z.literal("defineName"), name: z.string().min(1).max(255), ref: z.string().min(2).max(120) }),
  z.object({ op: z.literal("addTable"), sheet, name: z.string().min(1).max(255), range, filters: z.array(filterSchema).max(16).optional() }),
  z.object({ op: z.literal("setFilter"), sheet, table: z.string().min(1).max(255), filters: z.array(filterSchema).max(16) }),
  z.object({
    op: z.literal("addChart"),
    sheet,
    type: z.enum(CHART_TYPES),
    title: z.string().max(200).optional(),
    categories: z.string().min(2).max(120),
    series: z.array(seriesSchema).min(1).max(12),
    anchor: z.string().max(12).optional(),
  }),
  z.object({
    op: z.literal("updateChart"),
    sheet,
    id: z.string().min(1).max(40),
    type: z.enum(CHART_TYPES).optional(),
    title: z.string().max(200).optional(),
    categories: z.string().min(2).max(120).optional(),
    series: z.array(seriesSchema).min(1).max(12).optional(),
    anchor: z.string().max(12).optional(),
  }),
  z.object({ op: z.literal("removeChart"), sheet, id: z.string().min(1).max(40) }),
  z.object({ op: z.literal("setTitle"), title: z.string().trim().min(1).max(300) }),
]);

export type WorkbookOp = z.infer<typeof workbookOpSchema>;
export const workbookOpsSchema = z.array(workbookOpSchema).min(1).max(60);

export interface WorkbookOpResult extends SemanticOpResult<WorkbookModel> {
  /** The engine over the result, ready to read computed values from. */
  engine: WorkbookEngine;
  /** Cells whose stored content an op wrote. */
  touched: CellId[];
  /**
   * Formula cells the engine re-evaluated. For value/formula edits this is the
   * transitive dependents of `touched` — nothing else is recomputed. A
   * structural edit (rows, columns, sort, sheets) recomputes everything.
   */
  recalculated: CellId[];
  /** Cells whose computed value differs from before, with both values. */
  valueChanges: { cell: CellId; before: Value; after: Value }[];
  /** Chart ids whose drawn data changed. */
  chartsChanged: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sheetOrThrow(model: WorkbookModel, name: string): WorkbookSheet {
  const found = findSheet(model, name);
  if (!found) throw new SemanticError("not_found", `There is no sheet named "${name}"`);
  return found;
}

/** A cell address, or a defined name that points at one cell. */
function resolveTarget(model: WorkbookModel, sheetName: string, target: string): { sheet: WorkbookSheet; address: CellAddress } {
  const direct = parseCell(target);
  if (direct) return { sheet: sheetOrThrow(model, sheetName), address: direct };
  const qualified = parseQualifiedRange(target);
  if (qualified && qualified.sheet) {
    const { range: r } = qualified;
    if (r.start.col === r.end.col && r.start.row === r.end.row) return { sheet: sheetOrThrow(model, qualified.sheet), address: r.start };
  }
  const nameEntry = Object.entries(model.names).find(([name]) => name.toLowerCase() === target.toLowerCase());
  if (nameEntry) {
    const parsed = parseQualifiedRange(nameEntry[1])!;
    if (parsed.range.start.col !== parsed.range.end.col || parsed.range.start.row !== parsed.range.end.row) {
      throw new SemanticError("invalid_op", `The name "${target}" covers a range, not one cell`);
    }
    return { sheet: sheetOrThrow(model, parsed.sheet!), address: parsed.range.start };
  }
  throw new SemanticError("not_found", `"${target}" is neither a cell address nor a defined name`);
}

function rangeOrThrow(text: string): RangeAddress {
  const parsed = parseRange(text);
  if (!parsed) throw new SemanticError("invalid_op", `"${text}" is not a range`);
  return parsed;
}

function formulaContext(model: WorkbookModel) {
  return {
    sheetNames: new Set(model.sheets.map((s) => s.name.toLowerCase())),
    names: new Set(Object.keys(model.names).map((n) => n.toLowerCase())),
  };
}

/** Rewrite every parseable formula in the workbook. */
function rewriteFormulas(model: WorkbookModel, rewrite: (node: Node, sheetName: string) => Node): void {
  for (const s of model.sheets) {
    for (const stored of Object.values(s.cells)) {
      if (stored.f === undefined) continue;
      let node: Node;
      try {
        node = parseFormula(stored.f);
      } catch {
        continue; // An opaque formula this build cannot parse is left exactly as imported.
      }
      stored.f = printFormula(rewrite(node, s.name));
    }
  }
}

/** Rewrite a stored range text (chart, name, table) through the same AST transform. */
function rewriteRangeText(text: string, ownSheet: string, rewrite: (node: Node, sheetName: string) => Node): string | null {
  const parsed = parseQualifiedRange(text);
  if (!parsed) return text;
  const node: Node = {
    k: "range",
    sheet: parsed.sheet,
    start: { ...parsed.range.start, colAbs: false, rowAbs: false },
    end: { ...parsed.range.end, colAbs: false, rowAbs: false },
  };
  const out = rewrite(node, ownSheet);
  if (out.k === "err") return null;
  if (out.k !== "range") return text;
  const absolute = text.includes("$");
  return qualifiedRange(out.sheet, { start: out.start, end: out.end }, absolute);
}

function rewriteAllRanges(
  model: WorkbookModel,
  rewrite: (node: Node, sheetName: string) => Node,
  what: string
): void {
  for (const [name, ref] of Object.entries(model.names)) {
    const next = rewriteRangeText(ref, "", rewrite);
    if (next === null) throw new SemanticError("invalid_op", `${what} would remove the cells named "${name}"`);
    model.names[name] = next;
  }
  for (const s of model.sheets) {
    for (const chart of s.charts) {
      const categories = rewriteRangeText(chart.categories, s.name, rewrite);
      if (categories === null) throw new SemanticError("invalid_op", `${what} would remove the data of chart ${chart.id}`);
      chart.categories = categories;
      for (const series of chart.series) {
        const values = rewriteRangeText(series.values, s.name, rewrite);
        if (values === null) throw new SemanticError("invalid_op", `${what} would remove the data of chart ${chart.id}`);
        series.values = values;
      }
    }
    for (const table of s.tables) {
      const next = rewriteRangeText(table.range, s.name, rewrite);
      if (next === null) throw new SemanticError("invalid_op", `${what} would remove table ${table.name}`);
      table.range = next;
    }
  }
}

/** Move a sheet's cells along one axis. `count` < 0 deletes. */
function moveCells(target: WorkbookSheet, axis: "row" | "col", at: number, count: number): void {
  const next: WorkbookSheet["cells"] = {};
  for (const [key, stored] of Object.entries(target.cells)) {
    const address = parseCell(key)!;
    const value = address[axis];
    let moved = value;
    if (count > 0) moved = value >= at ? value + count : value;
    else if (value >= at && value < at - count) continue;
    else if (value >= at - count) moved = value + count;
    next[cellKey({ ...address, [axis]: moved })] = stored;
  }
  target.cells = next;
}

function shiftAnchor(chart: WorkbookChart, axis: "row" | "col", at: number, count: number): void {
  const address = parseCell(chart.anchor.cell)!;
  const value = address[axis];
  if (value >= at) chart.anchor.cell = cellKey({ ...address, [axis]: Math.max(1, value + count) });
}

function structuralShift(model: WorkbookModel, sheetName: string, axis: "row" | "col", at: number, count: number, what: string) {
  const target = sheetOrThrow(model, sheetName);
  const rewrite = (node: Node, formulaSheet: string) =>
    shiftReferences(node, { sheet: target.name, formulaSheet: formulaSheet || target.name, axis, at, count });
  rewriteAllRanges(model, rewrite, what);
  rewriteFormulas(model, rewrite);
  moveCells(target, axis, at, count);
  for (const chart of target.charts) shiftAnchor(chart, axis, at, count);
}

function compareForSort(a: Value, b: Value): number {
  const rank = (v: Value) => (v === null || v === "" ? 3 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : isError(v) ? 4 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b, "en", { sensitivity: "base", numeric: true });
  return 0;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply operations to a workbook. Returns a NEW model; the input is never
 * mutated. Throws SemanticError with `opIndex` on the first failure.
 */
export function applyWorkbookOps(
  model: WorkbookModel,
  ops: readonly WorkbookOp[],
  options: { previous?: WorkbookEngine } = {}
): WorkbookOpResult {
  const before = options.previous && options.previous.model === model ? options.previous : new WorkbookEngine(model);
  const next = cloneModel(model);
  const changes: string[] = [];
  const touched = new Set<CellId>();
  const formulaCells = new Set<CellId>();
  let structural = false;

  ops.forEach((op, index) => {
    try {
      const change = applyOne(next, op, touched, formulaCells, before);
      if (change.structural) structural = true;
      changes.push(change.text);
    } catch (error) {
      if (error instanceof SemanticError) throw new SemanticError(error.code, `Operation ${index + 1}: ${error.message}`, index + 1);
      throw error;
    }
  });

  // Re-validate the whole result exactly as a stored body is validated.
  let normalized: WorkbookModel;
  try {
    normalized = normalizeWorkbook(next);
  } catch (error) {
    if (error instanceof SemanticError) throw new SemanticError(error.code, `The edited workbook is invalid: ${error.message}`);
    throw error;
  }

  const engine = structural ? new WorkbookEngine(normalized) : new WorkbookEngine(normalized, { previous: before, changed: touched });
  for (const id of formulaCells) {
    if (engine.onCycle(id)) {
      const [sheetName, address] = id.split("!");
      const display = findSheet(normalized, sheetName)?.name ?? sheetName;
      throw new SemanticError("cycle", `The formula in ${display}!${address} would depend on itself`);
    }
  }

  const valueChanges: WorkbookOpResult["valueChanges"] = [];
  const seen = new Set<CellId>([...touched, ...engine.evaluated]);
  for (const id of seen) {
    const bang = id.lastIndexOf("!");
    const sheetKey = id.slice(0, bang);
    const address = id.slice(bang + 1);
    const was = findSheet(model, sheetKey) ? before.value(sheetKey, address) : null;
    const now = findSheet(normalized, sheetKey) ? engine.value(sheetKey, address) : null;
    if (JSON.stringify(was) !== JSON.stringify(now)) valueChanges.push({ cell: id, before: was, after: now });
  }

  const chartsChanged: string[] = [];
  for (const s of normalized.sheets) {
    for (const chart of s.charts) {
      const old = findSheet(model, s.name)?.charts.find((c) => c.id === chart.id);
      const drawnBefore = old ? JSON.stringify(chartData(before, findSheet(model, s.name)!.name, old)) : null;
      const drawnAfter = JSON.stringify(chartData(engine, s.name, chart));
      if (drawnBefore !== drawnAfter || JSON.stringify(old) !== JSON.stringify(chart)) chartsChanged.push(chart.id);
    }
  }

  return {
    model: normalized,
    changes,
    engine,
    touched: [...touched],
    recalculated: [...engine.evaluated],
    valueChanges,
    chartsChanged,
  };
}

function chartData(engine: WorkbookEngine, sheetName: string, chart: WorkbookChart) {
  return {
    c: engine.rangeValues(sheetName, chart.categories),
    s: chart.series.map((series) => engine.rangeValues(sheetName, series.values)),
  };
}

function applyOne(
  model: WorkbookModel,
  op: WorkbookOp,
  touched: Set<CellId>,
  formulaCells: Set<CellId>,
  before: WorkbookEngine
): { text: string; structural?: boolean } {
  switch (op.op) {
    case "setCell": {
      const { sheet: target, address } = resolveTarget(model, op.sheet, op.cell);
      const key = cellKey(address);
      const existing = target.cells[key];
      const input: CellInput = { v: op.value, ...(op.format ? { fmt: op.format } : existing?.fmt ? { fmt: existing.fmt } : {}), ...(existing?.bold ? { bold: true } : {}) };
      const stored = toStoredCell(input, formulaContext(model), `${target.name}!${key}`);
      if (stored) {
        if (existing?.t === "date" && typeof op.value === "number") stored.t = "date";
        target.cells[key] = stored;
      } else delete target.cells[key];
      touched.add(cellId(target.name, address));
      const shown = typeof op.value === "string" ? `"${op.value}"` : String(op.value);
      return { text: `Set ${target.name}!${key} to ${shown}` };
    }
    case "setFormula": {
      const { sheet: target, address } = resolveTarget(model, op.sheet, op.cell);
      const key = cellKey(address);
      const existing = target.cells[key];
      const formula = canonicalFormula(op.formula, formulaContext(model));
      const fmt = op.format ? resolveFormat(op.format) : existing?.fmt;
      if (op.format && !fmt) throw new SemanticError("invalid_op", `"${op.format}" is not a supported number format`);
      target.cells[key] = { f: formula, ...(fmt ? { fmt } : {}), ...(existing?.bold ? { bold: true } : {}) };
      const id = cellId(target.name, address);
      touched.add(id);
      formulaCells.add(id);
      return { text: `Set ${target.name}!${key} to =${formula}` };
    }
    case "setCells": {
      const target = sheetOrThrow(model, op.sheet);
      const start = parseCell(op.start);
      if (!start) throw new SemanticError("invalid_op", `"${op.start}" is not a cell`);
      const context = formulaContext(model);
      let count = 0;
      op.values.forEach((row, r) =>
        row.forEach((input, c) => {
          const address = { col: start.col + c, row: start.row + r };
          const key = cellKey(address);
          const stored = toStoredCell(input, context, `${target.name}!${key}`);
          if (stored) target.cells[key] = stored;
          else delete target.cells[key];
          const id = cellId(target.name, address);
          touched.add(id);
          if (stored?.f !== undefined) formulaCells.add(id);
          count++;
        })
      );
      return { text: `Wrote ${count} cells from ${target.name}!${cellKey(start)}` };
    }
    case "clearRange": {
      const target = sheetOrThrow(model, op.sheet);
      const r = rangeOrThrow(op.range);
      for (const address of eachCell(r)) {
        delete target.cells[cellKey(address)];
        touched.add(cellId(target.name, address));
      }
      return { text: `Cleared ${target.name}!${op.range.toUpperCase()}` };
    }
    case "setFormat": {
      const target = sheetOrThrow(model, op.sheet);
      const fmt = resolveFormat(op.format);
      if (!fmt) throw new SemanticError("invalid_op", `"${op.format}" is not a supported number format`);
      for (const address of eachCell(rangeOrThrow(op.range))) {
        const key = cellKey(address);
        const existing = target.cells[key] ?? {};
        if (fmt === "General") {
          const rest = { ...existing };
          delete rest.fmt;
          target.cells[key] = rest;
        } else target.cells[key] = { ...existing, fmt };
      }
      return { text: `Formatted ${target.name}!${op.range.toUpperCase()} as ${fmt}` };
    }
    case "setBold": {
      const target = sheetOrThrow(model, op.sheet);
      for (const address of eachCell(rangeOrThrow(op.range))) {
        const key = cellKey(address);
        const existing = { ...(target.cells[key] ?? {}) };
        if (op.bold) existing.bold = true;
        else delete existing.bold;
        target.cells[key] = existing;
      }
      return { text: `${op.bold ? "Bolded" : "Unbolded"} ${target.name}!${op.range.toUpperCase()}` };
    }
    case "insertRows":
      structuralShift(model, op.sheet, "row", op.before, op.count, `Inserting rows`);
      return { text: `Inserted ${op.count} row${op.count === 1 ? "" : "s"} before row ${op.before} on ${op.sheet}`, structural: true };
    case "deleteRows":
      structuralShift(model, op.sheet, "row", op.start, -op.count, `Deleting rows ${op.start}–${op.start + op.count - 1}`);
      return { text: `Deleted rows ${op.start}–${op.start + op.count - 1} on ${op.sheet}`, structural: true };
    case "insertColumns": {
      const at = columnNumber(op.before);
      structuralShift(model, op.sheet, "col", at, op.count, `Inserting columns`);
      return { text: `Inserted ${op.count} column${op.count === 1 ? "" : "s"} before ${op.before.toUpperCase()} on ${op.sheet}`, structural: true };
    }
    case "deleteColumns": {
      const at = columnNumber(op.start);
      structuralShift(model, op.sheet, "col", at, -op.count, `Deleting columns from ${op.start.toUpperCase()}`);
      return { text: `Deleted ${op.count} column${op.count === 1 ? "" : "s"} from ${op.start.toUpperCase()} on ${op.sheet}`, structural: true };
    }
    case "sortRange": {
      const target = sheetOrThrow(model, op.sheet);
      const r = rangeOrThrow(op.range);
      const keyCol = columnNumber(op.column);
      if (keyCol < r.start.col || keyCol > r.end.col) throw new SemanticError("invalid_op", `Column ${op.column} is outside ${op.range}`);
      const firstRow = r.start.row + (op.header ? 1 : 0);
      const rows: { row: number; key: Value; cells: Map<number, WorkbookSheet["cells"][string]> }[] = [];
      for (let row = firstRow; row <= r.end.row; row++) {
        const cells = new Map<number, WorkbookSheet["cells"][string]>();
        for (let col = r.start.col; col <= r.end.col; col++) {
          const stored = target.cells[cellKey({ col, row })];
          if (stored) cells.set(col, stored);
        }
        rows.push({ row, key: before.value(target.name, { col: keyCol, row }), cells });
      }
      const sorted = [...rows].sort((a, b) => {
        const cmp = compareForSort(a.key, b.key);
        // Blanks and errors stay last whichever way the sort runs.
        const tail = (v: Value) => v === null || v === "" || isError(v);
        if (tail(a.key) || tail(b.key)) return cmp;
        return op.direction === "asc" ? cmp : -cmp;
      });
      for (let row = firstRow; row <= r.end.row; row++) {
        for (let col = r.start.col; col <= r.end.col; col++) delete target.cells[cellKey({ col, row })];
      }
      // Each row carries its formulas with it, relative references moving with
      // the row (Excel's copy semantics); references from elsewhere do not follow.
      sorted.forEach((entry, i) => {
        const row = firstRow + i;
        for (const [col, stored] of entry.cells) {
          const moved = { ...stored };
          if (moved.f !== undefined && !moved.opaque) moved.f = printFormula(offsetRelative(parseFormula(moved.f), row - entry.row, 0));
          target.cells[cellKey({ col, row })] = moved;
        }
      });
      return { text: `Sorted ${target.name}!${op.range.toUpperCase()} by ${op.column.toUpperCase()} ${op.direction === "asc" ? "ascending" : "descending"}`, structural: true };
    }
    case "setFreeze": {
      const target = sheetOrThrow(model, op.sheet);
      target.freeze = { rows: op.rows, cols: op.cols };
      return { text: `Froze ${op.rows} row${op.rows === 1 ? "" : "s"} and ${op.cols} column${op.cols === 1 ? "" : "s"} on ${target.name}` };
    }
    case "setColumnWidth": {
      const target = sheetOrThrow(model, op.sheet);
      target.columns[op.column.toUpperCase()] = { width: op.width };
      return { text: `Set column ${op.column.toUpperCase()} on ${target.name} to width ${op.width}` };
    }
    case "addSheet": {
      if (findSheet(model, op.name)) throw new SemanticError("invalid_op", `A sheet named "${op.name}" already exists`);
      model.sheets.push({ name: op.name, cells: {}, columns: {}, freeze: { rows: 0, cols: 0 }, tables: [], charts: [] });
      if (op.rows) {
        const target = model.sheets[model.sheets.length - 1];
        const context = formulaContext(model);
        op.rows.forEach((row, r) =>
          row.forEach((input, c) => {
            const address = { col: c + 1, row: r + 1 };
            const stored = toStoredCell(input, context, `${op.name}!${cellKey(address)}`);
            if (stored) target.cells[cellKey(address)] = stored;
            if (stored?.f !== undefined) formulaCells.add(cellId(op.name, address));
          })
        );
      }
      return { text: `Added the sheet ${op.name}`, structural: true };
    }
    case "renameSheet": {
      const target = sheetOrThrow(model, op.from);
      const clash = findSheet(model, op.to);
      if (clash && clash !== target) throw new SemanticError("invalid_op", `A sheet named "${op.to}" already exists`);
      const from = target.name;
      const rewrite = (node: Node) => renameSheetReferences(node, from, op.to);
      rewriteFormulas(model, rewrite);
      rewriteAllRanges(model, rewrite, "Renaming");
      target.name = op.to;
      return { text: `Renamed the sheet ${from} to ${op.to}`, structural: true };
    }
    case "deleteSheet": {
      const target = sheetOrThrow(model, op.name);
      if (model.sheets.length === 1) throw new SemanticError("invalid_op", "A workbook keeps at least one sheet");
      const probe = (node: Node) => dropSheetReferences(node, target.name);
      for (const other of model.sheets) {
        if (other === target) continue;
        for (const [key, stored] of Object.entries(other.cells)) {
          if (stored.f === undefined) continue;
          let node: Node;
          try {
            node = parseFormula(stored.f);
          } catch {
            continue;
          }
          if (printFormula(probe(node)) !== printFormula(node)) {
            throw new SemanticError("invalid_op", `${other.name}!${key} reads from ${target.name}; change it before deleting the sheet`);
          }
        }
      }
      model.sheets = model.sheets.filter((s) => s !== target);
      rewriteAllRanges(model, probe, `Deleting ${target.name}`);
      return { text: `Deleted the sheet ${target.name}`, structural: true };
    }
    case "defineName": {
      const parsed = parseQualifiedRange(op.ref);
      if (!parsed || !parsed.sheet) throw new SemanticError("invalid_op", `"${op.ref}" must be a sheet-qualified range like Assumptions!B3`);
      const target = sheetOrThrow(model, parsed.sheet);
      for (const name of Object.keys(model.names)) if (name.toLowerCase() === op.name.toLowerCase()) delete model.names[name];
      model.names[op.name] = qualifiedRange(target.name, parsed.range, true);
      return { text: `Named ${model.names[op.name]} "${op.name}"`, structural: true };
    }
    case "addTable": {
      const target = sheetOrThrow(model, op.sheet);
      rangeOrThrow(op.range);
      const taken = model.sheets.flatMap((s) => s.tables.map((t) => t.id));
      target.tables.push({ id: nextId("t", taken), name: op.name, range: op.range.toUpperCase(), filters: op.filters ?? [] });
      return { text: `Made ${target.name}!${op.range.toUpperCase()} a table named ${op.name}` };
    }
    case "setFilter": {
      const target = sheetOrThrow(model, op.sheet);
      const table = target.tables.find((t) => t.id === op.table || t.name.toLowerCase() === op.table.toLowerCase());
      if (!table) throw new SemanticError("not_found", `There is no table "${op.table}" on ${target.name}`);
      table.filters = op.filters.map((f) => ({ ...f, column: f.column.toUpperCase() }));
      return { text: op.filters.length ? `Filtered table ${table.name}` : `Cleared the filters on table ${table.name}` };
    }
    case "addChart": {
      const target = sheetOrThrow(model, op.sheet);
      const taken = model.sheets.flatMap((s) => s.charts.map((c) => c.id));
      const id = nextId("ch", taken);
      target.charts.push({
        id,
        type: op.type,
        ...(op.title ? { title: op.title } : {}),
        categories: op.categories,
        series: op.series,
        anchor: { cell: (op.anchor ?? defaultAnchor(target)).toUpperCase(), cols: 8, rows: 16 },
      });
      return { text: `Added a ${op.type} chart${op.title ? ` "${op.title}"` : ""} on ${target.name}` };
    }
    case "updateChart": {
      const target = sheetOrThrow(model, op.sheet);
      const chart = target.charts.find((c) => c.id === op.id);
      if (!chart) throw new SemanticError("not_found", `There is no chart ${op.id} on ${target.name}`);
      if (op.type) chart.type = op.type;
      if (op.title !== undefined) chart.title = op.title;
      if (op.categories) chart.categories = op.categories;
      if (op.series) chart.series = op.series;
      if (op.anchor) chart.anchor.cell = op.anchor.toUpperCase();
      return { text: `Updated chart ${chart.id}${chart.title ? ` "${chart.title}"` : ""}` };
    }
    case "removeChart": {
      const target = sheetOrThrow(model, op.sheet);
      const before = target.charts.length;
      target.charts = target.charts.filter((c) => c.id !== op.id);
      if (target.charts.length === before) throw new SemanticError("not_found", `There is no chart ${op.id} on ${target.name}`);
      return { text: `Removed chart ${op.id}` };
    }
    case "setTitle":
      model.title = op.title;
      return { text: `Renamed the workbook to ${op.title}` };
  }
}

/** Two columns to the right of the used range. */
function defaultAnchor(target: WorkbookSheet): string {
  let maxCol = 0;
  for (const key of Object.keys(target.cells)) maxCol = Math.max(maxCol, parseCell(key)?.col ?? 0);
  return `${columnLetter(maxCol + 2)}2`;
}
