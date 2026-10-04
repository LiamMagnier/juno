/**
 * Deck operations: the only way a stored deck changes after it is made.
 *
 * Each operation names a slide or element by id and touches nothing else, so
 * "change the chart on slide 4" rewrites one element and leaves every other
 * slide deepEqual to what it was (no regeneration). A batch is all-or-nothing:
 * it runs on a clone, the model is re-normalized after every operation (so a
 * failure carries the 1-based index of the operation that caused it), and the
 * caller only stores the result when every operation succeeded.
 */

import { z } from "zod";
import { SemanticError, cloneModel, nextId, type SemanticOpResult } from "../shared";
import {
  DECK_LAYOUTS,
  DECK_LAYOUT_NAMES,
  chartSeriesSchema,
  chartTypeSchema,
  deckElementInputSchema,
  deckMasterSchema,
  deckSlideInputSchema,
  deckThemeSchema,
  normalizeDeck,
  paragraphsSchema,
  tableHeaderSchema,
  tableRowsSchema,
  type DeckElement,
  type DeckModel,
  type DeckRegion,
  type DeckSlide,
} from "./model";

const id = z.string().min(1).max(40);
const nullableText = (max: number) => z.string().max(max).nullable().optional();

export const deckOpSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("updateSlide"),
    id,
    /** null removes the title (or subtitle, or notes). */
    title: nullableText(300),
    subtitle: nullableText(300),
    layout: z.enum(DECK_LAYOUT_NAMES).optional(),
    notes: nullableText(4_000),
    transition: z.enum(["none", "fade", "push"]).optional(),
  }),
  z.strictObject({ op: z.literal("insertSlide"), after: id.nullable(), slide: deckSlideInputSchema }),
  z.strictObject({ op: z.literal("deleteSlide"), id }),
  z.strictObject({ op: z.literal("moveSlide"), id, after: id.nullable() }),
  z.strictObject({ op: z.literal("duplicateSlide"), id }),
  z.strictObject({ op: z.literal("setElement"), slideId: id, element: deckElementInputSchema }),
  z.strictObject({ op: z.literal("removeElement"), slideId: id, elementId: id }),
  z.strictObject({ op: z.literal("updateText"), slideId: id, elementId: id, paragraphs: paragraphsSchema }),
  z.strictObject({
    op: z.literal("updateChart"),
    slideId: id,
    elementId: id,
    categories: z.array(z.string().max(100)).min(1).max(50).optional(),
    series: z.array(chartSeriesSchema).min(1).max(12).optional(),
    chartType: chartTypeSchema.optional(),
    title: nullableText(200),
  }),
  z.strictObject({
    op: z.literal("updateTable"),
    slideId: id,
    elementId: id,
    header: tableHeaderSchema.optional(),
    rows: tableRowsSchema.optional(),
  }),
  z.strictObject({ op: z.literal("setTheme"), theme: deckThemeSchema.partial() }),
  z.strictObject({
    op: z.literal("setMaster"),
    master: z.strictObject({
      footer: deckMasterSchema.shape.footer.nullable(),
      slideNumbers: deckMasterSchema.shape.slideNumbers,
      logoText: deckMasterSchema.shape.logoText.nullable(),
    }).partial(),
  }),
]);

export const deckOpsSchema = z.array(deckOpSchema).min(1).max(60);

export type DeckOp = z.infer<typeof deckOpSchema>;
/** An operation as an author writes it (paragraph levels and similar defaults optional). */
export type DeckOpInput = z.input<typeof deckOpSchema>;

const ELEMENT_NOUN: Record<DeckElement["type"], string> = {
  text: "text",
  image: "image",
  shape: "shape",
  chart: "chart",
  table: "table",
};

function slideIndexOf(model: DeckModel, slideId: string, opIndex: number): number {
  const index = model.slides.findIndex((slide) => slide.id === slideId);
  if (index < 0) throw new SemanticError("not_found", `There is no slide "${slideId}".`, opIndex);
  return index;
}

function elementOf(
  model: DeckModel,
  slideId: string,
  elementId: string,
  opIndex: number
): { slide: DeckSlide; slideNumber: number; element: DeckElement; elementIndex: number } {
  const index = slideIndexOf(model, slideId, opIndex);
  const slide = model.slides[index];
  const elementIndex = slide.elements.findIndex((element) => element.id === elementId);
  if (elementIndex < 0) {
    throw new SemanticError("not_found", `Slide "${slideId}" has no element "${elementId}".`, opIndex);
  }
  return { slide, slideNumber: index + 1, element: slide.elements[elementIndex], elementIndex };
}

function allElementIds(model: DeckModel): Set<string> {
  const ids = new Set<string>();
  for (const slide of model.slides) for (const element of slide.elements) ids.add(element.id);
  return ids;
}

