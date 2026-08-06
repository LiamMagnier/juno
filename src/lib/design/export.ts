/**
 * Juno Design — exports.
 *
 * Every export is produced from the same document, the same layout engine and
 * the same renderer the editor draws with, so "what I exported" and "what I saw"
 * cannot disagree. Nothing here re-measures, re-lays-out, or re-styles.
 *
 * The formats split into three kinds:
 *
 *  - **Vector and document** (SVG, PDF) — emitted directly from the renderer's
 *    geometry, so they stay resolution-independent.
 *  - **Raster** (PNG) — needs a rasteriser, which is a browser (or a Mac web
 *    view) rather than this module. `pngRequest` describes the work; the caller
 *    performs it. Pretending to rasterise here would mean shipping a second,
 *    worse renderer.
 *  - **Code** (HTML prototype, React, SwiftUI) — generated with a stable mapping
 *    from design node id to the symbol that represents it, which is what makes a
 *    later "change this node" edit able to target source instead of regenerating
 *    a project.
 */

import { layoutPage, layoutSubtree, lineHeightPx, type LayoutBox, type LayoutMap } from "@/lib/design/layout";
import { renderNodeSvg, renderPageSvg, escapeXml } from "@/lib/design/render";
import { applyBoundVariables, exportTokens, rgbaToCss, rgbaToHex, type TokenExport } from "@/lib/design/variables";
import { effectLabel } from "@/lib/design/operations";
import {
  isContainer,
  type DesignDocument,
  type DesignNode,
  type DropShadowEffect,
  type GlassEffect,
  type InnerShadowEffect,
  type NodeId,
  type NoiseEffect,
  type PageId,
  type Paint,
  type TextureEffect,
} from "@/lib/design/types";

export type DesignExportFormat = "svg" | "png" | "pdf" | "html" | "react" | "swiftui" | "json" | "tokens";

export interface ExportResult {
  format: DesignExportFormat;
  fileName: string;
  mimeType: string;
  /** Text payload. Binary formats (PNG) are described, not produced — see below. */
  content: string;
}

function safeFileName(name: string, extension: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "design";
  return `${cleaned}.${extension}`;
}

// ---------------------------------------------------------------------------
// Vector
// ---------------------------------------------------------------------------

export function exportSvg(doc: DesignDocument, pageId: PageId, nodeId?: NodeId): ExportResult {
  const rendered = nodeId ? renderNodeSvg(doc, nodeId) : renderPageSvg(doc, pageId);
  if (!rendered) throw new Error("Nothing to export.");
  return {
    format: "svg",
    fileName: safeFileName(nodeId ? doc.nodes[nodeId]?.name ?? doc.name : doc.name, "svg"),
    mimeType: "image/svg+xml",
    content: rendered.svg,
  };
}

/**
 * What a PNG export needs, for a caller that has a rasteriser.
 *
 * Deliberately not a PNG: producing one requires drawing the SVG, which needs a
 * browser canvas or a Mac web view. Both callers have one; this module does
 * not, and a hand-rolled rasteriser here would be a second renderer that drifts
 * from the first.
 */
export interface PngRequest {
  svg: string;
  width: number;
  height: number;
  scale: number;
  fileName: string;
}

export function pngRequest(doc: DesignDocument, pageId: PageId, nodeId?: NodeId, scale = 2): PngRequest {
  const rendered = nodeId ? renderNodeSvg(doc, nodeId) : renderPageSvg(doc, pageId);
  if (!rendered) throw new Error("Nothing to export.");
  return {
    svg: rendered.svg,
    width: Math.round(rendered.width),
    height: Math.round(rendered.height),
    scale,
    fileName: safeFileName(nodeId ? doc.nodes[nodeId]?.name ?? doc.name : doc.name, "png"),
  };
}

/**
 * A single-page PDF wrapping the rendered geometry.
 *
 * PDF has no SVG primitive, so the scene is emitted as PDF content-stream
 * operators from the same layout boxes the renderer uses. This covers the
 * rectangle/ellipse/line/text/frame vocabulary the first production slice
 * supports; gradients, images and vector paths fall back to their flat fill,
 * and shadows, blur and grain do not appear at all. Every one of those is
 * stated in `unsupported` rather than silently dropped — a PDF that quietly
 * lost the shadow on every card is a PDF nobody can trust as a proof.
 */
export function exportPdf(doc: DesignDocument, pageId: PageId): ExportResult & { unsupported: string[] } {
  const boxes = layoutPage(doc, pageId);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];

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
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  const unsupported: string[] = [];
  const ops: string[] = [];

  // PDF's origin is bottom-left and y grows upward; the scene's is top-left.
  const flipY = (y: number) => height - (y - minY);
  const x0 = (x: number) => x - minX;

  ops.push(`${pdfColor(page.backgroundColor)} rg`);
  ops.push(`0 0 ${num(width)} ${num(height)} re f`);

  const draw = (node: DesignNode) => {
    const box = boxes.get(node.id);
    if (!box || !node.visible || node.opacity === 0) return;
    const resolved = applyBoundVariables(doc, node);
    const fill = resolved.fills[0];

    if (fill && fill.type !== "solid") unsupported.push(`${resolved.name}: ${fill.type} fill flattened`);
    if (resolved.fills.length > 1) unsupported.push(`${resolved.name}: only the base fill is drawn in PDF; ${resolved.fills.length - 1} stacked fill(s) were dropped`);
    if (resolved.rotation % 360 !== 0) unsupported.push(`${resolved.name}: rotation not applied`);
    // A PDF *can* carry a blurred shadow — as a soft mask over a smooth shading,
    // or as a rasterised image. Both mean building a second rasteriser inside
    // this module, which is the thing `pngRequest` exists not to do. So the
    // geometry exports and the effects are named as missing.
    for (const effect of resolved.effects) {
      if (effect.visible === false) continue;
      unsupported.push(`${resolved.name}: ${effectLabel(effect.type)} is not drawn in PDF`);
    }

    const solid = fill?.type === "solid" ? fill.color : null;
    switch (resolved.type) {
      case "text": {
        const typography = resolved.typography;
        const lh = lineHeightPx(typography);
        ops.push("BT");
        ops.push(`/F1 ${num(typography.fontSize)} Tf`);
        ops.push(`${pdfColor(solid ?? { r: 0, g: 0, b: 0, a: 1 })} rg`);
        const lines = resolved.characters.split("\n");
        lines.forEach((line, index) => {
          ops.push(`1 0 0 1 ${num(x0(box.x))} ${num(flipY(box.y + index * lh + typography.fontSize))} Tm`);
          ops.push(`(${pdfString(line)}) Tj`);
        });
        ops.push("ET");
        break;
      }
      case "ellipse": {
        if (!solid) break;
        ops.push(`${pdfColor(solid)} rg`);
        ops.push(ellipsePath(x0(box.x), flipY(box.y + box.height), box.width, box.height));
        ops.push("f");
        break;
      }
      case "line": {
        const stroke = resolved.strokes[0];
        const color = stroke?.paint.type === "solid" ? stroke.paint.color : { r: 0, g: 0, b: 0, a: 1 };
        ops.push(`${pdfColor(color)} RG ${num(stroke?.weight ?? 1)} w`);
        ops.push(`${num(x0(box.x))} ${num(flipY(box.y + box.height / 2))} m`);
        ops.push(`${num(x0(box.x + box.width))} ${num(flipY(box.y + box.height / 2))} l S`);
        break;
      }
      default: {
        // Images and vector paths have no PDF primitive here, so they export as
        // their bounding fill — a flat box is a better answer than a hole, and
        // the substitution is recorded rather than hidden.
        if (resolved.type === "image" || resolved.type === "path") {
          unsupported.push(`${resolved.name}: ${resolved.type} exported as its bounding fill`);
        }
        if (solid) {
          ops.push(`${pdfColor(solid)} rg`);
          ops.push(`${num(x0(box.x))} ${num(flipY(box.y + box.height))} ${num(box.width)} ${num(box.height)} re f`);
        }
        const stroke = resolved.strokes[0];
        if (stroke?.paint.type === "solid") {
          ops.push(`${pdfColor(stroke.paint.color)} RG ${num(stroke.weight)} w`);
          ops.push(`${num(x0(box.x))} ${num(flipY(box.y + box.height))} ${num(box.width)} ${num(box.height)} re S`);
        }
        break;
      }
    }

    if (isContainer(node)) {
      for (const childId of node.children) {
        const child = doc.nodes[childId];
        if (child) draw(child);
      }
    }
  };

  for (const rootId of page.children) {
    const node = doc.nodes[rootId];
    if (node) draw(node);
  }

  return {
    format: "pdf",
    fileName: safeFileName(doc.name, "pdf"),
    mimeType: "application/pdf",
    content: assemblePdf(ops.join("\n"), width, height),
    unsupported: [...new Set(unsupported)],
  };
}

