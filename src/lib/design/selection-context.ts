/**
 * What Juno is told about a selection.
 *
 * The rule this module enforces is "send what the request needs, and no more".
 * A document can hold thousands of nodes; a request to round one button's
 * corners needs that button, what it sits in, what sits next to it, the tokens
 * it is bound to, and a picture. Shipping the whole document instead would cost
 * budget, bury the actual subject, and hand the model latitude to change things
 * nobody asked about.
 *
 * Every context carries the document revision it was built from, so the
 * transaction the model returns can be refused if the document moved underneath
 * it rather than applied to a scene it never saw.
 */

import { ancestorsOf, selectionRect, subtreeIds } from "@/lib/design/document";
import { layoutPage } from "@/lib/design/layout";
import { renderSelectionSvg, svgDataUrl } from "@/lib/design/render";
import { resolveVariable } from "@/lib/design/variables";
import type { DesignDocument, DesignNode, NodeId, PageId } from "@/lib/design/types";

/** How deep below a selected node the compact subtree goes. Two levels is
 *  enough to describe a button (frame → label + icon) without serializing a
 *  whole screen when a top-level frame is selected. */
const DEFAULT_DEPTH = 2;
const MAX_SUBTREE_NODES = 120;
const MAX_SIBLINGS = 6;

export interface CompactNode {
  id: NodeId;
  type: DesignNode["type"];
  name: string;
  /** Absolute page coordinates, as laid out. */
  frame: { x: number; y: number; width: number; height: number };
  visible: boolean;
  locked: boolean;
  opacity: number;
  rotation: number;
  cornerRadius?: number | number[];
  fills?: string[];
  strokes?: { color: string; weight: number }[];
  text?: string;
  typography?: { family: string; size: number; weight: number; align: string };
  layout?: {
    direction: string;
    gap: number;
    padding: [number, number, number, number];
    align: string;
    justify: string;
    wrap: boolean;
  } | null;
  sizing?: { width: string; height: string };
  constraints?: { horizontal: string; vertical: string };
  boundVariables?: Record<string, { id: string; name: string; value: string }>;
  componentId?: string;
  variantProperties?: Record<string, string>;
  children?: CompactNode[];
  /** Present when the subtree was cut off at the depth limit. */
  truncatedChildren?: number;
}

export interface DesignSelectionContext {
  documentId: string;
  documentName: string;
  revision: number;
  pageId: PageId;
  pageName: string;
  selectedNodeIds: NodeId[];
  /** The selected nodes, each with a bounded subtree. */
  selection: CompactNode[];
  /** Parent chain of the (first) selection, outermost last. */
  ancestors: { id: NodeId; type: string; name: string; layout: string | null }[];
  /** A few nodes beside the selection, so "align this with the others" works. */
  siblings: { id: NodeId; type: string; name: string; frame: { x: number; y: number; width: number; height: number } }[];
  /** Tokens available to bind, resolved in the active mode. */
  variables: { id: string; name: string; type: string; value: string; collection: string; mode: string }[];
  interactions: { id: string; sourceNodeId: NodeId; trigger: string; action: string }[];
  animations: { id: string; name: string; durationMs: number; nodeIds: NodeId[] }[];
  comments: { id: string; nodeId: NodeId | null; body: string }[];
  /** Data-URL SVG of the selection with a little breathing room around it. */
  previewImage: string | null;
  previewSize: { width: number; height: number } | null;
  /** Total node count, so the model knows the document is bigger than this. */
  documentNodeCount: number;
}

function paintSummary(node: DesignNode): string[] | undefined {
  if (node.fills.length === 0) return undefined;
  return node.fills.map((paint) => {
    switch (paint.type) {
      case "solid":
        return colorHex(paint.color);
      case "linear-gradient":
        return `linear-gradient(${paint.stops.map((s) => colorHex(s.color)).join(" → ")})`;
      case "radial-gradient":
        return `radial-gradient(${paint.stops.map((s) => colorHex(s.color)).join(" → ")})`;
      case "image":
        return `image(${paint.assetId})`;
    }
  });
}

function colorHex(color: { r: number; g: number; b: number; a: number }): string {
  const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, "0");
  return color.a >= 1
    ? `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
    : `#${hex(color.r)}${hex(color.g)}${hex(color.b)}${hex(color.a)}`;
}

