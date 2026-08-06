/**
 * Juno Design — the executable contract.
 *
 * Every persisted document and every operation payload passes through these
 * schemas. Nothing in the design surface trusts a shape it did not validate
 * here: not model output, not a bridge message from the Mac, not a document
 * read back out of the database. `types.ts` declares the shapes; this file is
 * what enforces them at runtime.
 */

import { z } from "zod";
import { DESIGN_SCHEMA_VERSION, type DesignDocument, type DesignNode, type Rgba } from "@/lib/design/types";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const finite = z.number().finite();
const unit = finite.min(0).max(1);
/** Coordinates are bounded so a malformed op cannot push a node to ±Infinity
 *  in effect — a canvas a million points wide is already past any real use. */
const coord = finite.min(-1_000_000).max(1_000_000);
const size = finite.min(0).max(1_000_000);

const idSchema = z.string().min(1).max(120);

export const rgbaSchema = z.object({
  r: unit,
  g: unit,
  b: unit,
  a: unit,
});

const gradientStopSchema = z.object({ position: unit, color: rgbaSchema });
const pointSchema = z.object({ x: finite, y: finite });

export const paintSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("solid"),
    color: rgbaSchema,
    opacity: unit.optional(),
    visible: z.boolean().optional(),
    boundVariable: idSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal("linear-gradient"),
    stops: z.array(gradientStopSchema).min(2).max(32),
    from: pointSchema,
    to: pointSchema,
    opacity: unit.optional(),
    visible: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("radial-gradient"),
    stops: z.array(gradientStopSchema).min(2).max(32),
    center: pointSchema,
    radius: finite.min(0),
    opacity: unit.optional(),
    visible: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("image"),
    assetId: idSchema,
    scaleMode: z.enum(["fill", "fit", "stretch", "tile"]),
    opacity: unit.optional(),
    visible: z.boolean().optional(),
  }),
]);

export const strokeSchema = z.object({
  paint: paintSchema,
  weight: finite.min(0).max(10_000),
  align: z.enum(["inside", "center", "outside"]),
  dash: z.array(finite.min(0)).max(16).optional(),
});

export const shadowSchema = z.object({
  type: z.enum(["drop", "inner"]),
  color: rgbaSchema,
  offsetX: coord,
  offsetY: coord,
  blur: finite.min(0).max(10_000),
  spread: finite.min(-10_000).max(10_000),
  visible: z.boolean().optional(),
});

export const blurSchema = z.object({
  type: z.enum(["layer", "background"]),
  radius: finite.min(0).max(10_000),
});

export const blendModeSchema = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
]);

export const cornerRadiusSchema = z.union([
  finite.min(0).max(10_000),
  z.tuple([finite.min(0).max(10_000), finite.min(0).max(10_000), finite.min(0).max(10_000), finite.min(0).max(10_000)]),
]);

export const typographySchema = z.object({
  fontFamily: z.string().min(1).max(200),
  fontSize: finite.min(1).max(2_000),
  fontWeight: finite.min(1).max(1_000),
  lineHeight: z.union([finite.min(0).max(10_000), z.object({ unit: z.literal("percent"), value: finite.min(0).max(1_000) })]),
  letterSpacing: finite.min(-100).max(100),
  textAlign: z.enum(["left", "center", "right", "justify"]),
  verticalAlign: z.enum(["top", "middle", "bottom"]),
  textCase: z.enum(["none", "upper", "lower", "title"]).optional(),
  textDecoration: z.enum(["none", "underline", "strikethrough"]).optional(),
  italic: z.boolean().optional(),
});

export const constraintBehaviorSchema = z.enum(["min", "max", "center", "stretch", "scale"]);

export const constraintsSchema = z.object({
  horizontal: constraintBehaviorSchema,
  vertical: constraintBehaviorSchema,
});

export const sizingModeSchema = z.enum(["fixed", "hug", "fill"]);

export const paddingSchema = z.object({
  top: finite.min(0).max(100_000),
  right: finite.min(0).max(100_000),
  bottom: finite.min(0).max(100_000),
  left: finite.min(0).max(100_000),
});

export const autoLayoutSchema = z.object({
  direction: z.enum(["horizontal", "vertical", "grid"]),
  padding: paddingSchema,
  gap: finite.min(0).max(100_000),
  crossGap: finite.min(0).max(100_000).optional(),
  align: z.enum(["start", "center", "end", "baseline"]),
  justify: z.enum(["start", "center", "end", "space-between", "space-around", "space-evenly"]),
  wrap: z.boolean(),
  columns: z.number().int().min(1).max(64).optional(),
});