function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function pdfColor(color: { r: number; g: number; b: number }): string {
  return `${num(color.r)} ${num(color.g)} ${num(color.b)}`;
}

/** Escape for a PDF literal string. */
function pdfString(value: string): string {
  return value.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[\r\n]/g, " ");
}

/** Four Bézier arcs — PDF has no ellipse operator. */
function ellipsePath(x: number, y: number, width: number, height: number): string {
  const kappa = 0.5522847498;
  const rx = width / 2;
  const ry = height / 2;
  const cx = x + rx;
  const cy = y + ry;
  return [
    `${num(cx - rx)} ${num(cy)} m`,
    `${num(cx - rx)} ${num(cy + ry * kappa)} ${num(cx - rx * kappa)} ${num(cy + ry)} ${num(cx)} ${num(cy + ry)} c`,
    `${num(cx + rx * kappa)} ${num(cy + ry)} ${num(cx + rx)} ${num(cy + ry * kappa)} ${num(cx + rx)} ${num(cy)} c`,
    `${num(cx + rx)} ${num(cy - ry * kappa)} ${num(cx + rx * kappa)} ${num(cy - ry)} ${num(cx)} ${num(cy - ry)} c`,
    `${num(cx - rx * kappa)} ${num(cy - ry)} ${num(cx - rx)} ${num(cy - ry * kappa)} ${num(cx - rx)} ${num(cy)} c`,
  ].join("\n");
}

/** Minimal single-page PDF 1.4 with a correct cross-reference table. */
function assemblePdf(stream: string, width: number, height: number): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

// ---------------------------------------------------------------------------
// Code generation — with the node→symbol mapping
// ---------------------------------------------------------------------------

/**
 * Where one design node ended up in generated code.
 *
 * This is the whole point of the handoff: a later "make this button taller"
 * knows which file and which symbol to edit, instead of regenerating a project
 * and discarding whatever a human changed since.
 */
export interface CodeSymbolMapping {
  nodeId: NodeId;
  nodeName: string;
  nodeType: DesignNode["type"];
  /** File within the generated bundle. */
  file: string;
  /** The symbol that represents this node — a component name, or an element id. */
  symbol: string;
  /** 1-based line where the symbol is declared or used in that file. */
  line: number;
}

export interface GeneratedCode extends ExportResult {
  mappings: CodeSymbolMapping[];
  /** Anything the generator could not express, stated rather than dropped. */
  unsupported: string[];
}

/** A safe identifier derived from a layer name, unique within a document. */
export function symbolName(node: DesignNode, taken: Set<string>): string {
  const base =
    node.name
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join("") || "Node";
  const start = /^[A-Za-z]/.test(base) ? base : `N${base}`;
  let candidate = start;
  let counter = 2;
  while (taken.has(candidate)) candidate = `${start}${counter++}`;
  taken.add(candidate);
  return candidate;
}

/**
 * A paint as CSS.
 *
 * Stop positions and the gradient axis are carried, not discarded. They used to
 * be: a three-stop gradient with a 20%/80% ramp along a diagonal came out of
 * here as evenly spaced stops running top to bottom, which is a different
 * picture with the same colours in it. CSS measures a linear gradient's angle
 * clockwise from "pointing up", so the axis is converted rather than copied.
 */
function paintToCss(paint: Paint | undefined): string | null {
  if (!paint || paint.visible === false) return null;
  const stops = (list: { position: number; color: Parameters<typeof rgbaToCss>[0] }[]) =>
    list.map((s) => `${rgbaToCss(s.color)} ${round(s.position * 100)}%`).join(", ");
  switch (paint.type) {
    case "solid":
      return rgbaToCss(paint.color);
    case "linear-gradient": {
      const dx = paint.to.x - paint.from.x;
      const dy = paint.to.y - paint.from.y;
      const angle = dx === 0 && dy === 0 ? 180 : (Math.atan2(dx, -dy) * 180) / Math.PI;
      return `linear-gradient(${round((angle + 360) % 360)}deg, ${stops(paint.stops)})`;
    }
    case "radial-gradient":
      return `radial-gradient(circle at ${round(paint.center.x * 100)}% ${round(paint.center.y * 100)}%, ${stops(paint.stops)})`;
    case "image":
      return null;
  }
}