function compact(
  doc: DesignDocument,
  node: DesignNode,
  boxes: ReturnType<typeof layoutPage>,
  depth: number,
  budget: { left: number }
): CompactNode {
  const box = boxes.get(node.id) ?? { x: node.x, y: node.y, width: node.width, height: node.height };
  const out: CompactNode = {
    id: node.id,
    type: node.type,
    name: node.name,
    frame: { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) },
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    rotation: node.rotation,
  };
  if (node.cornerRadius !== 0) out.cornerRadius = node.cornerRadius;
  const fills = paintSummary(node);
  if (fills) out.fills = fills;
  if (node.strokes.length) {
    out.strokes = node.strokes.map((s) => ({
      color: s.paint.type === "solid" ? colorHex(s.paint.color) : s.paint.type,
      weight: s.weight,
    }));
  }
  if (node.type === "text") {
    out.text = node.characters.length > 400 ? `${node.characters.slice(0, 400)}…` : node.characters;
    out.typography = {
      family: node.typography.fontFamily,
      size: node.typography.fontSize,
      weight: node.typography.fontWeight,
      align: node.typography.textAlign,
    };
  }
  if (node.widthMode !== "fixed" || node.heightMode !== "fixed") {
    out.sizing = { width: node.widthMode, height: node.heightMode };
  }
  out.constraints = { horizontal: node.constraints.horizontal, vertical: node.constraints.vertical };

  if ("layout" in node) {
    out.layout = node.layout
      ? {
          direction: node.layout.direction,
          gap: node.layout.gap,
          padding: [node.layout.padding.top, node.layout.padding.right, node.layout.padding.bottom, node.layout.padding.left],
          align: node.layout.align,
          justify: node.layout.justify,
          wrap: node.layout.wrap,
        }
      : null;
  }
  if (node.type === "instance" || node.type === "component") {
    out.componentId = node.componentId;
    if (node.type === "instance" && Object.keys(node.variantProperties).length) {
      out.variantProperties = node.variantProperties;
    }
  }

  const bindings = Object.entries(node.boundVariables);
  if (bindings.length) {
    out.boundVariables = {};
    for (const [path, variableId] of bindings) {
      const variable = doc.variables[variableId];
      const resolved = resolveVariable(doc, variableId);
      out.boundVariables[path] = {
        id: variableId,
        name: variable?.name ?? "(missing)",
        value: resolved.ok ? formatValue(resolved.value) : `unresolved (${resolved.reason})`,
      };
    }
  }

  if ("children" in node && node.children.length > 0) {
    if (depth <= 0 || budget.left <= 0) {
      out.truncatedChildren = node.children.length;
    } else {
      const kids: CompactNode[] = [];
      for (const childId of node.children) {
        if (budget.left <= 0) {
          out.truncatedChildren = node.children.length - kids.length;
          break;
        }
        const child = doc.nodes[childId];
        if (!child) continue;
        budget.left -= 1;
        kids.push(compact(doc, child, boxes, depth - 1, budget));
      }
      out.children = kids;
    }
  }
  return out;
}

function formatValue(value: unknown): string {
  if (value && typeof value === "object" && "r" in (value as Record<string, unknown>)) {
    return colorHex(value as { r: number; g: number; b: number; a: number });
  }
  return String(value);
}