export const layoutChildSchema = z.object({
  grow: z.boolean(),
  alignSelf: z.enum(["start", "center", "end", "baseline", "stretch"]).optional(),
  absolute: z.boolean(),
});

export const sizeLimitsSchema = z.object({
  minWidth: size.optional(),
  maxWidth: size.optional(),
  minHeight: size.optional(),
  maxHeight: size.optional(),
});

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

const baseNodeShape = {
  id: idSchema,
  name: z.string().max(300),
  parentId: idSchema.nullable(),
  x: coord,
  y: coord,
  width: size,
  height: size,
  rotation: finite.min(-3_600).max(3_600),
  opacity: unit,
  visible: z.boolean(),
  locked: z.boolean(),
  blendMode: blendModeSchema,
  fills: z.array(paintSchema).max(32),
  strokes: z.array(strokeSchema).max(32),
  cornerRadius: cornerRadiusSchema,
  shadows: z.array(shadowSchema).max(32),
  blur: blurSchema.nullable(),
  constraints: constraintsSchema,
  widthMode: sizingModeSchema,
  heightMode: sizingModeSchema,
  limits: sizeLimitsSchema,
  layoutChild: layoutChildSchema,
  boundVariables: z.record(z.string().max(120), idSchema),
};

const containerShape = {
  ...baseNodeShape,
  children: z.array(idSchema).max(10_000),
  clipsContent: z.boolean(),
  layout: autoLayoutSchema.nullable(),
};

export const nodeSchema: z.ZodType<DesignNode> = z.discriminatedUnion("type", [
  z.object({ ...containerShape, type: z.literal("frame") }),
  z.object({ ...containerShape, type: z.literal("group") }),
  z.object({ ...containerShape, type: z.literal("component"), componentId: idSchema }),
  z.object({
    ...containerShape,
    type: z.literal("instance"),
    componentId: idSchema,
    variantProperties: z.record(z.string().max(120), z.string().max(200)),
    overrides: z.record(idSchema, z.record(z.string().max(120), z.unknown())),
  }),
  z.object({ ...baseNodeShape, type: z.literal("rectangle") }),
  z.object({ ...baseNodeShape, type: z.literal("ellipse") }),
  z.object({ ...baseNodeShape, type: z.literal("line") }),
  z.object({
    ...baseNodeShape,
    type: z.literal("path"),
    d: z.string().max(200_000),
    windingRule: z.enum(["nonzero", "evenodd"]),
  }),
  z.object({ ...baseNodeShape, type: z.literal("text"), characters: z.string().max(100_000), typography: typographySchema }),
  z.object({
    ...baseNodeShape,
    type: z.literal("image"),
    assetId: idSchema,
    scaleMode: z.enum(["fill", "fit", "stretch", "tile"]),
  }),
]) as unknown as z.ZodType<DesignNode>;

// ---------------------------------------------------------------------------
// Pages, components, variables, prototyping, motion
// ---------------------------------------------------------------------------

export const pageSchema = z.object({
  id: idSchema,
  name: z.string().max(300),
  children: z.array(idSchema).max(10_000),
  backgroundColor: rgbaSchema,
});

export const componentPropertySchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(["boolean", "text", "instance-swap", "variant"]),
  defaultValue: z.union([z.string().max(2_000), z.boolean()]),
  options: z.array(z.string().max(200)).max(64).optional(),
  targetNodeId: idSchema.optional(),
  targetField: z.string().max(120).optional(),
});

export const componentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(300),
  description: z.string().max(2_000),
  rootNodeId: idSchema,
  properties: z.array(componentPropertySchema).max(64),
  variants: z.record(z.string().max(500), idSchema),
});

export const variableValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("color"), value: rgbaSchema }),
  z.object({ kind: z.literal("number"), value: finite }),
  z.object({ kind: z.literal("string"), value: z.string().max(10_000) }),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }),
  z.object({ kind: z.literal("alias"), value: idSchema }),
]);

export const collectionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  modes: z.array(z.object({ id: idSchema, name: z.string().min(1).max(200) })).min(1).max(32),
});

export const variableSchema = z.object({
  id: idSchema,
  collectionId: idSchema,
  name: z.string().min(1).max(200),
  type: z.enum(["color", "number", "string", "boolean"]),
  valuesByMode: z.record(idSchema, variableValueSchema),
});

export const easingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("linear") }),
  z.object({ type: z.literal("ease-in") }),
  z.object({ type: z.literal("ease-out") }),
  z.object({ type: z.literal("ease-in-out") }),
  z.object({ type: z.literal("cubic-bezier"), x1: unit, y1: finite.min(-10).max(10), x2: unit, y2: finite.min(-10).max(10) }),
  z.object({
    type: z.literal("spring"),
    stiffness: finite.min(0.1).max(10_000),
    damping: finite.min(0).max(1_000),
    mass: finite.min(0.01).max(1_000),
  }),
]);

