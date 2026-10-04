/**
 * Will it fit? A deck file that opens perfectly can still have text running
 * off the slide, a box past the edge or a chart on top of a table. These
 * checks estimate layout from the model alone (no renderer, no font files),
 * so the canvas, the chat tool and the exporter agree on the same answer.
 *
 * The estimate is deliberately simple: an average glyph is half an em wide,
 * a line is 1.2 em tall, words wrap greedily, and boxes have PowerPoint's
 * default insets (0.1 in left/right, 0.05 in top/bottom). It errs slightly
 * towards "does not fit", which is the useful direction.
 */

import {
  DECK_LAYOUTS,
  FOOTER_BAND_Y,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  elementBox,
  type Box,
  type DeckElement,
  type DeckModel,
  type DeckSlide,
} from "./model";

export interface FitIssue {
  slideId: string;
  elementId?: string;
  kind: "overflow" | "outside" | "overlap" | "dense" | "empty";
  message: string;
}

export interface FitParagraph {
  text: string;
  level?: number;
  bullet?: boolean;
  bold?: boolean;
}

const INSET_X = 0.1;
const INSET_Y = 0.05;
const LINE_HEIGHT = 1.2;
const GLYPH_EM = 0.5;
const BOLD_FACTOR = 1.06;
/** pptxgenjs indents 0.375 in per level, and a bullet hangs another 0.375 in. */
const INDENT_IN = 0.375;
const EPSILON = 1e-6;

/** Body text never shrinks below this; past it the honest answer is "overflow". */
export const MIN_BODY_PT = 12;
/** The smallest size a table is still readable at. */
export const MIN_TABLE_PT = 10;
/** Free text boxes start here when the element does not set a size. */
export const DEFAULT_BOX_PT = 18;
export const DEFAULT_TABLE_PT = 14;
/** More categories than this and a chart's labels collide. */
export const DENSE_CHART_CATEGORIES = 12;

/** Greedy word wrap in average-glyph units; a word longer than a line breaks across lines. */
function wrappedLines(text: string, charsPerLine: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let used = 0;
  for (const word of words) {
    const length = word.length;
    if (used === 0) {
      if (length > charsPerLine) {
        lines += Math.ceil(length / charsPerLine) - 1;
        used = length % charsPerLine || charsPerLine;
      } else {
        used = length;
      }
    } else if (used + 1 + length <= charsPerLine) {
      used += 1 + length;
    } else {
      lines += 1;
      if (length > charsPerLine) {
        lines += Math.ceil(length / charsPerLine) - 1;
        used = length % charsPerLine || charsPerLine;
      } else {
        used = length;
      }
    }
  }
  return lines;
}

/** Estimated height in inches of `paragraphs` at `pt` in a box `width` inches wide. */
export function textHeight(paragraphs: readonly FitParagraph[], width: number, pt: number): number {
  const lineIn = (pt * LINE_HEIGHT) / 72;
  let lines = 0;
  for (const paragraph of paragraphs) {
    const indent = ((paragraph.level ?? 0) + (paragraph.bullet ? 1 : 0)) * INDENT_IN;
    const glyphIn = ((pt * GLYPH_EM) / 72) * (paragraph.bold ? BOLD_FACTOR : 1);
    const usable = Math.max(width - 2 * INSET_X - indent, glyphIn);
    const charsPerLine = Math.max(1, Math.floor(usable / glyphIn));
    lines += wrappedLines(paragraph.text, charsPerLine);
  }
  return lines * lineIn + 2 * INSET_Y;
}

/**
 * The largest size from `maxPt` down to `minPt` (in half-point steps) at which
 * the paragraphs fit the box, or null when they do not fit even at `minPt`.
 */
export function fitTextSize(
  paragraphs: readonly FitParagraph[],
  box: Pick<Box, "w" | "h">,
  maxPt: number,
  minPt: number
): number | null {
  for (let pt = maxPt; pt >= minPt - EPSILON; pt -= 0.5) {
    if (textHeight(paragraphs, box.w, pt) <= box.h + EPSILON) return pt;
  }
  return null;
}

/** Estimated table height (inches) with equal column widths. */
export function tableHeight(header: readonly string[], rows: readonly string[][], width: number, pt: number): number {
  const columnWidth = width / Math.max(1, header.length);
  const lineIn = (pt * LINE_HEIGHT) / 72;
  const glyphIn = (pt * GLYPH_EM) / 72;
  const charsPerLine = Math.max(1, Math.floor(Math.max(columnWidth - 2 * INSET_X, glyphIn) / glyphIn));
  let total = 0;
  for (const [index, row] of [header, ...rows].entries()) {
    const factor = index === 0 ? BOLD_FACTOR : 1;
    let tallest = 1;
    for (const cell of row) tallest = Math.max(tallest, wrappedLines(cell, Math.max(1, Math.floor(charsPerLine / factor))));
    total += tallest * lineIn + 2 * INSET_Y;
  }
  return total;
}

/** The largest table font size that fits the box, or null below `minPt`. */
export function fitTableSize(
  header: readonly string[],
  rows: readonly string[][],
  box: Pick<Box, "w" | "h">,
  maxPt = DEFAULT_TABLE_PT,
  minPt = MIN_TABLE_PT
): number | null {
  for (let pt = maxPt; pt >= minPt - EPSILON; pt -= 0.5) {
    if (tableHeight(header, rows, box.w, pt) <= box.h + EPSILON) return pt;
  }
  return null;
}

