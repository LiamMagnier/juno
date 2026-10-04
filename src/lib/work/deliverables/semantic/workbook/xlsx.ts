/**
 * Workbook <-> .xlsx.
 *
 * Export writes real formulas WITH their cached values (so a viewer that does
 * not calculate — Quick Look, a phone preview, a mail client — still shows
 * the numbers), number formats, defined names, frozen panes, column widths,
 * table ranges as an AutoFilter with filtered rows hidden, and charts as real
 * DrawingML chart parts whose series point at the sheet ranges (`c:f`) and
 * carry a cache of the computed values. exceljs writes everything except the
 * charts, which it does not support; those are added to the package after it.
 *
 * Import reads the same things back. A formula is imported as a formula only
 * when the file stores it as one (`<f>`), never because a string starts with
 * "="; a formula this build cannot compute keeps its text and the file's cached
 * value as an opaque cell, so nothing is lost and nothing pretends to compute.
 *
 * Server-only by the import graph (exceljs, jszip), like the rest of
 * `work/deliverables`.
 */

import { Workbook, ValueType, type Worksheet } from "exceljs";
import JSZip from "jszip";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { SemanticError } from "@/lib/work/deliverables/semantic/shared";
import { toNodeBuffer } from "@/lib/work/deliverables/spreadsheet";
import {
  cellKey,
  columnLetter,
  columnNumber,
  parseCell,
  parseQualifiedRange,
  parseRange,
  qualifiedRange,
} from "@/lib/work/deliverables/semantic/workbook/address";
import { WorkbookEngine, resolveChart, cellId } from "@/lib/work/deliverables/semantic/workbook/engine";
import { isError } from "@/lib/work/deliverables/semantic/workbook/formula";
import { dateToSerial, resolveFormat, serialToDate } from "@/lib/work/deliverables/semantic/workbook/format";
import {
  canonicalFormula,
  normalizeWorkbook,
  type CellInput,
  type WorkbookChart,
  type WorkbookModel,
} from "@/lib/work/deliverables/semantic/workbook/model";
import { hiddenRows } from "@/lib/work/deliverables/semantic/workbook/view";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function exportWorkbookXlsx(model: WorkbookModel, engine = new WorkbookEngine(model)): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = PRODUCT_NAME;
  workbook.title = model.title;
  workbook.created = new Date(0);
  workbook.modified = new Date(0);
  // Excel recalculates on open, so a cached value can never outlive its inputs.
  workbook.calcProperties = { fullCalcOnLoad: true };

  for (const sheet of model.sheets) {
    const ws = workbook.addWorksheet(sheet.name);
    for (const [key, stored] of Object.entries(sheet.cells)) {
      const target = ws.getCell(key);
      if (stored.f !== undefined) {
        const value = stored.opaque ? (stored.v ?? null) : engine.value(sheet.name, key);
        const result =
          value === null || (isError(value) && value.error === "#CYCLE!")
            ? undefined
            : isError(value)
              ? { error: value.error }
              : stored.t === "date" && typeof value === "number"
                ? serialToDate(value)
                : value;
        target.value = (result === undefined ? { formula: stored.f } : { formula: stored.f, result }) as never;
      } else if (stored.v !== undefined && stored.v !== null) {
        // A string is written as a string — exceljs only writes <f> for a
        // { formula } value — so "=cmd|…" stays inert text in the file too.
        target.value = stored.t === "date" && typeof stored.v === "number" ? serialToDate(stored.v) : stored.v;
      }
      if (stored.fmt) target.numFmt = stored.fmt;
      if (stored.bold) target.font = { bold: true };
    }
    for (const [letter, column] of Object.entries(sheet.columns)) {
      if (column.width !== undefined) ws.getColumn(columnNumber(letter)).width = column.width;
    }
    if (sheet.freeze.rows || sheet.freeze.cols) {
      ws.views = [{ state: "frozen", xSplit: sheet.freeze.cols, ySplit: sheet.freeze.rows }];
    }
    const table = sheet.tables[0];
    if (table) {
      const range = parseRange(table.range);
      if (range) {
        ws.autoFilter = table.range;
        for (const row of hiddenRows(engine, sheet, table)) ws.getRow(row).hidden = true;
      }
    }
  }
  for (const [name, ref] of Object.entries(model.names)) {
    const parsed = parseQualifiedRange(ref);
    if (parsed?.sheet) workbook.definedNames.add(qualifiedRange(parsed.sheet, parsed.range, true), name);
  }

  const bytes = toNodeBuffer(await workbook.xlsx.writeBuffer());
  const hasCharts = model.sheets.some((sheet) => sheet.charts.length > 0);
  return hasCharts ? injectCharts(bytes, model, engine) : bytes;
}

