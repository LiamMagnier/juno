/**
 * PowerPoint (.pptx) validator: slide count in presentation order, text per
 * slide, every shape inside the slide, an estimate of whether each text box's
 * text fits it, and charts/tables where the workflow asks for them.
 *
 * The fit estimate is deliberately coarse (half an em per character, 1.2 line
 * height, 30% slack) so it only fails text that clearly runs out of its box;
 * the rendered PDF from the office_reopen check is what a reviewer looks at.
 */

import path from "node:path";
import type { CheckResult, ValidatorSpec } from "../types";
import {
  attr,
  elements,
  fail,
  matches,
  packageChecks,
  pass,
  patternLabel,
  readOutput,
  runText,
  wordCount,
  type OpenedPackage,
} from "./util";

type PptxSpec = Extract<ValidatorSpec, { kind: "pptx" }>;

const PRESENTATION_MAIN = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const EMU_PER_PT = 12_700;

export interface SlideShape {
  kind: "text" | "table" | "chart" | "picture" | "other";
  x: number;
  y: number;
  cx: number;
  cy: number;
  text: string;
  paragraphs: string[];
  fontPt: number;
  autofit: boolean;
}

export interface SlideContent {
  index: number;
  part: string;
  shapes: SlideShape[];
  text: string;
}

export interface DeckContent {
  width: number;
  height: number;
  slides: SlideContent[];
}

function xfrm(fragment: string): { x: number; y: number; cx: number; cy: number } | null {
  const off = /<a:off\s([^>]*)\/>/.exec(fragment)?.[1];
  const ext = /<a:ext\s([^>]*)\/>/.exec(fragment)?.[1];
  if (!off || !ext) return null;
  return { x: Number(attr(off, "x")), y: Number(attr(off, "y")), cx: Number(attr(ext, "cx")), cy: Number(attr(ext, "cy")) };
}

function shapesOf(xml: string): SlideShape[] {
  const shapes: SlideShape[] = [];
  for (const sp of elements(xml, "p:sp")) {
    const box = xfrm(sp.inner);
    const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(sp.inner)?.[1] ?? "";
    const paragraphs = elements(body, "a:p").map((p) => runText(p.inner, "a"));
    const size = /\ssz="(\d+)"/.exec(body)?.[1];
    if (!box) continue; // placeholder inheriting its position from the layout
    shapes.push({
      kind: "text",
      ...box,
      paragraphs,
      text: paragraphs.join("\n"),
      fontPt: size ? Number(size) / 100 : 18,
      autofit: /<a:normAutofit/.test(body),
    });
  }
  for (const frame of elements(xml, "p:graphicFrame")) {
    const box = xfrm(frame.inner) ?? { x: 0, y: 0, cx: 0, cy: 0 };
    const isTable = /<a:tbl>/.test(frame.inner);
    const isChart = /<c:chart\s/.test(frame.inner) || /drawingml\/2006\/chart/.test(frame.inner);
    const cells = isTable ? elements(frame.inner, "a:tc").map((c) => runText(c.inner, "a")) : [];
    shapes.push({ kind: isTable ? "table" : isChart ? "chart" : "other", ...box, paragraphs: cells, text: cells.join("\n"), fontPt: 14, autofit: false });
  }
  for (const pic of elements(xml, "p:pic")) {
    const box = xfrm(pic.inner);
    if (box) shapes.push({ kind: "picture", ...box, paragraphs: [], text: "", fontPt: 0, autofit: false });
  }
  return shapes;
}

export async function readDeck(pkg: OpenedPackage): Promise<DeckContent> {
  const presentation = (await pkg.text("ppt/presentation.xml")) ?? "";
  const size = /<p:sldSz\s([^>]*)\/>/.exec(presentation)?.[1] ?? "";
  const rels = (await pkg.text("ppt/_rels/presentation.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const rel of elements(rels, "Relationship")) {
    const rid = attr(rel.attrs, "Id");
    const target = attr(rel.attrs, "Target");
    if (rid && target) targets.set(rid, target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join("ppt", target)));
  }
  const slides: SlideContent[] = [];
  let index = 0;
  for (const sld of elements(presentation, "p:sldId")) {
    const rid = attr(sld.attrs, "r:id");
    const part = rid ? targets.get(rid) : undefined;
    if (!part) continue;
    index += 1;
    const xml = (await pkg.text(part)) ?? "";
    const shapes = shapesOf(xml);
    slides.push({ index, part, shapes, text: shapes.map((s) => s.text).filter(Boolean).join("\n") });
  }
  return { width: Number(attr(size, "cx")) || 0, height: Number(attr(size, "cy")) || 0, slides };
}