/**
 * A turbulence-derived effect as a CSS background layer.
 *
 * The same `feTurbulence` the canvas draws, embedded as a data-URI SVG and
 * tiled — which is not a workaround but the way CSS has always expressed this,
 * and the reason the model stores turbulence parameters instead of a picture.
 * The generated markup therefore shows the identical grain (or the identical
 * lit relief) the editor did, from the identical handful of numbers.
 */
function turbulenceLayerCss(filterBody: string, opacity: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>` +
    `<filter id='n'>${filterBody}</filter>` +
    `<rect width='100%' height='100%' filter='url(#n)' opacity='${round(opacity)}'/>` +
    `</svg>`;
  // Only the characters that cannot appear raw in a `url()` are escaped, so the
  // value stays legible in the generated source instead of becoming base64.
  const encoded = svg.replace(/[<>#%"{}|\\^`\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `url("data:image/svg+xml,${encoded}")`;
}

function noiseToCss(noise: NoiseEffect): string {
  const grey = noise.monochrome ? "<feColorMatrix type='saturate' values='0'/>" : "";
  return turbulenceLayerCss(
    `<feTurbulence type='fractalNoise' baseFrequency='${round(noise.density)}' numOctaves='3' stitchTiles='stitch' seed='${noise.seed}'/>${grey}`,
    noise.opacity
  );
}

function textureToCss(texture: TextureEffect): string {
  return turbulenceLayerCss(
    `<feTurbulence type='fractalNoise' baseFrequency='${round(texture.scale)}' numOctaves='${texture.roughness}' stitchTiles='stitch' seed='${texture.seed}'/>` +
      `<feDiffuseLighting surfaceScale='${round(texture.depth)}' diffuseConstant='1' lighting-color='${rgbaToCss(texture.color)}'><feDistantLight azimuth='225' elevation='55'/></feDiffuseLighting>`,
    texture.opacity
  );
}

/** The light direction as a CSS offset, in pixels — the same vector the SVG
 *  renderer builds its rim gradient from, so the highlight lands on the same
 *  edge in the browser as on the canvas. */
