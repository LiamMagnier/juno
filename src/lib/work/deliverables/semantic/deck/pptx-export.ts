/**
 * DeckModel -> a real, editable .pptx, and a .pptx -> what is in it.
 *
 * Server-only by the import graph (pptxgenjs, JSZip, Buffer). The model and
 * its layout geometry come from `./model`, the shrink-to-fit sizes from
 * `./fit`, so the file matches what the canvas previewed.
 *
 * What the file carries:
 *   - one slide layout per DeckLayout (pptxgenjs `defineSlideMaster`), with
 *     the theme background, the master footer, logo text and slide number, and
 *     real title/body placeholders, so titles and region text land in layout
 *     placeholders a person can edit and re-layout in PowerPoint or Keynote;
 *   - text with a box as free text boxes; charts as native chart parts with
 *     their data (editable in PowerPoint's chart data sheet); tables as native
 *     tables; shapes as preset geometry; speaker notes as notes slides;
 *   - embedded images only for `data:` URIs. An https image is never fetched
 *     (a server-side fetch of a URL the model wrote is a request-forgery
 *     primitive): it becomes a light rectangle naming the picture;
 *   - transitions. pptxgenjs 4.0.1 has no transition API, so after it writes
 *     the file the exporter inserts the standard `<p:transition>` element
 *     (fade, or push from below) into each slide part that asks for one.
 *
 * What it cannot express: pptxgenjs writes a single slide master and turns
 * each `defineSlideMaster` call into a slide *layout* under it, so "one master
 * per layout" is one layout per DeckLayout under one master. Theme fonts are
 * set per text run (and on the placeholders) rather than in the theme part,
 * whose font scheme pptxgenjs fixes when it writes theme1.xml.
 */

import JSZip from "jszip";
import PptxGenJS from "pptxgenjs";
import { toNodeBuffer } from "@/lib/work/deliverables/spreadsheet";
import { SemanticError, decodeDataImage } from "../shared";
import {
  DECK_LAYOUTS,
  DECK_LAYOUT_NAMES,
  FOOTER_BAND_Y,
  SLIDE_WIDTH,
  elementBox,
  type Box,
  type DeckChartElement,
  type DeckElement,
  type DeckModel,
  type DeckParagraph,
  type DeckRegion,
  type DeckSlide,
  type PlaceholderName,
} from "./model";
import { DEFAULT_TABLE_PT, MIN_BODY_PT, MIN_TABLE_PT, fitTableSize, fitTextSize, startingTextSize } from "./fit";

type Pptx = InstanceType<typeof PptxGenJS>;
type PptxSlide = ReturnType<Pptx["addSlide"]>;