/** Resolve each sheet name to its part path through workbook.xml and its rels. */
async function sheetParts(zip: JSZip): Promise<Map<string, string>> {
  const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(match[1])?.[1];
    const target = /Target="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const out = new Map<string, string>();
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /name="([^"]*)"/.exec(match[1])?.[1];
    const rid = /r:id="([^"]+)"/.exec(match[1])?.[1];
    const target = rid ? targets.get(rid) : undefined;
    if (name !== undefined && target) out.set(decodeXml(name).toLowerCase(), `xl/${target}`);
  }
  return out;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function chartXml(chart: WorkbookChart, sheetName: string, engine: WorkbookEngine): string {
  const data = resolveChart(engine, sheetName, chart);
  const absolute = (ref: string) => {
    const parsed = parseQualifiedRange(ref)!;
    return escapeXml(qualifiedRange(parsed.sheet ?? sheetName, parsed.range, true));
  };
  const strCache = (values: string[]) =>
    `<c:strCache><c:ptCount val="${values.length}"/>${values
      .map((value, i) => `<c:pt idx="${i}"><c:v>${escapeXml(value)}</c:v></c:pt>`)
      .join("")}</c:strCache>`;
  const numCache = (values: (number | null)[]) =>
    `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values
      .map((value, i) => (value === null ? "" : `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`))
      .join("")}</c:numCache>`;
  const series = chart.series
    .map((s, i) => {
      const name = escapeXml(data.series[i].name);
      const cat = `<c:cat><c:strRef><c:f>${absolute(chart.categories)}</c:f>${strCache(data.categories)}</c:strRef></c:cat>`;
      const val = `<c:val><c:numRef><c:f>${absolute(s.values)}</c:f>${numCache(data.series[i].values)}</c:numRef></c:val>`;
      const head = `<c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${name}</c:v></c:tx>`;
      if (chart.type === "line") return `<c:ser>${head}<c:marker><c:symbol val="circle"/></c:marker>${cat}${val}<c:smooth val="0"/></c:ser>`;
      if (chart.type === "bar" || chart.type === "column") return `<c:ser>${head}<c:invertIfNegative val="0"/>${cat}${val}</c:ser>`;
      return `<c:ser>${head}${cat}${val}</c:ser>`;
    })
    .join("");
  const axes =
    `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${chart.type === "bar" ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="1"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/>` +
    `<c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>` +
    `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${chart.type === "bar" ? "b" : "l"}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/>` +
    `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/>` +
    `<c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const axIds = `<c:axId val="5001"/><c:axId val="5002"/>`;
  let plot: string;
  switch (chart.type) {
    case "bar":
    case "column":
      plot = `<c:barChart><c:barDir val="${chart.type === "bar" ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="80"/>${axIds}</c:barChart>${axes}`;
      break;
    case "line":
      plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/>${axIds}</c:lineChart>${axes}`;
      break;
    case "area":
      plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${axIds}</c:areaChart>${axes}`;
      break;
    case "pie":
      plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
  }
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${escapeXml(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    `<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

async function injectCharts(bytes: Buffer, model: WorkbookModel, engine: WorkbookEngine): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = await sheetParts(zip);
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  let chartNo = 0;
  let drawingNo = 0;
  for (const sheet of model.sheets) {
    if (!sheet.charts.length) continue;
    const part = parts.get(sheet.name.toLowerCase());
    if (!part) throw new SemanticError("unreadable", `The exported workbook has no part for sheet ${sheet.name}`);
    drawingNo++;
    const drawingPath = `xl/drawings/drawing${drawingNo}.xml`;
    const anchors: string[] = [];
    const drawingRels: string[] = [];
    sheet.charts.forEach((chart, i) => {
      chartNo++;
      zip.file(`xl/charts/chart${chartNo}.xml`, chartXml(chart, sheet.name, engine));
      contentTypes = contentTypes.replace(
        "</Types>",
        `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`
      );
      drawingRels.push(
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNo}.xml"/>`
      );
      const at = parseCell(chart.anchor.cell)!;
      anchors.push(
        `<xdr:twoCellAnchor editAs="oneCell">` +
          `<xdr:from><xdr:col>${at.col - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.row - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
          `<xdr:to><xdr:col>${at.col - 1 + chart.anchor.cols}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.row - 1 + chart.anchor.rows}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
          `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${escapeXml(chart.title ?? `Chart ${chart.id}`)}" descr="alevr:${escapeXml(chart.id)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
          `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
          `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
          `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${i + 1}"/>` +
          `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    });
    zip.file(
      drawingPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join("")}</xdr:wsDr>`
    );
    zip.file(
      `xl/drawings/_rels/drawing${drawingNo}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRels.join("")}</Relationships>`
    );
    contentTypes = contentTypes.replace(
      "</Types>",
      `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`
    );

    const relsPath = part.replace(/([^/]+)$/, "_rels/$1.rels");
    const existingRels = zip.file(relsPath) ? await zip.file(relsPath)!.async("string") : null;
    const relId = "rIdAlevrDrawing";
    const rel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingNo}.xml"/>`;
    zip.file(
      relsPath,
      existingRels
        ? existingRels.replace("</Relationships>", `${rel}</Relationships>`)
        : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`
    );

    let sheetXml = await zip.file(part)!.async("string");
    if (!/xmlns:r=/.test(sheetXml.slice(0, 600))) {
      sheetXml = sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
    }
    // CT_Worksheet order: <drawing> goes before legacyDrawing/picture/oleObjects/tableParts/extLst.
    const before = /<(legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(sheetXml);
    const tag = `<drawing r:id="${relId}"/>`;
    sheetXml = before
      ? `${sheetXml.slice(0, before.index)}${tag}${sheetXml.slice(before.index)}`
      : sheetXml.replace("</worksheet>", `${tag}</worksheet>`);
    zip.file(part, sheetXml);
  }
  zip.file("[Content_Types].xml", contentTypes);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface WorkbookImportReport {
  formulas: number;
  /** Formulas kept verbatim with their cached value because this build cannot compute them. */
  opaqueFormulas: string[];
  /** Number formats this build cannot render, dropped (the value is unaffected). */
  droppedFormats: number;
  charts: number;
}

interface RawChart {
  sheet: string;
  chart: Omit<WorkbookChart, "id">;
}

async function readCharts(bytes: Buffer): Promise<RawChart[]> {
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file("xl/workbook.xml")) return [];
  const parts = await sheetParts(zip);
  const out: RawChart[] = [];
  for (const [sheetKey, part] of parts) {
    const relsPath = part.replace(/([^/]+)$/, "_rels/$1.rels");
    const relsXml = await zip.file(relsPath)?.async("string");
    if (!relsXml) continue;
    for (const rel of relsXml.matchAll(/<Relationship\b[^>]*Type="[^"]*\/drawing"[^>]*>/g)) {
      const target = /Target="([^"]+)"/.exec(rel[0])?.[1];
      if (!target) continue;
      const drawingPath = new URL(target, `file:///${part}`).pathname.slice(1);
      const drawingXml = await zip.file(drawingPath)?.async("string");
      if (!drawingXml) continue;
      const drawingRelsXml = await zip.file(drawingPath.replace(/([^/]+)$/, "_rels/$1.rels"))?.async("string");
      const chartTargets = new Map<string, string>();
      for (const r of (drawingRelsXml ?? "").matchAll(/<Relationship\b([^>]*)>/g)) {
        const id = /Id="([^"]+)"/.exec(r[1])?.[1];
        const t = /Target="([^"]+)"/.exec(r[1])?.[1];
        if (id && t) chartTargets.set(id, new URL(t, `file:///${drawingPath}`).pathname.slice(1));
      }
      for (const anchor of drawingXml.matchAll(/<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g)) {
        const rid = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(anchor[0])?.[1];
        const chartPath = rid ? chartTargets.get(rid) : undefined;
        const chartXmlText = chartPath ? await zip.file(chartPath)?.async("string") : undefined;
        if (!chartXmlText) continue;
        const from = /<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor[0]);
        const to = /<xdr:to><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(anchor[0]);
        const kind = /<c:(bar|line|pie|area)Chart>/.exec(chartXmlText)?.[1];
        if (!kind) continue;
        const barDir = /<c:barDir val="(bar|col)"\/>/.exec(chartXmlText)?.[1];
        const type: WorkbookChart["type"] = kind === "bar" ? (barDir === "bar" ? "bar" : "column") : (kind as WorkbookChart["type"]);
        const titleRuns = /<c:title>([\s\S]*?)<\/c:title>/.exec(chartXmlText)?.[1];
        const title = titleRuns ? [...titleRuns.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1])).join("") : undefined;
        const series: WorkbookChart["series"] = [];
        let categories: string | undefined;
        for (const ser of chartXmlText.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)) {
          const name = /<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/.exec(ser[1])?.[1];
          const cat = /<c:cat>[\s\S]*?<c:f>([^<]+)<\/c:f>/.exec(ser[1])?.[1];
          const val = /<c:val>[\s\S]*?<c:f>([^<]+)<\/c:f>/.exec(ser[1])?.[1];
          if (!val) continue;
          categories ??= cat ? decodeXml(cat) : undefined;
          series.push({ ...(name ? { name: decodeXml(name) } : {}), values: decodeXml(val) });
        }
        if (!categories || !series.length) continue;
        const col = from ? Number(from[1]) + 1 : 8;
        const row = from ? Number(from[2]) + 1 : 2;
        out.push({
          sheet: sheetKey,
          chart: {
            type,
            ...(title ? { title } : {}),
            categories,
            series: series.slice(0, 12),
            anchor: {
              cell: cellKey({ col, row }),
              cols: Math.min(30, Math.max(2, to ? Number(to[1]) + 1 - col : 8)),
              rows: Math.min(60, Math.max(4, to ? Number(to[2]) + 1 - row : 16)),
            },
          },
        });
      }
    }
  }
  return out;
}

