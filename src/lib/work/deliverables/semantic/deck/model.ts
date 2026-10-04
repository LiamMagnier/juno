/**
 * The semantic deck model (BRIEF §29/§30): a presentation stored as slides,
 * layouts and typed elements rather than as Markdown split on headings.
 *
 * Pure: no Office writer is imported here, so the canvas previews the same
 * model in the browser that `pptx-export.ts` writes on the server. The layout
 * geometry (`DECK_LAYOUTS`) is the one both of them read.
 *
 * Layouts are a closed set with named placeholder regions. An element either
 * fills one of its slide's regions ("body", "left", "right") or carries an
 * explicit box in inches on the 10 x 5.625 slide. Normalization makes the
 * region explicit, so a stored model never depends on a default that could
 * later change.
 */

import { z } from "zod";
import { SemanticError, describeIssues, isAllowedImageSource, nextId, oneLine } from "../shared";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** LAYOUT_16x9, in inches. */
export const SLIDE_WIDTH = 10;
export const SLIDE_HEIGHT = 5.625;
/** The strip the master's footer, logo text and slide number sit in. */
export const FOOTER_BAND_Y = 5.15;
/** Rounding slack for boxes computed in floating point. */
const EPSILON = 1e-6;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DeckLayout = "title" | "section" | "title-content" | "two-column" | "title-only" | "blank";
export const DECK_LAYOUT_NAMES = [
  "title",
  "section",
  "title-content",
  "two-column",
  "title-only",
  "blank",
] as const satisfies readonly DeckLayout[];

export type DeckRegion = "body" | "left" | "right";
export type PlaceholderName = "title" | "subtitle" | DeckRegion;

export interface PlaceholderSpec {
  box: Box;
  /** The OOXML placeholder type the exporter declares on the layout. */
  type: "title" | "body";
  /** The size text starts at before it is shrunk to fit (points). */
  defaultPt: number;
  /** The smallest size the exporter shrinks to before it reports an overflow. */
  minPt: number;
  align: "left" | "center";
  bold: boolean;
}

export interface LayoutSpec {
  label: string;
  placeholders: Partial<Record<PlaceholderName, PlaceholderSpec>>;
  /** The content regions in the order an element without a region fills them. */
  contentRegions: DeckRegion[];
}

const TITLE_BAR: PlaceholderSpec = {
  box: { x: 0.5, y: 0.35, w: 9, h: 0.85 },
  type: "title",
  defaultPt: 28,
  minPt: 18,
  align: "left",
  bold: true,
};
const BODY_TOP = 1.35;
const BODY_HEIGHT = 3.7;

export const DECK_LAYOUTS: Readonly<Record<DeckLayout, LayoutSpec>> = {
  title: {
    label: "Title",
    placeholders: {
      title: { box: { x: 0.75, y: 1.6, w: 8.5, h: 1.3 }, type: "title", defaultPt: 40, minPt: 24, align: "center", bold: true },
      subtitle: { box: { x: 0.75, y: 3.0, w: 8.5, h: 0.8 }, type: "body", defaultPt: 20, minPt: 12, align: "center", bold: false },
    },
    contentRegions: [],
  },
  section: {
    label: "Section",
    placeholders: {
      title: { box: { x: 0.75, y: 2.0, w: 8.5, h: 1.4 }, type: "title", defaultPt: 34, minPt: 20, align: "center", bold: true },
    },
    contentRegions: [],
  },
  "title-content": {
    label: "Title and content",
    placeholders: {
      title: TITLE_BAR,
      body: { box: { x: 0.5, y: BODY_TOP, w: 9, h: BODY_HEIGHT }, type: "body", defaultPt: 18, minPt: 12, align: "left", bold: false },
    },
    contentRegions: ["body"],
  },
  "two-column": {
    label: "Two columns",
    placeholders: {
      title: TITLE_BAR,
      left: { box: { x: 0.5, y: BODY_TOP, w: 4.35, h: BODY_HEIGHT }, type: "body", defaultPt: 16, minPt: 12, align: "left", bold: false },
      right: { box: { x: 5.15, y: BODY_TOP, w: 4.35, h: BODY_HEIGHT }, type: "body", defaultPt: 16, minPt: 12, align: "left", bold: false },
    },
    contentRegions: ["left", "right"],
  },
  "title-only": {
    label: "Title only",
    placeholders: { title: TITLE_BAR },
    contentRegions: [],
  },
  blank: { label: "Blank", placeholders: {}, contentRegions: [] },
};

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const DECK_LIMITS = {
  slides: 200,
  elementsPerSlide: 30,
  titleChars: 300,
  notesChars: 4_000,
  paragraphs: 40,
  paragraphChars: 2_000,
  shapeTextChars: 300,
  altChars: 300,
  imageSrcChars: 5_000_000,
  categories: 50,
  series: 12,
  tableColumns: 12,
  tableRows: 30,
  cellChars: 300,
  fontNameChars: 64,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,40}$/, "ids are 1-40 letters, digits, '-' or '_'");
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colours are #rrggbb");
const fontSchema = z.string().trim().min(1).max(DECK_LIMITS.fontNameChars);

