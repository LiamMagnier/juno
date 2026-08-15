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
  isBackdropEffect,
  isContainer,
  type BackgroundBlurEffect,
  type CornerRadius,
  type DesignDocument,
  type DesignNode,
  type Effect,
  type GlassEffect,
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
  /** A copy of what is already beneath, re-emitted under a filter. Never sampled
   *  again — see `pushBackdrop`. */
  backdrop?: boolean;
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

/** Per-corner radii, top-left clockwise. */
function cornerValues(radius: CornerRadius): [number, number, number, number] {
  return typeof radius === "number"
    ? [radius, radius, radius, radius]
    : [radius[0], radius[1], radius[2], radius[3]];
}

const uniformRadius = (radius: CornerRadius): boolean => {
  const [tl, tr, br, bl] = cornerValues(radius);
  return tl === tr && tr === br && br === bl;
};

/**
 * Two adjacent radii cannot together exceed the edge they share.
 *
 * `<rect rx>` clamps this for you; a hand-built path does not, and an unclamped
 * corner produces an arc that doubles back and renders as a bow-tie. The scale
 * is uniform across all four corners, which is what CSS `border-radius` does, so
 * an over-specified box shrinks proportionally instead of losing one corner.
 */
function clampCorners(width: number, height: number, corners: [number, number, number, number]) {
  const [tl, tr, br, bl] = corners.map((r) => Math.max(0, r)) as [number, number, number, number];
  const ratio = (available: number, sum: number) => (sum > available ? available / sum : 1);
  const scale = Math.min(
    ratio(width, tl + tr),
    ratio(width, bl + br),
    ratio(height, tl + bl),
    ratio(height, tr + br)
  );
  return [tl * scale, tr * scale, br * scale, bl * scale] as [number, number, number, number];
}

/**
 * The `d` for a rectangle whose corners differ.
 *
 * `cornerRadius` has been `number | [number, number, number, number]` in the
 * schema from the start, and the validator accepts the tuple — but every drawing
 * path collapsed it with `Math.max(...radius)` and emitted one `rx`, so a
 * per-corner radius authored by the AI, by the host bridge or by an imported
 * document silently drew as four equal corners on the canvas, in the SVG export
 * and in the PNG taken from it. A card with only its top corners rounded is one
 * of the most ordinary shapes in interface design and the product could not
 * draw it.
 */