function r(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Build the context for a selection-scoped request.
 *
 * `includeImage` is separate because rendering costs work and an image is only
 * worth attaching when the model is being asked to judge appearance. The image
 * is the deterministic SVG the editor itself draws — never a screenshot of the
 * user's screen, so nothing outside the document can leak into it.
 */
export function buildSelectionContext(
  doc: DesignDocument,
  pageId: PageId,
  selectedNodeIds: NodeId[],
  opts: { depth?: number; includeImage?: boolean } = {}
): DesignSelectionContext {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const boxes = layoutPage(doc, page.id);
  const budget = { left: MAX_SUBTREE_NODES };
  const depth = opts.depth ?? DEFAULT_DEPTH;

  const selection = selectedNodeIds
    .map((id) => doc.nodes[id])
    .filter((n): n is DesignNode => !!n)
    .map((node) => compact(doc, node, boxes, depth, budget));

  const first = selectedNodeIds[0] ? doc.nodes[selectedNodeIds[0]] : null;
  const ancestors = first
    ? ancestorsOf(doc, first.id).map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        layout: "layout" in a && a.layout ? a.layout.direction : null,
      }))
    : [];

  const siblingIds = first
    ? (first.parentId === null
        ? page.children
        : (() => {
            const parent = doc.nodes[first.parentId];
            return parent && "children" in parent ? parent.children : [];
          })()
      ).filter((id) => !selectedNodeIds.includes(id))
    : [];

  const siblings = siblingIds.slice(0, MAX_SIBLINGS).flatMap((id) => {
    const node = doc.nodes[id];
    const box = boxes.get(id);
    if (!node || !box) return [];
    return [{ id, type: node.type, name: node.name, frame: { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) } }];
  });

  const selectedSubtree = new Set(selectedNodeIds.flatMap((id) => subtreeIds(doc, id)));

  const variables = Object.values(doc.variables).map((variable) => {
    const collection = doc.collections[variable.collectionId];
    const resolved = resolveVariable(doc, variable.id);
    const modeId = doc.activeModes[variable.collectionId] ?? collection?.modes[0]?.id ?? "";
    return {
      id: variable.id,
      name: variable.name,
      type: variable.type,
      value: resolved.ok ? formatValue(resolved.value) : `unresolved (${resolved.reason})`,
      collection: collection?.name ?? variable.collectionId,
      mode: collection?.modes.find((m) => m.id === modeId)?.name ?? modeId,
    };
  });

  const interactions = Object.values(doc.interactions)
    .filter((i) => selectedSubtree.has(i.sourceNodeId))
    .map((i) => ({ id: i.id, sourceNodeId: i.sourceNodeId, trigger: i.trigger.type, action: i.action.type }));

  const animations = Object.values(doc.animations)
    .filter((a) => a.tracks.some((t) => selectedSubtree.has(t.nodeId)))
    .map((a) => ({ id: a.id, name: a.name, durationMs: a.durationMs, nodeIds: [...new Set(a.tracks.map((t) => t.nodeId))] }));

  const comments = doc.comments
    .filter((c) => !c.resolvedAt && c.nodeId !== null && selectedSubtree.has(c.nodeId))
    .map((c) => ({ id: c.id, nodeId: c.nodeId, body: c.body }));

  let previewImage: string | null = null;
  let previewSize: { width: number; height: number } | null = null;
  if (opts.includeImage !== false && selectedNodeIds.length > 0) {
    const rendered = renderSelectionSvg(doc, page.id, selectedNodeIds);
    if (rendered) {
      previewImage = svgDataUrl(rendered.svg);
      previewSize = { width: Math.round(rendered.width), height: Math.round(rendered.height) };
    }
  }

  return {
    documentId: doc.id,
    documentName: doc.name,
    revision: doc.revision,
    pageId: page.id,
    pageName: page.name,
    selectedNodeIds,
    selection,
    ancestors,
    siblings,
    variables,
    interactions,
    animations,
    comments,
    previewImage,
    previewSize,
    documentNodeCount: Object.keys(doc.nodes).length,
  };
}

/** Whole-document summary — pages, counts, components, tokens. Cheap enough to
 *  send at the start of any design conversation. */
export function buildDocumentSummary(doc: DesignDocument) {
  const rect = selectionRect(doc, doc.pages.flatMap((p) => p.children));
  return {
    documentId: doc.id,
    name: doc.name,
    revision: doc.revision,
    schemaVersion: doc.schemaVersion,
    bounds: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
    pages: doc.pages.map((page) => ({
      id: page.id,
      name: page.name,
      topLevel: page.children.flatMap((id) => {
        const node = doc.nodes[id];
        return node ? [{ id, type: node.type, name: node.name, width: node.width, height: node.height }] : [];
      }),
    })),
    nodeCount: Object.keys(doc.nodes).length,
    components: Object.values(doc.components).map((c) => ({
      id: c.id,
      name: c.name,
      properties: c.properties.map((p) => ({ name: p.name, type: p.type })),
      variants: Object.keys(c.variants),
    })),
    collections: Object.values(doc.collections).map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes.map((m) => m.name),
      activeMode: c.modes.find((m) => m.id === (doc.activeModes[c.id] ?? c.modes[0]?.id))?.name ?? null,
      variableCount: Object.values(doc.variables).filter((v) => v.collectionId === c.id).length,
    })),
    interactionCount: Object.keys(doc.interactions).length,
    animationCount: Object.keys(doc.animations).length,
    openComments: doc.comments.filter((c) => !c.resolvedAt).length,
  };
}
