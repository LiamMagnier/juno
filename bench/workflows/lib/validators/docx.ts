/**
 * Word (.docx) validator: opens the package independently and checks what a
 * reader would — real editable text, headings by style, tables, required
 * content, and Unicode that survived the trip.
 */

import type { CheckResult, ValidatorSpec } from "../types";
import {
  attr,
  elements,
  fail,
  foldForMatch,
  matches,
  packageChecks,
  pass,
  patternLabel,
  readOutput,
  runText,
} from "./util";

type DocxSpec = Extract<ValidatorSpec, { kind: "docx" }>;

export interface DocxContent {
  paragraphs: Array<{ text: string; style: string | null; outlineLevel: number | null }>;
  tables: string[][][];
  fullText: string;
}

const WORD_MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

/** Paragraph text and style from `word/document.xml`, tables as rows of cell text. */
export function readDocxXml(xml: string): DocxContent {
  const paragraphs: DocxContent["paragraphs"] = [];
  for (const p of elements(xml, "w:p")) {
    const styleTag = /<w:pStyle\s[^>]*>/.exec(p.inner)?.[0] ?? "";
    const outlineTag = /<w:outlineLvl\s[^>]*>/.exec(p.inner)?.[0] ?? "";
    const outline = outlineTag ? Number(attr(outlineTag, "w:val")) : null;
    paragraphs.push({ text: runText(p.inner, "w"), style: styleTag ? attr(styleTag, "w:val") : null, outlineLevel: Number.isFinite(outline) ? outline : null });
  }
  const tables: string[][][] = [];
  for (const table of elements(xml, "w:tbl")) {
    const rows: string[][] = [];
    for (const row of elements(table.inner, "w:tr")) {
      rows.push(elements(row.inner, "w:tc").map((c) => runText(c.inner, "w").trim()));
    }
    tables.push(rows);
  }
  return { paragraphs, tables, fullText: paragraphs.map((p) => p.text).join("\n") };
}

/** Style ids that mean "heading" in Word, LibreOffice and the common generators. */
export function isHeadingStyle(style: string | null, outlineLevel: number | null): boolean {
  if (outlineLevel !== null && outlineLevel >= 0 && outlineLevel <= 8) return true;
  if (!style) return false;
  return /^(heading\s?\d|title|subtitle|titre\d?|berschrift\d?)$/i.test(style.replace(/[^A-Za-z0-9 ]/g, ""));
}

export async function validateDocx(spec: DocxSpec, outputsDir: string): Promise<CheckResult[]> {
  const id = (what: string) => `docx:${spec.file}:${what}`;
  let bytes: Buffer;
  try {
    bytes = readOutput(outputsDir, spec.file);
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  const { pkg, checks } = await packageChecks(`docx:${spec.file}`, bytes, WORD_MAIN, "word/document.xml");
  if (!pkg) return checks;
  const xml = await pkg.text("word/document.xml");
  if (!xml) return [...checks, fail(id("body"), "word/document.xml is missing")];
  // Style ids can be remapped through styles.xml names; map id -> name so
  // "Heading1" and a custom id named "heading 1" both count.
  const stylesXml = (await pkg.text("word/styles.xml")) ?? "";
  const styleNames = new Map<string, string>();
  for (const style of elements(stylesXml, "w:style")) {
    const styleId = attr(style.attrs, "w:styleId");
    const nameTag = /<w:name\s[^>]*>/.exec(style.inner)?.[0];
    if (styleId && nameTag) styleNames.set(styleId, attr(nameTag, "w:val") ?? styleId);
  }
  const content = readDocxXml(xml);
  const textChars = content.fullText.replace(/\s/g, "").length;
  checks.push(
    textChars > 0
      ? pass(id("editable-text"), `${content.paragraphs.length} paragraphs, ${textChars} non-space characters of real text`)
      : fail(id("editable-text"), "no editable text runs (an image-only or empty document)")
  );
  if (spec.minParagraphs !== undefined) {
    const nonEmpty = content.paragraphs.filter((p) => p.text.trim()).length;
    checks.push(nonEmpty >= spec.minParagraphs ? pass(id("paragraphs"), `${nonEmpty} non-empty`) : fail(id("paragraphs"), `${nonEmpty} non-empty, need ${spec.minParagraphs}`));
  }
  const headings = content.paragraphs
    .filter((p) => p.text.trim() && (isHeadingStyle(p.style, p.outlineLevel) || isHeadingStyle(styleNames.get(p.style ?? "") ?? null, null)))
    .map((p) => foldForMatch(p.text));
  for (const wanted of spec.requiredHeadings ?? []) {
    const found = headings.some((h) => h.toLowerCase().includes(wanted.toLowerCase()));
    checks.push(found ? pass(id(`heading:${wanted}`), "present as a styled heading") : fail(id(`heading:${wanted}`), `no heading containing "${wanted}" (headings: ${headings.slice(0, 12).join(" | ") || "none"})`));
  }
  const searchable = `${content.fullText}\n${content.tables.flat(2).join("\n")}`;
  for (const pattern of spec.requiredText ?? []) {
    checks.push(matches(searchable, pattern) ? pass(id(`text:${patternLabel(pattern)}`), "present") : fail(id(`text:${patternLabel(pattern)}`), "missing from the document text"));
  }
  for (const pattern of spec.forbiddenText ?? []) {
    checks.push(matches(searchable, pattern) ? fail(id(`forbidden:${patternLabel(pattern)}`), "present but must not be") : pass(id(`forbidden:${patternLabel(pattern)}`), "absent"));
  }
  for (const exact of spec.exactText ?? []) {
    checks.push(searchable.includes(exact) ? pass(id(`exact:${exact}`), "byte-exact Unicode survived") : fail(id(`exact:${exact}`), "not found verbatim (Unicode lost or altered)"));
  }
  if (spec.minTables !== undefined) {
    const real = content.tables.filter((t) => t.length >= 2 && t[0].length >= 2);
    checks.push(real.length >= spec.minTables ? pass(id("tables"), `${real.length} table(s) with a header and rows`) : fail(id("tables"), `${real.length} usable table(s), need ${spec.minTables}`));
  }
  return checks;
}