function setOrDelete<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | null | undefined): void {
  if (value === undefined) return;
  if (value === null || value === "") delete target[key];
  else target[key] = value;
}

/**
 * A layout change keeps every element: regions the new layout lacks move to
 * the nearest equivalent (body <-> left), and a "right" column with nowhere to
 * go is refused rather than stacked silently on top of the left one.
 */
function remapRegions(slide: DeckSlide, opIndex: number): void {
  const layout = DECK_LAYOUTS[slide.layout];
  for (const element of slide.elements) {
    if (element.type === "shape" || element.box || !element.region) continue;
    if (layout.placeholders[element.region]) continue;
    const fallback: Partial<Record<DeckRegion, DeckRegion>> = { body: "left", left: "body" };
    const next = fallback[element.region];
    if (next && layout.placeholders[next]) {
      element.region = next;
    } else {
      throw new SemanticError(
        "invalid_op",
        `Layout "${slide.layout}" has no "${element.region}" region for element ${element.id}; ` +
          `give it a box or remove it in the same batch first.`,
        opIndex
      );
    }
  }
}

function applyOne(model: DeckModel, op: DeckOp, opIndex: number): string {
  switch (op.op) {
    case "updateSlide": {
      const index = slideIndexOf(model, op.id, opIndex);
      const slide = model.slides[index];
      const touched: string[] = [];
      if (op.layout && op.layout !== slide.layout) {
        slide.layout = op.layout;
        remapRegions(slide, opIndex);
        touched.push(`layout to ${DECK_LAYOUTS[op.layout].label.toLowerCase()}`);
      }
      if (op.title !== undefined) {
        setOrDelete(slide, "title", op.title?.trim() ?? null);
        touched.push("title");
      }
      if (op.subtitle !== undefined) {
        setOrDelete(slide, "subtitle", op.subtitle?.trim() ?? null);
        touched.push("subtitle");
      }
      if (op.notes !== undefined) {
        setOrDelete(slide, "notes", op.notes?.trim() ? op.notes : null);
        touched.push("speaker notes");
      }
      if (op.transition !== undefined) {
        if (op.transition === "none") delete slide.transition;
        else slide.transition = op.transition;
        touched.push("transition");
      }
      if (touched.length === 0) throw new SemanticError("invalid_op", "updateSlide changes nothing.", opIndex);
      return `Changed the ${touched.join(", ")} of slide ${index + 1}`;
    }

    case "insertSlide": {
      const at = op.after === null ? 0 : slideIndexOf(model, op.after, opIndex) + 1;
      const taken = new Set(model.slides.map((slide) => slide.id));
      const slideId = op.slide.id ?? nextId("s", taken);
      if (taken.has(slideId)) throw new SemanticError("invalid_op", `Slide id "${slideId}" is already used.`, opIndex);
      const elementIds = allElementIds(model);
      const elements = op.slide.elements.map((element) => {
        if (element.id && elementIds.has(element.id)) {
          throw new SemanticError("invalid_op", `Element id "${element.id}" is already used.`, opIndex);
        }
        const elementId = element.id ?? nextId("e", elementIds);
        elementIds.add(elementId);
        return { ...element, id: elementId };
      });
      model.slides.splice(at, 0, { ...op.slide, id: slideId, elements } as DeckSlide);
      return `Inserted a new slide ${at + 1}${op.slide.title ? ` ("${op.slide.title}")` : ""}`;
    }

    case "deleteSlide": {
      const index = slideIndexOf(model, op.id, opIndex);
      if (model.slides.length === 1) {
        throw new SemanticError("invalid_op", "A deck keeps at least one slide.", opIndex);
      }
      model.slides.splice(index, 1);
      return `Deleted slide ${index + 1}`;
    }

    case "moveSlide": {
      const from = slideIndexOf(model, op.id, opIndex);
      if (op.after === op.id) throw new SemanticError("invalid_op", "A slide cannot move after itself.", opIndex);
      const [slide] = model.slides.splice(from, 1);
      const to = op.after === null ? 0 : slideIndexOf(model, op.after, opIndex) + 1;
      model.slides.splice(to, 0, slide);
      return `Moved slide ${from + 1} to position ${to + 1}`;
    }

    case "duplicateSlide": {
      const index = slideIndexOf(model, op.id, opIndex);
      const source = model.slides[index];
      const slideIds = new Set(model.slides.map((slide) => slide.id));
      const elementIds = allElementIds(model);
      const copy = cloneModel(source);
      copy.id = nextId("s", slideIds);
      for (const element of copy.elements) {
        element.id = nextId("e", elementIds);
        elementIds.add(element.id);
      }
      model.slides.splice(index + 1, 0, copy);
      return `Duplicated slide ${index + 1} as slide ${index + 2}`;
    }

    case "setElement": {
      const index = slideIndexOf(model, op.slideId, opIndex);
      const slide = model.slides[index];
      const noun = ELEMENT_NOUN[op.element.type];
      if (op.element.id) {
        const existing = slide.elements.findIndex((element) => element.id === op.element.id);
        if (existing >= 0) {
          slide.elements[existing] = op.element as DeckElement;
          return `Replaced the ${noun} on slide ${index + 1}`;
        }
        if (allElementIds(model).has(op.element.id)) {
          throw new SemanticError(
            "invalid_op",
            `Element id "${op.element.id}" belongs to another slide; setElement only edits its own slide.`,
            opIndex
          );
        }
      }
      const elementId = op.element.id ?? nextId("e", allElementIds(model));
      slide.elements.push({ ...op.element, id: elementId } as DeckElement);
      return `Added ${noun === "image" ? "an" : "a"} ${noun} to slide ${index + 1}`;
    }

    case "removeElement": {
      const { slide, slideNumber, element, elementIndex } = elementOf(model, op.slideId, op.elementId, opIndex);
      slide.elements.splice(elementIndex, 1);
      return `Removed the ${ELEMENT_NOUN[element.type]} from slide ${slideNumber}`;
    }

    case "updateText": {
      const { slideNumber, element } = elementOf(model, op.slideId, op.elementId, opIndex);
      if (element.type !== "text") {
        throw new SemanticError("invalid_op", `Element ${element.id} is a ${element.type}, not text.`, opIndex);
      }
      element.paragraphs = op.paragraphs;
      return `Updated the text on slide ${slideNumber}`;
    }

    case "updateChart": {
      const { slideNumber, element } = elementOf(model, op.slideId, op.elementId, opIndex);
      if (element.type !== "chart") {
        throw new SemanticError("invalid_op", `Element ${element.id} is a ${element.type}, not a chart.`, opIndex);
      }
      if (!op.categories && !op.series && !op.chartType && op.title === undefined) {
        throw new SemanticError("invalid_op", "updateChart changes nothing.", opIndex);
      }
      if (op.categories) element.categories = op.categories;
      if (op.series) element.series = op.series;
      if (op.chartType) element.chartType = op.chartType;
      setOrDelete(element, "title", op.title === undefined ? undefined : (op.title?.trim() ?? null));
      return `Updated the chart on slide ${slideNumber}`;
    }

    case "updateTable": {
      const { slideNumber, element } = elementOf(model, op.slideId, op.elementId, opIndex);
      if (element.type !== "table") {
        throw new SemanticError("invalid_op", `Element ${element.id} is a ${element.type}, not a table.`, opIndex);
      }
      if (!op.header && !op.rows) throw new SemanticError("invalid_op", "updateTable changes nothing.", opIndex);
      if (op.header) element.header = op.header;
      if (op.rows) element.rows = op.rows;
      return `Updated the table on slide ${slideNumber}`;
    }

    case "setTheme": {
      const keys = Object.keys(op.theme);
      if (keys.length === 0) throw new SemanticError("invalid_op", "setTheme changes nothing.", opIndex);
      model.theme = { ...model.theme, ...op.theme };
      return `Changed the theme (${keys.join(", ")})`;
    }

    case "setMaster": {
      const keys = Object.keys(op.master);
      if (keys.length === 0) throw new SemanticError("invalid_op", "setMaster changes nothing.", opIndex);
      if (op.master.slideNumbers !== undefined) model.master.slideNumbers = op.master.slideNumbers;
      setOrDelete(model.master, "footer", op.master.footer);
      setOrDelete(model.master, "logoText", op.master.logoText);
      return `Changed the slide master (${keys.join(", ")})`;
    }
  }
}

/**
 * Applies validated operations to a deck. Pure and all-or-nothing: the input
 * is never mutated, and the first failing operation throws a SemanticError
 * carrying its 1-based index.
 */
export function applyDeckOps(model: DeckModel, ops: readonly DeckOpInput[]): SemanticOpResult<DeckModel> {
  const parsed = deckOpsSchema.safeParse(ops);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const opIndex = typeof issue?.path[0] === "number" ? issue.path[0] + 1 : undefined;
    throw new SemanticError(
      "invalid_op",
      parsed.error.issues
        .slice(0, 4)
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; "),
      opIndex
    );
  }

  let working = cloneModel(model);
  const changes: string[] = [];
  for (const [index, op] of parsed.data.entries()) {
    const opIndex = index + 1;
    changes.push(applyOne(working, op, opIndex));
    try {
      working = normalizeDeck(working);
    } catch (err) {
      if (err instanceof SemanticError) throw new SemanticError("invalid_op", err.message, opIndex);
      throw err;
    }
  }
  return { model: working, changes };
}
