/**
 * Deterministic SVG rendering of a design document.
 *
 * This is the single renderer behind the preview, the SVG/PNG/PDF exports, the
 * prototype player's static frames, and the cropped image handed to the model.
 * It takes the boxes the layout engine computed and emits markup — no DOM, no
 * measurement of its own, no randomness — so an export, a screenshot and the
 * canvas can never disagree about what the document looks like.
 *
 * Everything user-authored (text, font family, path data, image URLs) is escaped
 * on the way out. The output is inert markup: no script, no event attributes,
 * no external references beyond the same-origin/data asset URLs the schema
 * already restricts.
 */

import { layoutPage, layoutSubtree, lineHeightPx, measureText, wrapText, type LayoutMap } from "@/lib/design/layout";
import { applyBoundVariables, rgbaToCss } from "@/lib/design/variables";
import {
  isContainer,
  type CornerRadius,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type Paint,
  type PageId,
  type Shadow,
} from "@/lib/design/types";

export interface RenderOptions {
  /** Emit `data-juno-node` on every shape so the editor can hit-test by id.
   *  Off for exports, which must not carry Juno's internals. */
  includeNodeIds?: boolean;
  /** Draw the page background. Off when rendering a subtree crop. */
  background?: boolean;
  /** Restrict output to these ids and their descendants (used for crops). */
  onlyIds?: NodeId[];
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function num(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

interface Defs {
  entries: string[];
  next: () => string;
}

function makeDefs(): Defs {
  let counter = 0;
  const entries: string[] = [];
  return { entries, next: () => `jd${(counter++).toString(36)}` };
}

function paintFill(paint: Paint | undefined, defs: Defs, doc: DesignDocument): string {
  if (!paint || paint.visible === false) return "none";
  switch (paint.type) {
    case "solid":
      return rgbaToCss(paint.color);
    case "linear-gradient": {
      const id = defs.next();
      const stops = paint.stops
        .map((s) => `<stop offset="${num(s.position)}" stop-color="${rgbaToCss(s.color)}"/>`)
        .join("");
      defs.entries.push(
        `<linearGradient id="${id}" x1="${num(paint.from.x)}" y1="${num(paint.from.y)}" x2="${num(paint.to.x)}" y2="${num(paint.to.y)}">${stops}</linearGradient>`
      );
      return `url(#${id})`;
    }
    case "radial-gradient": {
      const id = defs.next();
      const stops = paint.stops
        .map((s) => `<stop offset="${num(s.position)}" stop-color="${rgbaToCss(s.color)}"/>`)
        .join("");
      defs.entries.push(
        `<radialGradient id="${id}" cx="${num(paint.center.x)}" cy="${num(paint.center.y)}" r="${num(paint.radius)}">${stops}</radialGradient>`
      );
      return `url(#${id})`;
    }
    case "image": {
      const asset = doc.assets[paint.assetId];
      if (!asset) return "none";
      const id = defs.next();
      defs.entries.push(
        `<pattern id="${id}" patternUnits="objectBoundingBox" width="1" height="1"><image href="${escapeXml(asset.url)}" width="1" height="1" preserveAspectRatio="${paint.scaleMode === "fit" ? "xMidYMid meet" : paint.scaleMode === "stretch" ? "none" : "xMidYMid slice"}"/></pattern>`
      );
      return `url(#${id})`;
    }
  }
}

function shadowFilter(shadows: Shadow[], defs: Defs): string | null {
  const visible = shadows.filter((s) => s.visible !== false && s.type === "drop");
  if (visible.length === 0) return null;
  const id = defs.next();
  const body = visible
    .map(
      (s) =>
        `<feDropShadow dx="${num(s.offsetX)}" dy="${num(s.offsetY)}" stdDeviation="${num(s.blur / 2)}" flood-color="${rgbaToCss(s.color)}"/>`
    )
    .join("");
  defs.entries.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">${body}</filter>`);
  return id;
}

function radiusAttrs(radius: CornerRadius): string {
  const r = typeof radius === "number" ? radius : Math.max(...radius);
  return r > 0 ? ` rx="${num(r)}" ry="${num(r)}"` : "";
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(
  doc: DesignDocument,
  node: DesignNode,
  boxes: LayoutMap,
  defs: Defs,
  options: RenderOptions,
  out: string[]
): void {
  const box = boxes.get(node.id);
  if (!box || !node.visible || node.opacity === 0) return;

  const resolved = applyBoundVariables(doc, node);
  const fill = paintFill(resolved.fills[0], defs, doc);
  const stroke = resolved.strokes[0];
  const filterId = shadowFilter(resolved.shadows, defs);

  const idAttr = options.includeNodeIds ? ` data-juno-node="${escapeXml(node.id)}"` : "";
  const opacityAttr = resolved.opacity < 1 ? ` opacity="${num(resolved.opacity)}"` : "";
  const filterAttr = filterId ? ` filter="url(#${filterId})"` : "";
  const blendAttr = resolved.blendMode !== "normal" ? ` style="mix-blend-mode:${resolved.blendMode}"` : "";
  const rotateAttr =
    resolved.rotation % 360 !== 0
      ? ` transform="rotate(${num(resolved.rotation)} ${num(box.x + box.width / 2)} ${num(box.y + box.height / 2)})"`
      : "";
  const strokeAttrs = stroke
    ? ` stroke="${paintFill(stroke.paint, defs, doc)}" stroke-width="${num(stroke.weight)}"${stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.map(num).join(" ")}"` : ""}`
    : "";
  const common = `${idAttr}${opacityAttr}${filterAttr}${rotateAttr}${blendAttr}`;

  switch (resolved.type) {
    case "rectangle":
    case "frame":
    case "group":
    case "component":
    case "instance": {
      // Groups have no fill of their own unless one was authored.
      const hasBox = resolved.type !== "group" || resolved.fills.length > 0 || !!stroke;
      if (hasBox) {
        out.push(
          `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(resolved.cornerRadius)} fill="${fill}"${strokeAttrs}${common}/>`
        );
      }
      break;
    }
    case "ellipse":
      out.push(
        `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}" fill="${fill}"${strokeAttrs}${common}/>`
      );
      break;
    case "line":
      out.push(
        `<line x1="${num(box.x)}" y1="${num(box.y + box.height / 2)}" x2="${num(box.x + box.width)}" y2="${num(box.y + box.height / 2)}"${strokeAttrs || ' stroke="#000" stroke-width="1"'}${common}/>`
      );
      break;
    case "path":
      out.push(
        `<g transform="translate(${num(box.x)} ${num(box.y)})"${common}><path d="${escapeXml(resolved.d)}" fill="${fill}" fill-rule="${resolved.windingRule === "evenodd" ? "evenodd" : "nonzero"}"${strokeAttrs}/></g>`
      );
      break;
    case "image": {
      const asset = doc.assets[resolved.assetId];
      if (asset) {
        out.push(
          `<image href="${escapeXml(asset.url)}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" preserveAspectRatio="${resolved.scaleMode === "fit" ? "xMidYMid meet" : resolved.scaleMode === "stretch" ? "none" : "xMidYMid slice"}"${common}/>`
        );
      } else {
        out.push(
          `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="rgba(0,0,0,0.06)"${common}/>`
        );
      }
      break;
    }
    case "text": {
      const typography = resolved.typography;
      const lh = lineHeightPx(typography);
      const measured = measureText(resolved.characters, typography, box.width);
      const anchor = typography.textAlign === "center" ? "middle" : typography.textAlign === "right" ? "end" : "start";
      const anchorX = typography.textAlign === "center" ? box.x + box.width / 2 : typography.textAlign === "right" ? box.x + box.width : box.x;
      const blockHeight = measured.lines * lh;
      const top =
        typography.verticalAlign === "middle"
          ? box.y + (box.height - blockHeight) / 2
          : typography.verticalAlign === "bottom"
            ? box.y + box.height - blockHeight
            : box.y;
      // Baseline sits ~0.8em down from the line box top for typical UI faces.
      const lines = wrapText(resolved.characters, typography, box.width);
      const tspans = lines
        .map((line, index) => `<tspan x="${num(anchorX)}" y="${num(top + index * lh + typography.fontSize * 0.8)}">${escapeXml(line) || " "}</tspan>`)
        .join("");
      out.push(
        `<text fill="${fill}" font-family="${escapeXml(typography.fontFamily)}" font-size="${num(typography.fontSize)}" font-weight="${num(typography.fontWeight)}"${typography.italic ? ' font-style="italic"' : ""} letter-spacing="${num(typography.letterSpacing)}" text-anchor="${anchor}"${typography.textDecoration && typography.textDecoration !== "none" ? ` text-decoration="${typography.textDecoration === "strikethrough" ? "line-through" : "underline"}"` : ""}${common}>${tspans}</text>`
      );
      break;
    }
  }

  if (!isContainer(node)) return;

  const clip = node.type !== "group" && node.clipsContent;
  const childOut: string[] = [];
  for (const childId of node.children) {
    const child = doc.nodes[childId];
    if (child) renderNode(doc, child, boxes, defs, options, childOut);
  }
  if (childOut.length === 0) return;

  if (clip) {
    const clipId = defs.next();
    defs.entries.push(
      `<clipPath id="${clipId}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(resolved.cornerRadius)}/></clipPath>`
    );
    out.push(`<g clip-path="url(#${clipId})">${childOut.join("")}</g>`);
  } else {
    out.push(childOut.join(""));
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
  /** Origin of the rendered viewBox in page coordinates. */
  x: number;
  y: number;
}

