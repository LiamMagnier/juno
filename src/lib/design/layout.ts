/**
 * Juno Design — the layout engine.
 *
 * One engine, four consumers: the editor canvas, the prototype/preview
 * renderer, every export, and the cropped image the AI is shown. If any of them
 * measured layout its own way, "what Juno sees" and "what you see" would drift,
 * and a selection-scoped edit would be reasoning about a different picture than
 * the one on screen. So this module is deliberately pure, deterministic and
 * free of any DOM dependency: same document in, same numbers out, in a browser,
 * in a WKWebView, and in a Node test.
 *
 * That determinism has one honest cost. Text is measured by an advance-width
 * model rather than by asking a font engine, because a real measurement depends
 * on the fonts installed on the machine doing the measuring — which is exactly
 * the drift this engine exists to prevent. Hug-sized text therefore gets a
 * predictable box, and the renderer draws real glyphs inside it.
 */

import { isContainer, type AutoLayout, type DesignDocument, type DesignNode, type NodeId, type PageId, type Typography } from "@/lib/design/types";

export interface LayoutBox {
  /** Absolute page coordinates of the node's top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutMap = Map<NodeId, LayoutBox>;

// ---------------------------------------------------------------------------
// Text measurement
// ---------------------------------------------------------------------------

/**
 * Per-glyph advance widths, in 1/1000 em, for ASCII 32–126.
 *
 * This replaced a single mean ratio per family — 0.52em for every character —
 * which measured "iiiii" and "WWWWW" as exactly the same width. Since the
 * renderer draws REAL glyphs and only the line breaking used the estimate,
 * wrapped lines broke in the wrong place, hug-sized labels came out the wrong
 * width, and double-clicking to edit swapped in a textarea laid out by the
 * actual font engine — so the text visibly reflowed the moment you started
 * typing and reflowed back on commit.
 *
 * These are the standard Adobe core-font metrics (Helvetica and Times-Roman),
 * which Arial and the common serif stacks match closely enough that the
 * remaining error is a fraction of a character rather than a fifth of a line.
 *
 * They are TABLES, not measurements taken from the host, and that is the point:
 * `layoutPage` runs in the browser for the canvas and on the server for every
 * export, and those two must agree exactly. A `measureText` on a canvas element
 * would be more accurate in the editor and would make the PNG disagree with the
 * SVG disagree with the handoff — a worse failure than being uniformly a little
 * off.
 */
const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

const TIMES_WIDTHS = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
  278, 278, 564, 564, 564, 444, 921,
  722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611,
  333, 278, 333, 469, 500, 333,
  444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444,
  480, 200, 480, 541,
];

type FamilyClass = "mono" | "serif" | "sans";

function familyClass(family: string): FamilyClass {
  const f = family.toLowerCase();
  if (f.includes("mono") || f.includes("courier") || f.includes("consolas")) return "mono";
  // "sans-serif" contains "serif", so sans has to be ruled in BEFORE serif is
  // ruled out. The obvious ordering classified every `Inter, sans-serif` stack —
  // which is most of the product — as a serif and measured it with Times widths.
  if (f.includes("sans")) return "sans";
  if (f.includes("georgia") || f.includes("times") || f.includes("serif")) return "serif";
  return "sans";
}

/**
 * Full-width scripts advance about one em per character rather than half of one.
 *
 * CJK, Hangul and the fullwidth forms were being measured at 0.52em, so a
 * Japanese label reserved roughly half the box it needed and wrapped about twice
 * as late as it should.
 */
function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** Bold faces are wider than their regular cut by roughly this much. */
function weightFactor(weight: number, family: FamilyClass): number {
  if (family === "mono" || weight < 600) return 1;
  return family === "serif" ? 1.05 : 1.06;
}

/** One character's advance, in em. */
function advanceEm(code: number, family: FamilyClass): number {
  if (family === "mono") return 0.6;
  if (isFullWidth(code)) return 1;
  const table = family === "serif" ? TIMES_WIDTHS : HELVETICA_WIDTHS;
  if (code >= 32 && code <= 126) return table[code - 32] / 1000;
  // Latin-1 accented letters advance like their unaccented base; anything else
  // falls back to the family's mean rather than guessing per script.
  if (code >= 0xc0 && code <= 0xff) return family === "serif" ? 0.5 : 0.556;
  return family === "serif" ? 0.48 : 0.52;
}

