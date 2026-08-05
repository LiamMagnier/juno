/**
 * The compact form a model writes a design in.
 *
 * A `DesignDocument` node carries about twenty-five required fields. Asking a
 * model to emit all of them, correctly, for every rectangle is a recipe for
 * documents that fail validation and reach the user as "this design can't be
 * opened" — so it is not what we ask for. Instead the model writes a small,
 * obvious tree:
 *
 *   {"name":"Sign in","nodes":[
 *     {"type":"frame","name":"Screen","width":375,"height":812,"children":[
 *       {"type":"text","name":"Title","text":"Welcome back","x":24,"y":80,"fontSize":28}
 *     ]}
 *   ]}
 *
 * and this module expands it into a real document by running it through the
 * *same* operation layer the editor uses. Defaults, validation, id minting and
 * hierarchy checks are therefore identical whether a node came from a model, a
 * drag, or an undo — there is no second, laxer path into the scene graph.
 *
 * Already-complete documents pass through untouched, so a saved design that is
 * re-emitted (a regeneration, a restore) is not re-expanded and does not drift.
 */

import { z } from "zod";
import { createDesignDocument, DesignValidationError, parseDesignDocument } from "@/lib/design/schema";
import { applyTransaction, type DesignOperation } from "@/lib/design/operations";
import { hexToRgba } from "@/lib/design/variables";
import { readSchemaVersion } from "@/lib/design/migrations";
import type { DesignDocument, NodeId } from "@/lib/design/types";

/** A colour as a model naturally writes one. */
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{3,8}$/);

const layoutSchema = z.object({
  direction: z.enum(["horizontal", "vertical", "grid"]).default("vertical"),
  gap: z.number().finite().min(0).max(400).default(12),
  padding: z.union([z.number().finite().min(0).max(400), z.array(z.number().finite().min(0).max(400)).length(4)]).default(0),
  align: z.enum(["start", "center", "end", "baseline"]).default("start"),
  justify: z.enum(["start", "center", "end", "space-between", "space-around", "space-evenly"]).default("start"),
  wrap: z.boolean().default(false),
  columns: z.number().int().min(1).max(12).optional(),
});

/** One authored node. Everything except `type` is optional. */
const baseAuthoredNode = {
  type: z.enum(["frame", "group", "rectangle", "ellipse", "line", "text", "image"]),
  id: z.string().min(1).max(120).optional(),
  name: z.string().max(300).optional(),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().min(0).optional(),
  height: z.number().finite().min(0).optional(),
  fill: colorSchema.optional(),
  stroke: colorSchema.optional(),
  strokeWidth: z.number().finite().min(0).max(200).optional(),
  radius: z.union([z.number().finite().min(0).max(9_999), z.array(z.number().finite().min(0).max(9_999)).length(4)]).optional(),
  opacity: z.number().min(0).max(1).optional(),
  rotation: z.number().finite().optional(),
  /** Text nodes. */
  text: z.string().max(20_000).optional(),
  fontSize: z.number().finite().min(1).max(500).optional(),
  fontWeight: z.number().finite().min(1).max(1_000).optional(),
  fontFamily: z.string().max(200).optional(),
  align: z.enum(["left", "center", "right", "justify"]).optional(),
  /** Containers. */
  layout: layoutSchema.optional(),
  clip: z.boolean().optional(),
  /** Sizing behaviour, spelled the way the inspector spells it. */
  widthMode: z.enum(["fixed", "hug", "fill"]).optional(),
  heightMode: z.enum(["fixed", "hug", "fill"]).optional(),
  grow: z.boolean().optional(),
};

export interface AuthoredNode extends z.infer<z.ZodObject<typeof baseAuthoredNode>> {
  children?: AuthoredNode[];
}

const authoredNodeSchema: z.ZodType<AuthoredNode> = z.lazy(() =>
  z.object({ ...baseAuthoredNode, children: z.array(authoredNodeSchema).max(500).optional() })
) as z.ZodType<AuthoredNode>;

export const authoredDesignSchema = z.object({
  name: z.string().max(300).optional(),
  page: z.string().max(300).optional(),
  background: colorSchema.optional(),
  nodes: z.array(authoredNodeSchema).min(1).max(500),
});

export type AuthoredDesign = z.infer<typeof authoredDesignSchema>;

/** Deterministic ids so re-expanding the same authored source is stable. */
function idFactory(seed: string): (prefix: string) => string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  let counter = 0;
  return (prefix) => `${prefix}${hash.toString(36)}${(counter++).toString(36)}`;
}

function padding(value: number | number[] | undefined) {
  if (value === undefined) return { top: 0, right: 0, bottom: 0, left: 0 };
  if (typeof value === "number") return { top: value, right: value, bottom: value, left: value };
  return { top: value[0], right: value[1], bottom: value[2], left: value[3] };
}