export const transitionSchema = z.object({
  kind: z.enum(["instant", "dissolve", "slide", "push", "move"]),
  direction: z.enum(["left", "right", "up", "down"]).optional(),
  durationMs: finite.min(0).max(60_000),
  delayMs: finite.min(0).max(60_000),
  easing: easingSchema,
  matchStableIds: z.boolean(),
});

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click") }),
  z.object({ type: z.literal("hover") }),
  z.object({ type: z.literal("press") }),
  z.object({ type: z.literal("drag") }),
  z.object({ type: z.literal("key"), key: z.string().min(1).max(40) }),
  z.object({ type: z.literal("delay"), ms: finite.min(0).max(600_000) }),
  z.object({ type: z.literal("scroll-into-view") }),
]);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), targetNodeId: idSchema }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("open-overlay"), targetNodeId: idSchema }),
  z.object({ type: z.literal("close-overlay") }),
  z.object({ type: z.literal("scroll-to"), targetNodeId: idSchema }),
  // Prototype links are user content: an artifact-authored `javascript:` or
  // `data:` URL would execute in whatever surface opened it.
  z.object({ type: z.literal("open-url"), url: z.string().url().max(2_000).refine((u) => /^https?:\/\//i.test(u), "http(s) only") }),
  z.object({ type: z.literal("set-variable"), variableId: idSchema, value: variableValueSchema }),
  z.object({ type: z.literal("set-variable-mode"), collectionId: idSchema, modeId: idSchema }),
  z.object({ type: z.literal("set-variant"), instanceNodeId: idSchema, variantProperties: z.record(z.string().max(120), z.string().max(200)) }),
  z.object({ type: z.literal("play-animation"), animationId: idSchema, reverse: z.boolean() }),
]);

export const interactionSchema = z.object({
  id: idSchema,
  sourceNodeId: idSchema,
  trigger: triggerSchema,
  action: actionSchema,
  transition: transitionSchema,
});

export const keyframeSchema = z.object({
  time: finite.min(0).max(600_000),
  value: z.union([finite, rgbaSchema]),
  easing: easingSchema,
});

export const motionTrackSchema = z.object({
  nodeId: idSchema,
  property: z.enum([
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "cornerRadius",
    "blur",
    "fillColor",
    "strokeColor",
    "fontSize",
    "letterSpacing",
    "scale",
  ]),
  keyframes: z.array(keyframeSchema).max(1_000),
});

export const animationSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  durationMs: finite.min(0).max(600_000),
  loop: z.boolean(),
  tracks: z.array(motionTrackSchema).max(500),
  state: z.string().max(60).optional(),
});

export const commentSchema = z.object({
  id: idSchema,
  nodeId: idSchema.nullable(),
  pageId: idSchema,
  x: coord,
  y: coord,
  body: z.string().max(20_000),
  authorId: z.string().max(120),
  createdAt: z.string().max(60),
  resolvedAt: z.string().max(60).nullable(),
  transactionId: idSchema.nullable(),
});

export const assetSchema = z.object({
  id: idSchema,
  kind: z.literal("image"),
  // Same-origin app paths and inline data only. A remote `https://` asset would
  // make an offline Mac render a different document than the browser, and would
  // give a shared document a callback into a third-party origin.
  url: z
    .string()
    .max(5_000_000)
    .refine((u) => u.startsWith("/") || u.startsWith("data:image/"), "asset URLs must be app-relative or a data: image"),
  width: size,
  height: size,
  mimeType: z.string().max(120),
});

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const designDocumentSchema = z.object({
  schemaVersion: z.number().int().min(1).max(1_000),
  id: idSchema,
  name: z.string().max(300),
  revision: z.number().int().min(0),
  migratedFrom: z.array(z.number().int().min(1)).max(100),
  pages: z.array(pageSchema).min(1).max(200),
  nodes: z.record(idSchema, nodeSchema),
  components: z.record(idSchema, componentSchema),
  collections: z.record(idSchema, collectionSchema),
  variables: z.record(idSchema, variableSchema),
  activeModes: z.record(idSchema, idSchema),
  interactions: z.record(idSchema, interactionSchema),
  animations: z.record(idSchema, animationSchema),
  comments: z.array(commentSchema).max(10_000),
  assets: z.record(idSchema, assetSchema),
  updatedAt: z.string().max(60),
});

