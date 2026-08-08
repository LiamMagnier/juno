/**
 * .pptx → one block per text box, per slide, plus the speaker notes.
 *
 * The unit is the shape, not the bullet. A single bullet ("Down 12% YoY") is
 * unreadable once it is retrieved away from the four bullets around it, so a
 * text box's paragraphs stay together in one block — the same argument that
 * keeps a Word table's header row attached to its rows.
 *
 * Slide order comes from `ppt/presentation.xml`, never from the file names.
 * `slide7.xml` is the seventh slide *ever created*, not the seventh slide shown:
 * deleting and reordering slides leaves the numbering scrambled, and a citation
 * that says "slide 7" while the deck shows it fourth is worse than no citation.
 */

import { openOoxml, scanXml, xmlAttr, type OoxmlPackage } from "./ooxml";
import { BlockCollector, EXTRACT_LIMITS, type ExtractedBlock, type ExtractionResult } from "./types";

export const PPTX_PARSER = "pptx";
export const PPTX_PARSER_VERSION = "1";

/** English Metric Units per point. OOXML measures layout in EMU; bboxes are points. */
const EMU_PER_POINT = 12_700;

interface Shape {
  isTitle: boolean;
  /** Placeholder type, e.g. "title" | "ctrTitle" | "body" | "sldNum". */
  placeholder: string | null;
  paragraphs: string[];
  bbox?: number[];
}

/**
 * Slides in presentation order.
 *
 * `presentation.xml` lists slide relationship ids in display order; the rels
 * part maps each to a part name. When either is missing or unreadable we fall
 * back to a numeric sort of the slide parts, which is right for every deck that
 * has never been reordered and clearly labelled as a guess by nothing at all —
 * so the fallback also degrades the result.
 */
async function slidePartsInOrder(pkg: OoxmlPackage): Promise<{ parts: string[]; ordered: boolean }> {
  const present = pkg.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const numeric = present.sort(
    (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0)
  );

  const presentation = await pkg.read("ppt/presentation.xml");
  const rels = await pkg.read("ppt/_rels/presentation.xml.rels");
  if (!presentation || !rels) return { parts: numeric, ordered: false };

  const target = new Map<string, string>();
  scanXml(rels, (event) => {
    if ((event.kind === "open" || event.kind === "empty") && event.name === "Relationship") {
      const id = xmlAttr(event.attrs, "Id");
      const to = xmlAttr(event.attrs, "Target");
      if (id && to) target.set(id, `ppt/${to.replace(/^\.\.\//, "").replace(/^\//, "")}`);
    }
  });

  const ordered: string[] = [];
  scanXml(presentation, (event) => {
    if ((event.kind === "open" || event.kind === "empty") && event.name === "p:sldId") {
      const rid = xmlAttr(event.attrs, "r:id");
      const part = rid ? target.get(rid) : undefined;
      if (part && present.includes(part)) ordered.push(part);
    }
  });

  return ordered.length ? { parts: ordered, ordered: true } : { parts: numeric, ordered: false };
}

/** Every shape on one slide (or notes page), with its placeholder role and box. */
function shapesOf(xml: string): Shape[] {
  const shapes: Shape[] = [];
  let shape: Shape | null = null;
  let runs: string[] = [];
  let inParagraph = false;
  let inText = false;
  let offset: { x: number; y: number } | null = null;
  let extent: { w: number; h: number } | null = null;

  const endShape = () => {
    if (!shape) return;
    if (offset && extent) {
      shape.bbox = [
        offset.x / EMU_PER_POINT,
        offset.y / EMU_PER_POINT,
        extent.w / EMU_PER_POINT,
        extent.h / EMU_PER_POINT,
      ];
    }
    if (shape.paragraphs.some((p) => p.trim())) shapes.push(shape);
    shape = null;
    offset = null;
    extent = null;
  };

  scanXml(xml, (event) => {
    if (event.kind === "text") {
      if (inText && inParagraph) runs.push(event.text);
      return;
    }
    const name = event.name;

    if (event.kind === "open" || event.kind === "empty") {
      switch (name) {
        case "p:sp":
        case "p:graphicFrame":
          endShape();
          shape = { isTitle: false, placeholder: null, paragraphs: [] };
          return;
        case "p:ph": {
          if (!shape) return;
          const type = xmlAttr(event.attrs, "type");
          shape.placeholder = type;
          shape.isTitle = type === "title" || type === "ctrTitle";
          return;
        }
        case "a:off":
          offset = {
            x: Number(xmlAttr(event.attrs, "x") ?? NaN),
            y: Number(xmlAttr(event.attrs, "y") ?? NaN),
          };
          if (!Number.isFinite(offset.x) || !Number.isFinite(offset.y)) offset = null;
          return;
        case "a:ext":
          extent = {
            w: Number(xmlAttr(event.attrs, "cx") ?? NaN),
            h: Number(xmlAttr(event.attrs, "cy") ?? NaN),
          };
          if (!Number.isFinite(extent.w) || !Number.isFinite(extent.h)) extent = null;
          return;
        case "a:p":
          inParagraph = true;
          runs = [];
          return;
        case "a:t":
          inText = event.kind === "open";
          return;
        case "a:br":
          if (inParagraph) runs.push("\n");
          return;
        default:
          return;
      }
    }

    switch (name) {
      case "a:t":
        inText = false;
        return;
      case "a:p":
        if (shape && inParagraph) shape.paragraphs.push(runs.join(""));
        inParagraph = false;
        runs = [];
        return;
      case "p:sp":
      case "p:graphicFrame":
        endShape();
        return;
      default:
    }
  });
  endShape();
  return shapes;
}