const boxSchema = z.strictObject({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  w: z.number().finite().min(0),
  h: z.number().finite().min(0),
});
const regionSchema = z.enum(["body", "left", "right"]);

export const paragraphSchema = z.strictObject({
  text: z.string().max(DECK_LIMITS.paragraphChars),
  level: z.number().int().min(0).max(2).default(0),
  bullet: z.boolean().optional(),
  bold: z.boolean().optional(),
});
export const paragraphsSchema = z.array(paragraphSchema).min(1).max(DECK_LIMITS.paragraphs);

const placed = {
  id: idSchema.optional(),
  box: boxSchema.optional(),
  region: regionSchema.optional(),
};

const textElementSchema = z.strictObject({
  type: z.literal("text"),
  ...placed,
  paragraphs: paragraphsSchema,
  fontSize: z.number().min(10).max(60).optional(),
});

const imageElementSchema = z.strictObject({
  type: z.literal("image"),
  ...placed,
  src: z
    .string()
    .max(DECK_LIMITS.imageSrcChars)
    .refine(isAllowedImageSource, "an image is a base64 PNG/JPEG/GIF/WebP data URI or an https URL"),
  alt: z.string().trim().min(1).max(DECK_LIMITS.altChars),
});

const shapeElementSchema = z.strictObject({
  type: z.literal("shape"),
  id: idSchema.optional(),
  box: boxSchema,
  shape: z.enum(["rect", "roundRect", "ellipse", "line", "arrow"]),
  fill: colorSchema.optional(),
  line: colorSchema.optional(),
  text: z.string().max(DECK_LIMITS.shapeTextChars).optional(),
});

export const chartSeriesSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  values: z.array(z.number().finite()).min(1).max(DECK_LIMITS.categories),
});
export const chartTypeSchema = z.enum(["bar", "column", "line", "pie", "area"]);

const chartElementSchema = z.strictObject({
  type: z.literal("chart"),
  ...placed,
  chartType: chartTypeSchema,
  title: z.string().trim().max(200).optional(),
  categories: z.array(z.string().max(100)).min(1).max(DECK_LIMITS.categories),
  series: z.array(chartSeriesSchema).min(1).max(DECK_LIMITS.series),
  showLegend: z.boolean().optional(),
});

const cellSchema = z.string().max(DECK_LIMITS.cellChars);
export const tableHeaderSchema = z.array(cellSchema).min(1).max(DECK_LIMITS.tableColumns);
export const tableRowsSchema = z.array(z.array(cellSchema).max(DECK_LIMITS.tableColumns)).max(DECK_LIMITS.tableRows);

const tableElementSchema = z.strictObject({
  type: z.literal("table"),
  ...placed,
  header: tableHeaderSchema,
  rows: tableRowsSchema,
});

/** An element as an author (the chat model, an import) writes it: the id is optional. */
export const deckElementInputSchema = z.discriminatedUnion("type", [
  textElementSchema,
  imageElementSchema,
  shapeElementSchema,
  chartElementSchema,
  tableElementSchema,
]);

const transitionSchema = z.enum(["none", "fade", "push"]);

export const deckSlideInputSchema = z.strictObject({
  id: idSchema.optional(),
  layout: z.enum(DECK_LAYOUT_NAMES),
  title: z.string().trim().max(DECK_LIMITS.titleChars).optional(),
  subtitle: z.string().trim().max(DECK_LIMITS.titleChars).optional(),
  elements: z.array(deckElementInputSchema).max(DECK_LIMITS.elementsPerSlide).default([]),
  notes: z.string().max(DECK_LIMITS.notesChars).optional(),
  transition: transitionSchema.optional(),
});

export const deckThemeSchema = z.strictObject({
  headingFont: fontSchema,
  bodyFont: fontSchema,
  background: colorSchema,
  text: colorSchema,
  accent: colorSchema,
  muted: colorSchema,
});

export const deckMasterSchema = z.strictObject({
  footer: z.string().trim().max(120).optional(),
  slideNumbers: z.boolean(),
  logoText: z.string().trim().max(40).optional(),
});