/** pptxgenjs colours are hex without the '#'. */
function hex(color: string): string {
  return color.replace(/^#/, "").toUpperCase();
}

/** A colour mixed toward white, for the light image-placeholder fill. */
function tint(color: string, amount: number): string {
  const value = hex(color);
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return channels
    .map((channel) => Math.round(channel + (255 - channel) * amount).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Image size (for "contain" placement without a decoder)
// ---------------------------------------------------------------------------

/** Pixel size from the image header, or null when the header is unreadable. */
export function imagePixelSize(bytes: Buffer, extension: "png" | "jpeg" | "gif" | "webp"): { w: number; h: number } | null {
  try {
    if (extension === "png" && bytes.length >= 24 && bytes.toString("ascii", 12, 16) === "IHDR") {
      return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
    }
    if (extension === "gif" && bytes.length >= 10) {
      return { w: bytes.readUInt16LE(6), h: bytes.readUInt16LE(8) };
    }
    if (extension === "jpeg") {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) return null;
        const marker = bytes[offset + 1];
        const length = bytes.readUInt16BE(offset + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { w: bytes.readUInt16BE(offset + 7), h: bytes.readUInt16BE(offset + 5) };
        offset += 2 + length;
      }
      return null;
    }
    if (extension === "webp" && bytes.length >= 30 && bytes.toString("ascii", 8, 12) === "WEBP") {
      const chunk = bytes.toString("ascii", 12, 16);
      if (chunk === "VP8X") return { w: bytes.readUIntLE(24, 3) + 1, h: bytes.readUIntLE(27, 3) + 1 };
      if (chunk === "VP8 ") return { w: bytes.readUInt16LE(26) & 0x3fff, h: bytes.readUInt16LE(28) & 0x3fff };
      if (chunk === "VP8L") {
        const bits = bytes.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function containBox(box: Box, size: { w: number; h: number } | null): Box {
  if (!size || size.w <= 0 || size.h <= 0) return box;
  const scale = Math.min(box.w / size.w, box.h / size.h);
  const w = size.w * scale;
  const h = size.h * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

// ---------------------------------------------------------------------------
// Masters
// ---------------------------------------------------------------------------

function defineMasters(pptx: Pptx, model: DeckModel): void {
  const { theme, master } = model;
  for (const name of DECK_LAYOUT_NAMES) {
    const layout = DECK_LAYOUTS[name];
    const objects: NonNullable<Parameters<Pptx["defineSlideMaster"]>[0]["objects"]> = [];

    if (master.footer) {
      objects.push({
        text: {
          text: master.footer,
          options: {
            x: 0.5,
            y: FOOTER_BAND_Y,
            w: 5.5,
            h: 0.3,
            fontSize: 9,
            fontFace: theme.bodyFont,
            color: hex(theme.muted),
            valign: "middle",
          },
        },
      });
    }
    if (master.logoText) {
      objects.push({
        text: {
          text: master.logoText,
          options: {
            x: 6.1,
            y: FOOTER_BAND_Y,
            w: 2.7,
            h: 0.3,
            fontSize: 9,
            bold: true,
            fontFace: theme.headingFont,
            color: hex(theme.accent),
            align: "right",
            valign: "middle",
          },
        },
      });
    }
    for (const [placeholderName, spec] of Object.entries(layout.placeholders) as Array<
      [PlaceholderName, (typeof layout.placeholders)[PlaceholderName]]
    >) {
      if (!spec) continue;
      objects.push({
        placeholder: {
          options: {
            name: placeholderName,
            type: spec.type,
            ...spec.box,
            fontFace: spec.type === "title" ? theme.headingFont : theme.bodyFont,
            fontSize: spec.defaultPt,
            bold: spec.bold,
            align: spec.align,
            valign: spec.type === "title" ? "middle" : "top",
            color: hex(placeholderName === "subtitle" ? theme.muted : theme.text),
          },
          text: "",
        },
      });
    }

    pptx.defineSlideMaster({
      title: name,
      background: { color: hex(theme.background) },
      objects,
      ...(master.slideNumbers
        ? {
            slideNumber: {
              x: SLIDE_WIDTH - 1.1,
              y: FOOTER_BAND_Y,
              w: 0.6,
              h: 0.3,
              fontSize: 9,
              fontFace: theme.bodyFont,
              color: hex(theme.muted),
              align: "right",
            },
          }
        : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function textRuns(paragraphs: readonly DeckParagraph[]) {
  return paragraphs.map((paragraph, index) => ({
    text: paragraph.text,
    options: {
      bullet: paragraph.bullet ? true : false,
      indentLevel: paragraph.level,
      bold: paragraph.bold ?? false,
      breakLine: index < paragraphs.length - 1,
    },
  }));
}

const PALETTE = ["2F6FEB", "E8833A", "2DA44E", "BF3989", "8250DF", "D4A72C", "1B7C83", "CF222E", "57606A", "0969DA", "9A6700", "6E7781"];

function chartColors(model: DeckModel): string[] {
  const accent = hex(model.theme.accent);
  return [accent, ...PALETTE.filter((color) => color !== accent)].slice(0, 12);
}

function addChart(rendered: PptxSlide, model: DeckModel, element: DeckChartElement, box: Box): void {
  const type = (
    { bar: "bar", column: "bar", line: "line", pie: "pie", area: "area" } as const satisfies Record<
      DeckChartElement["chartType"],
      PptxGenJS.CHART_NAME
    >
  )[element.chartType];
  const data = element.series.map((series) => ({
    name: series.name,
    labels: element.categories,
    values: series.values,
  }));
  const font = model.theme.bodyFont;
  const textColor = hex(model.theme.text);
  rendered.addChart(type, data, {
    ...box,
    objectName: `chart:${element.id}`,
    ...(element.chartType === "bar" || element.chartType === "column"
      ? { barDir: element.chartType === "bar" ? "bar" : "col", barGrouping: "clustered" }
      : {}),
    chartColors: chartColors(model),
    showLegend: element.showLegend ?? element.series.length > 1,
    legendPos: "b",
    legendFontFace: font,
    legendFontSize: 11,
    legendColor: textColor,
    showTitle: Boolean(element.title),
    ...(element.title ? { title: element.title, titleFontFace: font, titleFontSize: 14, titleColor: textColor } : {}),
    catAxisLabelFontFace: font,
    catAxisLabelFontSize: 11,
    catAxisLabelColor: textColor,
    valAxisLabelFontFace: font,
    valAxisLabelFontSize: 11,
    valAxisLabelColor: textColor,
    ...(element.chartType === "pie" ? { showPercent: true, dataLabelColor: "FFFFFF" } : {}),
  });
}

function addElement(
  pptx: Pptx,
  rendered: PptxSlide,
  model: DeckModel,
  slide: DeckSlide,
  element: DeckElement,
  usedPlaceholders: Set<DeckRegion>
): void {
  const { theme } = model;
  const box = elementBox(slide, element);

  switch (element.type) {
    case "text": {
      const start = startingTextSize(slide, element);
      // Shrink to fit down to the 12 pt floor; past it the text stays at the
      // floor and validateDeckFit reports the overflow, rather than the file
      // quietly shipping unreadable 6 pt type.
      const size = fitTextSize(element.paragraphs, box, start, Math.min(start, MIN_BODY_PT)) ?? Math.min(start, MIN_BODY_PT);
      const common = { fontSize: size, fontFace: theme.bodyFont, color: hex(theme.text), valign: "top" as const };
      const region = element.box ? undefined : element.region;
      if (region && !usedPlaceholders.has(region)) {
        usedPlaceholders.add(region);
        rendered.addText(textRuns(element.paragraphs), { placeholder: region, ...common });
      } else {
        rendered.addText(textRuns(element.paragraphs), { ...box, ...common, objectName: `text:${element.id}` });
      }
      return;
    }

    case "image": {
      const decoded = decodeDataImage(element.src);
      if (decoded) {
        const placedBox = containBox(box, imagePixelSize(decoded.bytes, decoded.extension));
        rendered.addImage({
          data: `image/${decoded.extension};base64,${decoded.bytes.toString("base64")}`,
          ...placedBox,
          altText: element.alt,
          objectName: `image:${element.id}`,
        });
      } else {
        rendered.addText(`Image: ${element.alt}`, {
          ...box,
          shape: pptx.ShapeType.rect,
          fill: { color: tint(theme.muted, 0.85) },
          line: { color: tint(theme.muted, 0.5), width: 1, dashType: "dash" },
          fontSize: 12,
          fontFace: theme.bodyFont,
          color: hex(theme.muted),
          align: "center",
          valign: "middle",
          objectName: `image-placeholder:${element.id}`,
        });
      }
      return;
    }

    case "shape": {
      if (element.shape === "line" || element.shape === "arrow") {
        rendered.addShape(pptx.ShapeType.line, {
          ...box,
          line: {
            color: hex(element.line ?? element.fill ?? theme.text),
            width: 2,
            ...(element.shape === "arrow" ? { endArrowType: "triangle" as const } : {}),
          },
          objectName: `shape:${element.id}`,
        });
        return;
      }
      const shapeType = {
        rect: pptx.ShapeType.rect,
        roundRect: pptx.ShapeType.roundRect,
        ellipse: pptx.ShapeType.ellipse,
      }[element.shape];
      const fill = element.fill ?? (element.line ? undefined : theme.accent);
      const options = {
        ...box,
        ...(fill ? { fill: { color: hex(fill) } } : {}),
        ...(element.line ? { line: { color: hex(element.line), width: 1.5 } } : {}),
        ...(element.shape === "roundRect" ? { rectRadius: 0.12 } : {}),
        objectName: `shape:${element.id}`,
      };
      if (element.text) {
        const size = fitTextSize([{ text: element.text }], box, 14, MIN_BODY_PT) ?? MIN_BODY_PT;
        rendered.addText(element.text, {
          ...options,
          shape: shapeType,
          fontSize: size,
          fontFace: theme.bodyFont,
          color: fill ? "FFFFFF" : hex(theme.text),
          align: "center",
          valign: "middle",
        });
      } else {
        rendered.addShape(shapeType, options);
      }
      return;
    }

    case "chart":
      addChart(rendered, model, element, box);
      return;

    case "table": {
      const size = fitTableSize(element.header, element.rows, box, DEFAULT_TABLE_PT, MIN_TABLE_PT) ?? MIN_TABLE_PT;
      const columns = element.header.length;
      rendered.addTable(
        [
          element.header.map((cell) => ({
            text: cell,
            options: { bold: true, color: "FFFFFF", fill: { color: hex(theme.accent) } },
          })),
          ...element.rows.map((row) => row.map((cell) => ({ text: cell }))),
        ],
        {
          x: box.x,
          y: box.y,
          w: box.w,
          colW: Array.from({ length: columns }, () => box.w / columns),
          fontSize: size,
          fontFace: theme.bodyFont,
          color: hex(theme.text),
          border: { type: "solid", pt: 0.75, color: tint(theme.muted, 0.6) },
          valign: "middle",
          autoPage: false,
          objectName: `table:${element.id}`,
        }
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Transitions (post-processing: pptxgenjs 4.0.1 has no transition API)
// ---------------------------------------------------------------------------

const TRANSITION_XML = {
  fade: '<p:transition spd="med"><p:fade/></p:transition>',
  push: '<p:transition spd="med"><p:push dir="u"/></p:transition>',
} as const;

async function postProcess(bytes: Buffer, model: DeckModel): Promise<Buffer> {
  const transitions = model.slides.map((slide) => slide.transition);
  const needsTransitions = transitions.some((transition) => transition && transition !== "none");
  const needsWebp = model.slides.some((slide) =>
    slide.elements.some((element) => element.type === "image" && element.src.startsWith("data:image/webp"))
  );
  if (!needsTransitions && !needsWebp) return bytes;

  const zip = await JSZip.loadAsync(bytes);
  if (needsTransitions) {
    const order = await slidePartsInOrder(zip);
    for (const [index, transition] of transitions.entries()) {
      if (!transition || transition === "none") continue;
      const part = order[index];
      const file = part ? zip.file(part) : null;
      if (!file) throw new SemanticError("invalid_model", `Slide ${index + 1} is missing from the written file.`);
      const xml = await file.async("string");
      // <p:transition> follows <p:clrMapOvr> in CT_Slide (before <p:timing>).
      const updated = xml.includes("</p:clrMapOvr>")
        ? xml.replace("</p:clrMapOvr>", `</p:clrMapOvr>${TRANSITION_XML[transition]}`)
        : xml.replace("</p:cSld>", `</p:cSld>${TRANSITION_XML[transition]}`);
      zip.file(part, updated);
    }
  }
  if (needsWebp) {
    // pptxgenjs registers content types for png/jpeg/gif/svg only; a WebP part
    // without one is a file PowerPoint refuses to open.
    const types = await zip.file("[Content_Types].xml")!.async("string");
    if (!types.includes('Extension="webp"')) {
      zip.file(
        "[Content_Types].xml",
        types.replace(/(<Types[^>]*>)/, '$1<Default Extension="webp" ContentType="image/webp"/>')
      );
    }
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportDeckPptx(model: DeckModel): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.title = model.title;
  pptx.theme = { headFontFace: model.theme.headingFont, bodyFontFace: model.theme.bodyFont };
  defineMasters(pptx, model);

  for (const slide of model.slides) {
    const rendered = pptx.addSlide({ masterName: slide.layout });
    const layout = DECK_LAYOUTS[slide.layout];

    for (const which of ["title", "subtitle"] as const) {
      const text = slide[which];
      const spec = layout.placeholders[which];
      if (!text || !spec) continue;
      const size = fitTextSize([{ text, bold: spec.bold }], spec.box, spec.defaultPt, spec.minPt) ?? spec.minPt;
      rendered.addText(text, {
        placeholder: which,
        fontSize: size,
        fontFace: which === "title" ? model.theme.headingFont : model.theme.bodyFont,
        color: hex(which === "title" ? model.theme.text : model.theme.muted),
        bold: spec.bold,
        align: spec.align,
      });
    }

    const usedPlaceholders = new Set<DeckRegion>();
    for (const element of slide.elements) addElement(pptx, rendered, model, slide, element, usedPlaceholders);

    // An empty notes string still writes a notes part, and PowerPoint then
    // marks the slide as having notes; normalizeDeck already drops blank notes.
    if (slide.notes) rendered.addNotes(slide.notes);
  }

  const written = toNodeBuffer(await pptx.write({ outputType: "nodebuffer" }));
  return postProcess(written, model);
}

// ---------------------------------------------------------------------------
// Read back
// ---------------------------------------------------------------------------

export interface DeckReadbackChart {
  /** The OOXML plot type: "bar" (with direction), "line", "pie", "area", … */
  type: string;
  /** "bar" or "col" for bar charts. */
  barDir?: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
}

export interface DeckReadbackSlide {
  /** Every paragraph's text in document order (runs joined; field text such as slide numbers excluded). */
  texts: string[];
  notes: string;
  charts: number;
  chartData: DeckReadbackChart[];
  tables: number;
  images: number;
  /** Shapes with geometry, fill or outline: not placeholders, not plain text boxes, not image stand-ins. */
  shapes: number;
  /** Rectangles standing in for an https image the exporter did not fetch. */
  imagePlaceholders: number;
  /** The slide layout's name (the DeckLayout for files this module wrote). */
  layoutName: string;
  transition: "none" | "fade" | "push" | "other";
}

export interface DeckReadback {
  slideCount: number;
  title: string;
  slides: DeckReadbackSlide[];
}

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return match ? decodeXml(match[1]) : undefined;
}

/** Resolve a relationship target against the part that owns the .rels file. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = fromPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

async function readRels(zip: JSZip, part: string): Promise<Map<string, { type: string; target: string }>> {
  const rels = new Map<string, { type: string; target: string }>();
  const file = zip.file(relsPath(part));
  if (!file) return rels;
  const xml = await file.async("string");
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = attribute(match[0], "Id");
    const type = attribute(match[0], "Type");
    const target = attribute(match[0], "Target");
    if (id && type && target) rels.set(id, { type, target: resolveTarget(part, target) });
  }
  return rels;
}

async function slidePartsInOrder(zip: JSZip): Promise<string[]> {
  const presentation = zip.file("ppt/presentation.xml");
  if (!presentation) throw new SemanticError("unreadable", "The file has no ppt/presentation.xml; it is not a presentation.");
  const xml = await presentation.async("string");
  const rels = await readRels(zip, "ppt/presentation.xml");
  const order: string[] = [];
  for (const match of xml.matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const rid = attribute(match[0], "r:id");
    const rel = rid ? rels.get(rid) : undefined;
    if (rel) order.push(rel.target);
  }
  return order;
}

/** Paragraph texts in order, runs joined, field text (slide numbers, dates) skipped. */
function paragraphTexts(xml: string): string[] {
  const texts: string[] = [];
  for (const paragraph of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)) {
    const body = (paragraph[1] ?? paragraph[2] ?? "").replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "");
    let text = "";
    for (const run of body.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) text += decodeXml(run[1]);
    if (text.length > 0) texts.push(text);
  }
  return texts;
}

function readChart(xml: string): DeckReadbackChart {
  const plot = /<c:(\w+Chart)>/.exec(xml.replace(/<c:chart>/g, ""));
  const type = plot ? plot[1].replace(/Chart$/, "") : "unknown";
  const barDir = /<c:barDir val="(\w+)"/.exec(xml)?.[1];
  const points = (fragment: string): string[] => {
    const byIndex = new Map<number, string>();
    for (const pt of fragment.matchAll(/<c:pt idx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)) {
      byIndex.set(Number(pt[1]), decodeXml(pt[2]));
    }
    return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  };
  let categories: string[] = [];
  const series: DeckReadbackChart["series"] = [];
  for (const ser of xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)) {
    const body = ser[1];
    const name = points(/<c:tx>([\s\S]*?)<\/c:tx>/.exec(body)?.[1] ?? "")[0] ?? "";
    const cat = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(body)?.[1];
    if (cat && categories.length === 0) categories = points(cat);
    const val = /<c:val>([\s\S]*?)<\/c:val>/.exec(body)?.[1] ?? "";
    series.push({ name, values: points(val).map(Number) });
  }
  return { type, ...(barDir ? { barDir } : {}), categories, series };
}

/**
 * Reopens a .pptx and reports what each slide carries, in presentation order.
 * Reads any OOXML deck; the layout name and object classification are exact
 * for files `exportDeckPptx` wrote.
 */
export async function readDeckPptx(bytes: Buffer): Promise<DeckReadback> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new SemanticError("unreadable", `Not a readable .pptx: ${err instanceof Error ? err.message : String(err)}`);
  }
  const core = await zip.file("docProps/core.xml")?.async("string");
  const title = core ? decodeXml(/<dc:title>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? "") : "";

  const slides: DeckReadbackSlide[] = [];
  for (const part of await slidePartsInOrder(zip)) {
    const file = zip.file(part);
    if (!file) throw new SemanticError("unreadable", `The file lists ${part} but does not contain it.`);
    const xml = await file.async("string");
    const rels = await readRels(zip, part);

    let layoutName = "";
    let notes = "";
    for (const rel of rels.values()) {
      if (rel.type.endsWith("/slideLayout")) {
        const layoutXml = (await zip.file(rel.target)?.async("string")) ?? "";
        layoutName = attribute(/<p:cSld\b[^>]*>/.exec(layoutXml)?.[0] ?? "", "name") ?? "";
      } else if (rel.type.endsWith("/notesSlide")) {
        const notesXml = (await zip.file(rel.target)?.async("string")) ?? "";
        for (const sp of notesXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
          if (/<p:ph\b[^>]*type="body"/.test(sp[1])) notes = paragraphTexts(sp[1]).join("\n");
        }
      }
    }

    const chartData: DeckReadbackChart[] = [];
    for (const ref of xml.matchAll(/<c:chart\b[^>]*r:id="([^"]+)"/g)) {
      const rel = rels.get(ref[1]);
      const chartXml = rel ? await zip.file(rel.target)?.async("string") : undefined;
      if (chartXml) chartData.push(readChart(chartXml));
    }

    let shapes = 0;
    let imagePlaceholders = 0;
    for (const sp of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const body = sp[1];
      if (/<p:ph\b/.test(body)) continue;
      const name = attribute(/<p:cNvPr\b[^>]*>/.exec(body)?.[0] ?? "", "name") ?? "";
      if (name.startsWith("image-placeholder:")) {
        imagePlaceholders += 1;
        continue;
      }
      const spPr = /<p:spPr>([\s\S]*?)<\/p:spPr>/.exec(body)?.[1] ?? "";
      const geometry = /<a:prstGeom prst="(\w+)"/.exec(spPr)?.[1] ?? "rect";
      const outline = /<a:ln\b[^>]*>([\s\S]*?)<\/a:ln>/.exec(spPr)?.[1] ?? "";
      const plainTextBox =
        geometry === "rect" && /<a:noFill\/>/.test(spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/, "")) && !/<a:solidFill>/.test(outline);
      if (!plainTextBox) shapes += 1;
    }

    const transitionMatch = /<p:transition\b[^>]*>([\s\S]*?)<\/p:transition>/.exec(xml);
    const transition: DeckReadbackSlide["transition"] = !transitionMatch
      ? "none"
      : /<p:fade\b/.test(transitionMatch[1])
        ? "fade"
        : /<p:push\b/.test(transitionMatch[1])
          ? "push"
          : "other";

    slides.push({
      texts: paragraphTexts(xml),
      notes,
      charts: chartData.length,
      chartData,
      tables: (xml.match(/<a:tbl>/g) ?? []).length,
      images: (xml.match(/<p:pic>/g) ?? []).length,
      shapes,
      imagePlaceholders,
      layoutName,
      transition,
    });
  }
  return { slideCount: slides.length, title, slides };
}
