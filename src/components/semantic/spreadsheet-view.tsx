"use client";

import * as React from "react";
import { SemanticChart } from "@/components/semantic/semantic-chart";
import { cellKey, columnLetter, parseCell } from "@/lib/work/deliverables/semantic/workbook/address";
import { WorkbookEngine, resolveChart } from "@/lib/work/deliverables/semantic/workbook/engine";
import { isError, type Value } from "@/lib/work/deliverables/semantic/workbook/formula";
import { formatValue } from "@/lib/work/deliverables/semantic/workbook/format";
import { sheetExtent, type WorkbookModel } from "@/lib/work/deliverables/semantic/workbook/model";
import { hiddenRows } from "@/lib/work/deliverables/semantic/workbook/view";
import type { SemanticOpsHandler } from "@/components/semantic/semantic-artifact-view";

/**
 * The workbook in the canvas: computed values with their formats, the formula
 * of the selected cell, frozen panes, filtered rows hidden, and the charts
 * drawn from the same computed values. Editing a cell sends ONE operation; the
 * values that change because of it settle in presence blue once.
 */

const ROW_H = 28;
const HEAD_H = 24;
const ROWHEAD_W = 44;
const MAX_ROWS = 400;
const MAX_COLS = 40;

function colWidth(model: WorkbookModel["sheets"][number], col: number): number {
  const width = model.columns[columnLetter(col)]?.width;
  return width ? Math.round(width * 7 + 10) : 104;
}

function display(value: Value, fmt?: string): string {
  return formatValue(value, fmt ?? null);
}

/** What a person typed -> one operation. "=" makes a formula: that is their explicit choice. */
function opFor(sheet: string, cell: string, text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("=") && trimmed.length > 1) return { op: "setFormula", sheet, cell, formula: trimmed };
  if (trimmed === "") return { op: "setCell", sheet, cell, value: null };
  if (/^(true|false)$/i.test(trimmed)) return { op: "setCell", sheet, cell, value: trimmed.toLowerCase() === "true" };
  const percent = /^-?[\d,]*\.?\d+%$/.test(trimmed);
  const numeric = Number((percent ? trimmed.slice(0, -1) : trimmed).replace(/,/g, ""));
  if (/^-?[\d,]*\.?\d+%?$/.test(trimmed) && Number.isFinite(numeric)) {
    return { op: "setCell", sheet, cell, value: percent ? numeric / 100 : numeric };
  }
  return { op: "setCell", sheet, cell, value: text };
}