export const DEFAULT_DECK_THEME: DeckTheme = {
  headingFont: "Calibri",
  bodyFont: "Calibri",
  background: "#FFFFFF",
  text: "#1F2328",
  accent: "#2F6FEB",
  muted: "#6E7781",
};

export const DEFAULT_DECK_MASTER: DeckMaster = { slideNumbers: true };

export const deckInputSchema = z.strictObject({
  kind: z.literal("presentation").optional(),
  version: z.literal(1).optional(),
  title: z.string().trim().min(1).max(DECK_LIMITS.titleChars),
  theme: deckThemeSchema.partial().optional(),
  master: deckMasterSchema.partial().optional(),
  slides: z.array(deckSlideInputSchema).min(1).max(DECK_LIMITS.slides),
});

// ---------------------------------------------------------------------------
// Types (the normalized form: every id assigned, every region explicit)
// ---------------------------------------------------------------------------

export type DeckTheme = z.infer<typeof deckThemeSchema>;
export type DeckMaster = z.infer<typeof deckMasterSchema>;
export type DeckParagraph = z.infer<typeof paragraphSchema>;
export type DeckChartType = z.infer<typeof chartTypeSchema>;
export type DeckChartSeries = z.infer<typeof chartSeriesSchema>;
export type DeckTransition = z.infer<typeof transitionSchema>;

type Placed = { id: string; box?: Box; region?: DeckRegion };
export type DeckTextElement = Placed & { type: "text"; paragraphs: DeckParagraph[]; fontSize?: number };
export type DeckImageElement = Placed & { type: "image"; src: string; alt: string };
export type DeckShapeElement = {
  type: "shape";
  id: string;
  box: Box;
  shape: "rect" | "roundRect" | "ellipse" | "line" | "arrow";
  fill?: string;
  line?: string;
  text?: string;
};
export type DeckChartElement = Placed & {
  type: "chart";
  chartType: DeckChartType;
  title?: string;
  categories: string[];
  series: DeckChartSeries[];
  showLegend?: boolean;
};
export type DeckTableElement = Placed & { type: "table"; header: string[]; rows: string[][] };
export type DeckElement = DeckTextElement | DeckImageElement | DeckShapeElement | DeckChartElement | DeckTableElement;

export type DeckElementInput = z.input<typeof deckElementInputSchema>;
export type DeckSlideInput = z.input<typeof deckSlideInputSchema>;
export type DeckInput = z.input<typeof deckInputSchema>;

export interface DeckSlide {
  id: string;
  layout: DeckLayout;
  title?: string;
  subtitle?: string;
  elements: DeckElement[];
  notes?: string;
  transition?: DeckTransition;
}

export interface DeckModel {
  kind: "presentation";
  version: 1;
  title: string;
  theme: DeckTheme;
  master: DeckMaster;
  slides: DeckSlide[];
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** The box an element occupies: its own, or the placeholder region it fills. */
export function elementBox(slide: Pick<DeckSlide, "layout">, element: DeckElement): Box {
  if (element.box) return element.box;
  const region = element.type === "shape" ? undefined : element.region;
  const placeholder = region ? DECK_LAYOUTS[slide.layout].placeholders[region] : undefined;
  if (!placeholder) {
    // normalizeDeck never lets this through; a hand-built model is told plainly.
    throw new SemanticError(
      "invalid_model",
      `Element ${element.id} has no box and layout "${slide.layout}" has no "${region ?? "body"}" region.`
    );
  }
  return placeholder.box;
}

/** The placeholder a slide's title (or subtitle) sits in, when its layout has one. */
export function titleBox(layout: DeckLayout, which: "title" | "subtitle" = "title"): Box | undefined {
  return DECK_LAYOUTS[layout].placeholders[which]?.box;
}

function boxInsideSlide(box: Box): boolean {
  return (
    box.x >= -EPSILON &&
    box.y >= -EPSILON &&
    box.x + box.w <= SLIDE_WIDTH + EPSILON &&
    box.y + box.h <= SLIDE_HEIGHT + EPSILON
  );
}

// ---------------------------------------------------------------------------
// Normalize
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new SemanticError("invalid_model", message);
}

/** Copy only the keys that are set, so an absent optional stays absent (deepEqual-stable). */
function compact<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) out[key] = entry;
  return out as T;
}

type ParsedElement = z.infer<typeof deckElementInputSchema>;
type ParsedSlide = z.infer<typeof deckSlideInputSchema>;