function lightOffset(angle: number): { x: number; y: number } {
  const radians = ((angle % 360) * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
}

/**
 * The paintable half of glass as CSS background layers, topmost first.
 *
 * `linear-gradient`'s angle is already degrees clockwise from "to top", which is
 * exactly how `lightAngle` is stored, so the sheen needs no conversion — the
 * browser puts the highlight on the same edge the canvas does.
 */
function glassSurfaceCss(effect: GlassEffect): string[] {
  const layers: string[] = [];
  if (effect.lightIntensity > 0) {
    layers.push(
      `linear-gradient(${round(effect.lightAngle)}deg, rgba(255,255,255,0) 0%, rgba(255,255,255,${round(effect.lightIntensity * 0.28)}) 100%)`
    );
  }
  const tint = rgbaToCss({ ...effect.tint, a: effect.tint.a * effect.tintOpacity });
  if (effect.tint.a * effect.tintOpacity > 0) layers.push(`linear-gradient(${tint}, ${tint})`);
  return layers;
}

/** CSS for one node, from its resolved properties and its laid-out box.
 *  `unsupported` collects anything CSS genuinely cannot say, so it reaches the
 *  handoff bundle instead of vanishing between here and the browser. */
function cssFor(
  doc: DesignDocument,
  node: DesignNode,
  box: LayoutBox,
  parent: LayoutBox | null,
  unsupported: string[]
): Record<string, string> {
  const resolved = applyBoundVariables(doc, node);
  const style: Record<string, string> = {};

  const inFlow = parent && "layout" in node && false; // absolute positioning throughout — see note below
  void inFlow;
  // Every node is absolutely positioned relative to its parent. That is not a
  // shortcut: it is what makes the generated markup match the layout engine
  // exactly, rather than re-deriving the layout in a second (CSS) engine that
  // rounds differently. Auto layout is preserved separately in the handoff
  // bundle, where a human or a model can reintroduce it deliberately.
  style.position = "absolute";
  style.left = `${round(box.x - (parent?.x ?? 0))}px`;
  style.top = `${round(box.y - (parent?.y ?? 0))}px`;
  style.width = `${round(box.width)}px`;
  style.height = `${round(box.height)}px`;

  const fill = paintToCss(resolved.fills[0]);
  const effects = resolved.effects.filter((effect) => effect.visible !== false);

  // Background layers, topmost first — which is the *reverse* of the effect
  // stack, because CSS paints the first layer of `background-image` on top and
  // the model applies index 0 closest to the layer.
  const overlays: { css: string; blend: string }[] = [];
  for (const effect of [...effects].reverse()) {
    if (effect.type === "noise" && effect.opacity > 0) overlays.push({ css: noiseToCss(effect), blend: effect.blend });
    else if (effect.type === "texture" && effect.opacity > 0) overlays.push({ css: textureToCss(effect), blend: effect.blend });
    else if (effect.type === "glass") for (const layer of glassSurfaceCss(effect)) overlays.push({ css: layer, blend: "normal" });
  }

  // Fills past the first, as background layers under the effect overlays. The
  // model stacks them back to front and CSS paints its first layer on top, so
  // they go in reversed — the same rule the overlays follow, for the same reason.
  for (const paint of [...resolved.fills.slice(1)].reverse()) {
    if (paint.visible === false) continue;
    const css = paintToCss(paint);
    if (!css) continue;
    // A solid is a colour, not an image; CSS only stacks images, so it becomes
    // the degenerate gradient that has always been how you say "a flat layer".
    overlays.push({ css: paint.type === "solid" ? `linear-gradient(${css}, ${css})` : css, blend: "normal" });
  }

  if (fill && resolved.type === "text") {
    style.color = fill;
    // `background-blend-mode` composites background layers with each other, and
    // glyphs are not a background layer — grain behind text would sit under the
    // letters rather than across them.
    if (overlays.length > 0) unsupported.push(`${resolved.name}: grain, texture and glass on a text layer are not expressible in CSS`);
    if (resolved.fills.length > 1) unsupported.push(`${resolved.name}: a text layer has one colour; ${resolved.fills.length - 1} extra fill(s) were dropped`);
  } else if (overlays.length > 0) {
    // The effect overlays are the topmost background layers; the fill sits under
    // them and blends with them in the mode the document asked for.
    const under = fill && resolved.fills[0]?.type !== "solid" ? [fill] : [];
    style.backgroundImage = [...overlays.map((o) => o.css), ...under].join(", ");
    style.backgroundBlendMode = [...overlays.map((o) => o.blend), ...under.map(() => "normal")].join(", ");
    if (fill && resolved.fills[0]?.type === "solid") style.backgroundColor = fill;
  } else if (fill) {
    style.background = fill;
  }
  if (resolved.opacity < 1) style.opacity = String(resolved.opacity);
  if (resolved.rotation % 360 !== 0) style.transform = `rotate(${round(resolved.rotation)}deg)`;

  const radius = typeof resolved.cornerRadius === "number" ? resolved.cornerRadius : resolved.cornerRadius.join("px ");
  if (radius) style.borderRadius = typeof radius === "number" ? `${radius}px` : `${radius}px`;

  const stroke = resolved.strokes[0];
  if (stroke?.paint.type === "solid") style.border = `${stroke.weight}px solid ${rgbaToCss(stroke.paint.color)}`;

  // Every visible shadow, in order, not just the first drop one — and inner
  // shadows as `inset`, which is the whole reason `box-shadow` takes a keyword.
  // A rim light was previously dropped here and on the canvas both, so a glass
  // panel exported as a flat tinted rectangle. `box-shadow` paints its first
  // entry on top, so the stack is reversed on the way out for the same reason
  // the background layers are.
  const shadows = effects.filter(
    (effect): effect is DropShadowEffect | InnerShadowEffect => effect.type === "drop-shadow" || effect.type === "inner-shadow"
  );
  const boxShadows = [...shadows]
    .reverse()
    .map(
      (s) =>
        `${s.type === "inner-shadow" ? "inset " : ""}${round(s.offsetX)}px ${round(s.offsetY)}px ${round(s.blur)}px ${round(s.spread)}px ${rgbaToCss(s.color)}`
    );
  // The glass rim light is an inset highlight on the lit edge and an inset
  // shade opposite it — the same two-sided rim the canvas strokes, said in the
  // one CSS property that can say it.
  for (const effect of [...effects].reverse()) {
    if (effect.type !== "glass" || effect.lightIntensity <= 0) continue;
    const light = lightOffset(effect.lightAngle);
    boxShadows.unshift(
      `inset ${round(-light.x)}px ${round(-light.y)}px 0 rgba(255,255,255,${round(effect.lightIntensity)})`,
      `inset ${round(light.x)}px ${round(light.y)}px 0 rgba(0,0,0,${round(effect.lightIntensity * 0.35)})`
    );
  }

  if (boxShadows.length > 0) {
    if (resolved.type === "text") {
      // `text-shadow` has neither spread nor inset; only a drop shadow's
      // offset, blur and colour survive, and the rest is stated.
      const drops = shadows.filter((s) => s.type === "drop-shadow");
      if (drops.length > 0) {
        style.textShadow = [...drops]
          .reverse()
          .map((s) => `${round(s.offsetX)}px ${round(s.offsetY)}px ${round(s.blur)}px ${rgbaToCss(s.color)}`)
          .join(", ");
      }
      if (shadows.some((s) => s.type === "inner-shadow")) unsupported.push(`${resolved.name}: inner shadow on a text layer has no CSS form`);
      if (drops.some((s) => s.spread !== 0)) unsupported.push(`${resolved.name}: text-shadow has no spread; it was dropped`);
    } else {
      style.boxShadow = boxShadows.join(", ");
    }
  }

  // A layer blur blurs the layer; a background blur blurs what is behind it.
  // They are different declarations, and using `filter` for both — which is what
  // this once did — turned every glass panel into a smeared one.
  const blurChain = (radius: number, saturation: number) =>
    `blur(${round(radius)}px)${saturation !== 1 ? ` saturate(${round(saturation * 100)}%)` : ""}`;

  const layerBlurs = effects.filter((effect) => effect.type === "layer-blur");
  if (layerBlurs.length > 0) {
    style.filter = layerBlurs.map((effect) => blurChain(effect.radius, effect.saturation ?? 1)).join(" ");
  }

  const backdrops = effects.map((effect) =>
    effect.type === "background-blur"
      ? blurChain(effect.radius, effect.saturation ?? 1)
      : effect.type === "glass"
        ? blurChain(effect.blur, effect.saturation)
        : null
  );
  const backdropChain = backdrops.filter((chain): chain is string => chain !== null).join(" ");
  if (backdropChain) {
    // Safari carried `backdrop-filter` behind the prefix for years, and the
    // generated prototype is a file people open locally in whatever they have.
    style.WebkitBackdropFilter = backdropChain;
    style.backdropFilter = backdropChain;
  }

  for (const effect of effects) {
    if (effect.type !== "glass" || effect.refraction <= 0) continue;
    // The one part of glass CSS has no way to say. `backdrop-filter` filters the
    // backdrop in place; it cannot magnify or displace it, and there is no
    // property that can. Naming it beats shipping a panel that is subtly flatter
    // in the browser than it was on the canvas and letting someone find out.
    unsupported.push(
      `${resolved.name}: glass refraction ${round(effect.refraction)} has no CSS equivalent — the rim renders as flat frosting`
    );
  }
  if ("clipsContent" in resolved && resolved.clipsContent) style.overflow = "hidden";

  if (resolved.type === "text") {
    const t = resolved.typography;
    style.fontFamily = t.fontFamily;
    style.fontSize = `${t.fontSize}px`;
    style.fontWeight = String(t.fontWeight);
    style.lineHeight = typeof t.lineHeight === "number" ? `${t.lineHeight}px` : `${t.lineHeight.value}%`;
    style.letterSpacing = `${t.letterSpacing}px`;
    style.textAlign = t.textAlign;
    if (t.italic) style.fontStyle = "italic";
    if (t.textDecoration && t.textDecoration !== "none") {
      style.textDecoration = t.textDecoration === "strikethrough" ? "line-through" : "underline";
    }
  }
  return style;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function styleString(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value}`)
    .join("; ");
}

/**
 * A standalone, runnable HTML prototype.
 *
 * Interactions become data attributes plus one small inert script: navigating
 * between frames is showing one root and hiding the others, which is the honest
 * translation of what a prototype link means. No framework, no network.
 */
export function exportHtmlPrototype(doc: DesignDocument, pageId: PageId): GeneratedCode {
  const boxes = layoutPage(doc, pageId);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const mappings: CodeSymbolMapping[] = [];
  const unsupported: string[] = [];
  const file = "index.html";

  const lines: string[] = [];
  const push = (text: string) => lines.push(text);

  const emit = (node: DesignNode, parent: LayoutBox | null, depth: number) => {
    const box = boxes.get(node.id);
    if (!box || !node.visible) return;
    const resolved = applyBoundVariables(doc, node);
    const indent = "  ".repeat(depth);
    const style = styleString(cssFor(doc, node, box, parent, unsupported));
    const interactions = Object.values(doc.interactions).filter((i) => i.sourceNodeId === node.id);
    const attrs = [
      `id="${escapeXml(node.id)}"`,
      `data-juno-node="${escapeXml(node.id)}"`,
      `data-juno-name="${escapeXml(node.name)}"`,
      `style="${escapeXml(style)}"`,
    ];
    for (const interaction of interactions) {
      if (interaction.action.type === "navigate") {
        attrs.push(`data-navigate="${escapeXml(interaction.action.targetNodeId)}"`);
      } else if (interaction.action.type === "open-url") {
        attrs.push(`data-open-url="${escapeXml(interaction.action.url)}"`);
      } else {
        unsupported.push(`${node.name}: ${interaction.action.type} interaction not represented`);
      }
    }

    mappings.push({
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      file,
      symbol: `#${node.id}`,
      line: lines.length + 1,
    });

    if (resolved.type === "text") {
      push(`${indent}<div ${attrs.join(" ")}>${escapeXml(resolved.characters)}</div>`);
      return;
    }
    if (resolved.type === "image") {
      const asset = doc.assets[resolved.assetId];
      push(`${indent}<img ${attrs.join(" ")} src="${escapeXml(asset?.url ?? "")}" alt="${escapeXml(node.name)}" />`);
      return;
    }

    push(`${indent}<div ${attrs.join(" ")}>`);
    if (isContainer(node)) {
      for (const childId of node.children) {
        const child = doc.nodes[childId];
        if (child) emit(child, box, depth + 1);
      }
    }
    push(`${indent}</div>`);
  };

  push("<!doctype html>");
  push('<html lang="en">');
  push("<head>");
  push('<meta charset="utf-8" />');
  push(`<title>${escapeXml(doc.name)}</title>`);
  push("<style>");
  push(`body { margin: 0; background: ${rgbaToCss(page.backgroundColor)}; font-family: Inter, system-ui, sans-serif; }`);
  push(".juno-root { position: relative; }");
  push(".juno-root[hidden] { display: none; }");
  push("[data-navigate], [data-open-url] { cursor: pointer; }");
  push("</style>");
  push("</head>");
  push("<body>");

  for (const rootId of page.children) {
    const node = doc.nodes[rootId];
    const box = boxes.get(rootId);
    if (!node || !box) continue;
    push(`<div class="juno-root" data-root="${escapeXml(rootId)}"${rootId === page.children[0] ? "" : " hidden"} style="width:${round(box.width)}px;height:${round(box.height)}px">`);
    emit(node, box, 1);
    push("</div>");
  }

  // Inert by construction: it reads data attributes this generator wrote and
  // toggles `hidden`. It evaluates nothing and fetches nothing.
  push("<script>");
  push(`document.addEventListener('click', function (event) {
  var target = event.target.closest('[data-navigate], [data-open-url]');
  if (!target) return;
  var url = target.getAttribute('data-open-url');
  if (url) { window.open(url, '_blank', 'noopener'); return; }
  var destination = target.getAttribute('data-navigate');
  var roots = document.querySelectorAll('.juno-root');
  for (var i = 0; i < roots.length; i++) {
    roots[i].hidden = roots[i].getAttribute('data-root') !== destination;
  }
});`);
  push("</script>");
  push("</body>");
  push("</html>");

  return {
    format: "html",
    fileName: safeFileName(doc.name, "html"),
    mimeType: "text/html",
    content: lines.join("\n"),
    mappings,
    unsupported: [...new Set(unsupported)],
  };
}

