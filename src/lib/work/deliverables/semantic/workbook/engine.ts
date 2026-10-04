/**
 * The workbook's calculation engine: dependency graph, topological
 * recalculation, cycle detection and incremental recalculation.
 *
 * Built per model version (models are immutable values). A full build
 * evaluates every formula once, in dependency order. An incremental build is
 * given the previous version's engine and the cells an edit touched; it copies
 * every value it can prove unaffected and evaluates only the transitive
 * dependents of the touched cells — which is what "increase the conversion
 * assumption and update the charts" means, and `evaluated` is the list a test
 * reads to prove it.
 *
 * A formula on a cycle evaluates to #CYCLE! (Excel shows 0 and a warning; an
 * explicit error is the honest form). Edits that would create a cycle are
 * refused before they are stored (`ops.ts`), so a cycle only exists in a
 * workbook imported with one.
 */

import {
  cellKey,
  eachCell,
  parseCell,
  rangeSize,
  parseQualifiedRange,
  type CellAddress,
  type RangeAddress,
} from "@/lib/work/deliverables/semantic/workbook/address";
import {
  err,
  evaluate,
  isError,
  walk,
  type EvalContext,
  type Matrix,
  type Node,
  type Value,
} from "@/lib/work/deliverables/semantic/workbook/formula";
import { formulaAst, type WorkbookModel, type WorkbookSheet } from "@/lib/work/deliverables/semantic/workbook/model";

/** `sheetname-lowercase!A1` — the engine's cell identity. */
export type CellId = string;

export function cellId(sheet: string, address: CellAddress | string): CellId {
  const key = typeof address === "string" ? address.toUpperCase() : cellKey(address);
  return `${sheet.toLowerCase()}!${key}`;
}

interface RangeDep {
  sheet: string;
  range: RangeAddress;
}

interface FormulaCell {
  id: CellId;
  sheet: string;
  node: Node;
  cells: Set<CellId>;
  ranges: RangeDep[];
}

function contains(range: RangeAddress, address: CellAddress): boolean {
  return (
    address.col >= range.start.col &&
    address.col <= range.end.col &&
    address.row >= range.start.row &&
    address.row <= range.end.row
  );
}

function splitId(id: CellId): { sheet: string; address: CellAddress } {
  const bang = id.lastIndexOf("!");
  return { sheet: id.slice(0, bang), address: parseCell(id.slice(bang + 1))! };
}

export class WorkbookEngine {
  readonly values = new Map<CellId, Value>();
  readonly cycles = new Set<CellId>();
  /** The formula cells this build evaluated, in evaluation order. */
  readonly evaluated: CellId[] = [];

  private readonly sheets = new Map<string, WorkbookSheet>();
  private readonly formulas = new Map<CellId, FormulaCell>();
  private readonly formulasBySheet = new Map<string, { id: CellId; address: CellAddress }[]>();
  private readonly names = new Map<string, { sheet: string; range: RangeAddress }>();
  /** Exact-cell reverse edges. Range references are scanned (there are few). */
  private readonly readers = new Map<CellId, Set<CellId>>();
  private readonly rangeReaders: { reader: CellId; dep: RangeDep }[] = [];
  private order: CellId[] = [];

  constructor(
    readonly model: WorkbookModel,
    incremental?: { previous: WorkbookEngine; changed: Iterable<CellId> }
  ) {
    for (const sheet of model.sheets) this.sheets.set(sheet.name.toLowerCase(), sheet);
    for (const [name, ref] of Object.entries(model.names)) {
      const target = parseQualifiedRange(ref);
      if (target?.sheet) this.names.set(name.toLowerCase(), { sheet: target.sheet.toLowerCase(), range: target.range });
    }
    this.buildGraph();
    this.order = this.topologicalOrder();
    if (incremental) this.recalcIncremental(incremental.previous, incremental.changed);
    else this.recalcAll();
  }

  // ── Graph ────────────────────────────────────────────────────────────────

