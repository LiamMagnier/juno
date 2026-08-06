/**
 * Typed deck specs -> a real .pptx.
 *
 * `src/lib/office-export.ts` decides where slides begin by splitting markdown
 * on `---` or `## `, and then flattens whatever it finds into a bullet list.
 * That is the correct reading of a document somebody wrote as prose, and it is
 * the reason the chat system prompt has to instruct the model to write "one
 * slide per `## ` heading". Here the deck is specified: a slide declares its
 * layout, and the layout decides where its text goes. Nothing is split, nothing
 * is guessed, and a slide with two paragraphs and a table does not silently
 * become fourteen bullets. office-export.ts is untouched and still serves the
 * markdown path it was built for.
 *
 * Layouts are a closed set rather than free geometry. A spec that could place
 * a text box at arbitrary inches would put the agent in charge of visual
 * design, and the failure mode of that is not an ugly deck — it is overlapping
 * boxes and text running off the slide, neither of which any validator can
 * detect, because the file opens perfectly.
 */

import PptxGenJS from "pptxgenjs";
import { z } from "zod";
import { toNodeBuffer } from "@/lib/work/deliverables/spreadsheet";
import { DeliverableError } from "@/lib/work/deliverables/validate";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_SLIDES = 300;
const MAX_TITLE_CHARS = 300;
const MAX_BULLETS = 20;
const MAX_BULLET_CHARS = 500;
const MAX_PARAGRAPHS = 10;
const MAX_PARAGRAPH_CHARS = 2_000;
const MAX_NOTES_CHARS = 4_000;
const MAX_TABLE_COLUMNS = 10;
const MAX_TABLE_ROWS = 20;
const MAX_CELL_CHARS = 300;

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

const title = z.string().trim().min(1).max(MAX_TITLE_CHARS);
const notes = z.string().trim().max(MAX_NOTES_CHARS).optional();

const bulletSchema = z.object({
  text: z.string().trim().min(1).max(MAX_BULLET_CHARS),
  /** 0 is a top-level bullet, 1 is one indent in. Two levels is the useful limit. */
  level: z.number().int().min(0).max(2).optional(),
});

export const slideSpecSchema = z.discriminatedUnion("layout", [
  /** The opening slide: one large title, one optional line under it. */
  z.object({
    layout: z.literal("title"),
    title,
    subtitle: z.string().trim().max(MAX_TITLE_CHARS).optional(),
    notes,
  }),
  /** A divider between parts of the deck. Title only, centred. */
  z.object({ layout: z.literal("section"), title, notes }),
  z.object({
    layout: z.literal("bullets"),
    title,
    bullets: z.array(bulletSchema).min(1).max(MAX_BULLETS),
    notes,
  }),
  z.object({
    layout: z.literal("body"),
    title,
    paragraphs: z.array(z.string().trim().min(1).max(MAX_PARAGRAPH_CHARS)).min(1).max(MAX_PARAGRAPHS),
    notes,
  }),
  z.object({
    layout: z.literal("table"),
    title,
    header: z.array(z.string().trim().max(MAX_CELL_CHARS)).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(z.array(z.string().trim().max(MAX_CELL_CHARS))).max(MAX_TABLE_ROWS),
    notes,
  }),
]);

export type SlideSpec = z.infer<typeof slideSpecSchema>;

export const presentationSpecSchema = z.object({
  kind: z.literal("presentation"),
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  slides: z.array(slideSpecSchema).min(1).max(MAX_SLIDES),
});

export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * LAYOUT_16x9 is 10 x 5.625 inches, and every box below is placed inside it
 * with a half-inch margin. The numbers are here rather than inline so the one
 * invariant that matters — nothing extends past 9.5 across or 5.2 down — can be
 * checked by reading nine lines instead of forty.
 */
const MARGIN = 0.5;
const CONTENT_WIDTH = 9;
const TITLE_Y = 0.35;
const TITLE_HEIGHT = 0.8;
const BODY_Y = 1.4;
const BODY_HEIGHT = 3.6;

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the .pptx bytes for a validated spec.
 *
 * The row-width check is the same rule the document and spreadsheet builders
 * apply, and for the same reason: a short row does not draw a short row, it
 * shifts every later value one column left.
 */
export async function buildPresentation(spec: PresentationSpec): Promise<Buffer> {
  for (const [index, slide] of spec.slides.entries()) {
    if (slide.layout !== "table") continue;
    for (const [rowIndex, row] of slide.rows.entries()) {
      if (row.length !== slide.header.length) {
        throw new DeliverableError(
          "invalid_spec",
          `Slide ${index + 1} ("${slide.title}") table row ${rowIndex + 1} has ${row.length} cells ` +
            `but the header declares ${slide.header.length}.`
        );
      }
    }
  }

  try {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_16x9";
    pptx.title = spec.title;

    for (const slide of spec.slides) {
      const rendered = pptx.addSlide();

      if (slide.layout === "title" || slide.layout === "section") {
        rendered.addText(slide.title, {
          x: MARGIN,
          y: slide.layout === "title" ? 2.0 : 2.4,
          w: CONTENT_WIDTH,
          h: 1.0,
          fontSize: slide.layout === "title" ? 36 : 30,
          bold: true,
          align: "center",
        });
        if (slide.layout === "title" && slide.subtitle) {
          rendered.addText(slide.subtitle, {
            x: MARGIN,
            y: 3.05,
            w: CONTENT_WIDTH,
            h: 0.6,
            fontSize: 16,
            color: "555555",
            align: "center",
          });
        }
      } else {
        rendered.addText(slide.title, {
          x: MARGIN,
          y: TITLE_Y,
          w: CONTENT_WIDTH,
          h: TITLE_HEIGHT,
          fontSize: 28,
          bold: true,
        });
      }

      if (slide.layout === "bullets") {
        rendered.addText(
          slide.bullets.map((bullet) => ({
            text: bullet.text,
            options: { bullet: true, indentLevel: bullet.level ?? 0, breakLine: true },
          })),
          { x: MARGIN, y: BODY_Y, w: CONTENT_WIDTH, h: BODY_HEIGHT, fontSize: 16, valign: "top" }
        );
      } else if (slide.layout === "body") {
        rendered.addText(
          slide.paragraphs.map((paragraph) => ({
            text: paragraph,
            options: { breakLine: true, paraSpaceAfter: 8 },
          })),
          { x: MARGIN, y: BODY_Y, w: CONTENT_WIDTH, h: BODY_HEIGHT, fontSize: 16, valign: "top" }
        );
      } else if (slide.layout === "table") {
        rendered.addTable(
          [
            slide.header.map((cell) => ({ text: cell, options: { bold: true, fill: { color: "F1F1F1" } } })),
            ...slide.rows.map((row) => row.map((cell) => ({ text: cell }))),
          ],
          {
            x: MARGIN,
            y: BODY_Y,
            w: CONTENT_WIDTH,
            fontSize: 12,
            border: { type: "solid", pt: 1, color: "DDDDDD" },
          }
        );
      }

      // Speaker notes carry the provenance sentence a presenter needs and the
      // slide has no room for. Empty notes are skipped: pptxgenjs writes a
      // notes part for an empty string, and PowerPoint then shows every slide
      // as having notes.
      if (slide.notes) rendered.addNotes(slide.notes);
    }

    return toNodeBuffer(await pptx.write({ outputType: "nodebuffer" }));
  } catch (err) {
    if (err instanceof DeliverableError) throw err;
    throw new DeliverableError("build_failed", `Could not build the .pptx: ${reason(err)}`);
  }
}