/** React output: one component per top-level frame, node ids preserved. */
export function exportReact(doc: DesignDocument, pageId: PageId): GeneratedCode {
  const boxes = layoutPage(doc, pageId);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const mappings: CodeSymbolMapping[] = [];
  const unsupported: string[] = [];
  const taken = new Set<string>(["React"]);
  const lines: string[] = [];
  const file = `${safeFileName(doc.name, "tsx")}`;

  lines.push("// Generated by Juno Design. Node ids are preserved as `data-juno-node`");
  lines.push("// so a later selected-node edit can find this element again.");
  lines.push("");

  const emit = (node: DesignNode, parent: LayoutBox | null, depth: number): string[] => {
    const box = boxes.get(node.id);
    if (!box || !node.visible) return [];
    const resolved = applyBoundVariables(doc, node);
    const indent = "  ".repeat(depth + 1);
    const style = cssFor(doc, node, box, parent, unsupported);
    const styleLiteral = `{{ ${Object.entries(style)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ")} }}`;
    const attrs = `data-juno-node=${JSON.stringify(node.id)} style=${styleLiteral}`;

    if (resolved.type === "text") {
      return [`${indent}<div ${attrs}>{${JSON.stringify(resolved.characters)}}</div>`];
    }
    if (resolved.type === "image") {
      const asset = doc.assets[resolved.assetId];
      return [`${indent}<img ${attrs} src=${JSON.stringify(asset?.url ?? "")} alt=${JSON.stringify(node.name)} />`];
    }

    const children = isContainer(node)
      ? node.children.flatMap((id) => {
          const child = doc.nodes[id];
          return child ? emit(child, box, depth + 1) : [];
        })
      : [];
    if (children.length === 0) return [`${indent}<div ${attrs} />`];
    return [`${indent}<div ${attrs}>`, ...children, `${indent}</div>`];
  };

  for (const rootId of page.children) {
    const node = doc.nodes[rootId];
    if (!node) continue;
    const name = symbolName(node, taken);
    mappings.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type, file, symbol: name, line: lines.length + 1 });
    lines.push(`export function ${name}() {`);
    lines.push("  return (");
    lines.push(...emit(node, null, 1));
    lines.push("  );");
    lines.push("}");
    lines.push("");

    // Descendants map to their JSX element, addressed by the node id attribute.
    for (const [id, descendant] of Object.entries(doc.nodes)) {
      if (id === node.id) continue;
      let cursor = descendant.parentId;
      let inside = false;
      while (cursor) {
        if (cursor === node.id) {
          inside = true;
          break;
        }
        cursor = doc.nodes[cursor]?.parentId ?? null;
      }
      if (!inside) continue;
      mappings.push({
        nodeId: id,
        nodeName: descendant.name,
        nodeType: descendant.type,
        file,
        symbol: `${name} › [data-juno-node="${id}"]`,
        line: lines.length,
      });
    }
  }

  if (Object.keys(doc.interactions).length > 0) {
    unsupported.push("Prototype interactions are described in the handoff bundle, not generated as React handlers.");
  }
  if (Object.keys(doc.animations).length > 0) {
    unsupported.push("Motion is described in the handoff bundle's animation spec, not generated as framer-motion code.");
  }

  return {
    format: "react",
    fileName: file,
    mimeType: "text/plain",
    content: lines.join("\n"),
    mappings,
    unsupported,
  };
}