/** The size a text element starts at: its own, its region's, or the free-box default. */
export function startingTextSize(slide: Pick<DeckSlide, "layout">, element: DeckElement & { type: "text" }): number {
  if (element.fontSize) return element.fontSize;
  if (!element.box && element.region) {
    return DECK_LAYOUTS[slide.layout].placeholders[element.region]?.defaultPt ?? DEFAULT_BOX_PT;
  }
  return DEFAULT_BOX_PT;
}

function area(box: Box): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function outsideSlide(box: Box): boolean {
  return box.x < -EPSILON || box.y < -EPSILON || box.x + box.w > SLIDE_WIDTH + EPSILON || box.y + box.h > SLIDE_HEIGHT + EPSILON;
}

function describe(element: DeckElement): string {
  return `${element.type} ${element.id}`;
}

/**
 * Every fit problem on every slide, in slide order. An empty array means the
 * deck is expected to render without clipping, collisions or crowding.
 */
export function validateDeckFit(model: DeckModel): FitIssue[] {
  const issues: FitIssue[] = [];
  const footerShown = Boolean(model.master.footer || model.master.slideNumbers || model.master.logoText);

  for (const slide of model.slides) {
    const layout = DECK_LAYOUTS[slide.layout];

    if (!slide.title && !slide.subtitle && slide.elements.length === 0) {
      issues.push({ slideId: slide.id, kind: "empty", message: `Slide ${slide.id} has no title and no content.` });
      continue;
    }

    // Titles shrink down to their placeholder's floor, then report.
    for (const which of ["title", "subtitle"] as const) {
      const text = slide[which];
      const placeholder = layout.placeholders[which];
      if (!text || !placeholder) continue;
      const size = fitTextSize([{ text, bold: placeholder.bold }], placeholder.box, placeholder.defaultPt, placeholder.minPt);
      if (size === null) {
        issues.push({
          slideId: slide.id,
          kind: "overflow",
          message: `The ${which} of slide ${slide.id} does not fit its placeholder even at ${placeholder.minPt} pt; shorten it.`,
        });
      }
    }

    const placed: Array<{ id?: string; label: string; box: Box }> = [];
    if (slide.title && layout.placeholders.title) {
      placed.push({ label: "the title", box: layout.placeholders.title.box });
    }
    if (slide.subtitle && layout.placeholders.subtitle) {
      placed.push({ label: "the subtitle", box: layout.placeholders.subtitle.box });
    }

    for (const element of slide.elements) {
      let box: Box;
      try {
        box = elementBox(slide, element);
      } catch (err) {
        issues.push({
          slideId: slide.id,
          elementId: element.id,
          kind: "outside",
          message: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (outsideSlide(box)) {
        issues.push({
          slideId: slide.id,
          elementId: element.id,
          kind: "outside",
          message: `The ${describe(element)} on slide ${slide.id} extends past the edge of the ${SLIDE_WIDTH} x ${SLIDE_HEIGHT} in slide.`,
        });
      } else if (footerShown && element.type !== "shape" && box.y + box.h > FOOTER_BAND_Y + EPSILON) {
        issues.push({
          slideId: slide.id,
          elementId: element.id,
          kind: "outside",
          message: `The ${describe(element)} on slide ${slide.id} runs into the footer band (below ${FOOTER_BAND_Y} in).`,
        });
      }

      if (element.type === "text") {
        const start = startingTextSize(slide, element);
        if (fitTextSize(element.paragraphs, box, start, Math.min(start, MIN_BODY_PT)) === null) {
          issues.push({
            slideId: slide.id,
            elementId: element.id,
            kind: "overflow",
            message:
              `The text ${element.id} on slide ${slide.id} does not fit its ${box.w} x ${box.h} in box even at ` +
              `${Math.min(start, MIN_BODY_PT)} pt; split it across slides or cut it.`,
          });
        }
      } else if (element.type === "table") {
        if (fitTableSize(element.header, element.rows, box) === null) {
          issues.push({
            slideId: slide.id,
            elementId: element.id,
            kind: "overflow",
            message:
              `The table ${element.id} on slide ${slide.id} (${element.rows.length} rows) is taller than its box ` +
              `even at ${MIN_TABLE_PT} pt; split it.`,
          });
        }
      } else if (element.type === "chart") {
        if (element.categories.length > DENSE_CHART_CATEGORIES) {
          issues.push({
            slideId: slide.id,
            elementId: element.id,
            kind: "dense",
            message:
              `The chart ${element.id} on slide ${slide.id} has ${element.categories.length} categories; ` +
              `more than ${DENSE_CHART_CATEGORIES} crowd the axis labels.`,
          });
        }
      } else if (element.type === "shape" && element.text) {
        if (fitTextSize([{ text: element.text }], box, 14, MIN_BODY_PT) === null) {
          issues.push({
            slideId: slide.id,
            elementId: element.id,
            kind: "overflow",
            message: `The text in shape ${element.id} on slide ${slide.id} does not fit the shape.`,
          });
        }
      }

      // Shapes are decoration and may sit behind content on purpose.
      if (element.type !== "shape") placed.push({ id: element.id, label: describe(element), box });
    }

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        const shared = intersection(a.box, b.box);
        const smaller = Math.min(area(a.box), area(b.box));
        if (smaller > 0 && shared > 0.1 * smaller) {
          issues.push({
            slideId: slide.id,
            elementId: b.id ?? a.id,
            kind: "overlap",
            message: `On slide ${slide.id}, ${b.label} overlaps ${a.label} (${Math.round((shared / smaller) * 100)}% of the smaller box).`,
          });
        }
      }
    }
  }
  return issues;
}