function checkElement(slide: ParsedSlide, slideLabel: string, element: ParsedElement, label: string): void {
  if (element.type !== "shape" && element.box && element.region) {
    fail(`${label} on ${slideLabel} gives both a box and a region; give one.`);
  }
  if (element.box) {
    const { box } = element;
    const isLine = element.type === "shape" && (element.shape === "line" || element.shape === "arrow");
    if (isLine ? box.w + box.h <= 0 : box.w <= 0 || box.h <= 0) {
      fail(`${label} on ${slideLabel} has an empty box (${box.w} x ${box.h} in).`);
    }
    if (!boxInsideSlide(box)) {
      fail(
        `${label} on ${slideLabel} has a box (${box.x}, ${box.y}, ${box.w} x ${box.h} in) outside the ` +
          `${SLIDE_WIDTH} x ${SLIDE_HEIGHT} in slide.`
      );
    }
  } else if (element.type !== "shape" && element.region) {
    if (!DECK_LAYOUTS[slide.layout].placeholders[element.region]) {
      fail(`${label} on ${slideLabel} fills region "${element.region}", which layout "${slide.layout}" does not have.`);
    }
  }
  if (element.type === "chart") {
    for (const series of element.series) {
      if (series.values.length !== element.categories.length) {
        fail(
          `${label} on ${slideLabel}: series "${series.name}" has ${series.values.length} values ` +
            `for ${element.categories.length} categories.`
        );
      }
    }
    if (element.chartType === "pie" && element.series.length !== 1) {
      fail(`${label} on ${slideLabel} is a pie chart with ${element.series.length} series; a pie shows exactly one.`);
    }
  }
  if (element.type === "table") {
    element.rows.forEach((row, index) => {
      if (row.length !== element.header.length) {
        fail(
          `${label} on ${slideLabel}: table row ${index + 1} has ${row.length} cells but the header has ` +
            `${element.header.length}.`
        );
      }
    });
  }
}

/**
 * Untrusted JSON (the authoring form, an import, a stored body) -> a validated
 * DeckModel with every id assigned and every region explicit. Idempotent: a
 * normalized model normalizes to a deepEqual copy of itself.
 */
export function normalizeDeck(input: unknown): DeckModel {
  const parsed = deckInputSchema.safeParse(input);
  if (!parsed.success) throw new SemanticError("invalid_model", describeIssues(parsed.error.issues));
  const raw = parsed.data;

  // Ids: given ones must be unique; missing ones are numbered after the highest.
  const slideIds = new Set<string>();
  const elementIds = new Set<string>();
  for (const slide of raw.slides) {
    if (slide.id) {
      if (slideIds.has(slide.id)) fail(`Slide id "${slide.id}" is used twice.`);
      slideIds.add(slide.id);
    }
    for (const element of slide.elements) {
      if (element.id) {
        if (elementIds.has(element.id)) fail(`Element id "${element.id}" is used twice.`);
        elementIds.add(element.id);
      }
    }
  }

  const slides: DeckSlide[] = raw.slides.map((slide, slideIndex) => {
    const id = slide.id ?? nextId("s", slideIds);
    slideIds.add(id);
    const slideLabel = `slide ${slideIndex + 1} (${id})`;
    const layout = DECK_LAYOUTS[slide.layout];

    if (slide.title && !layout.placeholders.title) {
      fail(`${slideLabel} has a title but layout "${slide.layout}" has no title placeholder; use a text element.`);
    }
    if (slide.subtitle && !layout.placeholders.subtitle) {
      fail(`${slideLabel} has a subtitle but only the "title" layout has a subtitle placeholder.`);
    }

    const used = new Set<DeckRegion>();
    for (const element of slide.elements) {
      if (element.type !== "shape" && !element.box && element.region) used.add(element.region);
    }

    const elements = slide.elements.map((element, elementIndex): DeckElement => {
      const label = `element ${elementIndex + 1}${element.id ? ` (${element.id})` : ""}`;
      checkElement(slide, slideLabel, element, label);
      const elementId = element.id ?? nextId("e", elementIds);
      elementIds.add(elementId);

      if (element.type === "shape") {
        return compact({ ...element, id: elementId });
      }
      let region = element.region;
      if (!element.box && !region) {
        if (layout.contentRegions.length === 0) {
          fail(
            `${label} on ${slideLabel} has no box, and layout "${slide.layout}" has no content region to place it in.`
          );
        }
        region = layout.contentRegions.find((candidate) => !used.has(candidate)) ?? layout.contentRegions[0];
        used.add(region);
      }
      if (element.type === "text") {
        return compact({
          ...element,
          id: elementId,
          region,
          paragraphs: element.paragraphs.map((paragraph) => compact({ ...paragraph })),
        });
      }
      if (element.type === "image") {
        return compact({ ...element, id: elementId, region, src: element.src.replace(/\s+/g, "") });
      }
      return compact({ ...element, id: elementId, region }) as DeckElement;
    });

    return compact({
      id,
      layout: slide.layout,
      title: slide.title || undefined,
      subtitle: slide.subtitle || undefined,
      elements,
      notes: slide.notes?.trim() ? slide.notes : undefined,
      transition: slide.transition,
    });
  });

  const master = { ...DEFAULT_DECK_MASTER, ...compact(raw.master ?? {}) };
  return {
    kind: "presentation",
    version: 1,
    title: raw.title,
    theme: { ...DEFAULT_DECK_THEME, ...compact(raw.theme ?? {}) },
    master: compact({
      slideNumbers: master.slideNumbers,
      footer: master.footer || undefined,
      logoText: master.logoText || undefined,
    }),
    slides,
  };
}