  private buildGraph(): void {
    for (const sheet of this.model.sheets) {
      const sheetKey = sheet.name.toLowerCase();
      for (const [key, cell] of Object.entries(sheet.cells)) {
        if (cell.f === undefined || cell.opaque) continue;
        const id = cellId(sheetKey, key);
        let node: Node;
        try {
          node = formulaAst(cell.f);
        } catch {
          node = { k: "err", v: "#NAME?" };
        }
        const formula: FormulaCell = { id, sheet: sheetKey, node, cells: new Set(), ranges: [] };
        walk(node, (n) => {
          if (n.k === "ref") formula.cells.add(cellId(n.sheet ?? sheetKey, n.at));
          else if (n.k === "range") {
            formula.ranges.push({
              sheet: (n.sheet ?? sheetKey).toLowerCase(),
              range: { start: { col: n.start.col, row: n.start.row }, end: { col: n.end.col, row: n.end.row } },
            });
          } else if (n.k === "name") {
            const target = this.names.get(n.name.toLowerCase());
            if (target) formula.ranges.push(target);
          }
        });
        this.formulas.set(id, formula);
        let list = this.formulasBySheet.get(sheetKey);
        if (!list) this.formulasBySheet.set(sheetKey, (list = []));
        list.push({ id, address: parseCell(key)! });
      }
    }
    for (const formula of this.formulas.values()) {
      for (const dep of formula.cells) {
        let set = this.readers.get(dep);
        if (!set) this.readers.set(dep, (set = new Set()));
        set.add(formula.id);
      }
      for (const dep of formula.ranges) this.rangeReaders.push({ reader: formula.id, dep });
    }
  }

  /** The formula cells that read `id` directly. */
  directReaders(id: CellId): CellId[] {
    const out = new Set(this.readers.get(id) ?? []);
    const { sheet, address } = splitId(id);
    for (const { reader, dep } of this.rangeReaders) {
      if (dep.sheet === sheet && contains(dep.range, address)) out.add(reader);
    }
    return [...out];
  }

  /** The formula cells a formula reads (directly or through a range or a name). */
  private formulaDeps(formula: FormulaCell): CellId[] {
    const out: CellId[] = [];
    for (const dep of formula.cells) if (this.formulas.has(dep)) out.push(dep);
    for (const dep of formula.ranges) {
      const onSheet = this.formulasBySheet.get(dep.sheet) ?? [];
      // Walk whichever is smaller: the range's cells or the sheet's formulas.
      if (rangeSize(dep.range) <= onSheet.length) {
        for (const address of eachCell(dep.range)) {
          const id = cellId(dep.sheet, address);
          if (this.formulas.has(id)) out.push(id);
        }
      } else {
        for (const other of onSheet) if (contains(dep.range, other.address)) out.push(other.id);
      }
    }
    return out;
  }

  /** Every cell that transitively depends on any of `ids`. */
  dependentsOf(ids: Iterable<CellId>): Set<CellId> {
    const seen = new Set<CellId>();
    const queue = [...ids];
    while (queue.length) {
      const id = queue.pop()!;
      for (const reader of this.directReaders(id)) {
        if (seen.has(reader)) continue;
        seen.add(reader);
        queue.push(reader);
      }
    }
    return seen;
  }

