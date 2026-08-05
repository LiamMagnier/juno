/**
 * Typed document specs -> a real .docx.
 *
 * The block vocabulary declared here is the whole deliverables layer's, not
 * just the .docx builder's: `report.ts` renders the same blocks to markdown and
 * to print-ready HTML, and `site.ts` renders them into pages. One vocabulary
 * rendered three ways is the reason a heading is a heading in every output
 * rather than a line that happened to start with a `#` in one of them.
 *
 * WHY NOT `src/lib/office-export.ts`, which already builds .docx files: that
 * module's entry points are `toDocx(markdown, title)` and friends — they parse
 * model-authored markdown and infer structure from it, which is exactly right
 * for the chat canvas, where the model emits prose and the user picks a
 * download format afterwards. It is exactly wrong here. A Work deliverable is
 * specified before it is built: the agent says "a table with these four typed
 * columns", not "here is some markdown, guess where the table is". Routing a
 * spec through markdown to get back to structure would mean serialising a
 * table to pipes so a parser could split it on pipes again, and every cell
 * containing a `|` would be a data-loss bug nobody could see. So nothing in
 * office-export.ts is forked and nothing is deleted: it stays the download-time
 * markdown conversion for chat artifacts, and this is the typed path. The only
 * overlap is that both call the `docx` package, which is the library's surface,
 * not shared Juno code.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import { z } from "zod";
import { DeliverableError } from "@/lib/work/deliverables/validate";

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

/**
 * Bounds on one authored string.
 *
 * Generous for a paragraph, small enough that a runaway generation cannot put a
 * megabyte into a single run and produce a document whose layout engine hangs
 * rather than failing.
 */
const MAX_RUN_CHARS = 20_000;
const MAX_RUNS_PER_BLOCK = 200;
const MAX_LIST_ITEMS = 500;
const MAX_CODE_LINES = 2_000;
const MAX_TABLE_COLUMNS = 32;
const MAX_TABLE_ROWS = 5_000;
const MAX_BLOCKS = 5_000;

/**
 * A styled span, as a field rather than as markup.
 *
 * `{ text: "3 * 4 * 5", bold: true }` cannot be misread; `"**3 * 4 * 5**"`
 * can, and every markdown parser reads that emphasis differently. The point of
 * a typed spec is that there is no second interpretation step between what the
 * agent meant and what the reader sees.
 */
export const textRunSchema = z.object({
  text: z.string().max(MAX_RUN_CHARS),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  /** Monospaced. For an identifier or a value, not for a code block. */
  code: z.boolean().optional(),
});

export type TextRunSpec = z.infer<typeof textRunSchema>;

/** A plain string where nothing is styled, a run array where something is. */
export const richTextSchema = z.union([
  z.string().max(MAX_RUN_CHARS),
  z.array(textRunSchema).min(1).max(MAX_RUNS_PER_BLOCK),
]);

export type RichText = z.infer<typeof richTextSchema>;

export function toRuns(value: RichText): TextRunSpec[] {
  return typeof value === "string" ? [{ text: value }] : value;
}

export function toPlainText(value: RichText): string {
  return toRuns(value)
    .map((run) => run.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export const documentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heading"),
    level: z.number().int().min(1).max(6),
    text: richTextSchema,
  }),
  z.object({ type: z.literal("paragraph"), text: richTextSchema }),
  z.object({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(richTextSchema).min(1).max(MAX_LIST_ITEMS),
  }),
  z.object({ type: z.literal("quote"), text: richTextSchema }),
  z.object({
    type: z.literal("code"),
    /** For the markdown and HTML renderings; .docx has no syntax highlighting. */
    language: z.string().trim().max(40).optional(),
    lines: z.array(z.string().max(MAX_RUN_CHARS)).max(MAX_CODE_LINES),
  }),
  z.object({
    type: z.literal("table"),
    caption: z.string().trim().max(300).optional(),
    header: z.array(richTextSchema).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(z.array(richTextSchema)).max(MAX_TABLE_ROWS),
  }),
  z.object({ type: z.literal("pageBreak") }),
]);

export type DocumentBlock = z.infer<typeof documentBlockSchema>;
export type TableBlock = Extract<DocumentBlock, { type: "table" }>;

export const documentSpecSchema = z.object({
  kind: z.literal("document"),
  title: z.string().trim().min(1).max(300),
  subtitle: z.string().trim().max(300).optional(),
  blocks: z.array(documentBlockSchema).min(1).max(MAX_BLOCKS),
});

export type DocumentSpec = z.infer<typeof documentSpecSchema>;

/**
 * Checks a table is rectangular, and refuses it if not.
 *
 * `office-export.ts` pads ragged rows, which is the right call there: it is
 * parsing markdown a model wrote freehand, and dropping a row because it had
 * one pipe too few would lose real data. Here the table arrived as a typed
 * spec, so a row with the wrong number of cells is not raggedness to be
 * tolerated — it means the producer lost track of its own columns, and padding
 * it silently shifts every value in that row under the wrong heading. A
 * spreadsheet of correct numbers under wrong headings is worse than an error.
 *
 * Shared by all three renderers so a table that is refused in one is refused in
 * every one, rather than a .docx export succeeding where the markdown failed.
 */