export async function extractPptx(input: { bytes: Uint8Array; fileName: string }): Promise<ExtractionResult> {
  const base = { parser: PPTX_PARSER, parserVersion: PPTX_PARSER_VERSION };

  const opened = await openOoxml(input.bytes);
  if (!opened.ok) return { ...base, status: "failed", blocks: [], reason: opened.reason };
  const pkg = opened.pkg;

  const { parts, ordered } = await slidePartsInOrder(pkg);
  if (!parts.length) {
    return {
      ...base,
      status: "failed",
      blocks: [],
      reason: "This .pptx contains no slides — the file is either damaged or not a PowerPoint deck.",
    };
  }

  const collector = new BlockCollector();
  const slides = parts.slice(0, EXTRACT_LIMITS.maxSections);

  for (let index = 0; index < slides.length; index += 1) {
    const part = slides[index];
    const slide = index + 1;
    const xml = await pkg.read(part);
    if (!xml) continue;

    const shapes = shapesOf(xml);
    const titleShape = shapes.find((s) => s.isTitle);
    const title = titleShape ? titleShape.paragraphs.join(" ").trim() : "";
    // Every block on the slide is filed under the slide's title, so a retrieved
    // bullet can say which slide it belongs to without re-reading the deck.
    const heading = title ? [title] : [];

    const push = (block: Omit<ExtractedBlock, "confidence" | "slide">) => {
      collector.push({ ...block, slide, confidence: 1 });
    };

    if (titleShape) {
      push({ type: "slide_title", text: title, heading: [], path: part, bbox: titleShape.bbox });
    }
    for (const shape of shapes) {
      if (shape === titleShape) continue;
      // Slide-number and date placeholders hold a field, not content; indexing
      // them fills the corpus with blocks whose entire text is "4".
      if (shape.placeholder === "sldNum" || shape.placeholder === "dt" || shape.placeholder === "ftr") continue;
      push({ type: "paragraph", text: shape.paragraphs.join("\n"), heading, path: part, bbox: shape.bbox });
    }

    const notesPart = part.replace("ppt/slides/slide", "ppt/notesSlides/notesSlide");
    const notesXml = pkg.names.includes(notesPart) ? await pkg.read(notesPart) : null;
    if (notesXml) {
      const notes = shapesOf(notesXml)
        .filter((s) => s.placeholder !== "sldNum" && s.placeholder !== "dt")
        .map((s) => s.paragraphs.join("\n"))
        .join("\n")
        .trim();
      if (notes) push({ type: "speaker_notes", text: notes, heading, path: notesPart });
    }
  }

  const blocks = collector.done();
  if (!blocks.length) {
    return {
      ...base,
      status: "degraded",
      blocks: [],
      pageCount: slides.length,
      reason: "This deck has no text — its slides are images only, and Juno does not read text out of pictures yet.",
    };
  }

  const truncated = parts.length > slides.length || collector.hitLimit;
  const reason = !ordered
    ? "Slide order could not be read from the deck, so slide numbers follow the file's internal order and may not match what you see in PowerPoint."
    : truncated
      ? "This deck is longer than Juno's indexing limit, so only its first slides were indexed."
      : undefined;

  return {
    ...base,
    status: reason ? "degraded" : "ok",
    blocks,
    pageCount: slides.length,
    reason,
  };
}
