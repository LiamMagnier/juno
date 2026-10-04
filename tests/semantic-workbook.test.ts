import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { Workbook } from "exceljs";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import { WorkbookEngine, resolveChart } from "@/lib/work/deliverables/semantic/workbook/engine";
import { evaluate, parseFormula, printFormula, shiftReferences } from "@/lib/work/deliverables/semantic/workbook/formula";
import { formatValue } from "@/lib/work/deliverables/semantic/workbook/format";
import { normalizeWorkbook, type WorkbookModel } from "@/lib/work/deliverables/semantic/workbook/model";
import { applyWorkbookOps, workbookOpsSchema, type WorkbookOp } from "@/lib/work/deliverables/semantic/workbook/ops";
import { hiddenRows, outlineWorkbook } from "@/lib/work/deliverables/semantic/workbook/view";
import { exportWorkbookXlsx, readWorkbookXlsx } from "@/lib/work/deliverables/semantic/workbook/xlsx";

/*
 * The semantic workbook: formulas, dependency recalculation, edit operations
 * and the .xlsx roundtrip. The headline case is BRIEF §29's own example —
 * "Increase conversion assumption to 7.5% and update the charts" — which must
 * change ONE stored cell and recompute only what depends on it.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function growthModel(): WorkbookModel {
  const modelRows: unknown[][] = [[{ v: "Month", bold: true }, { v: "Visitors", bold: true }, { v: "Orders", bold: true }, { v: "Revenue", bold: true }]];
  MONTHS.forEach((month, i) => {
    const r = i + 2;
    modelRows.push([
      month,
      i === 0 ? { f: "=Assumptions!B2", fmt: "integer" } : { f: `=ROUND(B${r - 1}*(1+Assumptions!$B$5),0)`, fmt: "integer" },
      { f: `=ROUND(B${r}*conversion,0)`, fmt: "integer" },
      { f: `=C${r}*Assumptions!$B$4`, fmt: "currency" },
    ]);
  });
  modelRows.push([{ v: "Total", bold: true }, null, { f: "=SUM(C2:C13)" }, { f: "=SUM(D2:D13)", fmt: "currency" }]);
  return normalizeWorkbook({
    title: "Growth model",
    sheets: [
      {
        name: "Assumptions",
        rows: [
          [{ v: "Assumption", bold: true }, { v: "Value", bold: true }],
          ["Monthly visitors", { v: 120000, fmt: "integer" }],
          ["Conversion rate", { v: 0.05, fmt: "percent" }],
          ["Average order value", { v: 48, fmt: "currency" }],
          ["Monthly growth", { v: 0.04, fmt: "percent" }],
          ["Scraped note", "=HYPERLINK(\"http://evil.example\",\"click\")"],
        ],
        freeze: { rows: 1 },
      },
      {
        name: "Model",
        rows: modelRows,
        freeze: { rows: 1, cols: 1 },
        columns: { A: { width: 12 } },
        tables: [{ name: "Plan", range: "A1:D13" }],
        charts: [{ type: "line", title: "Revenue", categories: "A2:A13", series: [{ name: "Revenue", values: "D2:D13" }], anchor: { cell: "F2" } }],
      },
      { name: "Notes", rows: [["Unrelated", { f: "=1+1" }]] },
    ],
    names: { conversion: "Assumptions!$B$3" },
  });
}

function evalText(formula: string): unknown {
  return evaluate(parseFormula(formula), {
    cell: (_s, a) => ([[1, 2, 3], ["a", "b", null]] as unknown[][])[a.row - 1]?.[a.col - 1] as never ?? null,
    range: (_s, start, end) => {
      const out: never[][] = [];
      for (let r = start.row; r <= end.row; r++) {
        const row: never[] = [];
        for (let c = start.col; c <= end.col; c++) row.push((([[1, 2, 3], ["a", "b", null]] as unknown[][])[r - 1]?.[c - 1] ?? null) as never);
        out.push(row);
      }
      return out;
    },
    name: () => ({ error: "#NAME?" }),
  });
}

// ── Formula language ──────────────────────────────────────────────────────

test("formulas follow Excel precedence and print canonically", () => {
  assert.equal(evalText("=-2^2"), 4);
  assert.equal(evalText("=2+3*4"), 14);
  assert.equal(evalText("=(2+3)*4"), 20);
  assert.equal(evalText("=50%"), 0.5);
  assert.equal(evalText('="a"&1+1'), "a2");
  assert.deepEqual(evalText("=1/0"), { error: "#DIV/0!" });
  assert.equal(printFormula(parseFormula("= sum( a1 : b2 ) + 'My Sheet'!$C$3")), "SUM(A1:B2)+'My Sheet'!$C$3");
  assert.equal(printFormula(parseFormula("=(1+2)*3")), "(1+2)*3");
  assert.equal(printFormula(parseFormula("=1-(2-3)")), "1-(2-3)");
});

test("the common functions compute like Excel", () => {
  assert.equal(evalText("=SUM(A1:C1)"), 6);
  assert.equal(evalText("=AVERAGE(A1:C1)"), 2);
  assert.equal(evalText("=MIN(A1:C1)+MAX(A1:C1)"), 4);
  assert.equal(evalText("=COUNT(A1:C2)"), 3);
  assert.equal(evalText("=COUNTA(A1:C2)"), 5);
  assert.equal(evalText('=IF(A1>0,"pos","neg")'), "pos");
  assert.equal(evalText("=ROUND(2.345,2)"), 2.35);
  assert.equal(evalText("=ROUND(1.005,2)"), 1.01);
  assert.equal(evalText("=ROUNDDOWN(-2.7,0)"), -2);
  assert.equal(evalText('=SUMIF(A1:C1,">1")'), 5);
  assert.equal(evalText('=COUNTIF(A2:C2,"a")'), 1);
  assert.equal(evalText("=IFERROR(1/0,7)"), 7);
  assert.equal(evalText("=INDEX(A1:C1,3)"), 3);
  assert.equal(evalText("=MATCH(2,A1:C1,0)"), 2);
  assert.equal(evalText('=VLOOKUP(1,A1:C1,3,FALSE)'), 3);
  assert.equal(evalText('=UPPER(LEFT("alevr",2))&LEN("abc")'), "AL3");
  assert.equal(Math.round((evalText("=PMT(0.05/12,360,300000)") as number) * 100) / 100, -1610.46);
  assert.deepEqual(evalText("=NOPE(1)"), { error: "#NAME?" });
});

test("reference shifting inserts and deletes like Excel", () => {
  const shifted = shiftReferences(parseFormula("=SUM(B2:B10)+B12+Other!B5"), { sheet: "S", formulaSheet: "S", axis: "row", at: 5, count: 2 });
  assert.equal(printFormula(shifted), "SUM(B2:B12)+B14+Other!B5");
  const deleted = shiftReferences(parseFormula("=B3+SUM(B2:B6)"), { sheet: "S", formulaSheet: "S", axis: "row", at: 3, count: -2 });
  assert.equal(printFormula(deleted), "#REF!+SUM(B2:B4)");
});

test("number formats render as Excel shows them", () => {
  assert.equal(formatValue(1234.5, '"$"#,##0.00'), "$1,234.50");
  assert.equal(formatValue(0.075, "0.0%"), "7.5%");
  assert.equal(formatValue(-12, "#,##0"), "-12");
  assert.equal(formatValue(46112, "yyyy-mm-dd"), "2026-03-31");
  assert.equal(formatValue(46112, "mmm yyyy"), "Mar 2026");
  assert.equal(formatValue(0.1 + 0.2, null), "0.3");
});

// ── Model and injection rule ──────────────────────────────────────────────

test("a string that starts with = stays text; only {f} is a formula", () => {
  const model = growthModel();
  const note = model.sheets[0].cells.B6;
  assert.equal(note.f, undefined);
  assert.equal(note.v, '=HYPERLINK("http://evil.example","click")');
  const engine = new WorkbookEngine(model);
  assert.equal(engine.isFormula("Assumptions", "B6"), false);
  assert.equal(engine.value("Assumptions", "B6"), '=HYPERLINK("http://evil.example","click")');
});

test("normalize refuses unknown functions, missing sheets and undefined names", () => {
  const bad = (cell: unknown) => () =>
    normalizeWorkbook({ title: "x", sheets: [{ name: "S", cells: { A1: cell } }] });
  assert.throws(bad({ f: "=WEBSERVICE(\"http://x\")" }), (e: unknown) => e instanceof SemanticError && e.code === "invalid_formula");
  assert.throws(bad({ f: "=Missing!A1" }), /does not exist/);
  assert.throws(bad({ f: "=rate*2" }), /not defined/);
  assert.throws(bad({ f: "=SUM(A1:" }), /not a valid formula/);
  assert.throws(() => normalizeWorkbook({ title: "x", sheets: [{ name: "S" }, { name: "s" }] }), /both named/);
});

test("the engine computes the growth model", () => {
  const engine = new WorkbookEngine(growthModel());
  assert.equal(engine.value("Model", "B2"), 120000);
  assert.equal(engine.value("Model", "B3"), 124800);
  assert.equal(engine.value("Model", "C2"), 6000);
  assert.equal(engine.value("Model", "D2"), 288000);
  const total = engine.value("Model", "D14") as number;
  assert.ok(total > 4_000_000 && total < 5_000_000, String(total));
  assert.equal(engine.cycles.size, 0);
});

// ── The headline edit ─────────────────────────────────────────────────────

test("'Increase conversion assumption to 7.5% and update the charts' changes one cell and its dependents only", () => {
  const model = growthModel();
  const before = new WorkbookEngine(model);
  const chartBefore = resolveChart(before, "Model", model.sheets[1].charts[0]);
  const ops = workbookOpsSchema.parse([{ op: "setCell", sheet: "Assumptions", cell: "conversion", value: 0.075 }]);

  const result = applyWorkbookOps(model, ops, { previous: before });

  // The stored model: exactly one cell differs.
  const diffs: string[] = [];
  for (const [i, sheet] of result.model.sheets.entries()) {
    const old = model.sheets[i];
    for (const key of new Set([...Object.keys(sheet.cells), ...Object.keys(old.cells)])) {
      if (JSON.stringify(sheet.cells[key]) !== JSON.stringify(old.cells[key])) diffs.push(`${sheet.name}!${key}`);
    }
    assert.deepEqual(sheet.charts, old.charts, "chart definitions are untouched; their data follows the cells");
  }
  assert.deepEqual(diffs, ["Assumptions!B3"]);
  assert.deepEqual(result.model.sheets[0].cells.B3, { v: 0.075, fmt: "0.0%" });
  assert.deepEqual(result.touched, ["assumptions!B3"]);

  // Recalculation: only the orders and revenue chain plus the totals.
  const expected = new Set([
    ...MONTHS.map((_, i) => `model!C${i + 2}`),
    ...MONTHS.map((_, i) => `model!D${i + 2}`),
    "model!C14",
    "model!D14",
  ]);
  assert.deepEqual(new Set(result.recalculated), expected);
  assert.ok(!result.recalculated.includes("model!B3"), "visitors do not depend on conversion");
  assert.ok(!result.recalculated.includes("notes!B1"), "an unrelated sheet is not recomputed");

  // Values and the chart follow.
  assert.equal(result.engine.value("Model", "C2"), 9000);
  assert.equal(result.engine.value("Model", "D2"), 432000);
  assert.ok(result.chartsChanged.includes("ch1"));
  const chartAfter = resolveChart(result.engine, "Model", result.model.sheets[1].charts[0]);
  assert.equal(chartAfter.series[0].values[0], 432000);
  assert.notDeepEqual(chartAfter, chartBefore);
  assert.deepEqual(result.changes, ["Set Assumptions!B3 to 0.075"]);

  // The incremental result equals a from-scratch recalculation.
  const full = new WorkbookEngine(result.model);
  for (const [id, value] of full.values) assert.deepEqual(result.engine.values.get(id), value, id);

  // And the input model was not mutated.
  assert.equal(model.sheets[0].cells.B3.v, 0.05);
});

test("a formula edit that would create a cycle is refused and nothing is applied", () => {
  const model = growthModel();
  const snapshot = JSON.stringify(model);
  assert.throws(
    () =>
      applyWorkbookOps(model, [
        { op: "setCell", sheet: "Notes", cell: "A1", value: "changed" },
        { op: "setFormula", sheet: "Assumptions", cell: "B2", formula: "=Model!B13" },
      ]),
    (error: unknown) => error instanceof SemanticError && error.code === "cycle"
  );
  assert.equal(JSON.stringify(model), snapshot);
  const direct = () => applyWorkbookOps(model, [{ op: "setFormula", sheet: "Notes", cell: "C1", formula: "=C1+1" }]);
  assert.throws(direct, /depend on itself/);
});

test("an imported cycle evaluates to #CYCLE! without hiding the rest", () => {
  const model = normalizeWorkbook({
    title: "cycle",
    sheets: [{ name: "S", cells: { A1: { f: "=B1+1" }, B1: { f: "=A1+1" }, C1: { f: "=IFERROR(A1,5)" }, D1: { f: "=2*3" } } }],
  });
  const engine = new WorkbookEngine(model);
  assert.deepEqual(engine.value("S", "A1"), { error: "#CYCLE!" });
  assert.deepEqual(engine.value("S", "B1"), { error: "#CYCLE!" });
  assert.equal(engine.value("S", "C1"), 5);
  assert.equal(engine.value("S", "D1"), 6);
  assert.deepEqual([...engine.cycles].sort(), ["s!A1", "s!B1"]);
});

test("operations are all-or-nothing and name the failing operation", () => {
  const model = growthModel();
  try {
    applyWorkbookOps(model, [
      { op: "setCell", sheet: "Notes", cell: "A2", value: 1 },
      { op: "setCell", sheet: "Nowhere", cell: "A1", value: 1 },
    ]);
    assert.fail("expected a failure");
  } catch (error) {
    assert.ok(error instanceof SemanticError);
    assert.equal(error.opIndex, 2);
    assert.equal(error.code, "not_found");
  }
  assert.equal(model.sheets[2].cells.A2, undefined);
});

test("inserting and deleting rows rewrites formulas, charts, tables and names", () => {
  const model = growthModel();
  const inserted = applyWorkbookOps(model, [{ op: "insertRows", sheet: "Model", before: 5, count: 2 }]);
  const modelSheet = inserted.model.sheets[1];
  assert.equal(modelSheet.cells.D16.f, "SUM(D2:D15)");
  assert.equal(modelSheet.cells.B7.f, "ROUND(B4*(1+Assumptions!$B$5),0)");
  assert.equal(modelSheet.charts[0].series[0].values, "D2:D15");
  assert.equal(modelSheet.tables[0].range, "A1:D15");
  assert.equal(inserted.engine.value("Model", "D16"), new WorkbookEngine(model).value("Model", "D14"));

  const insertedAssumption = applyWorkbookOps(model, [{ op: "insertRows", sheet: "Assumptions", before: 2, count: 1 }]);
  assert.equal(insertedAssumption.model.names.conversion, "Assumptions!$B$4");
  assert.equal(insertedAssumption.model.sheets[1].cells.C2.f, "ROUND(B2*conversion,0)");
  assert.equal(insertedAssumption.model.sheets[1].cells.D2.f, "C2*Assumptions!$B$5");
  assert.equal(insertedAssumption.engine.value("Model", "D2"), 288000);

  assert.throws(
    () => applyWorkbookOps(model, [{ op: "deleteRows", sheet: "Assumptions", start: 3, count: 1 }]),
    /named "conversion"/
  );
  const deleted = applyWorkbookOps(model, [{ op: "deleteRows", sheet: "Model", start: 13, count: 1 }]);
  assert.equal(deleted.model.sheets[1].cells.D13.f, "SUM(D2:D12)");
});

test("renaming a sheet follows every reference", () => {
  const result = applyWorkbookOps(growthModel(), [{ op: "renameSheet", from: "Assumptions", to: "Inputs 2026" }]);
  assert.equal(result.model.sheets[1].cells.D2.f, "C2*'Inputs 2026'!$B$4");
  assert.equal(result.model.names.conversion, "'Inputs 2026'!$B$3");
  assert.equal(result.engine.value("Model", "D2"), 288000);
});

test("sorting carries each row's formulas with it", () => {
  const model = normalizeWorkbook({
    title: "sort",
    sheets: [
      {
        name: "S",
        rows: [
          ["Item", "Qty", "Price", "Total"],
          ["c", 3, 10, { f: "=B2*C2" }],
          ["a", 1, 20, { f: "=B3*C3" }],
          ["b", 2, 30, { f: "=B4*C4" }],
        ],
      },
    ],
  });
  const result = applyWorkbookOps(model, [{ op: "sortRange", sheet: "S", range: "A1:D4", column: "D", direction: "desc", header: true }]);
  const s = result.model.sheets[0];
  assert.deepEqual([s.cells.A2.v, s.cells.A3.v, s.cells.A4.v], ["b", "c", "a"]);
  assert.equal(s.cells.D2.f, "B2*C2");
  assert.deepEqual([2, 3, 4].map((r) => result.engine.value("S", `D${r}`)), [60, 30, 20]);
});

test("table filters hide rows in the view without touching data", () => {
  const model = growthModel();
  const result = applyWorkbookOps(model, [
    { op: "setFilter", sheet: "Model", table: "Plan", filters: [{ column: "D", op: "gt", value: 330000 }] },
  ]);
  const sheet = result.model.sheets[1];
  const hidden = hiddenRows(result.engine, sheet, sheet.tables[0]);
  assert.ok(hidden.has(2) && hidden.has(3));
  assert.ok(!hidden.has(13));
  assert.deepEqual(sheet.cells, model.sheets[1].cells);
});

test("charts can be added and rebound by operation", () => {
  const ops: WorkbookOp[] = workbookOpsSchema.parse([
    { op: "addChart", sheet: "Model", type: "column", title: "Orders", categories: "A2:A13", series: [{ name: "Orders", values: "C2:C13" }] },
    { op: "updateChart", sheet: "Model", id: "ch1", type: "area" },
  ]);
  const result = applyWorkbookOps(growthModel(), ops);
  assert.deepEqual(result.model.sheets[1].charts.map((c) => [c.id, c.type]), [["ch1", "area"], ["ch2", "column"]]);
});

test("the outline addresses every cell with formulas and computed values", () => {
  const model = growthModel();
  const outline = outlineWorkbook(model, new WorkbookEngine(model));
  assert.match(outline, /Names: conversion = Assumptions!\$B\$3/);
  assert.match(outline, /B3: 0\.05 \[0\.0% shows 5\.0%\]/);
  assert.match(outline, /C2: =ROUND\(B2\*conversion,0\) → 6000/);
  assert.match(outline, /chart ch1 line "Revenue"/);
  const bounded = outlineWorkbook(model, new WorkbookEngine(model), 600);
  assert.ok(bounded.length < 900);
  assert.match(bounded, /more cells not shown/);
});

// ── .xlsx roundtrip ───────────────────────────────────────────────────────

test("export writes formulas with cached values, formats, names, panes, filters and a real chart", async () => {
  const model = growthModel();
  const bytes = await exportWorkbookXlsx(model);

  const wb = new Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = wb.getWorksheet("Model")!;
  assert.equal(sheet.getCell("D14").formula, "SUM(D2:D13)");
  assert.equal(typeof sheet.getCell("D14").result, "number");
  assert.equal(sheet.getCell("D2").numFmt, '"$"#,##0.00');
  assert.equal(wb.getWorksheet("Assumptions")!.getCell("B6").value, '=HYPERLINK("http://evil.example","click")');

  const zip = await JSZip.loadAsync(bytes);
  const assumptionsXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const b6 = /<c r="B6"[^>]*>([\s\S]*?)<\/c>/.exec(assumptionsXml)![1];
  assert.ok(!b6.includes("<f>"), "an =-string must not become a formula in the file");
  const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
  assert.match(chart, /<c:lineChart>/);
  assert.match(chart, /<c:f>Model!\$D\$2:\$D\$13<\/c:f>/);
  assert.match(chart, /<c:pt idx="0"><c:v>288000<\/c:v><\/c:pt>/);
  const types = await zip.file("[Content_Types].xml")!.async("string");
  assert.match(types, /drawingml\.chart\+xml/);
  const modelXml = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
  assert.match(modelXml, /<drawing r:id="rIdAlevrDrawing"\/>/);
  assert.match(modelXml, /<pane[^>]*xSplit="1"[^>]*ySplit="1"/);
  assert.match(modelXml, /<autoFilter ref="A1:D13"/);
  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  assert.match(workbookXml, /<definedName name="conversion">Assumptions!\$B\$3<\/definedName>/);
});

test("import reads back the same workbook: cells, formulas, formats, names, panes, tables and charts", async () => {
  const model = growthModel();
  const { model: reopened, report } = await readWorkbookXlsx(await exportWorkbookXlsx(model), { title: model.title });
  assert.deepEqual(report.opaqueFormulas, []);
  assert.equal(report.charts, 1);
  assert.deepEqual(reopened.names, model.names);
  for (const [i, sheet] of model.sheets.entries()) {
    const back = reopened.sheets[i];
    assert.equal(back.name, sheet.name);
    assert.deepEqual(back.cells, sheet.cells, `cells of ${sheet.name}`);
    assert.deepEqual(back.freeze, sheet.freeze);
  }
  assert.equal(reopened.sheets[1].tables[0].range, "A1:D13");
  const chart = reopened.sheets[1].charts[0];
  assert.equal(chart.type, "line");
  assert.equal(chart.title, "Revenue");
  assert.equal(chart.categories, "Model!$A$2:$A$13");
  assert.deepEqual(chart.series, [{ name: "Revenue", values: "Model!$D$2:$D$13" }]);
  assert.deepEqual(chart.anchor, model.sheets[1].charts[0].anchor);
  // And it computes the same numbers.
  assert.equal(new WorkbookEngine(reopened).value("Model", "D14"), new WorkbookEngine(model).value("Model", "D14"));
});

test("edit -> export -> import keeps the edit and its dependents", async () => {
  const edited = applyWorkbookOps(growthModel(), [{ op: "setCell", sheet: "Assumptions", cell: "B3", value: 0.075 }]);
  const bytes = await exportWorkbookXlsx(edited.model, edited.engine);
  const zip = await JSZip.loadAsync(bytes);
  const chart = await zip.file("xl/charts/chart1.xml")!.async("string");
  assert.match(chart, /<c:pt idx="0"><c:v>432000<\/c:v><\/c:pt>/);
  const { model } = await readWorkbookXlsx(bytes);
  assert.equal(model.sheets[0].cells.B3.v, 0.075);
  assert.equal(new WorkbookEngine(model).value("Model", "D2"), 432000);
});

test("an imported formula this build cannot compute is kept opaque with its cached value", async () => {
  const wb = new Workbook();
  const ws = wb.addWorksheet("S");
  ws.getCell("A1").value = 5;
  ws.getCell("A2").value = { formula: "XLOOKUP(5,A1:A1,A1:A1)", result: 5 } as never;
  ws.getCell("A3").value = { formula: "A1*2", result: 10 } as never;
  ws.getCell("A4").value = "=A1*100";
  const bytes = Buffer.from(await wb.xlsx.writeBuffer());
  const { model, report } = await readWorkbookXlsx(bytes);
  assert.deepEqual(report.opaqueFormulas, ["S!A2"]);
  assert.deepEqual(model.sheets[0].cells.A2, { f: "XLOOKUP(5,A1:A1,A1:A1)", opaque: true, v: 5 });
  assert.deepEqual(model.sheets[0].cells.A3, { f: "A1*2" });
  assert.deepEqual(model.sheets[0].cells.A4, { v: "=A1*100" });
  const engine = new WorkbookEngine(model);
  assert.equal(engine.value("S", "A2"), 5);
  assert.equal(engine.value("S", "A3"), 10);
  // Re-exported, the opaque formula is written back verbatim.
  const again = await new Workbook().xlsx.load((await exportWorkbookXlsx(model)) as unknown as ArrayBuffer);
  assert.equal(again.getWorksheet("S")!.getCell("A2").formula, "XLOOKUP(5,A1:A1,A1:A1)");
});