export function SpreadsheetView({
  model,
  readOnly,
  onApplyOps,
}: {
  model: WorkbookModel;
  readOnly: boolean;
  onApplyOps?: SemanticOpsHandler;
}) {
  const engine = React.useMemo(() => new WorkbookEngine(model), [model]);
  const [sheetIndex, setSheetIndex] = React.useState(0);
  const sheet = model.sheets[Math.min(sheetIndex, model.sheets.length - 1)];
  const [selected, setSelected] = React.useState("A1");
  const [editing, setEditing] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);

  // Which displayed values changed since the last model: those settle once.
  const previous = React.useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = React.useState<Set<string>>(new Set());
  const shown = React.useMemo(() => {
    const out = new Map<string, string>();
    for (const s of model.sheets) {
      for (const [key, stored] of Object.entries(s.cells)) out.set(`${s.name}!${key}`, display(engine.value(s.name, key), stored.fmt));
    }
    return out;
  }, [engine, model]);
  React.useEffect(() => {
    const before = previous.current;
    previous.current = shown;
    if (!before) return;
    const diff = new Set<string>();
    for (const [key, text] of shown) if (before.get(key) !== text) diff.add(key);
    setChanged(diff);
    if (diff.size) setNote(`${diff.size} value${diff.size === 1 ? "" : "s"} changed`);
  }, [shown]);

  const extent = sheetExtent(sheet);
  const freezeRows = sheet.freeze.rows;
  const freezeCols = sheet.freeze.cols;
  const rows = Math.min(MAX_ROWS, Math.max(extent.rows + 3, 12));
  const cols = Math.min(MAX_COLS, Math.max(extent.cols + 2, 8));
  const hidden = React.useMemo(() => {
    const set = new Set<number>();
    for (const table of sheet.tables) for (const row of hiddenRows(engine, sheet, table)) set.add(row);
    return set;
  }, [engine, sheet]);
  const widths = React.useMemo(() => Array.from({ length: cols }, (_, i) => colWidth(sheet, i + 1)), [sheet, cols]);
  const leftOf = (col: number) => ROWHEAD_W + widths.slice(0, col - 1).reduce((a, b) => a + b, 0);

  const selectedCell = sheet.cells[selected];
  const formulaText = selectedCell?.f !== undefined ? `=${selectedCell.f}` : selectedCell?.v === undefined || selectedCell.v === null ? "" : String(selectedCell.v);
  const [draft, setDraft] = React.useState(formulaText);
  React.useEffect(() => setDraft(formulaText), [formulaText, selected, sheet.name]);

  const commit = async (address: string, text: string) => {
    setEditing(null);
    if (!onApplyOps || readOnly) return;
    if (text === formulaText) return;
    setBusy(true);
    setError(null);
    const result = await onApplyOps([opFor(sheet.name, address, text)]);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const move = (dc: number, dr: number) => {
    const at = parseCell(selected) ?? { col: 1, row: 1 };
    let row = at.row + dr;
    while (hidden.has(row) && row > 1 && row < rows) row += dr || 1;
    const next = cellKey({ col: Math.min(cols, Math.max(1, at.col + dc)), row: Math.min(rows, Math.max(1, row)) });
    setSelected(next);
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-cell="${next}"]`)?.focus());
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (editing) return;
    const keys: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Tab: [1, 0] };
    if (keys[event.key]) {
      event.preventDefault();
      move(...(event.shiftKey && event.key === "Tab" ? ([-1, 0] as [number, number]) : keys[event.key]));
    } else if (!readOnly && onApplyOps && (event.key === "Enter" || event.key === "F2")) {
      event.preventDefault();
      setEditing(selected);
    } else if (!readOnly && onApplyOps && (event.key === "Backspace" || event.key === "Delete")) {
      event.preventDefault();
      void commit(selected, "");
    } else if (!readOnly && onApplyOps && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      setDraft(event.key);
      setEditing(selected);
      event.preventDefault();
    }
  };

  const formulas = model.sheets.reduce((n, s) => n + Object.values(s.cells).filter((c) => c.f !== undefined).length, 0);

  return (
    <div className="sx" data-kind="spreadsheet">
      <div className="sx-bar" role="tablist" aria-label="Sheets">
        {model.sheets.map((s, i) => (
          <button
            key={s.name}
            role="tab"
            type="button"
            className="sx-tab sx-annot"
            aria-selected={s === sheet}
            onClick={() => {
              setSheetIndex(i);
              setSelected("A1");
            }}
          >
            {s.name}
          </button>
        ))}
        <span className="sx-annot ml-auto truncate" aria-live="polite" data-tone={error ? "attention" : undefined}>
          {error ?? (busy ? "Recalculating…" : note ?? `${formulas} formula${formulas === 1 ? "" : "s"}${Object.keys(model.names).length ? ` · ${Object.keys(model.names).length} named` : ""}`)}
        </span>
      </div>
      <div className="sx-formula">
        <span className="sx-annot" aria-label="Selected cell">
          {selected}
        </span>
        <input
          aria-label={`Contents of ${selected}`}
          value={editing === "bar" ? draft : formulaText}
          readOnly={readOnly || !onApplyOps}
          onFocus={() => {
            if (!readOnly && onApplyOps) {
              setDraft(formulaText);
              setEditing("bar");
            }
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => editing === "bar" && void commit(selected, draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
            if (event.key === "Escape") {
              setDraft(formulaText);
              setEditing(null);
            }
          }}
        />
      </div>
      <div className="sx-grid-wrap" ref={gridRef} onKeyDown={onKey}>
        <table className="sx-grid" role="grid" aria-label={`${sheet.name}, ${model.title}`} aria-rowcount={rows} aria-colcount={cols}>
          <colgroup>
            <col style={{ width: ROWHEAD_W }} />
            {widths.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sx-rowhead" aria-hidden />
              {widths.map((_, i) => (
                <th key={i} scope="col" style={i < freezeCols ? { position: "sticky", left: leftOf(i + 1), zIndex: 3 } : undefined}>
                  {columnLetter(i + 1)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => r + 1)
              .filter((row) => !hidden.has(row))
              .map((row) => {
                const frozenRow = row <= freezeRows;
                return (
                  <tr key={row}>
                    <th scope="row" className="sx-rowhead" style={frozenRow ? { top: HEAD_H + (row - 1) * ROW_H, position: "sticky", zIndex: 3 } : { position: "sticky", left: 0 }}>
                      {row}
                    </th>
                    {widths.map((_, c) => {
                      const col = c + 1;
                      const key = cellKey({ col, row });
                      const stored = sheet.cells[key];
                      const value = stored ? engine.value(sheet.name, key) : null;
                      const frozenCol = col <= freezeCols;
                      const style: React.CSSProperties = {};
                      if (frozenRow) style.top = HEAD_H + (row - 1) * ROW_H;
                      if (frozenCol) style.left = leftOf(col);
                      if (frozenRow || frozenCol) {
                        style.position = "sticky";
                        style.zIndex = frozenRow && frozenCol ? 2 : 1;
                      }
                      const isEditing = editing === key;
                      return (
                        <td
                          key={key}
                          data-cell={key}
                          className={[
                            "sx-cell",
                            row === freezeRows ? "sx-freeze-edge" : "",
                            col === freezeCols ? "sx-freeze-col" : "",
                          ].join(" ")}
                          style={style}
                          role="gridcell"
                          tabIndex={selected === key ? 0 : -1}
                          aria-selected={selected === key}
                          aria-label={`${key}${stored?.f ? `, formula =${stored.f}` : ""}`}
                          data-num={typeof value === "number"}
                          data-bold={stored?.bold ?? false}
                          data-error={isError(value)}
                          data-changed={changed.has(`${sheet.name}!${key}`)}
                          title={stored?.f ? `=${stored.f}` : undefined}
                          onClick={() => setSelected(key)}
                          onDoubleClick={() => !readOnly && onApplyOps && setEditing(key)}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              aria-label={`Edit ${key}`}
                              defaultValue={draft !== formulaText ? draft : formulaText}
                              onBlur={(event) => void commit(key, event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  (event.target as HTMLInputElement).blur();
                                  move(0, 1);
                                }
                                if (event.key === "Escape") setEditing(null);
                              }}
                            />
                          ) : stored ? (
                            display(value, stored.fmt)
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>
        {sheet.charts.length > 0 && (
          <div className="sx-charts">
            {sheet.charts.map((chart) => {
              const data = resolveChart(engine, sheet.name, chart);
              const anyChanged = chart.series.some(() => changed.size > 0);
              return (
                <figure key={chart.id} className="m-0" data-changed={anyChanged || undefined}>
                  <figcaption className="mb-2 flex items-baseline gap-3">
                    <span className="sx-chart-title">{chart.title ?? "Chart"}</span>
                    <span className="sx-annot">
                      {chart.type} · {chart.series.map((s) => s.values).join(", ")}
                    </span>
                  </figcaption>
                  <SemanticChart type={chart.type} title={chart.title} categories={data.categories} series={data.series} />
                </figure>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