/**
 * The width a run of text actually occupies, letter spacing included.
 *
 * Exported because the canvas's inline text editor has to lay its textarea out
 * with the same numbers the renderer wraps with — that agreement is the whole
 * reason the text no longer jumps when you start editing it.
 */
export function measureRun(
  text: string,
  typography: Pick<Typography, "fontSize" | "fontFamily" | "letterSpacing" | "fontWeight">
): number {
  const family = familyClass(typography.fontFamily);
  const factor = weightFactor(typography.fontWeight ?? 400, family);
  let em = 0;
  for (const char of text) em += advanceEm(char.codePointAt(0) ?? 32, family);
  return em * typography.fontSize * factor + text.length * typography.letterSpacing;
}

/** Mean advance for one character — a coarse estimate kept only for callers that
 *  need a per-character step rather than a measured run. */
export function advanceWidth(typography: Pick<Typography, "fontSize" | "fontFamily" | "letterSpacing">): number {
  const family = familyClass(typography.fontFamily);
  const mean = family === "mono" ? 0.6 : family === "serif" ? 0.48 : 0.52;
  return typography.fontSize * mean + typography.letterSpacing;
}

export function lineHeightPx(typography: Typography): number {
  const lh = typography.lineHeight;
  if (typeof lh === "number") return lh;
  return (typography.fontSize * lh.value) / 100;
}

/**
 * Greedy word wrap of `characters` to `maxWidth`; `maxWidth <= 0` means "do not
 * wrap". Explicit newlines always break.
 *
 * Both the measuring pass and the renderer call this. They used to each carry
 * their own copy of the advance model, and the copies disagreed — the
 * renderer's knew about monospace but not about serifs, so serif text was
 * measured at 0.5em per character and drawn as though it were 0.52em. Hug-sized
 * serif labels came out the wrong size and wrapped somewhere other than where
 * they had been measured to wrap. One function, one model, no drift.
 */