function roundedRectPathData(box: LayoutBox, radius: CornerRadius): string {
  const [tl, tr, br, bl] = clampCorners(box.width, box.height, cornerValues(radius));
  const { x, y, width: w, height: h } = box;
  const arc = (r: number, dx: number, dy: number) => `a${num(r)} ${num(r)} 0 0 1 ${num(dx)} ${num(dy)}`;
  return [
    `M${num(x + tl)} ${num(y)}`,
    `H${num(x + w - tr)}`,
    tr > 0 ? arc(tr, tr, tr) : "",
    `V${num(y + h - br)}`,
    br > 0 ? arc(br, -br, br) : "",
    `H${num(x + bl)}`,
    bl > 0 ? arc(bl, -bl, -bl) : "",
    `V${num(y + tl)}`,
    tl > 0 ? arc(tl, tl, -tl) : "",
    "Z",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * A box, as the cheapest element that can draw it.
 *
 * Uniform corners stay a `<rect>`: it is smaller, it is what every existing
 * snapshot contains, and the browser clamps its radii for us. Only a genuinely
 * per-corner radius pays for a path.
 */
function boxMarkup(box: LayoutBox, radius: CornerRadius, attrs: string): string {
  if (uniformRadius(radius)) {
    return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"${radiusAttrs(radius)}${attrs}/>`;
  }
  return `<path d="${roundedRectPathData(box, radius)}"${attrs}/>`;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * The layer-side half of a node's effect stack, as a single SVG filter.
 *
 * The list is walked **in order**, and each entry composites onto the result of
 * the ones before it. That is the whole reason the model unified three fields
 * into one array: the old renderer hard-coded blur → grain → inner shadows →
 * drop shadows, so a document could not say "grain, then blur it" even though
 * that is a different and perfectly ordinary surface. Now the document says it
 * and this reads it back.
 *
 * Shadows are still cast by `SourceAlpha` rather than by whatever the chain has
 * accumulated, on purpose: a shadow is cast by the layer's *silhouette*, which
 * is what CSS `box-shadow` and SwiftUI `.shadow` both do, and casting it from a
 * blurred intermediate would make the canvas the only target that agreed with
 * itself.
 *
 * Two things this originally replaced are worth keeping named, because both
 * were silent: `feDropShadow` cannot express `spread`, so every spread a user
 * typed was discarded on the way to the canvas; and inner shadows were filtered
 * out of the list entirely, so the model could hold one and nothing could ever
 * show it. Both are built by hand out of morphology, offset, blur and flood.
 */
function effectFilter(effects: Effect[], box: LayoutBox, defs: Defs): string | null {
  const layerEffects = effects.filter((effect) => !isBackdropEffect(effect));
  if (layerEffects.length === 0) return null;

  const parts: string[] = [];
  let counter = 0;
  const step = () => `f${(counter++).toString(36)}`;
  let last = "SourceGraphic";

  /** Turbulence, shared by grain and texture — the same field, used two ways. */
  const turbulence = (frequency: number, octaves: number, seed: number) => {
    const result = step();
    parts.push(
      `<feTurbulence type="fractalNoise" baseFrequency="${num(frequency)}" numOctaves="${num(octaves)}" seed="${num(seed)}" stitchTiles="stitch" result="${result}"/>`
    );
    return result;
  };

  /** Trim to the layer's silhouette, fade to `opacity`, blend onto the chain. */
  const overlay = (source: string, opacity: number, blend: string) => {
    const faded = step();
    parts.push(
      `<feComponentTransfer in="${source}" result="${faded}"><feFuncA type="linear" slope="0" intercept="${num(opacity)}"/></feComponentTransfer>`
    );
    const trimmed = step();
    parts.push(`<feComposite in="${faded}" in2="SourceAlpha" operator="in" result="${trimmed}"/>`);
    const blended = step();
    parts.push(`<feBlend in="${trimmed}" in2="${last}" mode="${blend}" result="${blended}"/>`);
    last = blended;
  };

  for (const effect of layerEffects) {
    switch (effect.type) {
      case "layer-blur": {
        const blurred = step();
        parts.push(`<feGaussianBlur in="${last}" stdDeviation="${num(effect.radius / 2)}" result="${blurred}"/>`);
        last = blurred;
        const saturation = effect.saturation ?? 1;
        if (saturation !== 1) {
          const saturated = step();
          parts.push(`<feColorMatrix in="${last}" type="saturate" values="${num(saturation)}" result="${saturated}"/>`);
          last = saturated;
        }
        break;
      }

      case "noise": {
        let grain = turbulence(effect.density, 3, effect.seed);
        if (effect.monochrome) {
          const grey = step();
          parts.push(`<feColorMatrix in="${grain}" type="saturate" values="0" result="${grey}"/>`);
          grain = grey;
        }
        // `feTurbulence` writes a noisy alpha channel as well as noisy colour.
        // Left alone it punches transparent holes through the layer instead of
        // speckling it, so `overlay` flattens alpha to the grain's own strength.
        overlay(grain, effect.opacity, effect.blend);
        break;
      }

      case "texture": {
        // The same turbulence, read as a height map and lit — which is the only
        // difference between grain and a surface. `feDiffuseLighting` discards
        // the colour of its input and lights its alpha, so the field is fed in
        // as-is and the light's own colour is what tints the relief.
        const field = turbulence(effect.scale, effect.roughness, effect.seed);
        const lit = step();
        parts.push(
          `<feDiffuseLighting in="${field}" surfaceScale="${num(effect.depth)}" diffuseConstant="1" lighting-color="${rgbaToCss(effect.color)}" result="${lit}"><feDistantLight azimuth="225" elevation="55"/></feDiffuseLighting>`
        );
        overlay(lit, effect.opacity, effect.blend);
        break;
      }

      case "inner-shadow": {
        // A positive spread makes an inner shadow *thicker*, which means the
        // silhouette it is cast into has to shrink — hence erode, not dilate.
        let alpha = "SourceAlpha";
        if (effect.spread !== 0) {
          const eroded = step();
          parts.push(
            `<feMorphology in="SourceAlpha" operator="${effect.spread > 0 ? "erode" : "dilate"}" radius="${num(Math.abs(effect.spread))}" result="${eroded}"/>`
          );
          alpha = eroded;
        }
        const offset = step();
        parts.push(`<feOffset in="${alpha}" dx="${num(effect.offsetX)}" dy="${num(effect.offsetY)}" result="${offset}"/>`);
        let hole = offset;
        if (effect.blur > 0) {
          const softened = step();
          parts.push(`<feGaussianBlur in="${hole}" stdDeviation="${num(effect.blur / 2)}" result="${softened}"/>`);
          hole = softened;
        }
        // Inside the shape but outside the offset silhouette: that difference is
        // exactly the crescent an inner shadow occupies.
        const ring = step();
        parts.push(`<feComposite in="SourceAlpha" in2="${hole}" operator="out" result="${ring}"/>`);
        const flood = step();
        parts.push(`<feFlood flood-color="${rgbaToCss(effect.color)}" result="${flood}"/>`);
        const tinted = step();
        parts.push(`<feComposite in="${flood}" in2="${ring}" operator="in" result="${tinted}"/>`);
        const merged = step();
        parts.push(`<feComposite in="${tinted}" in2="${last}" operator="over" result="${merged}"/>`);
        last = merged;
        break;
      }

      case "drop-shadow": {
        let alpha = "SourceAlpha";
        if (effect.spread !== 0) {
          const grown = step();
          parts.push(
            `<feMorphology in="SourceAlpha" operator="${effect.spread > 0 ? "dilate" : "erode"}" radius="${num(Math.abs(effect.spread))}" result="${grown}"/>`
          );
          alpha = grown;
        }
        const offset = step();
        parts.push(`<feOffset in="${alpha}" dx="${num(effect.offsetX)}" dy="${num(effect.offsetY)}" result="${offset}"/>`);
        let softened = offset;
        if (effect.blur > 0) {
          const blurred = step();
          parts.push(`<feGaussianBlur in="${softened}" stdDeviation="${num(effect.blur / 2)}" result="${blurred}"/>`);
          softened = blurred;
        }
        const flood = step();
        parts.push(`<feFlood flood-color="${rgbaToCss(effect.color)}" result="${flood}"/>`);
        const tinted = step();
        parts.push(`<feComposite in="${flood}" in2="${softened}" operator="in" result="${tinted}"/>`);
        const merged = step();
        parts.push(`<feComposite in="${last}" in2="${tinted}" operator="over" result="${merged}"/>`);
        last = merged;
        break;
      }
    }
  }

  if (parts.length === 0) return null;

  const id = defs.next();
  defs.entries.push(
    `<filter id="${id}"${filterRegionAttrs(box, effectPadding(layerEffects))} color-interpolation-filters="sRGB">${parts.join("")}</filter>`
  );
  return id;
}

/** How far outside its own box a node's effects can reach, in points. */
function effectPadding(effects: Effect[]): number {
  let pad = 0;
  for (const effect of effects) {
    if (effect.type === "layer-blur") pad = Math.max(pad, effect.radius * 1.5);
    if (effect.type !== "drop-shadow") continue;
    const reach = effect.blur * 1.5 + Math.max(effect.spread, 0);
    pad = Math.max(pad, Math.abs(effect.offsetX) + reach, Math.abs(effect.offsetY) + reach);
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

/**
 * The node's own silhouette, in page coordinates, with whatever paint
 * attributes the caller needs.
 *
 * One function rather than three, because the shape a background blur is *seen
 * through*, the shape a glass tint is *painted on* and the shape a rim light is
 * *stroked around* are all the same shape — and the moment they were written out
 * separately, a rounded glass panel blurred square corners.
 */
function silhouette(node: DesignNode, box: LayoutBox, attrs: string): string {
  switch (node.type) {
    case "ellipse":
      return `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}"${attrs}/>`;
    case "path":
      return `<path transform="translate(${num(box.x)} ${num(box.y)})" d="${escapeXml(node.d)}"${attrs}/>`;
    default:
      return boxMarkup(box, node.cornerRadius, attrs);
  }
}

function clipShape(node: DesignNode, box: LayoutBox): string {
  return silhouette(node, box, node.type === "path" ? ` clip-rule="${node.windingRule === "evenodd" ? "evenodd" : "nonzero"}"` : "");
}

/**
 * Everything already painted that could show through this node, as markup.
 *
 * SVG has no backdrop filter. `BackgroundImage` was specified for exactly this
 * and no browser ever implemented it; Filter Effects 1 dropped it. So the only
 * honest way to composite a backdrop in a single-pass SVG renderer is to draw
 * one: take the markup already emitted beneath this node and paint a filtered
 * copy of it immediately before the node itself. The node's own low-alpha fill
 * then tints the result — which is precisely the compositing model
 * `backdrop-filter` describes, performed explicitly instead of asked for.
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
function backdropCopy(ctx: RenderContext, box: LayoutBox, radius: number): string | null {
  const bleed = radius * 1.5 + 1;
  const region: LayoutBox = {
    x: box.x - bleed,
    y: box.y - bleed,
    width: box.width + bleed * 2,
    height: box.height + bleed * 2,
  };
  // `!chunk.backdrop` is what stops backdrops compounding — see `pushBackdrop`.
  const behind = ctx.painted.filter((chunk) => !chunk.backdrop && (!chunk.box || intersects(chunk.box, region)));
  if (behind.length === 0) return null;
  return behind.map((chunk) => chunk.markup).join("").replace(/ data-juno-node="[^"]*"/g, "");
}

/** A blur (and optional saturation lift) as a reusable filter def. */
function backdropFilter(ctx: RenderContext, radius: number, saturation: number): string {
  const id = ctx.defs.next();
  ctx.defs.entries.push(
    `<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${num(radius / 2)}"/>${saturation !== 1 ? `<feColorMatrix type="saturate" values="${num(saturation)}"/>` : ""}</filter>`
  );
  return id;
}

function clipDef(ctx: RenderContext, node: DesignNode, box: LayoutBox): string {
  const id = ctx.defs.next();
  ctx.defs.entries.push(`<clipPath id="${id}">${clipShape(node, box)}</clipPath>`);
  return id;
}

function backgroundBlurMarkup(ctx: RenderContext, node: DesignNode, box: LayoutBox, effect: BackgroundBlurEffect): string | null {
  const copy = backdropCopy(ctx, box, effect.radius);
  if (!copy) return null;
  const clipId = clipDef(ctx, node, box);
  const filterId = backdropFilter(ctx, effect.radius, effect.saturation ?? 1);
  return `<g clip-path="url(#${clipId})"><g filter="url(#${filterId})">${copy}</g></g>`;
}

/** The light's direction as a unit vector, from `lightAngle` degrees clockwise
 *  from 12 o'clock. Pointing *towards* the light, so the bright edge is the one
 *  the vector reaches. */
function lightVector(angle: number): { x: number; y: number } {
  const radians = ((angle % 360) * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/**
 * Glass, composed.
 *
 * Two pieces of markup, because glass genuinely is two things in two places: a
 * treatment of what is *behind* the layer, and a surface painted *on* it. The
 * old "Liquid glass" button could only ever emit the second half plus a blur,
 * which is why it looked like frosting rather than glass — a real one bends what
 * is behind it, and only the renderer that owns the backdrop can do that.
 *
 *  - **backdrop**: the blurred, saturated copy, clipped to the silhouette; then,
 *    masked to a band `depth` points wide at the rim, a *magnified* second copy.
 *    That is what a lens does — near the edge you see a displaced, enlarged
 *    version of what is behind it — and it is a transform plus a gradient mask,
 *    nothing a target cannot follow.
 *  - **surface**: the tint, a sheen along the light direction so the surface
 *    reads as curved rather than flat, and a rim light stroked on the silhouette,
 *    bright where the light is and dark opposite it.
 *
 * Both halves are painted from the node's own geometry, so they rotate, clip and
 * export with it.
 */
function glassMarkup(
  ctx: RenderContext,
  node: DesignNode,
  box: LayoutBox,
  effect: GlassEffect
): { backdrop: string | null; surface: string } {
  const clipId = clipDef(ctx, node, box);
  const filterId = backdropFilter(ctx, effect.blur, effect.saturation);
  const copy = backdropCopy(ctx, box, effect.blur);

  let backdrop: string | null = null;
  if (copy) {
    const layers = [`<g filter="url(#${filterId})">${copy}</g>`];
    const reach = Math.max(box.width, box.height) / 2;
    if (effect.refraction > 0 && effect.depth > 0 && reach > 0) {
      // The rim band, as a luminance mask: black through the middle, white at
      // the edge, so the magnified copy only shows where the glass curves.
      const gradientId = ctx.defs.next();
      const inner = Math.max(0, Math.min(0.95, 1 - effect.depth / reach));
      ctx.defs.entries.push(
        `<radialGradient id="${gradientId}" gradientUnits="userSpaceOnUse" cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" r="${num(reach)}"><stop offset="0" stop-color="#000"/><stop offset="${num(inner)}" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient>`
      );
      const maskId = ctx.defs.next();
      ctx.defs.entries.push(
        `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}"><rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="url(#${gradientId})"/></mask>`
      );
      // A quarter of the refraction as magnification: past that the rim stops
      // reading as a bevel and starts reading as a second, wrong image.
      const scale = 1 + effect.refraction * 0.25;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      layers.push(
        `<g mask="url(#${maskId})"><g transform="translate(${num(cx)} ${num(cy)}) scale(${num(scale)}) translate(${num(-cx)} ${num(-cy)})" filter="url(#${filterId})">${copy}</g></g>`
      );
    }
    backdrop = `<g clip-path="url(#${clipId})">${layers.join("")}</g>`;
  }

  const parts: string[] = [];
  const tintAlpha = effect.tint.a * effect.tintOpacity;
  if (tintAlpha > 0) parts.push(silhouette(node, box, ` fill="${rgbaToCss({ ...effect.tint, a: tintAlpha })}"`));

  const light = lightVector(effect.lightAngle);
  if (effect.lightIntensity > 0) {
    const sheenId = ctx.defs.next();
    // Object-bounding-box coordinates: the sheen has to follow the shape when the
    // shape is resized, and a user-space axis would slide off it.
    ctx.defs.entries.push(
      `<linearGradient id="${sheenId}" x1="${num(0.5 + light.x / 2)}" y1="${num(0.5 + light.y / 2)}" x2="${num(0.5 - light.x / 2)}" y2="${num(0.5 - light.y / 2)}"><stop offset="0" stop-color="#fff" stop-opacity="${num(effect.lightIntensity * 0.28)}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`
    );
    parts.push(silhouette(node, box, ` fill="url(#${sheenId})"`));

    const rimId = ctx.defs.next();
    ctx.defs.entries.push(
      `<linearGradient id="${rimId}" x1="${num(0.5 + light.x / 2)}" y1="${num(0.5 + light.y / 2)}" x2="${num(0.5 - light.x / 2)}" y2="${num(0.5 - light.y / 2)}"><stop offset="0" stop-color="#fff" stop-opacity="${num(effect.lightIntensity)}"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${num(effect.lightIntensity * 0.35)}"/></linearGradient>`
    );
    parts.push(silhouette(node, box, ` fill="none" stroke="url(#${rimId})" stroke-width="1.25"`));
  }

  return { backdrop, surface: parts.join("") };
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
  // A hidden effect is skipped once, here, so every consumer below — the filter
  // chain, the backdrops, the surfaces, the padding — agrees about what is on.
  const effects = resolved.effects.filter((effect) => effect.visible !== false);
  const filterId = effectFilter(effects, box, ctx.defs);

  const push = (markup: string) => ctx.painted.push({ markup, box });

  // Backdrop effects go down before the layer, in list order among themselves.
  // Each one samples what has been painted so far, so a glass panel over a
  // background blur sees the blur — which is the whole reason they are pushed
  // one at a time rather than gathered and emitted together.
  /**
   * A backdrop copy renders, but is never itself copied again.
   *
   * `backdropCopy` re-emits every painted chunk under the node — so once a glass
   * card's copy of the page was in the paint list, the NEXT glass card copied
   * that copy along with the original, and a third copied both. Size, canvas
   * parse time and export weight grew multiplicatively in the number of
   * overlapping backdrop layers: the exact effect the product markets was the
   * one that made a document unusable.
   *
   * Marking them is enough to stop it and costs no fidelity, because a copy is
   * by definition a duplicate of chunks that are still in the list on their own
   * account — a later sampler sees the real content either way.
   */
  const pushBackdrop = (markup: string) => ctx.painted.push({ markup, box, backdrop: true });

  const surfaces: string[] = [];
  for (const effect of effects) {
    if (effect.type === "background-blur") {
      const backdrop = backgroundBlurMarkup(ctx, resolved, box, effect);
      if (backdrop) pushBackdrop(backdrop);
    } else if (effect.type === "glass") {
      const glass = glassMarkup(ctx, resolved, box, effect);
      if (glass.backdrop) pushBackdrop(glass.backdrop);
      if (glass.surface) surfaces.push(glass.surface);
    }
  }

  const idAttr = options.includeNodeIds ? ` data-juno-node="${escapeXml(node.id)}"` : "";
  const opacityAttr = resolved.opacity < 1 ? ` opacity="${num(resolved.opacity)}"` : "";
  const filterAttr = filterId ? ` filter="url(#${filterId})"` : "";
  const blendAttr = resolved.blendMode !== "normal" ? ` style="mix-blend-mode:${resolved.blendMode}"` : "";
  const rotateAttr =
    resolved.rotation % 360 !== 0
      ? ` transform="rotate(${num(resolved.rotation)} ${num(box.x + box.width / 2)} ${num(box.y + box.height / 2)})"`
      : "";
  /**
   * Stroke alignment, which the model has always carried and the renderer never
   * honoured.
   *
   * `Stroke.align` is `inside | center | outside` and every one of them drew as
   * `center`, because that is the only thing SVG does natively: a stroke always
   * straddles its path. So a 4pt inside stroke on a button — the single most
   * common stroke in interface design, and what CSS `border` means — overflowed
   * its own box by 2pt on every side, and `outside` was indistinguishable from
   * it. The two non-centre cases are drawn at double weight and then cut in
   * half, which is the standard construction:
   *
   *  - **inside**: clip the stroke to the shape, keeping the inner half.
   *  - **outside**: mask the interior away, keeping the outer half. This one has
   *    to be a separate element painted over the shape, because a mask that
   *    removed the interior from the shape itself would remove its fill too.
   *
   * A line and a text run have no interior for a stroke to fall inside of, so
   * they stay centred rather than being given a meaningless treatment.
   */
  const strokeRender = (() => {
    if (!stroke) return { attrs: "", overlay: "" };
    const paint = paintFill(stroke.paint, ctx.defs, doc);
    const dash = stroke.dash?.length ? ` stroke-dasharray="${stroke.dash.map(num).join(" ")}"` : "";
    const align = stroke.align ?? "center";
    const centred = ` stroke="${paint}" stroke-width="${num(stroke.weight)}"${dash}`;
    if (align === "center" || resolved.type === "line" || resolved.type === "text") {
      return { attrs: centred, overlay: "" };
    }
    const doubled = ` stroke="${paint}" stroke-width="${num(stroke.weight * 2)}"${dash}`;
    if (align === "inside") {
      const clipId = ctx.defs.next();
      ctx.defs.entries.push(`<clipPath id="${clipId}">${clipShape(resolved, box)}</clipPath>`);
      return { attrs: `${doubled} clip-path="url(#${clipId})"`, overlay: "" };
    }
    // outside — the mask's white ground has to reach past the stroke it keeps.
    const maskId = ctx.defs.next();
    const pad = stroke.weight + 2;
    ctx.defs.entries.push(
      `<mask id="${maskId}" maskUnits="userSpaceOnUse"><rect x="${num(box.x - pad)}" y="${num(box.y - pad)}" width="${num(box.width + pad * 2)}" height="${num(box.height + pad * 2)}" fill="white"/>${silhouette(resolved, box, ' fill="black"')}</mask>`
    );
    return {
      attrs: "",
      overlay: silhouette(resolved, box, ` fill="none"${doubled} mask="url(#${maskId})"`),
    };
  })();
  const strokeAttrs = strokeRender.attrs;

  /**
   * Fills past the first, painted as their own silhouettes over the shape.
   *
   * `fills` has been an array since the first slice and this drew `fills[0]`,
   * which made a second fill something a document could hold, an inspector could
   * now add, and nothing could ever show. They stack **back to front** — index 0
   * is the layer's base, matching `children` and the effect stack rather than
   * contradicting both.
   *
   * Text and lines are excluded, and honestly: a glyph run has one `fill` and a
   * line has none, so a second paint on either has nowhere to go. The exporters
   * say the same thing in their own words.
   */
  const extraFills =
    resolved.type === "text" || resolved.type === "line" ? [] : resolved.fills.slice(1).filter((paint) => paint.visible !== false);

  // With extra fills the whole stack has to sit inside one group, or the effect
  // filter would run once per fill and a single drop shadow would be cast three
  // times. The single-fill case is left exactly as it was — that is the common
  // one, and it is the markup the canvas hit-tests against.
  const common = extraFills.length > 0 ? idAttr : `${idAttr}${opacityAttr}${filterAttr}${rotateAttr}${blendAttr}`;
  const pushShape = (markup: string) => {
    if (extraFills.length === 0) return push(markup);
    const layers = extraFills
      .map((paint) => silhouette(resolved, box, ` fill="${paintFill(paint, ctx.defs, doc)}"${paintOpacityAttr(paint)}`))
      .join("");
    push(`<g${opacityAttr}${filterAttr}${rotateAttr}${blendAttr}>${markup}${layers}</g>`);
  };

  switch (resolved.type) {
    case "rectangle":
    case "frame":
    case "group":
    case "component":
    case "instance": {
      // Groups have no fill of their own unless one was authored. A group that
      // carries effects still needs a box to hang them on, though — a rim light
      // with nothing to be a rim of draws nothing at all.
      const hasBox = resolved.type !== "group" || resolved.fills.length > 0 || !!stroke || !!filterId || surfaces.length > 0;
      if (hasBox) {
        pushShape(
          boxMarkup(box, resolved.cornerRadius, ` fill="${fill}"${fillOpacity}${strokeAttrs}${common}`)
        );
      }
      break;
    }
    case "ellipse":
      pushShape(
        `<ellipse cx="${num(box.x + box.width / 2)}" cy="${num(box.y + box.height / 2)}" rx="${num(box.width / 2)}" ry="${num(box.height / 2)}" fill="${fill}"${fillOpacity}${strokeAttrs}${common}/>`
      );
      break;
    case "line":
      pushShape(
        `<line x1="${num(box.x)}" y1="${num(box.y + box.height / 2)}" x2="${num(box.x + box.width)}" y2="${num(box.y + box.height / 2)}"${strokeAttrs || ' stroke="#000" stroke-width="1"'}${common}/>`
      );
      break;
    case "path":
      pushShape(
        `<g transform="translate(${num(box.x)} ${num(box.y)})"${common}><path d="${escapeXml(resolved.d)}" fill="${fill}"${fillOpacity} fill-rule="${resolved.windingRule === "evenodd" ? "evenodd" : "nonzero"}"${strokeAttrs}/></g>`
      );
      break;
    case "image": {
      const asset = doc.assets[resolved.assetId];
      if (asset) {
        pushShape(
          `<image href="${escapeXml(asset.url)}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" preserveAspectRatio="${resolved.scaleMode === "fit" ? "xMidYMid meet" : resolved.scaleMode === "stretch" ? "none" : "xMidYMid slice"}"${common}/>`
        );
      } else {
        pushShape(`<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" fill="rgba(0,0,0,0.06)"${common}/>`);
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
      pushShape(
        `<text fill="${fill}"${fillOpacity} font-family="${escapeXml(typography.fontFamily)}" font-size="${num(typography.fontSize)}" font-weight="${num(typography.fontWeight)}"${typography.italic ? ' font-style="italic"' : ""} letter-spacing="${num(typography.letterSpacing)}" text-anchor="${anchor}"${typography.textDecoration && typography.textDecoration !== "none" ? ` text-decoration="${typography.textDecoration === "strikethrough" ? "line-through" : "underline"}"` : ""}${common}>${tspans}</text>`
      );
      break;
    }
  }

  // An outside-aligned stroke, painted over the shape it belongs to. It cannot
  // ride on the shape element itself — the mask that keeps only its outer half
  // would take the fill with it — so it is a sibling drawn immediately after,
  // carrying the same rotation and opacity as the layer it outlines.
  if (strokeRender.overlay) push(`<g${rotateAttr}${opacityAttr}>${strokeRender.overlay}</g>`);

  // The glass surface sits on the layer and *under* its children: a card's
  // contents are on the glass, not behind it. It carries the node's own rotation
  // so a tilted panel's rim light tilts with it, and no `data-juno-node`, because
  // the layer itself is already the hit target and a second one would shadow it.
  if (surfaces.length > 0) push(`<g${rotateAttr}${opacityAttr}>${surfaces.join("")}</g>`);

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
    // The clip has to agree with the shape it clips, corner for corner —
    // otherwise a card with only its top corners rounded clips its children
    // against a different silhouette than the one it draws.
    `<clipPath id="${clipId}">${boxMarkup(box, resolved.cornerRadius, "")}</clipPath>`
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