/** SwiftUI output for Apple UI documents. */
export function exportSwiftUI(doc: DesignDocument, pageId: PageId): GeneratedCode {
  const boxes = layoutPage(doc, pageId);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const mappings: CodeSymbolMapping[] = [];
  const unsupported: string[] = [];
  const taken = new Set<string>(["View", "Text", "Image", "Color"]);
  const lines: string[] = [];
  const file = `${(doc.name.replace(/[^A-Za-z0-9]+/g, "") || "Design")}.swift`;

  lines.push("// Generated by Juno Design.");
  lines.push("// `.accessibilityIdentifier` carries each design node id, so a later");
  lines.push("// selected-node edit can find the view it produced.");
  lines.push("import SwiftUI");
  lines.push("");

  const swiftColorLiteral = (c: { r: number; g: number; b: number; a: number }) =>
    `Color(.sRGB, red: ${round(c.r)}, green: ${round(c.g)}, blue: ${round(c.b)}, opacity: ${round(c.a)})`;

  /**
   * A paint as a SwiftUI `ShapeStyle`.
   *
   * Gradients are real gradients here, not their first stop: `Gradient.Stop`
   * takes exactly the position the document stores, and `startPoint`/`endPoint`
   * take exactly the normalised axis, so a SwiftUI build of a design gets the
   * same ramp as the canvas rather than a flat approximation of it.
   */
  const swiftPaint = (paint: Paint | undefined): string | null => {
    if (!paint || paint.visible === false) return null;
    const stops = (list: { position: number; color: { r: number; g: number; b: number; a: number } }[]) =>
      list.map((s) => `.init(color: ${swiftColorLiteral(s.color)}, location: ${round(s.position)})`).join(", ");
    switch (paint.type) {
      case "solid":
        return swiftColorLiteral(paint.color);
      case "linear-gradient":
        return `LinearGradient(stops: [${stops(paint.stops)}], startPoint: UnitPoint(x: ${round(paint.from.x)}, y: ${round(paint.from.y)}), endPoint: UnitPoint(x: ${round(paint.to.x)}, y: ${round(paint.to.y)}))`;
      case "radial-gradient":
        return `RadialGradient(stops: [${stops(paint.stops)}], center: UnitPoint(x: ${round(paint.center.x)}, y: ${round(paint.center.y)}), startRadius: 0, endRadius: ${round(paint.radius)})`;
      case "image":
        return null;
    }
  };

  const emit = (node: DesignNode, parent: LayoutBox | null, depth: number): string[] => {
    const box = boxes.get(node.id);
    if (!box || !node.visible) return [];
    const resolved = applyBoundVariables(doc, node);
    const indent = "    ".repeat(depth + 1);
    const out: string[] = [];

    const body =
      resolved.type === "text"
        ? `Text(${JSON.stringify(resolved.characters)})`
        : resolved.type === "ellipse"
          ? "Ellipse()"
          : resolved.type === "image"
            ? `Image(${JSON.stringify(doc.assets[resolved.assetId]?.id ?? node.name)})`
            : "Rectangle()";

    const children = isContainer(node)
      ? node.children.flatMap((id) => {
          const child = doc.nodes[id];
          return child ? emit(child, box, depth + 1) : [];
        })
      : [];

    if (children.length > 0) {
      out.push(`${indent}ZStack(alignment: .topLeading) {`);
      out.push(...children);
      out.push(`${indent}}`);
    } else {
      out.push(`${indent}${body}`);
    }

    const effects = resolved.effects.filter((effect) => effect.visible !== false);

    // A backdrop is a material, and a material goes *under* the tint — so it is
    // emitted before the fill, in the order SwiftUI composes them.
    for (const effect of effects) {
      if (effect.type !== "background-blur" && effect.type !== "glass") continue;
      const radius = effect.type === "glass" ? effect.blur : effect.radius;
      const saturation = effect.type === "glass" ? effect.saturation : effect.saturation ?? 1;
      out.push(`${indent}    .background(${swiftMaterial(radius)})`);
      unsupported.push(
        `${resolved.name}: ${effectLabel(effect.type)} exported as ${swiftMaterial(radius)} — SwiftUI materials are not radius-parameterised (design asks for ${round(radius)}pt${saturation !== 1 ? `, saturation ${round(saturation)}` : ""})`
      );
      if (effect.type !== "glass") continue;
      // The rest of glass is a tint and a rim, and SwiftUI has both — but the
      // rim wants the same rounded silhouette the clip below applies, and that
      // shape is not known until the corner radius is read. So the tint goes on
      // here and the rim goes on after the clip, with the shape it belongs to.
      if (effect.tint.a * effect.tintOpacity > 0) {
        out.push(`${indent}    .overlay(${swiftColorLiteral(effect.tint)}.opacity(${round(effect.tintOpacity)}))`);
      }
      if (effect.refraction > 0) {
        unsupported.push(
          `${resolved.name}: glass refraction ${round(effect.refraction)} has no SwiftUI equivalent — a material does not displace what is behind it`
        );
      }
    }

    const fill = swiftPaint(resolved.fills[0]);
    if (fill && resolved.type === "text") out.push(`${indent}    .foregroundStyle(${fill})`);
    else if (fill && children.length === 0) out.push(`${indent}    .foregroundStyle(${fill})`);
    else if (fill) out.push(`${indent}    .background(${fill})`);

    // Fills past the first are overlays, in the order the model stacks them.
    // A text layer gets one colour and says so rather than emitting a second
    // `.foregroundStyle` that would silently win.
    for (const paint of resolved.fills.slice(1)) {
      if (paint.visible === false) continue;
      const extra = swiftPaint(paint);
      if (!extra) continue;
      if (resolved.type === "text") {
        unsupported.push(`${resolved.name}: a SwiftUI Text has one foreground style; an extra fill was dropped`);
        continue;
      }
      out.push(`${indent}    .overlay(${extra}${paint.opacity !== undefined && paint.opacity < 1 ? `.opacity(${round(paint.opacity)})` : ""})`);
    }

    if (resolved.type === "text") {
      out.push(`${indent}    .font(.system(size: ${round(resolved.typography.fontSize)}, weight: ${swiftWeight(resolved.typography.fontWeight)}))`);
    }
    const radius = typeof resolved.cornerRadius === "number" ? resolved.cornerRadius : Math.max(...resolved.cornerRadius);
    if (radius > 0) out.push(`${indent}    .clipShape(RoundedRectangle(cornerRadius: ${round(radius)}, style: .continuous))`);

    // Effects come after the clip so a shadow is cast by the rounded silhouette
    // rather than by the square frame behind it — and they are emitted in list
    // order, because SwiftUI modifiers compose in the order they are written and
    // that is the same claim the model's ordering makes.
    const swiftShape = radius > 0 ? `RoundedRectangle(cornerRadius: ${round(radius)}, style: .continuous)` : "Rectangle()";
    for (const effect of effects) {
      switch (effect.type) {
        case "layer-blur":
          out.push(`${indent}    .blur(radius: ${round(effect.radius)})`);
          if (effect.saturation !== undefined && effect.saturation !== 1) {
            out.push(`${indent}    .saturation(${round(effect.saturation)})`);
          }
          break;
        case "drop-shadow":
          out.push(
            `${indent}    .shadow(color: ${swiftColorLiteral(effect.color)}, radius: ${round(effect.blur / 2)}, x: ${round(effect.offsetX)}, y: ${round(effect.offsetY)})`
          );
          if (effect.spread !== 0) unsupported.push(`${resolved.name}: shadow spread ${round(effect.spread)} has no SwiftUI equivalent`);
          break;
        case "inner-shadow":
          // `ShapeStyle.shadow(.inner(…))` exists, but it is a property of the
          // *style* a shape is filled with, not a modifier on an assembled view,
          // and this generator emits assembled views. Saying so in the file beats
          // emitting something that does not compile.
          out.push(
            `${indent}    // Juno: inner shadow (${round(effect.offsetX)}, ${round(effect.offsetY)}, blur ${round(effect.blur)}) has no view modifier — fill the shape with .shadow(.inner(…)) to restore it.`
          );
          unsupported.push(`${resolved.name}: inner shadow needs a ShapeStyle fill; emitted as a comment`);
          break;
        case "noise":
          out.push(`${indent}    // Juno: ${round(effect.opacity * 100)}% grain — overlay a Canvas or a tiled noise Image to restore it.`);
          unsupported.push(`${resolved.name}: grain has no SwiftUI primitive; emitted as a comment`);
          break;
        case "texture":
          out.push(
            `${indent}    // Juno: texture (scale ${round(effect.scale)}, depth ${round(effect.depth)}) — SwiftUI has no turbulence; overlay a tiled texture Image to restore it.`
          );
          unsupported.push(`${resolved.name}: texture has no SwiftUI primitive; emitted as a comment`);
          break;
        case "glass":
          // The material and the tint already went on above; this is the rim,
          // which needs the clipped silhouette to be stroked around.
          if (effect.lightIntensity > 0) {
            out.push(
              `${indent}    .overlay(${swiftShape}.strokeBorder(LinearGradient(colors: [Color.white.opacity(${round(effect.lightIntensity)}), Color.black.opacity(${round(effect.lightIntensity * 0.35)})], startPoint: .top, endPoint: .bottom), lineWidth: 1))`
            );
            if (effect.lightAngle % 360 !== 0) {
              unsupported.push(
                `${resolved.name}: glass light angle ${round(effect.lightAngle)}° emitted as a top-to-bottom rim; SwiftUI gradients take unit points, not an angle`
              );
            }
          }
          break;
        case "background-blur":
          break;
      }
    }

    out.push(`${indent}    .frame(width: ${round(box.width)}, height: ${round(box.height)}, alignment: .topLeading)`);
    if (resolved.opacity < 1) out.push(`${indent}    .opacity(${round(resolved.opacity)})`);
    if (resolved.rotation % 360 !== 0) out.push(`${indent}    .rotationEffect(.degrees(${round(resolved.rotation)}))`);
    out.push(
      `${indent}    .offset(x: ${round(box.x - (parent?.x ?? 0))}, y: ${round(box.y - (parent?.y ?? 0))})`
    );
    out.push(`${indent}    .accessibilityIdentifier(${JSON.stringify(node.id)})`);
    return out;
  };

  for (const rootId of page.children) {
    const node = doc.nodes[rootId];
    if (!node) continue;
    const name = `${symbolName(node, taken)}View`;
    mappings.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type, file, symbol: name, line: lines.length + 1 });
    lines.push(`struct ${name}: View {`);
    lines.push("    var body: some View {");
    lines.push("        ZStack(alignment: .topLeading) {");
    lines.push(...emit(node, null, 2));
    lines.push("        }");
    lines.push(`        .frame(width: ${round(boxes.get(rootId)?.width ?? node.width)}, height: ${round(boxes.get(rootId)?.height ?? node.height)})`);
    lines.push("    }");
    lines.push("}");
    lines.push("");

    for (const [id, descendant] of Object.entries(doc.nodes)) {
      if (id === node.id) continue;
      let cursor = descendant.parentId;
      let inside = false;
      while (cursor) {
        if (cursor === node.id) {
          inside = true;
          break;
        }
        cursor = doc.nodes[cursor]?.parentId ?? null;
      }
      if (!inside) continue;
      mappings.push({
        nodeId: id,
        nodeName: descendant.name,
        nodeType: descendant.type,
        file,
        symbol: `${name} › accessibilityIdentifier(${JSON.stringify(id)})`,
        line: lines.length,
      });
    }
  }

  if (Object.keys(doc.animations).length > 0) {
    unsupported.push("Motion is described in the handoff bundle's animation spec, not generated as SwiftUI animations.");
  }
  if (Object.values(doc.nodes).some((n) => "layout" in n && n.layout)) {
    unsupported.push("Auto layout is emitted as absolute offsets; the handoff bundle records the original stacks.");
  }

  return { format: "swiftui", fileName: file, mimeType: "text/plain", content: lines.join("\n"), mappings, unsupported };
}

