/**
 * Read-side helpers shared by the canvas, the exporter and the chat model's
 * outline: which rows a table's filters hide, and the bounded, addressable
 * text the model reads before it edits a workbook.
 */

import { oneLine } from "@/lib/work/deliverables/semantic/shared";
import { cellKey, parseCell, parseRange } from "@/lib/work/deliverables/semantic/workbook/address";
import type { WorkbookEngine } from "@/lib/work/deliverables/semantic/workbook/engine";
import { isError, type Value } from "@/lib/work/deliverables/semantic/workbook/formula";
import { formatValue } from "@/lib/work/deliverables/semantic/workbook/format";
import {
  sheetExtent,
  type WorkbookModel,
  type WorkbookSheet,
  type WorkbookTable,
} from "@/lib/work/deliverables/semantic/workbook/model";
import { columnNumber } from "@/lib/work/deliverables/semantic/workbook/address";

function passes(value: Value, filter: WorkbookTable["filters"][number]): boolean {
  if (filter.op === "nonempty") return value !== null && value !== "";
  if (isError(value)) return false;
  const target = filter.value;
  if (filter.op === "contains") {
    return String(value ?? "").toLowerCase().includes(String(target ?? "").toLowerCase());
  }
  const numeric = typeof value === "number" && typeof target === "number";
  const a = numeric ? (value as number) : String(value ?? "").toLowerCase();
  const b = numeric ? (target as number) : String(target ?? "").toLowerCase();
  switch (filter.op) {
    case "eq": return a === b;
    case "ne": return a !== b;
    case "gt": return a > b;
    case "gte": return a >= b;
    case "lt": return a < b;
    default: return a <= b;
  }
}

/** Data rows (1-based sheet rows) a table's filters hide. The header row is never hidden. */
export function hiddenRows(engine: WorkbookEngine, sheet: WorkbookSheet, table: WorkbookTable): Set<number> {
  const hidden = new Set<number>();
  if (!table.filters.length) return hidden;
  const range = parseRange(table.range);
  if (!range) return hidden;
  for (let row = range.start.row + 1; row <= range.end.row; row++) {
    const visible = table.filters.every((filter) =>
      passes(engine.value(sheet.name, { col: columnNumber(filter.column), row }), filter)
    );
    if (!visible) hidden.add(row);
  }
  return hidden;
}

function literal(value: Value): string {
  if (typeof value === "string") return JSON.stringify(oneLine(value, 60));
  if (isError(value)) return value.error;
  return String(value);
}

/**
 * The workbook as the chat model reads it before an edit: every non-empty
 * cell by address, formulas with their computed value, formats, names,
 * tables and charts. Bounded; the tail says how much was left out.
 */
export function outlineWorkbook(model: WorkbookModel, engine: WorkbookEngine, maxChars = 12_000): string {
  const lines: string[] = [];
  lines.push(`Workbook "${model.title}" — ${model.sheets.length} sheet${model.sheets.length === 1 ? "" : "s"}`);
  const names = Object.entries(model.names);
  if (names.length) lines.push(`Names: ${names.map(([name, ref]) => `${name} = ${ref}`).join("; ")}`);
  let used = lines.join("\n").length;
  let omitted = 0;
  for (const sheet of model.sheets) {
    const extent = sheetExtent(sheet);
    const header =
      `Sheet "${sheet.name}" (used A1:${cellKey({ col: Math.max(extent.cols, 1), row: Math.max(extent.rows, 1) })}` +
      `${sheet.freeze.rows || sheet.freeze.cols ? `, frozen ${sheet.freeze.rows}r/${sheet.freeze.cols}c` : ""})`;
    lines.push(header);
    used += header.length + 1;
    const keys = Object.keys(sheet.cells).sort((a, b) => {
      const x = parseCell(a)!;
      const y = parseCell(b)!;
      return x.row - y.row || x.col - y.col;
    });
    for (const key of keys) {
      const stored = sheet.cells[key];
      if (stored.f === undefined && stored.v === undefined) continue;
      const value = engine.value(sheet.name, key);
      let line = `  ${key}: `;
      if (stored.f !== undefined) line += `=${stored.f} → ${literal(value)}${stored.opaque ? " (imported, not computed)" : ""}`;
      else line += literal(stored.v ?? null);
      if (stored.fmt) line += ` [${stored.fmt}${typeof value === "number" ? ` shows ${formatValue(value, stored.fmt)}` : ""}]`;
      if (used + line.length + 1 > maxChars) {
        omitted++;
        continue;
      }
      lines.push(line);
      used += line.length + 1;
    }
    for (const table of sheet.tables) {
      const line = `  table ${table.id} "${table.name}" ${table.range}${table.filters.length ? ` filters: ${table.filters.map((f) => `${f.column} ${f.op} ${f.value ?? ""}`.trim()).join(", ")}` : ""}`;
      lines.push(line);
      used += line.length + 1;
    }
    for (const chart of sheet.charts) {
      const line = `  chart ${chart.id} ${chart.type}${chart.title ? ` "${chart.title}"` : ""} categories ${chart.categories}; series ${chart.series.map((s) => `${s.name ?? "?"}=${s.values}`).join(", ")}; at ${chart.anchor.cell}`;
      lines.push(line);
      used += line.length + 1;
    }
  }
  if (omitted) lines.push(`… ${omitted} more cells not shown`);
  return lines.join("\n");
}