export function assertRectangularTable(block: TableBlock, where: string): void {
  const width = block.header.length;
  for (const [index, row] of block.rows.entries()) {
    if (row.length !== width) {
      throw new DeliverableError(
        "invalid_spec",
        `${where}: table row ${index + 1} has ${row.length} cells but the header declares ${width}. ` +
          `Rows are not padded, because a padded row files its values under the wrong headings.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// docx rendering
// ---------------------------------------------------------------------------

const DOCX_HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const MONO = "Consolas";
const ORDERED_REF = "juno-work-ordered";

function toTextRun(run: TextRunSpec): TextRun {
  return new TextRun({
    text: run.text,
    bold: run.bold,
    italics: run.italic,
    ...(run.code ? { font: MONO } : {}),
  });
}

function runsFor(value: RichText): TextRun[] {
  return toRuns(value).map(toTextRun);
}

function docxCell(value: RichText, header: boolean): TableCell {
  const runs = toRuns(value).map((run) => toTextRun(header ? { ...run, bold: true } : run));
  return new TableCell({
    children: [new Paragraph({ children: runs })],
    ...(header ? { shading: { fill: "F1F1F1" } } : {}),
  });
}

function docxTable(block: TableBlock): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        // Repeats the header on every page the table spills onto, which is the
        // difference between a readable twelve-page table and an unreadable one.
        tableHeader: true,
        children: block.header.map((cell) => docxCell(cell, true)),
      }),
      ...block.rows.map((row) => new TableRow({ children: row.map((cell) => docxCell(cell, false)) })),
    ],
  });
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the .docx bytes for a validated spec.
 *
 * Wrapped so the only thing that escapes is a `DeliverableError`, matching the
 * shape office-export.ts uses: a route needs to tell a caller's bad spec apart
 * from a library failure, and a raw `TypeError` from deep inside `docx` tells
 * it neither.
 */
export async function buildDocument(spec: DocumentSpec): Promise<Buffer> {
  for (const block of spec.blocks) {
    if (block.type === "table") assertRectangularTable(block, `document "${spec.title}"`);
  }

  try {
    const children: (Paragraph | Table)[] = [];

    // The title is skipped when the body already opens with its own H1,
    // otherwise every document leads with the same line twice.
    const opensWithH1 = spec.blocks[0]?.type === "heading" && spec.blocks[0].level === 1;
    if (!opensWithH1) {
      children.push(
        new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: spec.title })] })
      );
    }
    if (spec.subtitle) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true, color: "555555" })] })
      );
    }

    let orderedInstance = 0;

    for (const block of spec.blocks) {
      switch (block.type) {
        case "heading":
          children.push(
            new Paragraph({ heading: DOCX_HEADINGS[block.level - 1], children: runsFor(block.text) })
          );
          break;

        case "paragraph":
          children.push(new Paragraph({ children: runsFor(block.text) }));
          break;

        case "list": {
          // Every ordered list needs its own numbering instance, or Word
          // continues the previous list's count instead of restarting at 1.
          const instance = block.ordered ? orderedInstance++ : 0;
          for (const item of block.items) {
            children.push(
              new Paragraph({
                children: runsFor(item),
                ...(block.ordered
                  ? { numbering: { reference: ORDERED_REF, level: 0, instance } }
                  : { bullet: { level: 0 } }),
              })
            );
          }
          break;
        }

        case "quote":
          children.push(
            new Paragraph({
              children: toRuns(block.text).map((run) => toTextRun({ ...run, italic: true })),
              indent: { left: 480 },
              border: { left: { style: BorderStyle.SINGLE, size: 12, color: "CCCCCC", space: 12 } },
            })
          );
          break;

        case "code":
          for (const line of block.lines) {
            children.push(
              new Paragraph({
                // Word collapses an empty run, so a blank code line needs a
                // space to keep the block's vertical rhythm.
                children: [new TextRun({ text: line === "" ? " " : line, font: MONO })],
                spacing: { before: 0, after: 0 },
                shading: { fill: "F6F6F6" },
              })
            );
          }
          break;

        case "table":
          if (block.caption) {
            children.push(
              new Paragraph({ children: [new TextRun({ text: block.caption, bold: true })] })
            );
          }
          children.push(docxTable(block));
          // Two adjacent tables with nothing between them merge into one in Word.
          children.push(new Paragraph({ children: [] }));
          break;

        case "pageBreak":
          children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
          break;
      }
    }

    // A section with no children produces a document Word refuses to open, and
    // a spec of nothing but page breaks gets there.
    if (children.length === 0) children.push(new Paragraph({ children: [] }));

    const doc = new Document({
      title: spec.title,
      description: spec.subtitle,
      numbering: {
        config: [
          {
            reference: ORDERED_REF,
            levels: [
              {
                level: 0,
                format: LevelFormat.DECIMAL,
                text: "%1.",
                alignment: AlignmentType.START,
                style: { paragraph: { indent: { left: 720, hanging: 360 } } },
              },
            ],
          },
        ],
      },
      sections: [{ children }],
    });

    return await Packer.toBuffer(doc);
  } catch (err) {
    if (err instanceof DeliverableError) throw err;
    throw new DeliverableError("build_failed", `Could not build the .docx: ${reason(err)}`);
  }
}
