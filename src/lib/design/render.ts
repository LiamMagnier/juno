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
 *
 * Paint order is a flat list, not a tree of nested buffers. That is what lets a
 * background blur exist at all: a backdrop is *everything already painted*, and
 * a renderer that hands each container its own private array cannot see it. The
 * one place the tree still matters — a clipping container — splices its own run
 * back out of the flat list once its children are done, which rearranges markup
 * that has already been produced without ever hiding it from a node that was
 * painted inside the run.
 */

import { layoutPage, layoutSubtree, lineHeightPx, measureText, wrapText, type LayoutBox, type LayoutMap } from "@/lib/design/layout";
import { applyBoundVariables, rgbaToCss, rgbaToHex } from "@/lib/design/variables";
import {
  isContainer,
  type Blur,
  type CornerRadius,
  type DesignDocument,
  type DesignNode,
  type NodeId,
  type Paint,
  type PageId,
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
// The render context
// ---------------------------------------------------------------------------

interface Defs {
  entries: string[];
  next: () => string;
}

/** One emitted element, with the region it covers. The box is what lets a
 *  backdrop include only the markup that can actually show through the layer
 *  sampling it — without it, every glass panel would carry a copy of the whole
 *  page. `null` means "no bounded extent", which only the page background has. */
interface PaintedChunk {
  markup: string;
  box: LayoutBox | null;
}

interface RenderContext {
  defs: Defs;
  /** Everything painted so far, in paint order. */
  painted: PaintedChunk[];
}

function makeContext(): RenderContext {
  let counter = 0;
  const entries: string[] = [];
  return { defs: { entries, next: () => `jd${(counter++).toString(36)}` }, painted: [] };
}

function intersects(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Gradient stops carry their alpha in `stop-opacity`, not in `stop-color`.
 *
 * `stop-color` is a `<color>` and SVG 1.1 says nothing about alpha in one;
 * browsers accept `rgba()` there, but a PDF/print pipeline and several SVG
 * rasterisers quietly clamp it to opaque, which turned a glass panel's fade
 * into a flat white slab in exactly the exports it mattered most in.
 */
function gradientStops(stops: { position: number; color: { r: number; g: number; b: number; a: number } }[]): string {
  return stops
    .map(
      (s) =>
        `<stop offset="${num(s.position)}" stop-color="${rgbaToHex(s.color).slice(0, 7)}"${s.color.a < 1 ? ` stop-opacity="${num(s.color.a)}"` : ""}/>`
    )
    .join("");
}

function paintFill(paint: Paint | undefined, defs: Defs, doc: DesignDocument): string {
  if (!paint || paint.visible === false) return "none";
  switch (paint.type) {
    case "solid":
      return rgbaToCss(paint.color);
    case "linear-gradient": {
      const id = defs.next();
      defs.entries.push(
        `<linearGradient id="${id}" x1="${num(paint.from.x)}" y1="${num(paint.from.y)}" x2="${num(paint.to.x)}" y2="${num(paint.to.y)}">${gradientStops(paint.stops)}</linearGradient>`
      );
      return `url(#${id})`;
    }
    case "radial-gradient": {
      const id = defs.next();
      defs.entries.push(
        `<radialGradient id="${id}" cx="${num(paint.center.x)}" cy="${num(paint.center.y)}" r="${num(paint.radius)}">${gradientStops(paint.stops)}</radialGradient>`
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

/** A paint's own opacity, as the `fill-opacity` it has always meant. */
function paintOpacityAttr(paint: Paint | undefined): string {
  const opacity = paint?.opacity;
  return opacity === undefined || opacity >= 1 ? "" : ` fill-opacity="${num(opacity)}"`;
}

function radiusAttrs(radius: CornerRadius): string {
  const r = typeof radius === "number" ? radius : Math.max(...radius);
  return r > 0 ? ` rx="${num(r)}" ry="${num(r)}"` : "";
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * The whole effect stack of one node as a single SVG filter.
 *
 * Order is the order a designer describes it in: the layer is blurred, grain
 * goes over the blurred layer (grain that gets blurred is not grain), inner
 * shadows sit on top of both because they are lighting on the surface, and drop
 * shadows go behind everything because they are cast by it.
 *
 * Two things this replaces are worth naming, because both were silent:
 * `feDropShadow` cannot express `spread`, so every spread a user typed was
 * discarded on the way to the canvas; and inner shadows were filtered out of
 * the list entirely, so the model could hold one and nothing could ever show
 * it. Both are now built by hand out of morphology, offset, blur and flood.
 */
function effectFilter(node: DesignNode, box: LayoutBox, defs: Defs): string | null {
  const shadows = node.shadows.filter((s) => s.visible !== false);
  const drops = shadows.filter((s) => s.type === "drop");
  const inners = shadows.filter((s) => s.type === "inner");
  const layerBlur = node.blur && node.blur.type === "layer" ? node.blur : null;
  const noise = node.noise && node.noise.visible !== false && node.noise.opacity > 0 ? node.noise : null;
  if (drops.length === 0 && inners.length === 0 && !layerBlur && !noise) return null;

  const parts: string[] = [];
  let counter = 0;
  const step = () => `f${(counter++).toString(36)}`;
  let last = "SourceGraphic";

  if (layerBlur) {
    const blurred = step();
    parts.push(`<feGaussianBlur in="${last}" stdDeviation="${num(layerBlur.radius / 2)}" result="${blurred}"/>`);
    last = blurred;
    const saturation = layerBlur.saturation ?? 1;
    if (saturation !== 1) {
      const saturated = step();
      parts.push(`<feColorMatrix in="${last}" type="saturate" values="${num(saturation)}" result="${saturated}"/>`);
      last = saturated;
    }
  }

  if (noise) {
    const turbulence = step();
    parts.push(
      `<feTurbulence type="fractalNoise" baseFrequency="${num(noise.density)}" numOctaves="3" seed="${num(noise.seed)}" stitchTiles="stitch" result="${turbulence}"/>`
    );
    let grain = turbulence;
    if (noise.monochrome) {
      const grey = step();
      parts.push(`<feColorMatrix in="${grain}" type="saturate" values="0" result="${grey}"/>`);
      grain = grey;
    }
    // `feTurbulence` writes a noisy alpha channel as well as noisy colour.
    // Left alone it punches transparent holes through the layer instead of
    // speckling it, so alpha is flattened to the grain's own strength.
    const flattened = step();
    parts.push(
      `<feComponentTransfer in="${grain}" result="${flattened}"><feFuncA type="linear" slope="0" intercept="${num(noise.opacity)}"/></feComponentTransfer>`
    );
    const trimmed = step();
    parts.push(`<feComposite in="${flattened}" in2="SourceAlpha" operator="in" result="${trimmed}"/>`);
    const blended = step();
    parts.push(`<feBlend in="${trimmed}" in2="${last}" mode="${noise.blend}" result="${blended}"/>`);
    last = blended;
  }

  for (const shadow of inners) {
    // A positive spread makes an inner shadow *thicker*, which means the
    // silhouette it is cast into has to shrink — hence erode, not dilate.
    let alpha = "SourceAlpha";
    if (shadow.spread !== 0) {
      const eroded = step();
      parts.push(
        `<feMorphology in="SourceAlpha" operator="${shadow.spread > 0 ? "erode" : "dilate"}" radius="${num(Math.abs(shadow.spread))}" result="${eroded}"/>`
      );
      alpha = eroded;
    }
    const offset = step();
    parts.push(`<feOffset in="${alpha}" dx="${num(shadow.offsetX)}" dy="${num(shadow.offsetY)}" result="${offset}"/>`);
    let hole = offset;
    if (shadow.blur > 0) {
      const softened = step();
      parts.push(`<feGaussianBlur in="${hole}" stdDeviation="${num(shadow.blur / 2)}" result="${softened}"/>`);
      hole = softened;
    }
    // Inside the shape but outside the offset silhouette: that difference is
    // exactly the crescent an inner shadow occupies.
    const ring = step();
    parts.push(`<feComposite in="SourceAlpha" in2="${hole}" operator="out" result="${ring}"/>`);
    const flood = step();
    parts.push(`<feFlood flood-color="${rgbaToCss(shadow.color)}" result="${flood}"/>`);
    const tinted = step();
    parts.push(`<feComposite in="${flood}" in2="${ring}" operator="in" result="${tinted}"/>`);
    const merged = step();
    parts.push(`<feComposite in="${tinted}" in2="${last}" operator="over" result="${merged}"/>`);
    last = merged;
  }

  for (const shadow of drops) {
    let alpha = "SourceAlpha";
    if (shadow.spread !== 0) {
      const grown = step();
      parts.push(
        `<feMorphology in="SourceAlpha" operator="${shadow.spread > 0 ? "dilate" : "erode"}" radius="${num(Math.abs(shadow.spread))}" result="${grown}"/>`
      );
      alpha = grown;
    }
    const offset = step();
    parts.push(`<feOffset in="${alpha}" dx="${num(shadow.offsetX)}" dy="${num(shadow.offsetY)}" result="${offset}"/>`);
    let softened = offset;
    if (shadow.blur > 0) {
      const blurred = step();
      parts.push(`<feGaussianBlur in="${softened}" stdDeviation="${num(shadow.blur / 2)}" result="${blurred}"/>`);
      softened = blurred;
    }
    const flood = step();
    parts.push(`<feFlood flood-color="${rgbaToCss(shadow.color)}" result="${flood}"/>`);
    const tinted = step();
    parts.push(`<feComposite in="${flood}" in2="${softened}" operator="in" result="${tinted}"/>`);
    const merged = step();
    parts.push(`<feComposite in="${last}" in2="${tinted}" operator="over" result="${merged}"/>`);
    last = merged;
  }

  const id = defs.next();
  defs.entries.push(
    `<filter id="${id}"${filterRegionAttrs(box, effectPadding(node))} color-interpolation-filters="sRGB">${parts.join("")}</filter>`
  );
  return id;
}

/** How far outside its own box a node's effects can reach, in points. */
function effectPadding(node: DesignNode): number {
  let pad = 0;
  if (node.blur?.type === "layer") pad = Math.max(pad, node.blur.radius * 1.5);
  for (const shadow of node.shadows) {
    if (shadow.visible === false || shadow.type !== "drop") continue;
    const reach = shadow.blur * 1.5 + Math.max(shadow.spread, 0);
    pad = Math.max(pad, Math.abs(shadow.offsetX) + reach, Math.abs(shadow.offsetY) + reach);
  }
  return pad;
}

/**
 * The filter region, as a percentage of the node's bounding box.
 *
 * Percentages rather than `userSpaceOnUse` because a rotated node carries its
 * rotation as a `transform` on the same element, and a user-space region would
 * then be measured in the rotated frame while the layout box is not — the
 * shadow would swing off the shape. The bounding box is rotation-invariant in
 * the element's own space, so a proportional region is the one that survives.
 */
function filterRegionAttrs(box: LayoutBox, pad: number): string {
  if (pad <= 0) return "";
  // A zero-height line or a hairline frame would otherwise ask for a region
  // measured in the millions of percent, which renderers cap or refuse.
  const px = Math.min(1_000, (pad / Math.max(1, box.width)) * 100);
  const py = Math.min(1_000, (pad / Math.max(1, box.height)) * 100);
  return ` x="${num(-px)}%" y="${num(-py)}%" width="${num(100 + px * 2)}%" height="${num(100 + py * 2)}%"`;
}

/** The clip geometry for a node, in page coordinates — the shape a background
 *  blur is seen through, which has to be the node's silhouette rather than its
 *  box or every rounded glass panel would blur square corners. */
function clipShape(node: DesignNode, box: LayoutBox): string {
  switch (node.type) {
    case "ellipse":
      return `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}"/>`;
    case "path":
      return `<path transform="translate(${num(box.x)} ${num(box.y)})" d="${escapeXml(node.d)}" clip-rule="${node.windingRule === "evenodd" ? "evenodd" : "nonzero"}"/>`;
    default:
      return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(node.cornerRadius)}/>`;
  }
}

/**
 * A background blur, drawn as what it actually is.
 *
 * SVG has no backdrop filter. `BackgroundImage` was specified for exactly this
 * and no browser ever implemented it; Filter Effects 1 dropped it. So the only
 * honest way to composite a backdrop in a single-pass SVG renderer is to draw
 * one: take the markup already emitted beneath this node, blur and saturate it,
 * clip it to the node's silhouette, and paint that immediately before the node
 * itself. The node's own low-alpha fill then tints the result — which is
 * precisely the compositing model `backdrop-filter` describes, performed
 * explicitly instead of asked for.
 *
 * Two consequences worth stating rather than discovering:
 *
 *  - Only content that can actually show through is copied. The candidate set
 *    is the painted chunks intersecting the node's box grown by the blur radius
 *    (content just outside still bleeds inward under a blur), so a glass card on
 *    a large page carries a copy of the card's own backdrop, not of the page.
 *  - The copy is stripped of `data-juno-node`. The editor hit-tests by that
 *    attribute, and a duplicated one would make the topmost element under the
 *    pointer a ghost of a layer painted somewhere else entirely.
 */
function backgroundBlurMarkup(ctx: RenderContext, node: DesignNode, box: LayoutBox, blur: Blur): string | null {
  const bleed = blur.radius * 1.5 + 1;
  const region: LayoutBox = {
    x: box.x - bleed,
    y: box.y - bleed,
    width: box.width + bleed * 2,
    height: box.height + bleed * 2,
  };
  const behind = ctx.painted.filter((chunk) => !chunk.box || intersects(chunk.box, region));
  if (behind.length === 0) return null;

  const clipId = ctx.defs.next();
  ctx.defs.entries.push(`<clipPath id="${clipId}">${clipShape(node, box)}</clipPath>`);

  const filterId = ctx.defs.next();
  const saturation = blur.saturation ?? 1;
  ctx.defs.entries.push(
    `<filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${num(blur.radius / 2)}"/>${saturation !== 1 ? `<feColorMatrix type="saturate" values="${num(saturation)}"/>` : ""}</filter>`
  );

  const copy = behind.map((chunk) => chunk.markup).join("").replace(/ data-juno-node="[^"]*"/g, "");
  return `<g clip-path="url(#${clipId})"><g filter="url(#${filterId})">${copy}</g></g>`;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function renderNode(doc: DesignDocument, node: DesignNode, boxes: LayoutMap, ctx: RenderContext, options: RenderOptions): void {
  const box = boxes.get(node.id);
  if (!box || !node.visible || node.opacity === 0) return;

  const resolved = applyBoundVariables(doc, node);
  const fill = paintFill(resolved.fills[0], ctx.defs, doc);
  const fillOpacity = paintOpacityAttr(resolved.fills[0]);
  const stroke = resolved.strokes[0];
  const filterId = effectFilter(resolved, box, ctx.defs);

  const push = (markup: string) => ctx.painted.push({ markup, box });

  if (resolved.blur?.type === "background") {
    const backdrop = backgroundBlurMarkup(ctx, resolved, box, resolved.blur);
    if (backdrop) push(backdrop);
  }

  const idAttr = options.includeNodeIds ? ` data-juno-node="${escapeXml(node.id)}"` : "";
  const opacityAttr = resolved.opacity < 1 ? ` opacity="${num(resolved.opacity)}"` : "";
  const filterAttr = filterId ? ` filter="url(#${filterId})"` : "";
  const blendAttr = resolved.blendMode !== "normal" ? ` style="mix-blend-mode:${resolved.blendMode}"` : "";
  const rotateAttr =
    resolved.rotation % 360 !== 0
      ? ` transform="rotate(${num(resolved.rotation)} ${num(box.x + box.width / 2)} ${num(box.y + box.height / 2)})"`
      : "";
  const strokeAttrs = stroke
    ? ` stroke="${paintFill(stroke.paint, ctx.defs, doc)}" stroke-width="${num(stroke.weight)}"${stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.map(num).join(" ")}"` : ""}`
    : "";
  const common = `${idAttr}${opacityAttr}${filterAttr}${rotateAttr}${blendAttr}`;

  switch (resolved.type) {
    case "rectangle":
    case "frame":
    case "group":
    case "component":
    case "instance": {
      // Groups have no fill of their own unless one was authored. A group that
      // carries effects still needs a box to hang them on, though — a rim light
      // with nothing to be a rim of draws nothing at all.
      const hasBox = resolved.type !== "group" || resolved.fills.length > 0 || !!stroke || !!filterId;
      if (hasBox) {
        push(
          `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(resolved.cornerRadius)} fill="${fill}"${fillOpacity}${strokeAttrs}${common}/>`
        );
      }
      break;
    }
    case "ellipse":
      push(
        `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}" fill="${fill}"${fillOpacity}${strokeAttrs}${common}/>`
      );
      break;
    case "line":
      push(
        `<line x1="${num(box.x)}" y1="${num(box.y + box.height / 2)}" x2="${num(box.x + box.width)}" y2="${num(box.y + box.height / 2)}"${strokeAttrs || ' stroke="#000" stroke-width="1"'}${common}/>`
      );
      break;
    case "path":
      push(
        `<g transform="translate(${num(box.x)} ${num(box.y)})"${common}><path d="${escapeXml(resolved.d)}" fill="${fill}"${fillOpacity} fill-rule="${resolved.windingRule === "evenodd" ? "evenodd" : "nonzero"}"${strokeAttrs}/></g>`
      );
      break;
    case "image": {
      const asset = doc.assets[resolved.assetId];
      if (asset) {
        push(
          `<image href="${escapeXml(asset.url)}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" preserveAspectRatio="${resolved.scaleMode === "fit" ? "xMidYMid meet" : resolved.scaleMode === "stretch" ? "none" : "xMidYMid slice"}"${common}/>`
        );
      } else {
        push(`<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="rgba(0,0,0,0.06)"${common}/>`);
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
      push(
        `<text fill="${fill}"${fillOpacity} font-family="${escapeXml(typography.fontFamily)}" font-size="${num(typography.fontSize)}" font-weight="${num(typography.fontWeight)}"${typography.italic ? ' font-style="italic"' : ""} letter-spacing="${num(typography.letterSpacing)}" text-anchor="${anchor}"${typography.textDecoration && typography.textDecoration !== "none" ? ` text-decoration="${typography.textDecoration === "strikethrough" ? "line-through" : "underline"}"` : ""}${common}>${tspans}</text>`
      );
      break;
    }
  }

  if (!isContainer(node)) return;

  const clip = node.type !== "group" && node.clipsContent;
  const start = ctx.painted.length;
  for (const childId of node.children) {
    const child = doc.nodes[childId];
    if (child) renderNode(doc, child, boxes, ctx, options);
  }
  if (!clip || ctx.painted.length === start) return;

  // The children are already in the flat list — which is what let any of them
  // sample the ones before it as a backdrop. Now that the run is complete it is
  // lifted back out and re-inserted as one clipped group.
  const chunk = ctx.painted.splice(start);
  const clipId = ctx.defs.next();
  ctx.defs.entries.push(
    `<clipPath id="${clipId}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(resolved.cornerRadius)}/></clipPath>`
  );
  ctx.painted.push({ markup: `<g clip-path="url(#${clipId})">${chunk.map((c) => c.markup).join("")}</g>`, box });
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
  const ctx = makeContext();

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

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  // The background goes into the paint list first, not concatenated on at the
  // end: it is the backdrop a glass layer over empty canvas samples, and a
  // renderer that bolted it on afterwards would blur nothing and show grey.
  if (options.background !== false && page) {
    ctx.painted.push({
      markup: `<rect x="${num(minX)}" y="${num(minY)}" width="${num(width)}" height="${num(height)}" fill="${rgbaToCss(page.backgroundColor)}"/>`,
      box: null,
    });
  }

  for (const rootId of page?.children ?? []) {
    const node = doc.nodes[rootId];
    if (node) renderNode(doc, node, boxes, ctx, options);
  }

  return {
    svg: wrapSvg(minX, minY, width, height, ctx),
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
  const ctx = makeContext();
  renderNode(doc, node, boxes, ctx, options);
  return {
    svg: wrapSvg(0, 0, Math.max(1, box.width), Math.max(1, box.height), ctx),
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

  const ctx = makeContext();
  for (const id of nodeIds) {
    const node = doc.nodes[id];
    if (node) renderNode(doc, node, boxes, ctx, {});
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { svg: wrapSvg(minX, minY, width, height, ctx), width, height, x: minX, y: minY };
}

function wrapSvg(x: number, y: number, width: number, height: number, ctx: RenderContext): string {
  const defsBlock = ctx.defs.entries.length ? `<defs>${ctx.defs.entries.join("")}</defs>` : "";
  const body = ctx.painted.map((chunk) => chunk.markup).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="${num(x)} ${num(y)} ${num(width)} ${num(height)}">${defsBlock}${body}</svg>`;
}

/** A data URL of the rendered SVG — what gets attached to an AI request as the
 *  "cropped rendered image of the selected region". */
export function svgDataUrl(svg: string): string {
  const encoded = typeof btoa === "function" ? btoa(unescape(encodeURIComponent(svg))) : Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${encoded}`;
}