/** Render a whole page. */
export function renderPageSvg(doc: DesignDocument, pageId: PageId, options: RenderOptions = {}): RenderedSvg {
  const page = doc.pages.find((p) => p.id === pageId);
  const boxes = layoutPage(doc, pageId);
  const defs = makeDefs();
  const body: string[] = [];

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  for (const box of boxes.values()) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (boxes.size === 0) {
    maxX = 1200;
    maxY = 800;
  }

  for (const rootId of page?.children ?? []) {
    const node = doc.nodes[rootId];
    if (node) renderNode(doc, node, boxes, defs, options, body);
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const background =
    options.background !== false && page
      ? `<rect x="${num(minX)}" y="${num(minY)}" width="${num(width)}" height="${num(height)}" fill="${rgbaToCss(page.backgroundColor)}"/>`
      : "";

  return {
    svg: wrapSvg(minX, minY, width, height, defs, background + body.join("")),
    width,
    height,
    x: minX,
    y: minY,
  };
}

/** Render one subtree at its own origin — the crop the model is shown, and the
 *  unit every frame export uses. */
export function renderNodeSvg(doc: DesignDocument, nodeId: NodeId, options: RenderOptions = {}): RenderedSvg | null {
  const node = doc.nodes[nodeId];
  if (!node) return null;
  const boxes = layoutSubtree(doc, nodeId);
  const box = boxes.get(nodeId);
  if (!box) return null;
  const defs = makeDefs();
  const body: string[] = [];
  renderNode(doc, node, boxes, defs, options, body);
  return {
    svg: wrapSvg(0, 0, Math.max(1, box.width), Math.max(1, box.height), defs, body.join("")),
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    x: 0,
    y: 0,
  };
}

/** Render several nodes together into their shared bounding box — what "the
 *  selection" looks like when more than one node is selected. */
export function renderSelectionSvg(doc: DesignDocument, pageId: PageId, nodeIds: NodeId[], padding = 24): RenderedSvg | null {
  if (nodeIds.length === 0) return null;
  const boxes = layoutPage(doc, pageId);
  const selected = nodeIds.map((id) => boxes.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
  if (selected.length === 0) return null;

  const minX = Math.min(...selected.map((b) => b.x)) - padding;
  const minY = Math.min(...selected.map((b) => b.y)) - padding;
  const maxX = Math.max(...selected.map((b) => b.x + b.width)) + padding;
  const maxY = Math.max(...selected.map((b) => b.y + b.height)) + padding;

  const defs = makeDefs();
  const body: string[] = [];
  for (const id of nodeIds) {
    const node = doc.nodes[id];
    if (node) renderNode(doc, node, boxes, defs, {}, body);
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { svg: wrapSvg(minX, minY, width, height, defs, body.join("")), width, height, x: minX, y: minY };
}

function wrapSvg(x: number, y: number, width: number, height: number, defs: Defs, body: string): string {
  const defsBlock = defs.entries.length ? `<defs>${defs.entries.join("")}</defs>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}">${defsBlock}${body}</svg>`;
}

/** A data URL of the rendered SVG — what gets attached to an AI request as the
 *  "cropped rendered image of the selected region". */
export function svgDataUrl(svg: string): string {
  const encoded = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(svg))) : Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}