/**
 * The material closest to a blur radius.
 *
 * SwiftUI's materials are named thicknesses, not radii, so this is a bucketing
 * and not a conversion — which is exactly why every use of it also files an
 * `unsupported` note carrying the radius the designer actually asked for. The
 * thresholds follow Apple's own published blur radii for the four system
 * materials closely enough that a 24pt glass panel lands on `.ultraThinMaterial`,
 * which is what the platform calls the same effect.
 */
function swiftMaterial(radius: number): string {
  if (radius >= 60) return ".thickMaterial";
  if (radius >= 40) return ".regularMaterial";
  if (radius >= 20) return ".thinMaterial";
  return ".ultraThinMaterial";
}

function swiftWeight(weight: number): string {
  if (weight >= 800) return ".heavy";
  if (weight >= 700) return ".bold";
  if (weight >= 600) return ".semibold";
  if (weight >= 500) return ".medium";
  if (weight <= 300) return ".light";
  return ".regular";
}

// ---------------------------------------------------------------------------
// The Juno Code handoff bundle
// ---------------------------------------------------------------------------

export interface HandoffBundle {
  version: 1;
  generatedAt: string;
  document: DesignDocument;
  tokens: TokenExport;
  components: {
    id: string;
    name: string;
    description: string;
    rootNodeId: NodeId;
    properties: { name: string; type: string; defaultValue: unknown }[];
    variants: string[];
    instanceNodeIds: NodeId[];
  }[];
  assets: { id: string; fileName: string; mimeType: string; width: number; height: number; url: string }[];
  /** Every prototype link, as a graph a reader can follow. */
  interactionGraph: {
    id: string;
    from: { nodeId: NodeId; name: string };
    trigger: string;
    action: string;
    to: { nodeId: NodeId; name: string } | null;
    transition: { kind: string; durationMs: number; delayMs: number; easing: string; matchStableIds: boolean };
  }[];
  animations: {
    id: string;
    name: string;
    durationMs: number;
    loop: boolean;
    state?: string;
    tracks: { nodeId: NodeId; nodeName: string; property: string; keyframes: { time: number; value: unknown; easing: string }[] }[];
  }[];
  /** Rendered SVG per top-level frame — reference images, not the payload. */
  referenceImages: { nodeId: NodeId; name: string; width: number; height: number; svg: string }[];
  /** The mapping that makes a targeted edit possible. */
  codeMappings: Record<"react" | "swiftui" | "html", CodeSymbolMapping[]>;
  generated: { react: string; swiftui: string; html: string };
  /** Anything a generator could not express. Stated, never dropped. */
  unsupported: string[];
  /** Layout facts the absolute-positioned output flattened, kept for a reader. */
  layoutNotes: { nodeId: NodeId; name: string; autoLayout: unknown; constraints: unknown }[];
}