export function serializeDeck(model: DeckModel): string {
  return JSON.stringify(model);
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
}

function placement(element: DeckElement): string {
  if (element.box) {
    const { x, y, w, h } = element.box;
    return ` @${formatNumber(x)},${formatNumber(y)} ${formatNumber(w)}x${formatNumber(h)}`;
  }
  return element.type === "shape" || !element.region ? "" : ` (${element.region})`;
}

function describeElement(element: DeckElement): string {
  const where = placement(element);
  switch (element.type) {
    case "text": {
      const text = element.paragraphs
        .map((p) => `${"  ".repeat(p.level)}${p.bullet ? "• " : ""}${p.text}`)
        .join(" / ");
      return `text${where}: ${oneLine(text, 200)}`;
    }
    case "image":
      return `image${where}: "${oneLine(element.alt, 80)}" (${element.src.startsWith("data:") ? "embedded" : "linked"})`;
    case "shape":
      return `shape ${element.shape}${where}${element.text ? `: "${oneLine(element.text, 80)}"` : ""}`;
    case "chart": {
      const cats = element.categories;
      const categories = cats.length <= 3 ? cats.join(", ") : `${cats[0]}..${cats[cats.length - 1]} (${cats.length})`;
      const series = element.series
        .map((s) => {
          const shown = s.values.slice(0, 6).map(formatNumber).join(",");
          return `${s.name} ${shown}${s.values.length > 6 ? ",…" : ""}`;
        })
        .join(" | ");
      const title = element.title ? ` "${oneLine(element.title, 60)}"` : "";
      return `chart ${element.chartType}${title}${where}: categories ${oneLine(categories, 80)}; series ${oneLine(series, 160)}`;
    }
    case "table":
      return `table${where}: ${element.header.length} cols x ${element.rows.length} rows; header ${oneLine(element.header.join(" | "), 120)}`;
  }
}

/**
 * Addressable text the chat model reads before it edits the deck: every slide
 * and element id, bounded to `maxChars`, ending with "… N more slides" when it
 * had to stop.
 */
export function outlineDeck(model: DeckModel, maxChars = 12_000): string {
  const { theme, master } = model;
  const head =
    `Deck "${oneLine(model.title, 100)}" — ${model.slides.length} slide${model.slides.length === 1 ? "" : "s"}; ` +
    `fonts ${theme.headingFont}/${theme.bodyFont}, background ${theme.background}, text ${theme.text}, ` +
    `accent ${theme.accent}, muted ${theme.muted}; ` +
    `footer ${master.footer ? `"${oneLine(master.footer, 60)}"` : "none"}, ` +
    `slide numbers ${master.slideNumbers ? "on" : "off"}${master.logoText ? `, logo "${master.logoText}"` : ""}`;
  const lines = [head];
  let length = head.length;

  for (const [index, slide] of model.slides.entries()) {
    const block: string[] = [];
    let first = `[${slide.id}] ${slide.layout}`;
    if (slide.title) first += ` "${oneLine(slide.title, 100)}"`;
    if (slide.subtitle) first += ` — subtitle "${oneLine(slide.subtitle, 100)}"`;
    if (slide.transition && slide.transition !== "none") first += ` (transition ${slide.transition})`;
    block.push(first);
    for (const element of slide.elements) block.push(`  [${element.id}] ${describeElement(element)}`);
    if (slide.notes) block.push(`  notes: ${oneLine(slide.notes, 160)}`);

    const blockLength = block.reduce((sum, line) => sum + line.length + 1, 0);
    const remaining = model.slides.length - index;
    if (length + blockLength > maxChars && index > 0) {
      lines.push(`… ${remaining} more slide${remaining === 1 ? "" : "s"}`);
      break;
    }
    lines.push(...block);
    length += blockLength;
  }
  return lines.join("\n");
}
