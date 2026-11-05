/**
 * Excel (.xlsx) validator. Layout-agnostic on purpose: two products will lay a
 * workbook out differently, so checks ask "is there a formula that computes
 * 390" or "is there a row labelled paid whose number is 390", never "is B9
 * 390".
 */

import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import {
  attr,
  decodeXml,
  elements,
  fail,
  matches,
  packageChecks,
  pass,
  patternLabel,
  readOutput,
  type OpenedPackage,
} from "./util";

type XlsxSpec = Extract<ValidatorSpec, { kind: "xlsx" }>;

export interface SheetCell {
  ref: string;
  row: number;
  col: number;
  type: "number" | "string" | "bool" | "error" | "empty";
  value: number | string | boolean | null;
  formula: string | null;
}

export interface WorkbookContent {
  sheets: Array<{ name: string; cells: SheetCell[] }>;
  hasChart: boolean;
}

const SHEET_MAIN = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";

export function cellAddress(ref: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return { row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), col };
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return elements(xml, "si").map((si) => {
    const parts = [...si.inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
    return parts.join("");
  });
}

function parseSheet(xml: string, strings: string[]): SheetCell[] {
  const cells: SheetCell[] = [];
  for (const c of elements(xml, "c")) {
    const ref = attr(c.attrs, "r");
    if (!ref) continue;
    const t = attr(c.attrs, "t") ?? "n";
    const formula = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(c.inner)?.[1];
    const sharedFormula = /<f\s[^>]*t="shared"[^>]*\/>/.test(c.inner);
    const raw = /<v>([\s\S]*?)<\/v>/.exec(c.inner)?.[1];
    const inline = /<is>([\s\S]*?)<\/is>/.exec(c.inner)?.[1];
    const { row, col } = cellAddress(ref);
    let type: SheetCell["type"] = "empty";
    let value: SheetCell["value"] = null;
    if (t === "s" && raw !== undefined) {
      type = "string";
      value = strings[Number(raw)] ?? "";
    } else if (t === "inlineStr" && inline !== undefined) {
      type = "string";
      value = [...inline.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join("");
    } else if (t === "str" && raw !== undefined) {
      type = "string";
      value = decodeXml(raw);
    } else if (t === "b" && raw !== undefined) {
      type = "bool";
      value = raw === "1";
    } else if (t === "e" && raw !== undefined) {
      type = "error";
      value = decodeXml(raw);
    } else if (raw !== undefined && raw !== "") {
      type = "number";
      value = Number(raw);
    }
    cells.push({ ref, row, col, type, value, formula: formula !== undefined ? decodeXml(formula) : sharedFormula ? "(shared)" : null });
  }
  return cells;
}

export async function readWorkbook(pkg: OpenedPackage): Promise<WorkbookContent> {
  const workbook = (await pkg.text("xl/workbook.xml")) ?? "";
  const rels = (await pkg.text("xl/_rels/workbook.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const rel of elements(rels, "Relationship")) {
    const id = attr(rel.attrs, "Id");
    const target = attr(rel.attrs, "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target));
  }
  const strings = sharedStrings(await pkg.text("xl/sharedStrings.xml"));
  const sheets: WorkbookContent["sheets"] = [];
  for (const sheet of elements(workbook, "sheet")) {
    const name = attr(sheet.attrs, "name") ?? "?";
    const rid = attr(sheet.attrs, "r:id");
    const part = rid ? targets.get(rid) : undefined;
    const xml = part ? await pkg.text(path.posix.normalize(part)) : null;
    sheets.push({ name, cells: xml ? parseSheet(xml, strings) : [] });
  }
  const hasChart = pkg.names.some((n) => /^xl\/charts\/chart\d*\.xml$/.test(n));
  return { sheets, hasChart };
}

const NUMERIC_TEXT = /^\s*[-+]?(?:EUR|€|\$)?\s*\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?\s*(?:EUR|€|%)?\s*$|^\s*[-+]?\d+(?:\.\d+)?\s*$/;

export async function validateXlsx(spec: XlsxSpec, outputsDir: string): Promise<CheckResult[]> {
  const id = (what: string) => `xlsx:${spec.file}:${what}`;
  let bytes: Buffer;
  try {
    bytes = readOutput(outputsDir, spec.file);
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  const { pkg, checks } = await packageChecks(`xlsx:${spec.file}`, bytes, SHEET_MAIN, "xl/workbook.xml");
  if (!pkg) return checks;
  const wb = await readWorkbook(pkg);
  const all = wb.sheets.flatMap((s) => s.cells.map((c) => ({ ...c, sheet: s.name })));
  checks.push(
    all.some((c) => c.type !== "empty")
      ? pass(id("cells"), `${wb.sheets.length} sheet(s), ${all.filter((c) => c.type !== "empty").length} non-empty cells`)
      : fail(id("cells"), "no values in any sheet")
  );
  const errors = all.filter((c) => c.type === "error");
  checks.push(errors.length ? fail(id("no-errors"), `error values: ${errors.slice(0, 5).map((c) => `${c.sheet}!${c.ref}=${c.value}`).join(", ")}`) : pass(id("no-errors"), "no #REF!/#VALUE!/#DIV/0! cells"));

  for (const want of spec.formulaValues ?? []) {
    const tol = want.tolerance ?? 0.005;
    const formulas = all.filter((c) => c.formula);
    const hit = formulas.find((c) => c.type === "number" && Math.abs((c.value as number) - want.value) <= tol);
    const uncached = formulas.filter((c) => c.type === "empty");
    checks.push(
      hit
        ? pass(id(`formula=${want.value}`), `${hit.sheet}!${hit.ref} = ${hit.formula} → ${hit.value}`)
        : fail(
            id(`formula=${want.value}`),
            formulas.length === 0
              ? "the workbook has no formulas (values were typed in, not computed)"
              : `no formula cell has cached value ${want.value}${uncached.length ? `; ${uncached.length} formula(s) carry no cached value, which viewers that do not recalculate show as blank` : ""}`
          )
    );
  }

  for (const want of spec.labelValues ?? []) {
    const tol = want.tolerance ?? 0.005;
    let where: string | null = null;
    for (const sheet of wb.sheets) {
      const byPos = new Map(sheet.cells.map((c) => [`${c.row}:${c.col}`, c]));
      for (const label of sheet.cells.filter((c) => c.type === "string" && matches(String(c.value), want.label))) {
        const sameRow = sheet.cells.filter((c) => c.row === label.row && c.type === "number" && Math.abs((c.value as number) - want.value) <= tol);
        const below = byPos.get(`${label.row + 1}:${label.col}`);
        const hit = sameRow[0] ?? (below && below.type === "number" && Math.abs((below.value as number) - want.value) <= tol ? below : undefined);
        if (hit) {
          where = `${sheet.name}!${label.ref} "${label.value}" → ${hit.ref} = ${hit.value}`;
          break;
        }
      }
      if (where) break;
    }
    checks.push(where ? pass(id(`label:${patternLabel(want.label)}=${want.value}`), where) : fail(id(`label:${patternLabel(want.label)}=${want.value}`), `no row labelled ${patternLabel(want.label)} carries the number ${want.value}`));
  }

  for (const text of spec.uniqueTexts ?? []) {
    const perSheet = wb.sheets.map((s) => ({ name: s.name, n: s.cells.filter((c) => c.type === "string" && String(c.value).trim() === text).length }));
    const total = perSheet.reduce((sum, s) => sum + s.n, 0);
    const dup = perSheet.find((s) => s.n > 1);
    checks.push(
      total === 0
        ? fail(id(`unique:${text}`), "not present")
        : dup
          ? fail(id(`unique:${text}`), `appears ${dup.n} times on sheet "${dup.name}" (not deduplicated)`)
          : pass(id(`unique:${text}`), "present once per sheet")
    );
  }

  if (spec.numbersNotText) {
    const textNumbers = all.filter((c) => c.row > 1 && c.type === "string" && NUMERIC_TEXT.test(String(c.value)));
    checks.push(
      textNumbers.length
        ? fail(id("numbers-not-text"), `numbers stored as text: ${textNumbers.slice(0, 6).map((c) => `${c.sheet}!${c.ref}="${c.value}"`).join(", ")}`)
        : pass(id("numbers-not-text"), "numeric values are stored as numbers")
    );
  }

  if (spec.requireChart) {
    checks.push(wb.hasChart ? pass(id("chart"), "a chart part is present") : fail(id("chart"), "no chart in the workbook"));
  }

  for (const exact of spec.exactText ?? []) {
    const found = all.some((c) => c.type === "string" && String(c.value).includes(exact));
    checks.push(found ? pass(id(`exact:${exact}`), "byte-exact Unicode survived") : fail(id(`exact:${exact}`), "not found verbatim"));
  }
  return checks;
}