export function wrapText(
  characters: string,
  typography: Pick<Typography, "fontSize" | "fontFamily" | "letterSpacing" | "fontWeight">,
  maxWidth: number
): string[] {
  const out: string[] = [];

  for (const paragraph of characters.split("\n")) {
    if (maxWidth <= 0 || measureRun(paragraph, typography) <= maxWidth) {
      out.push(paragraph);
      continue;
    }
    let current = "";
    for (const word of paragraph.split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      // Measured, not counted. Breaking on `candidate.length * perChar` treated
      // "Illinois" and "WWWWWWWW" as the same width, so a line of narrow
      // characters broke early and a line of wide ones overflowed its box.
      if (current && measureRun(candidate, typography) > maxWidth) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
  }

  return out;
}

/** Wrap `text` to `maxWidth`, returning the resulting line count and the widest
 *  line. `maxWidth <= 0` means "do not wrap". */
export function measureText(
  characters: string,
  typography: Typography,
  maxWidth: number
): { width: number; height: number; lines: number } {
  const lines = wrapText(characters, typography, maxWidth);
  const widest = Math.max(0, ...lines.map((line) => measureRun(line, typography)));

  return {
    width: Math.min(widest, maxWidth > 0 ? maxWidth : widest),
    height: lines.length * lineHeightPx(typography),
    lines: Math.max(1, lines.length),
  };
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

function clampSize(value: number, min?: number, max?: number): number {
  let out = value;
  if (typeof min === "number") out = Math.max(out, min);
  if (typeof max === "number") out = Math.min(out, max);
  return Math.max(0, out);
}

/** Children that participate in the flow (absolute children are positioned by
 *  their own x/y and take no space). */
function flowChildren(doc: DesignDocument, node: DesignNode): DesignNode[] {
  if (!isContainer(node)) return [];
  return node.children
    .map((id) => doc.nodes[id])
    .filter((child): child is DesignNode => !!child && !child.layoutChild.absolute && child.visible);
}

interface Measured {
  width: number;
  height: number;
}

/**
 * Intrinsic size of a node, bottom-up.
 *
 * `available` is the space the parent can offer along each axis; a `fill` node
 * takes it, a `hug` node ignores it and reports its content, a `fixed` node
 * reports what it was authored at.
 */
export function measureNode(doc: DesignDocument, node: DesignNode, available: { width: number; height: number }): Measured {
  const width =
    node.widthMode === "fill"
      ? available.width
      : node.widthMode === "hug"
        ? hugWidth(doc, node, available)
        : node.width;
  const height =
    node.heightMode === "fill"
      ? available.height
      : node.heightMode === "hug"
        ? hugHeight(doc, node, clampSize(width, node.limits.minWidth, node.limits.maxWidth))
        : node.height;

  return {
    width: clampSize(width, node.limits.minWidth, node.limits.maxWidth),
    height: clampSize(height, node.limits.minHeight, node.limits.maxHeight),
  };
}

function hugWidth(doc: DesignDocument, node: DesignNode, available: { width: number; height: number }): number {
  if (node.type === "text") {
    return measureText(node.characters, node.typography, 0).width;
  }
  if (!isContainer(node) || !node.layout) return node.width;
  const layout = node.layout;
  const children = flowChildren(doc, node);
  if (children.length === 0) return layout.padding.left + layout.padding.right;

  const sizes = children.map((child) => measureNode(doc, child, { width: available.width, height: available.height }));
  const inner =
    layout.direction === "horizontal"
      ? sizes.reduce((sum, s) => sum + s.width, 0) + layout.gap * (children.length - 1)
      : layout.direction === "vertical"
        ? Math.max(...sizes.map((s) => s.width))
        : gridWidth(layout, sizes);
  return layout.padding.left + layout.padding.right + inner;
}

function hugHeight(doc: DesignDocument, node: DesignNode, resolvedWidth: number): number {
  if (node.type === "text") {
    const inner = node.widthMode === "hug" ? 0 : resolvedWidth;
    return measureText(node.characters, node.typography, inner).height;
  }
  if (!isContainer(node) || !node.layout) return node.height;
  const layout = node.layout;
  const children = flowChildren(doc, node);
  if (children.length === 0) return layout.padding.top + layout.padding.bottom;

  const contentWidth = Math.max(0, resolvedWidth - layout.padding.left - layout.padding.right);
  const rows = arrangeIntoRows(doc, node, layout, children, contentWidth);
  const inner = rows.reduce((sum, row, index) => sum + row.height + (index > 0 ? crossGap(layout) : 0), 0);
  return layout.padding.top + layout.padding.bottom + inner;
}

function crossGap(layout: AutoLayout): number {
  return layout.crossGap ?? layout.gap;
}

function gridWidth(layout: AutoLayout, sizes: Measured[]): number {
  const columns = Math.max(1, layout.columns ?? 2);
  const widest = Math.max(0, ...sizes.map((s) => s.width));
  return widest * columns + layout.gap * (columns - 1);
}

interface Row {
  items: { node: DesignNode; size: Measured }[];
  height: number;
}

/**
 * Break the flow into rows (or columns, for a vertical layout).
 *
 * A vertical layout always produces one "row" per child; a horizontal layout
 * produces one row unless `wrap` is set; a grid produces `columns` per row.
 * Expressing all three this way is what lets hug-height, arrangement and the
 * grid share one measuring pass instead of three that can disagree.
 */
function arrangeIntoRows(
  doc: DesignDocument,
  parent: DesignNode,
  layout: AutoLayout,
  children: DesignNode[],
  contentWidth: number
): Row[] {
  const measure = (child: DesignNode) =>
    measureNode(doc, child, {
      width: layout.direction === "vertical" ? contentWidth : Math.max(0, contentWidth),
      height: 0,
    });

  if (layout.direction === "vertical") {
    return children.map((child) => {
      const size = measure(child);
      return { items: [{ node: child, size }], height: size.height };
    });
  }

  if (layout.direction === "grid") {
    const columns = Math.max(1, layout.columns ?? 2);
    const rows: Row[] = [];
    for (let i = 0; i < children.length; i += columns) {
      const slice = children.slice(i, i + columns).map((child) => ({ node: child, size: measure(child) }));
      rows.push({ items: slice, height: Math.max(0, ...slice.map((item) => item.size.height)) });
    }
    return rows;
  }

  // Horizontal.
  const rows: Row[] = [];
  let current: { node: DesignNode; size: Measured }[] = [];
  let used = 0;
  for (const child of children) {
    const size = measure(child);
    const projected = current.length === 0 ? size.width : used + layout.gap + size.width;
    if (layout.wrap && current.length > 0 && projected > contentWidth) {
      rows.push({ items: current, height: Math.max(0, ...current.map((i) => i.size.height)) });
      current = [{ node: child, size }];
      used = size.width;
    } else {
      current.push({ node: child, size });
      used = projected;
    }
  }
  if (current.length > 0) rows.push({ items: current, height: Math.max(0, ...current.map((i) => i.size.height)) });
  void parent;
  return rows;
}

// ---------------------------------------------------------------------------
// Arranging
// ---------------------------------------------------------------------------

function mainAxisStart(justify: AutoLayout["justify"], free: number, count: number, gap: number): { offset: number; spacing: number } {
  if (free <= 0 || count === 0) return { offset: 0, spacing: gap };
  switch (justify) {
    case "center":
      return { offset: free / 2, spacing: gap };
    case "end":
      return { offset: free, spacing: gap };
    case "space-between":
      return count > 1 ? { offset: 0, spacing: gap + free / (count - 1) } : { offset: 0, spacing: gap };
    case "space-around": {
      const each = free / count;
      return { offset: each / 2, spacing: gap + each };
    }
    case "space-evenly": {
      const each = free / (count + 1);
      return { offset: each, spacing: gap + each };
    }
    default:
      return { offset: 0, spacing: gap };
  }
}

function crossOffset(align: AutoLayout["align"] | "stretch", free: number): number {
  if (align === "center") return free / 2;
  if (align === "end") return free;
  return 0;
}

/**
 * Lay out one page and return every node's absolute box.
 *
 * Containers without auto layout keep their children's authored x/y (the
 * "free" canvas); containers with auto layout position them. Absolute children
 * always keep their authored x/y regardless.
 */
export function layoutPage(doc: DesignDocument, pageId: PageId): LayoutMap {
  const boxes: LayoutMap = new Map();
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return boxes;
  for (const rootId of page.children) {
    const root = doc.nodes[rootId];
    if (!root) continue;
    const size = measureNode(doc, root, { width: root.width, height: root.height });
    placeNode(doc, root, root.x, root.y, size.width, size.height, boxes);
  }
  return boxes;
}

/** Lay out a single subtree, treating `rootId` as if it sat at (0,0). Used by
 *  the cropped render handed to the model, and by SVG/PNG export of a frame. */
export function layoutSubtree(doc: DesignDocument, rootId: NodeId): LayoutMap {
  const boxes: LayoutMap = new Map();
  const root = doc.nodes[rootId];
  if (!root) return boxes;
  const size = measureNode(doc, root, { width: root.width, height: root.height });
  placeNode(doc, root, 0, 0, size.width, size.height, boxes);
  return boxes;
}

function placeNode(
  doc: DesignDocument,
  node: DesignNode,
  x: number,
  y: number,
  width: number,
  height: number,
  boxes: LayoutMap
): void {
  boxes.set(node.id, { x, y, width, height });
  if (!isContainer(node)) return;

  // Absolute children ignore the flow entirely, in both layout modes.
  const absolute = node.children
    .map((id) => doc.nodes[id])
    .filter((child): child is DesignNode => !!child && (child.layoutChild.absolute || !node.layout));

  for (const child of absolute) {
    const size = measureNode(doc, child, { width, height });
    placeNode(doc, child, x + child.x, y + child.y, size.width, size.height, boxes);
  }

  if (!node.layout) return;
  const layout = node.layout;
  const children = flowChildren(doc, node);
  if (children.length === 0) return;

  const contentWidth = Math.max(0, width - layout.padding.left - layout.padding.right);
  const contentHeight = Math.max(0, height - layout.padding.top - layout.padding.bottom);
  const rows = arrangeIntoRows(doc, node, layout, children, contentWidth);

  // Cross-axis distribution of the rows themselves.
  const rowsHeight = rows.reduce((sum, row, index) => sum + row.height + (index > 0 ? crossGap(layout) : 0), 0);
  const growRows = layout.direction === "vertical" ? rows.filter((r) => r.items[0]?.node.layoutChild.grow || r.items[0]?.node.heightMode === "fill") : [];
  let rowY = y + layout.padding.top;
  if (layout.direction !== "vertical") {
    rowY += crossOffset(layout.align, Math.max(0, contentHeight - rowsHeight));
  } else if (growRows.length === 0) {
    rowY += mainAxisStart(layout.justify, Math.max(0, contentHeight - rowsHeight), rows.length, 0).offset;
  }

  const verticalFree = Math.max(0, contentHeight - rowsHeight);
  const verticalSpacing =
    layout.direction === "vertical" && growRows.length === 0
      ? mainAxisStart(layout.justify, verticalFree, rows.length, crossGap(layout)).spacing
      : crossGap(layout);
  const perGrowRow = growRows.length > 0 ? verticalFree / growRows.length : 0;

  for (const row of rows) {
    const rowHeight = layout.direction === "vertical" && growRows.includes(row) ? row.height + perGrowRow : row.height;

    if (layout.direction === "vertical") {
      const child = row.items[0].node;
      const size = row.items[0].size;
      const childWidth = child.widthMode === "fill" || child.layoutChild.alignSelf === "stretch" ? contentWidth : size.width;
      const free = Math.max(0, contentWidth - childWidth);
      const childX = x + layout.padding.left + crossOffset(child.layoutChild.alignSelf ?? layout.align, free);
      placeNode(doc, child, childX, rowY, childWidth, rowHeight, boxes);
      rowY += rowHeight + verticalSpacing;
      continue;
    }

    // Horizontal / grid row: distribute the main axis.
    const growing = row.items.filter((item) => item.node.layoutChild.grow || item.node.widthMode === "fill");
    const naturalWidth = row.items.reduce((sum, item) => sum + item.size.width, 0) + layout.gap * (row.items.length - 1);
    const free = Math.max(0, contentWidth - naturalWidth);
    const perGrow = growing.length > 0 ? free / growing.length : 0;
    const { offset, spacing } =
      growing.length > 0 ? { offset: 0, spacing: layout.gap } : mainAxisStart(layout.justify, free, row.items.length, layout.gap);

    let cursorX = x + layout.padding.left + offset;
    for (const item of row.items) {
      const childWidth = growing.includes(item) ? item.size.width + perGrow : item.size.width;
      const stretch = item.node.layoutChild.alignSelf === "stretch" || item.node.heightMode === "fill";
      const childHeight = stretch ? rowHeight : item.size.height;
      const childY = rowY + crossOffset(item.node.layoutChild.alignSelf ?? layout.align, Math.max(0, rowHeight - childHeight));
      placeNode(doc, item.node, cursorX, childY, childWidth, childHeight, boxes);
      cursorX += childWidth + spacing;
    }
    rowY += rowHeight + crossGap(layout);
  }
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

export interface ConstraintUpdate {
  nodeId: NodeId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Reposition a container's non-flow children when the container resizes.
 *
 * Constraints only ever *matter* on resize — they are how a free-canvas frame
 * behaves responsively without auto layout — so they are computed as an
 * explicit list of updates the caller turns into operations. Children of an
 * auto-layout container are excluded: their position is the flow's business,
 * and applying both would fight.
 */
export function resizeWithConstraints(
  doc: DesignDocument,
  parentId: NodeId,
  from: { width: number; height: number },
  to: { width: number; height: number }
): ConstraintUpdate[] {
  const parent = doc.nodes[parentId];
  if (!parent || !isContainer(parent)) return [];
  const dx = to.width - from.width;
  const dy = to.height - from.height;
  const scaleX = from.width === 0 ? 1 : to.width / from.width;
  const scaleY = from.height === 0 ? 1 : to.height / from.height;
  const inFlow = !!parent.layout;

  const updates: ConstraintUpdate[] = [];
  for (const childId of parent.children) {
    const child = doc.nodes[childId];
    if (!child) continue;
    if (inFlow && !child.layoutChild.absolute) continue;

    const h = axisUpdate(child.constraints.horizontal, child.x, child.width, dx, scaleX, from.width);
    const v = axisUpdate(child.constraints.vertical, child.y, child.height, dy, scaleY, from.height);
    if (h.position === child.x && h.size === child.width && v.position === child.y && v.size === child.height) continue;
    updates.push({ nodeId: childId, x: h.position, y: v.position, width: h.size, height: v.size });
  }
  return updates;
}

function axisUpdate(
  behavior: "min" | "max" | "center" | "stretch" | "scale",
  position: number,
  size: number,
  delta: number,
  scale: number,
  parentSize: number
): { position: number; size: number } {
  switch (behavior) {
    case "min":
      return { position, size };
    case "max":
      return { position: position + delta, size };
    case "center": {
      const centerRatio = parentSize === 0 ? 0 : (position + size / 2) / parentSize;
      const nextParent = parentSize + delta;
      return { position: round(nextParent * centerRatio - size / 2), size };
    }
    case "stretch":
      return { position, size: Math.max(0, round(size + delta)) };
    case "scale":
      return { position: round(position * scale), size: Math.max(0, round(size * scale)) };
  }
}

/** Layout numbers are rounded to a thousandth of a point so the same document
 *  serializes identically after a resize on two machines with different float
 *  rounding in the middle of a chain. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