  /**
   * Dependency order over formula cells, by Tarjan's strongly connected
   * components (iterative, so a 50,000-cell chain does not exhaust the stack).
   * Tarjan emits a component only after everything it reads, which is exactly
   * evaluation order. A component of more than one cell, or a cell that reads
   * itself, is a cycle: those cells — and only those — go into `cycles`;
   * everything downstream still evaluates, reading #CYCLE! from them.
   */
  private topologicalOrder(): CellId[] {
    const deps = new Map<CellId, CellId[]>();
    for (const formula of this.formulas.values()) deps.set(formula.id, this.formulaDeps(formula));
    const index = new Map<CellId, number>();
    const low = new Map<CellId, number>();
    const onStack = new Set<CellId>();
    const stack: CellId[] = [];
    const order: CellId[] = [];
    let counter = 0;
    for (const root of this.formulas.keys()) {
      if (index.has(root)) continue;
      const work: { id: CellId; next: number }[] = [{ id: root, next: 0 }];
      index.set(root, counter);
      low.set(root, counter++);
      stack.push(root);
      onStack.add(root);
      while (work.length) {
        const frame = work[work.length - 1];
        const list = deps.get(frame.id)!;
        if (frame.next < list.length) {
          const dep = list[frame.next++];
          if (!index.has(dep)) {
            index.set(dep, counter);
            low.set(dep, counter++);
            stack.push(dep);
            onStack.add(dep);
            work.push({ id: dep, next: 0 });
          } else if (onStack.has(dep)) {
            low.set(frame.id, Math.min(low.get(frame.id)!, index.get(dep)!));
          }
          continue;
        }
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1].id;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const component: CellId[] = [];
          let member: CellId;
          do {
            member = stack.pop()!;
            onStack.delete(member);
            component.push(member);
          } while (member !== frame.id);
          const selfLoop = component.length === 1 && list.includes(frame.id);
          if (component.length > 1 || selfLoop) for (const id of component) this.cycles.add(id);
          order.push(...component);
        }
      }
    }
    return order;
  }

  /** True when the given formula cell sits on a dependency cycle. */
  onCycle(id: CellId): boolean {
    return this.cycles.has(id);
  }

  // ── Evaluation ───────────────────────────────────────────────────────────

  private context(sheetKey: string): EvalContext {
    return {
      cell: (sheet, address) => this.read((sheet ?? sheetKey).toLowerCase(), address),
      range: (sheet, start, end) => this.readRange((sheet ?? sheetKey).toLowerCase(), { start, end }),
      name: (name) => {
        const target = this.names.get(name.toLowerCase());
        if (!target) return err("#NAME?");
        const { range } = target;
        if (range.start.col === range.end.col && range.start.row === range.end.row) {
          return this.read(target.sheet, range.start);
        }
        return this.readRange(target.sheet, range);
      },
    };
  }

  private read(sheetKey: string, address: CellAddress): Value {
    const sheet = this.sheets.get(sheetKey);
    if (!sheet) return err("#REF!");
    const id = cellId(sheetKey, address);
    if (this.formulas.has(id)) return this.cycles.has(id) ? err("#CYCLE!") : (this.values.get(id) ?? null);
    const cell = sheet.cells[cellKey(address)];
    if (!cell) return null;
    return cell.v ?? null;
  }

  private readRange(sheetKey: string, range: RangeAddress): Matrix | { error: "#REF!" } {
    if (!this.sheets.has(sheetKey)) return err("#REF!") as { error: "#REF!" };
    const rows: Matrix = [];
    for (let row = Math.min(range.start.row, range.end.row); row <= Math.max(range.start.row, range.end.row); row++) {
      const line: Value[] = [];
      for (let col = Math.min(range.start.col, range.end.col); col <= Math.max(range.start.col, range.end.col); col++) {
        line.push(this.read(sheetKey, { col, row }));
      }
      rows.push(line);
    }
    return rows;
  }

  private evaluateCell(id: CellId): void {
    const formula = this.formulas.get(id)!;
    this.evaluated.push(id);
    if (this.cycles.has(id)) {
      this.values.set(id, err("#CYCLE!"));
      return;
    }
    this.values.set(id, evaluate(formula.node, this.context(formula.sheet)));
  }

  private recalcAll(): void {
    for (const id of this.order) this.evaluateCell(id);
  }

  private recalcIncremental(previous: WorkbookEngine, changed: Iterable<CellId>): void {
    const changedIds = [...changed];
    const dirty = this.dependentsOf(changedIds);
    for (const id of changedIds) if (this.formulas.has(id)) dirty.add(id);
    for (const id of this.order) {
      if (dirty.has(id) || !previous.values.has(id)) this.evaluateCell(id);
      else this.values.set(id, previous.values.get(id)!);
    }
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** The value a cell shows: computed for a formula, cached for an opaque one, stored otherwise. */
  value(sheet: string, address: CellAddress | string): Value {
    const parsed = typeof address === "string" ? parseCell(address) : address;
    if (!parsed) return err("#REF!");
    const sheetKey = sheet.toLowerCase();
    const s = this.sheets.get(sheetKey);
    if (!s) return err("#REF!");
    const id = cellId(sheetKey, parsed);
    if (this.formulas.has(id)) return this.cycles.has(id) ? err("#CYCLE!") : (this.values.get(id) ?? null);
    return s.cells[cellKey(parsed)]?.v ?? null;
  }

  /** A qualified or sheet-relative range as a matrix of values. */
  rangeValues(defaultSheet: string, ref: string): Matrix {
    const parsed = parseQualifiedRange(ref);
    if (!parsed) return [];
    const result = this.readRange((parsed.sheet ?? defaultSheet).toLowerCase(), parsed.range);
    return isError(result) ? [] : result;
  }

  isFormula(sheet: string, address: string): boolean {
    return this.formulas.has(cellId(sheet, address));
  }
}

/** The data a chart draws, resolved against computed values. */
export interface ResolvedChart {
  categories: string[];
  series: { name: string; values: (number | null)[] }[];
}

export function resolveChart(
  engine: WorkbookEngine,
  sheet: string,
  chart: { categories: string; series: { name?: string; values: string }[] }
): ResolvedChart {
  const flat = (matrix: Matrix) => matrix.flat();
  const categories = flat(engine.rangeValues(sheet, chart.categories)).map((value) =>
    value === null ? "" : isError(value) ? value.error : String(value)
  );
  return {
    categories,
    series: chart.series.map((series, index) => ({
      name: series.name ?? `Series ${index + 1}`,
      values: flat(engine.rangeValues(sheet, series.values)).map((value) => (typeof value === "number" ? value : null)),
    })),
  };
}