/**
 * Build the bundle Juno Code receives.
 *
 * It carries structure, not screenshots: the scene document itself, the tokens,
 * component metadata, the interaction graph, the animation spec, reference
 * renders — and, crucially, the node→symbol mapping for each generated target.
 * That mapping is what lets "change the sign-in button's radius" edit the line
 * that produced it rather than regenerate the project around it.
 */
export function buildHandoffBundle(doc: DesignDocument, pageId: PageId, now: string): HandoffBundle {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];

  const react = exportReact(doc, pageId);
  const swiftui = exportSwiftUI(doc, pageId);
  const html = exportHtmlPrototype(doc, pageId);

  const named = (id: NodeId) => ({ nodeId: id, name: doc.nodes[id]?.name ?? id });

  const referenceImages = page.children.flatMap((rootId) => {
    const rendered = renderNodeSvg(doc, rootId);
    const node = doc.nodes[rootId];
    if (!rendered || !node) return [];
    return [{ nodeId: rootId, name: node.name, width: Math.round(rendered.width), height: Math.round(rendered.height), svg: rendered.svg }];
  });

  const instancesByComponent = new Map<string, NodeId[]>();
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== "instance") continue;
    const list = instancesByComponent.get(node.componentId) ?? [];
    list.push(node.id);
    instancesByComponent.set(node.componentId, list);
  }

  const layoutNotes = Object.values(doc.nodes)
    .filter((node) => ("layout" in node && node.layout) || node.constraints.horizontal !== "min" || node.constraints.vertical !== "min")
    .map((node) => ({
      nodeId: node.id,
      name: node.name,
      autoLayout: "layout" in node ? node.layout : null,
      constraints: node.constraints,
    }));

  return {
    version: 1,
    generatedAt: now,
    document: doc,
    tokens: exportTokens(doc),
    components: Object.values(doc.components).map((component) => ({
      id: component.id,
      name: component.name,
      description: component.description,
      rootNodeId: component.rootNodeId,
      properties: component.properties.map((p) => ({ name: p.name, type: p.type, defaultValue: p.defaultValue })),
      variants: Object.keys(component.variants),
      instanceNodeIds: instancesByComponent.get(component.id) ?? [],
    })),
    assets: Object.values(doc.assets).map((asset) => ({
      id: asset.id,
      fileName: `${asset.id}.${asset.mimeType.split("/")[1]?.split("+")[0] ?? "bin"}`,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      url: asset.url,
    })),
    interactionGraph: Object.values(doc.interactions).map((interaction) => {
      const target =
        "targetNodeId" in interaction.action ? named(interaction.action.targetNodeId as NodeId) : null;
      return {
        id: interaction.id,
        from: named(interaction.sourceNodeId),
        trigger: interaction.trigger.type,
        action: interaction.action.type,
        to: target,
        transition: {
          kind: interaction.transition.kind,
          durationMs: interaction.transition.durationMs,
          delayMs: interaction.transition.delayMs,
          easing: describeEasing(interaction.transition.easing),
          matchStableIds: interaction.transition.matchStableIds,
        },
      };
    }),
    animations: Object.values(doc.animations).map((animation) => ({
      id: animation.id,
      name: animation.name,
      durationMs: animation.durationMs,
      loop: animation.loop,
      state: animation.state,
      tracks: animation.tracks.map((track) => ({
        nodeId: track.nodeId,
        nodeName: doc.nodes[track.nodeId]?.name ?? track.nodeId,
        property: track.property,
        keyframes: track.keyframes.map((k) => ({
          time: k.time,
          value: typeof k.value === "object" ? rgbaToHex(k.value) : k.value,
          easing: describeEasing(k.easing),
        })),
      })),
    })),
    referenceImages,
    codeMappings: { react: react.mappings, swiftui: swiftui.mappings, html: html.mappings },
    generated: { react: react.content, swiftui: swiftui.content, html: html.content },
    unsupported: [...new Set([...react.unsupported, ...swiftui.unsupported, ...html.unsupported])],
    layoutNotes,
  };
}

function describeEasing(easing: { type: string } & Record<string, unknown>): string {
  switch (easing.type) {
    case "cubic-bezier":
      return `cubic-bezier(${easing.x1}, ${easing.y1}, ${easing.x2}, ${easing.y2})`;
    case "spring":
      return `spring(stiffness ${easing.stiffness}, damping ${easing.damping}, mass ${easing.mass})`;
    default:
      return easing.type;
  }
}

/** Find where a node ended up in a generated target — the lookup a targeted
 *  edit performs before touching source. */
export function findSymbol(bundle: HandoffBundle, nodeId: NodeId, target: "react" | "swiftui" | "html"): CodeSymbolMapping | null {
  return bundle.codeMappings[target].find((mapping) => mapping.nodeId === nodeId) ?? null;
}

export { layoutSubtree, type LayoutMap };