/** Turn one authored node into the patch `createNode` expects. */
function patchFor(node: AuthoredNode): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ["x", "y", "width", "height", "opacity", "rotation"] as const) {
    if (node[key] !== undefined) patch[key] = node[key];
  }
  if (node.name) patch.name = node.name;
  if (node.fill) {
    const color = hexToRgba(node.fill);
    if (color) patch.fills = [{ type: "solid", color }];
  }
  if (node.stroke) {
    const color = hexToRgba(node.stroke);
    if (color) patch.strokes = [{ paint: { type: "solid", color }, weight: node.strokeWidth ?? 1, align: "center" }];
  }
  if (node.radius !== undefined) patch.cornerRadius = node.radius;
  if (node.clip !== undefined) patch.clipsContent = node.clip;
  if (node.widthMode) patch.widthMode = node.widthMode;
  if (node.heightMode) patch.heightMode = node.heightMode;
  if (node.grow !== undefined) patch.layoutChild = { grow: node.grow, absolute: false };

  if (node.layout) {
    patch.layout = {
      direction: node.layout.direction,
      gap: node.layout.gap,
      padding: padding(node.layout.padding),
      align: node.layout.align,
      justify: node.layout.justify,
      wrap: node.layout.wrap,
      ...(node.layout.columns ? { columns: node.layout.columns } : {}),
    };
  }

  if (node.type === "text") {
    patch.characters = node.text ?? node.name ?? "Text";
    const typography: Record<string, unknown> = {};
    if (node.fontSize !== undefined) typography.fontSize = node.fontSize;
    if (node.fontWeight !== undefined) typography.fontWeight = node.fontWeight;
    if (node.fontFamily) typography.fontFamily = node.fontFamily;
    if (node.align) typography.textAlign = node.align;
    if (Object.keys(typography).length) patch.typography = typography;
    // Text authored without a fill would be invisible on a white frame.
    if (!node.fill) patch.fills = [{ type: "solid", color: { r: 0.06, g: 0.06, b: 0.08, a: 1 } }];
  }
  return patch;
}

/**
 * Expand an authored design into a full, validated `DesignDocument`.
 *
 * Every node is created through `createNode`, so the result is exactly as valid
 * as anything the editor produces — and an authored design that cannot be
 * expanded fails here, with a reason, rather than being stored and failing to
 * open later.
 */
export function expandAuthoredDesign(authored: AuthoredDesign, seed: string): DesignDocument {
  const pageId = "page-1";
  const mintId = idFactory(seed);
  let document = createDesignDocument({
    id: `design-${seed.slice(0, 12)}`,
    name: authored.name ?? "Design",
    pageId,
    now: new Date(0).toISOString(),
  });

  if (authored.page) document.pages[0].name = authored.page;
  if (authored.background) {
    const color = hexToRgba(authored.background);
    if (color) document.pages[0].backgroundColor = color;
  }

  const operations: DesignOperation[] = [];
  const walk = (node: AuthoredNode, parentId: NodeId | null) => {
    const id = node.id ?? mintId("n");
    operations.push({
      op: "createNode",
      parentId,
      pageId,
      node: { type: node.type, id, name: node.name, patch: patchFor(node) as never },
    });
    for (const child of node.children ?? []) walk(child, id);
  };
  for (const node of authored.nodes) walk(node, null);

  const result = applyTransaction(document, {
    id: `author-${seed.slice(0, 12)}`,
    baseRevision: document.revision,
    operations,
    author: "juno",
    summary: "Create design",
    createdAt: new Date(0).toISOString(),
  });
  document = result.document;
  // Authoring is creation, not an edit history — the document starts at 1 so a
  // later transaction has a coherent base to build on.
  document.revision = 1;
  return parseDesignDocument(JSON.parse(JSON.stringify(document)));
}

/**
 * Normalize whatever a DESIGN artifact body contains into a stored document.
 *
 * Three inputs are accepted, in this order:
 *  1. A complete `DesignDocument` — passed through, validated. This is what the
 *     editor writes back, so a save never re-expands and never drifts.
 *  2. The compact authored form — expanded through the operation layer.
 *  3. Anything else — refused with a reason, because storing a body the editor
 *     cannot open would surface much later as data loss.
 */
export function normalizeDesignArtifact(content: string, seed: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new DesignValidationError("A design artifact must contain JSON.");
  }

  if (readSchemaVersion(raw) > 0) {
    return JSON.stringify(parseDesignDocument(raw));
  }

  const authored = authoredDesignSchema.safeParse(raw);
  if (!authored.success) {
    throw new DesignValidationError(
      "A design artifact must be either a full design document or the compact authoring form",
      authored.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    );
  }
  return JSON.stringify(expandAuthoredDesign(authored.data, seed));
}