/** Estimated rendered height (pt) of a text shape's paragraphs at its font size. */
export function estimatedTextHeight(shape: SlideShape): number {
  const widthPt = Math.max(1, shape.cx / EMU_PER_PT - 14.4);
  const charsPerLine = Math.max(1, Math.floor(widthPt / (shape.fontPt * 0.5)));
  const lines = shape.paragraphs.reduce((sum, p) => sum + Math.max(1, Math.ceil(p.length / charsPerLine)), 0);
  return lines * shape.fontPt * 1.2 + 7.2;
}

export async function validatePptx(spec: PptxSpec, outputsDir: string): Promise<CheckResult[]> {
  const id = (what: string) => `pptx:${spec.file}:${what}`;
  let bytes: Buffer;
  try {
    bytes = readOutput(outputsDir, spec.file);
  } catch (error) {
    return [fail(id("exists"), (error as Error).message)];
  }
  const { pkg, checks } = await packageChecks(`pptx:${spec.file}`, bytes, PRESENTATION_MAIN, "ppt/presentation.xml");
  if (!pkg) return checks;
  const deck = await readDeck(pkg);
  const n = deck.slides.length;
  if (spec.slides) {
    const ok = (spec.slides.min === undefined || n >= spec.slides.min) && (spec.slides.max === undefined || n <= spec.slides.max);
    checks.push(ok ? pass(id("slide-count"), `${n} slides`) : fail(id("slide-count"), `${n} slides, expected ${spec.slides.min ?? 0}–${spec.slides.max ?? "∞"}`));
  }
  const empty = deck.slides.filter((s) => !s.text.trim() && !s.shapes.some((sh) => sh.kind === "chart" || sh.kind === "picture"));
  checks.push(empty.length ? fail(id("no-empty-slides"), `empty slides: ${empty.map((s) => s.index).join(", ")}`) : pass(id("no-empty-slides"), "every slide has content"));

  const outside: string[] = [];
  const overflow: string[] = [];
  for (const slide of deck.slides) {
    for (const shape of slide.shapes) {
      const tolX = deck.width * 0.01;
      const tolY = deck.height * 0.01;
      if (shape.x < -tolX || shape.y < -tolY || shape.x + shape.cx > deck.width + tolX || shape.y + shape.cy > deck.height + tolY) {
        outside.push(`slide ${slide.index} ${shape.kind} "${shape.text.slice(0, 30)}"`);
      }
      if (shape.kind === "text" && shape.text.trim() && !shape.autofit) {
        const need = estimatedTextHeight(shape);
        const have = shape.cy / EMU_PER_PT;
        if (need > have * 1.3) overflow.push(`slide ${slide.index} "${shape.text.slice(0, 30)}…" needs ~${Math.round(need)}pt in ${Math.round(have)}pt`);
      }
    }
  }
  checks.push(outside.length ? fail(id("within-slide"), outside.slice(0, 5).join("; ")) : pass(id("within-slide"), "every shape lies inside the slide"));
  checks.push(overflow.length ? fail(id("text-fits"), overflow.slice(0, 5).join("; ")) : pass(id("text-fits"), "no text box is estimated to overflow"));

  if (spec.maxWordsPerSlide !== undefined) {
    const dense = deck.slides.filter((s) => wordCount(s.text) > spec.maxWordsPerSlide!);
    checks.push(dense.length ? fail(id("words-per-slide"), dense.map((s) => `slide ${s.index}: ${wordCount(s.text)} words`).join(", ")) : pass(id("words-per-slide"), `every slide ≤ ${spec.maxWordsPerSlide} words`));
  }
  const allText = deck.slides.map((s) => s.text).join("\n");
  for (const pattern of spec.requiredText ?? []) {
    checks.push(matches(allText, pattern) ? pass(id(`text:${patternLabel(pattern)}`), "present") : fail(id(`text:${patternLabel(pattern)}`), "missing from the slides"));
  }
  for (const exact of spec.exactText ?? []) {
    checks.push(allText.includes(exact) ? pass(id(`exact:${exact}`), "byte-exact Unicode survived") : fail(id(`exact:${exact}`), "not found verbatim"));
  }
  if (spec.requireChart) {
    const charts = pkg.names.filter((name) => /^ppt\/charts\/chart\d*\.xml$/.test(name)).length;
    checks.push(charts ? pass(id("chart"), `${charts} chart part(s)`) : fail(id("chart"), "no chart"));
  }
  if (spec.requireTable) {
    const tables = deck.slides.flatMap((s) => s.shapes).filter((s) => s.kind === "table").length;
    checks.push(tables ? pass(id("table"), `${tables} table(s)`) : fail(id("table"), "no native table (a picture of a table is not editable)"));
  }
  return checks;
}