function excelDateSerial(date: Date): number {
  // exceljs hands back JS Dates built at UTC midnight for date cells.
  return dateToSerial(date);
}

/**
 * Read an .xlsx into a workbook model. Throws SemanticError("unreadable") for
 * a file exceljs cannot open.
 */
export async function readWorkbookXlsx(
  bytes: Buffer,
  options: { title?: string } = {}
): Promise<{ model: WorkbookModel; report: WorkbookImportReport }> {
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch (error) {
    throw new SemanticError("unreadable", `This .xlsx could not be opened: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report: WorkbookImportReport = { formulas: 0, opaqueFormulas: [], droppedFormats: 0, charts: 0 };
  const sheets: WorkbookSheetInput[] = [];
  const sheetNames = new Set<string>();
  workbook.eachSheet((ws) => sheetNames.add(ws.name.toLowerCase()));

  const names: Record<string, string> = {};
  const definedNames = (workbook.definedNames as unknown as { model: { name: string; ranges: string[] }[] }).model ?? [];
  for (const entry of definedNames) {
    const ref = entry.ranges?.[0];
    if (!ref || entry.ranges.length !== 1 || entry.name.startsWith("_xlnm")) continue;
    const parsed = parseQualifiedRange(ref);
    if (parsed?.sheet && sheetNames.has(parsed.sheet.toLowerCase())) names[entry.name] = ref;
  }
  const context = { sheetNames, names: new Set(Object.keys(names).map((n) => n.toLowerCase())) };

  const charts = await readCharts(bytes);
  workbook.eachSheet((ws: Worksheet) => {
    const cells: Record<string, CellInput> = {};
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const key = cell.address;
        const fmtRaw = cell.numFmt;
        const fmt = fmtRaw ? resolveFormat(fmtRaw) : null;
        if (fmtRaw && !fmt && fmtRaw !== "General") report.droppedFormats++;
        const style: { fmt?: string; bold?: boolean } = {
          ...(fmt && fmt !== "General" ? { fmt } : {}),
          ...(cell.font?.bold ? { bold: true } : {}),
        };
        switch (cell.type) {
          case ValueType.Formula: {
            report.formulas++;
            const formula = cell.formula;
            const raw = cell.result as unknown;
            const cached =
              raw instanceof Date
                ? excelDateSerial(raw)
                : typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean"
                  ? raw
                  : null;
            if (!formula) {
              cells[key] = cached === null ? null : { v: cached, ...style };
              break;
            }
            try {
              cells[key] = { f: canonicalFormula(formula, context), ...style };
            } catch {
              report.opaqueFormulas.push(`${ws.name}!${key}`);
              cells[key] = { f: formula, opaque: true, v: cached, ...style };
            }
            break;
          }
          case ValueType.Number:
            cells[key] = { v: cell.value as number, ...style };
            break;
          case ValueType.Boolean:
            cells[key] = { v: cell.value as boolean, ...style };
            break;
          case ValueType.Date:
            cells[key] = { v: excelDateSerial(cell.value as Date), t: "date", fmt: style.fmt ?? "yyyy-mm-dd", ...(style.bold ? { bold: true } : {}) };
            break;
          case ValueType.String:
          case ValueType.SharedString:
            // Text, always — even "=1+1". Only an <f> element makes a formula.
            cells[key] = { v: String(cell.value ?? ""), ...style };
            break;
          case ValueType.RichText:
          case ValueType.Hyperlink:
            cells[key] = { v: cell.text, ...style };
            break;
          default:
            break;
        }
      });
    });

    const columns: Record<string, { width: number }> = {};
    for (let col = 1; col <= Math.min(ws.columnCount, 256); col++) {
      const width = ws.getColumn(col).width;
      if (typeof width === "number" && width > 0) columns[columnLetter(col)] = { width: Math.min(120, Math.max(2, width)) };
    }
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    const freeze = view?.state === "frozen" ? { rows: Math.min(100, view.ySplit ?? 0), cols: Math.min(30, view.xSplit ?? 0) } : undefined;
    const autoFilter = ws.autoFilter;
    const filterRange =
      typeof autoFilter === "string"
        ? autoFilter
        : autoFilter && typeof autoFilter === "object" && "from" in autoFilter
          ? `${typeof autoFilter.from === "string" ? autoFilter.from : cellKey({ col: autoFilter.from.column, row: autoFilter.from.row })}:${typeof autoFilter.to === "string" ? autoFilter.to : cellKey({ col: autoFilter.to.column, row: autoFilter.to.row })}`
          : undefined;
    const sheetCharts = charts.filter((c) => c.sheet === ws.name.toLowerCase()).map((c) => c.chart);
    report.charts += sheetCharts.length;
    sheets.push({
      name: ws.name,
      cells,
      columns,
      ...(freeze ? { freeze } : {}),
      ...(filterRange && parseRange(filterRange) ? { tables: [{ name: `${ws.name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1")}_table`, range: filterRange, filters: [] }] } : {}),
      ...(sheetCharts.length ? { charts: sheetCharts } : {}),
    });
  });

  const model = normalizeWorkbook({
    title: options.title ?? (workbook.title || "Imported workbook"),
    sheets,
    names,
  });
  return { model, report };
}

type WorkbookSheetInput = {
  name: string;
  cells: Record<string, CellInput>;
  columns: Record<string, { width: number }>;
  freeze?: { rows: number; cols: number };
  tables?: { name: string; range: string; filters: [] }[];
  charts?: Omit<WorkbookChart, "id">[];
};

export { cellId };