export class DesignValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "DesignValidationError";
    this.issues = issues;
  }
}

/**
 * Structural checks a per-field schema cannot express: every child is a real
 * node, `parentId` agrees with the parent's `children`, no node is its own
 * ancestor, and every page root is parentless. A document that fails any of
 * these would render, but its operations would not be invertible — so it is
 * refused at the door rather than repaired silently.
 */
export function validateHierarchy(doc: DesignDocument): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const page of doc.pages) {
    for (const childId of page.children) {
      const child = doc.nodes[childId];
      if (!child) {
        issues.push(`page ${page.id} references missing node ${childId}`);
        continue;
      }
      if (child.parentId !== null) issues.push(`page-root ${childId} has parentId ${child.parentId}`);
      if (seen.has(childId)) issues.push(`node ${childId} appears in more than one parent`);
      seen.add(childId);
    }
  }

  for (const node of Object.values(doc.nodes)) {
    if (!("children" in node)) continue;
    for (const childId of node.children) {
      const child = doc.nodes[childId];
      if (!child) {
        issues.push(`node ${node.id} references missing child ${childId}`);
        continue;
      }
      if (child.parentId !== node.id) {
        issues.push(`child ${childId} claims parent ${child.parentId ?? "null"} but is listed under ${node.id}`);
      }
      if (seen.has(childId)) issues.push(`node ${childId} appears in more than one parent`);
      seen.add(childId);
    }
  }

  for (const node of Object.values(doc.nodes)) {
    if (!seen.has(node.id) && node.parentId !== null) {
      issues.push(`node ${node.id} is orphaned (parent ${node.parentId} does not list it)`);
    }
    // Cycle detection: walk to the root, bounded by the node count.
    let cursor: string | null = node.parentId;
    let steps = 0;
    while (cursor) {
      if (cursor === node.id) {
        issues.push(`node ${node.id} is its own ancestor`);
        break;
      }
      const parent: DesignNode | undefined = doc.nodes[cursor];
      if (!parent) {
        issues.push(`node ${node.id} has missing ancestor ${cursor}`);
        break;
      }
      cursor = parent.parentId;
      if (++steps > Object.keys(doc.nodes).length) {
        issues.push(`node ${node.id} has a cyclic ancestry`);
        break;
      }
    }
  }

  return issues;
}

/** Parse + structurally validate. Throws `DesignValidationError` on anything
 *  that is not a complete, coherent document at the current schema version. */
export function parseDesignDocument(raw: unknown): DesignDocument {
  const result = designDocumentSchema.safeParse(raw);
  if (!result.success) {
    throw new DesignValidationError(
      "Design document failed schema validation",
      result.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    );
  }
  const doc = result.data as unknown as DesignDocument;
  const issues = validateHierarchy(doc);
  if (issues.length) throw new DesignValidationError("Design document hierarchy is invalid", issues.slice(0, 20));
  return doc;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** Defaults every node inherits. Spread first, then override — a node literal
 *  that forgets a field still decodes, which keeps the operation layer honest
 *  about what it actually changed. */
export function baseNodeDefaults(): Omit<DesignNode, "id" | "type" | "name"> & Record<string, unknown> {
  return {
    parentId: null,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    blendMode: "normal",
    fills: [],
    strokes: [],
    cornerRadius: 0,
    shadows: [],
    blur: null,
    constraints: { horizontal: "min", vertical: "min" },
    widthMode: "fixed",
    heightMode: "fixed",
    limits: {},
    layoutChild: { grow: false, absolute: false },
    boundVariables: {},
  } as unknown as Omit<DesignNode, "id" | "type" | "name"> & Record<string, unknown>;
}

export function defaultTypography() {
  return {
    fontFamily: "Inter",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: { unit: "percent" as const, value: 140 },
    letterSpacing: 0,
    textAlign: "left" as const,
    verticalAlign: "top" as const,
  };
}

/** A new, empty, valid document with one page. */
export function createDesignDocument(opts: { id: string; name: string; pageId: string; now?: string }): DesignDocument {
  return {
    schemaVersion: DESIGN_SCHEMA_VERSION,
    id: opts.id,
    name: opts.name,
    revision: 0,
    migratedFrom: [],
    pages: [{ id: opts.pageId, name: "Page 1", children: [], backgroundColor: { r: 0.96, g: 0.96, b: 0.97, a: 1 } }],
    nodes: {},
    components: {},
    collections: {},
    variables: {},
    activeModes: {},
    interactions: {},
    animations: {},
    comments: [],
    assets: {},
    updatedAt: opts.now ?? new Date(0).toISOString(),
  };
}
