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
import { cornerValues, renderNodeSvg, renderPageSvg, escapeXml } from "@/lib/design/render";
import { applyBoundVariables, exportTokens, rgbaToCss, rgbaToHex, type TokenExport } from "@/lib/design/variables";
import { effectLabel } from "@/lib/design/operations";
import {
  isContainer,
  type AnimatableProperty,
  type AnimationId,
  type DesignDocument,
  type DesignNode,
  type DropShadowEffect,
  type EasingCurve,
  type GlassEffect,
  type InnerShadowEffect,
  type Keyframe,
  type MotionAnimation,
  type MotionTrack,
  type NodeId,
  type NoiseEffect,
  type PageId,
  type Paint,
  type Rgba,
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
        // `re` is the only rectangle PDF has and it has square corners. A
        // rounded one is four Bézier segments this exporter could emit, but
        // `roundedRectPathData` already knows how to walk them and lives in the
        // renderer in SVG's own command vocabulary — reimplementing the walk in
        // PDF operators here would be the second geometry this module exists to
        // avoid. Every other corner-radius consumer in the product honours the
        // per-corner tuple, so a PDF quietly squaring it off is the one place a
        // designer could not tell what had happened.
        if (cornerValues(resolved.cornerRadius).some((r) => r > 0)) {
          unsupported.push(`${resolved.name}: corner radius is not drawn in PDF; the box is square`);
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

/**
 * Typographic characters that have a plain equivalent, mapped before encoding.
 *
 * These are the ones real design copy is full of — smart quotes, dashes,
 * ellipses — and they sit in the 0x80–0x9F range where WinAnsi and Latin-1
 * disagree. Folding them to ASCII first means the octal escape below only ever
 * has to handle 0xA0–0xFF, where the two encodings are identical.
 */
const PDF_TEXT_FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": ",", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-",
  "…": "...", "•": "-", " ": " ", " ": " ", " ": " ", " ": " ",
  "‹": "<", "›": ">", "«": '"', "»": '"', "′": "'", "″": '"',
  "€": "EUR", "™": "(TM)", "‰": "%%",
};

/**
 * Escape for a PDF literal string — and transcode it to WinAnsi.
 *
 * This used to escape only `\`, `(` and `)`, which left the string carrying
 * whatever the author typed. Two things then went wrong at once. The file is
 * served as UTF-8, so a single accented character made the byte length differ
 * from the JS string length and `assemblePdf`'s cross-reference offsets pointed
 * into the middle of an object; and the content stream is drawn with a Type1
 * Helvetica, whose literal strings are single-byte WinAnsi, so the raw UTF-8
 * bytes would have rendered as mojibake even if the offsets had been right.
 *
 * The output is therefore ASCII by construction: anything above 0x7F is written
 * as a `\ooo` octal escape of its WinAnsi byte, and anything WinAnsi has no
 * glyph for degrades to `?` rather than silently corrupting the stream. Keeping
 * the whole file single-byte is also what makes the offset arithmetic in
 * `assemblePdf` provably correct instead of accidentally correct.
 */
function pdfString(value: string): string {
  let out = "";
  for (const char of value.replace(/[\r\n]/g, " ").replace(/[ -› «»€™‰]/g, (c) => PDF_TEXT_FOLD[c] ?? c)) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || char === "(" || char === ")") out += `\\${char}`;
    else if (code >= 0x20 && code <= 0x7e) out += char;
    // 0xA0–0xFF is Latin-1, which WinAnsi matches exactly in that range.
    else if (code >= 0xa0 && code <= 0xff) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
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

/**
 * Bytes, not UTF-16 code units.
 *
 * Every offset in a PDF is a byte offset into the file, and the file is served
 * as UTF-8. `String.length` counts code units, so it agreed with the byte count
 * only while the document happened to be pure ASCII — which is exactly the case
 * that gets tested and never the case that ships. `pdfString` now guarantees
 * ASCII, so these two measures agree again; measuring properly anyway means a
 * future non-ASCII escape hatch cannot silently corrupt the xref table.
 */
const PDF_BYTES = new TextEncoder();
const byteLength = (value: string): number => PDF_BYTES.encode(value).length;

/** Minimal single-page PDF 1.4 with a correct cross-reference table. */
function assemblePdf(stream: string, width: number, height: number): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    // /Length is likewise a byte count of the stream data.
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = byteLength(pdf);
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
  // `border-radius` is an ellipse quadrant and nothing else. CSS grew a
  // `corner-shape: superellipse()` that says exactly this, but it lands in one
  // engine and the generated prototype is a file people open in whatever they
  // have — emitting it would make the same HTML draw two different shapes and
  // give nobody a way to know which one they were looking at. So the browser
  // gets the circular corner it can actually draw, and the caveat is named.
  if (radius && resolved.cornerSmoothing) {
    unsupported.push(
      `${resolved.name}: corner smoothing ${Math.round(resolved.cornerSmoothing * 100)}% has no portable CSS form — border-radius draws a circular corner`
    );
  }

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

// ---------------------------------------------------------------------------
// Motion → CSS
// ---------------------------------------------------------------------------

/**
 * The document's animations, as real `@keyframes`.
 *
 * Motion reached no export target at all. React and SwiftUI push a note saying
 * the animations are "described in the handoff bundle", and the HTML prototype
 * — the one target that actually runs — emitted nothing, so the timeline was
 * the only surface in the entire product where a keyframe could ever be seen
 * moving. A designer could spend an afternoon on a spring and then have no
 * artifact to show for it.
 *
 * CSS is a genuine fit for this model rather than a stand-in. A keyframe's
 * easing governs the segment that *starts* at it, which is exactly what a
 * per-stop `animation-timing-function` means; a track that stops short of the
 * animation's end holds its last value, which is what `animation-fill-mode:
 * both` plus a synthesised 100% stop gives. The two places CSS cannot follow —
 * springs, and two transform components keyframed at different instants — are
 * reported rather than quietly approximated.
 *
 * Names are generated (`juno-k0`, `juno-a0`, `a0`) rather than derived from
 * document ids. A node id is an arbitrary string from a JSON file; putting one
 * in a CSS selector or a `querySelectorAll` argument is an escaping problem with
 * no upside, and generated tokens are safe by construction.
 */
interface MotionCss {
  /** Rules for the prototype's `<style>` block. */
  rules: string[];
  /** The class that carries a node's `animation` shorthand. */
  classByNode: Map<NodeId, string>;
  /** Generated tokens on a node, for the runtime's `~=` lookup. */
  tokensByNode: Map<NodeId, string[]>;
  /** Generated token per animation, for a `play-animation` interaction. */
  tokenByAnimation: Map<AnimationId, string>;
}

/** Where the static CSS put this node, so an `x`/`y` track can move it from
 *  there. The track carries authored coordinates; `left`/`top` are relative to
 *  the parent box, and for an auto-laid-out child the two are not the same
 *  number — the delta is right in both cases where the static position is. */
function motionBase(doc: DesignDocument, boxes: LayoutMap, node: DesignNode): { left: number; top: number } | null {
  const box = boxes.get(node.id);
  if (!box) return null;
  // A root frame is emitted inside a wrapper of its own size, so it sits at 0,0.
  const parent = node.parentId ? boxes.get(node.parentId) : box;
  return { left: round(box.x - (parent?.x ?? 0)), top: round(box.y - (parent?.y ?? 0)) };
}

function motionDeclaration(
  node: DesignNode,
  base: { left: number; top: number },
  property: AnimatableProperty,
  value: number | Rgba
): string | null {
  const n = typeof value === "number" ? value : null;
  const color = typeof value === "object" ? value : null;
  switch (property) {
    case "x":
      return n === null ? null : `left: ${round(base.left + (n - node.x))}px`;
    case "y":
      return n === null ? null : `top: ${round(base.top + (n - node.y))}px`;
    case "width":
      return n === null ? null : `width: ${round(n)}px`;
    case "height":
      return n === null ? null : `height: ${round(n)}px`;
    case "opacity":
      return n === null ? null : `opacity: ${round(n)}`;
    case "cornerRadius":
      return n === null ? null : `border-radius: ${round(n)}px`;
    case "blur":
      return n === null ? null : `filter: blur(${round(Math.max(0, n))}px)`;
    case "fontSize":
      return n === null ? null : `font-size: ${round(n)}px`;
    case "letterSpacing":
      return n === null ? null : `letter-spacing: ${round(n)}px`;
    case "fillColor":
      // A text layer's fill is its glyph colour, exactly as `cssFor` decides.
      return color === null ? null : `${node.type === "text" ? "color" : "background-color"}: ${rgbaToCss(color)}`;
    case "strokeColor":
      return color === null ? null : `border-color: ${rgbaToCss(color)}`;
    case "rotation":
    case "scale":
      // Both are `transform`, which is one property and cannot be written twice.
      // Merged below instead.
      return null;
  }
}

function cssTiming(easing: EasingCurve, label: string, unsupported: string[]): string {
  switch (easing.type) {
    case "linear":
      return "linear";
    case "ease-in":
    case "ease-out":
    case "ease-in-out":
      // The keywords, not the control points: `NAMED_BEZIERS` in the motion
      // model is CSS's own table, so these two describe one curve.
      return easing.type;
    case "cubic-bezier":
      return `cubic-bezier(${round(easing.x1)}, ${round(easing.y1)}, ${round(easing.x2)}, ${round(easing.y2)})`;
    case "spring":
      // A spring overshoots and settles over a duration the physics chooses.
      // `linear()` could approximate it point by point, but it is a 2023
      // addition and this file is opened locally in whatever browser is to
      // hand. Saying so beats shipping motion that is subtly wrong.
      unsupported.push(`${label}: a spring has no CSS timing function — the prototype eases out instead`);
      return "ease-out";
  }
}

const sortFrames = (keyframes: Keyframe[]): Keyframe[] => [...keyframes].sort((a, b) => a.time - b.time);

/** A numeric track sampled linearly. Only reached when two transform components
 *  are keyframed at different instants and one has to be filled in at the
 *  other's stop; the caller reports it. */
function sampleLinear(frames: Keyframe[], timeMs: number): number | null {
  if (frames.length === 0) return null;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (typeof first.value !== "number" || typeof last.value !== "number") return null;
  if (timeMs <= first.time) return first.value;
  if (timeMs >= last.time) return last.value;
  let index = 0;
  while (index < frames.length - 1 && frames[index + 1].time <= timeMs) index++;
  const from = frames[index];
  const to = frames[index + 1];
  if (typeof from.value !== "number" || typeof to.value !== "number") return null;
  const span = to.time - from.time;
  if (span <= 0) return to.value;
  return from.value + (to.value - from.value) * ((timeMs - from.time) / span);
}

/** The body of one `@keyframes` rule: every stop this node's tracks name, with
 *  only the properties that actually have a keyframe there. CSS interpolates
 *  each property across the stops that declare it and ignores the rest, which
 *  is what makes tracks of different lengths compose without sampling. */
function keyframesBody(
  node: DesignNode,
  base: { left: number; top: number },
  tracks: MotionTrack[],
  durationMs: number,
  label: string,
  unsupported: string[]
): string | null {
  const stops = new Map<number, { declarations: string[]; timing: string | null }>();
  const percentOf = (time: number) => Math.round(Math.max(0, Math.min(1, time / durationMs)) * 10_000) / 100;

  const at = (percent: number) => {
    const existing = stops.get(percent);
    if (existing) return existing;
    const created = { declarations: [] as string[], timing: null as string | null };
    stops.set(percent, created);
    return created;
  };

  /**
   * A stop's timing function, first writer wins.
   *
   * CSS has one `animation-timing-function` per stop and it governs every
   * property leaving that stop, where this model gives each keyframe its own
   * easing. Two tracks that ease differently out of the same instant cannot
   * both be honoured, so the loser is named rather than lost quietly.
   */
  let timingConflict = false;
  const proposeTiming = (stop: { timing: string | null }, timing: string) => {
    if (stop.timing === null) stop.timing = timing;
    else if (stop.timing !== timing) timingConflict = true;
  };

  const rotation = tracks.find((track) => track.property === "rotation");
  const scale = tracks.find((track) => track.property === "scale");

  for (const track of tracks) {
    if (track.property === "rotation" || track.property === "scale") continue;
    const frames = sortFrames(track.keyframes);
    for (const [index, frame] of frames.entries()) {
      const declaration = motionDeclaration(node, base, track.property, frame.value);
      if (!declaration) continue;
      const stop = at(percentOf(frame.time));
      stop.declarations.push(declaration);
      // The LAST keyframe's easing governs nothing — there is no segment after
      // it — so it is not allowed to claim the stop's timing function.
      if (index < frames.length - 1) proposeTiming(stop, cssTiming(frame.easing, label, unsupported));
    }
    // A track that starts late or ends early holds its end values, which is what
    // `sampleTrack` does. Without these two stops CSS would tween from the
    // element's static style instead, so a fade that begins at 100ms would start
    // fading at 0.
    const first = frames[0];
    const last = frames[frames.length - 1];
    if (first && first.time > 0) {
      const declaration = motionDeclaration(node, base, track.property, first.value);
      if (declaration) at(0).declarations.push(declaration);
    }
    if (last && last.time < durationMs) {
      const declaration = motionDeclaration(node, base, track.property, last.value);
      if (declaration) at(100).declarations.push(declaration);
    }
  }

  if (rotation || scale) {
    const rotationFrames = rotation ? sortFrames(rotation.keyframes) : [];
    const scaleFrames = scale ? sortFrames(scale.keyframes) : [];
    const times = new Set<number>([...rotationFrames, ...scaleFrames].map((frame) => frame.time));
    if (rotationFrames.length > 0 && scaleFrames.length > 0) {
      const rotationTimes = rotationFrames.map((frame) => frame.time).join(",");
      const scaleTimes = scaleFrames.map((frame) => frame.time).join(",");
      if (rotationTimes !== scaleTimes) {
        unsupported.push(
          `${label}: rotation and scale are one CSS \`transform\`, so the component without a keyframe at a shared stop is filled in linearly`
        );
      }
    }
    times.add(0);
    times.add(durationMs);
    // `transform` replaces the static one wholesale, so a layer rotated in the
    // document and only scaled by the animation would spring upright the moment
    // the animation applied. The authored angle is carried through instead.
    const staticAngle = rotationFrames.length === 0 && node.rotation % 360 !== 0 ? node.rotation : null;
    const lastTime = Math.max(rotationFrames[rotationFrames.length - 1]?.time ?? 0, scaleFrames[scaleFrames.length - 1]?.time ?? 0);
    for (const time of [...times].sort((a, b) => a - b)) {
      const angle = rotationFrames.length > 0 ? sampleLinear(rotationFrames, time) : staticAngle;
      const factor = scaleFrames.length > 0 ? sampleLinear(scaleFrames, time) : null;
      const parts: string[] = [];
      if (angle !== null) parts.push(`rotate(${round(angle)}deg)`);
      if (factor !== null) parts.push(`scale(${round(factor)})`);
      if (parts.length === 0) continue;
      const stop = at(percentOf(time));
      stop.declarations.push(`transform: ${parts.join(" ")}`);
      // Whichever of the two actually has a keyframe here owns the easing out of
      // it; reading only the rotation track dropped a spring authored on scale.
      const owner = rotationFrames.find((frame) => frame.time === time) ?? scaleFrames.find((frame) => frame.time === time);
      if (owner && time < lastTime) proposeTiming(stop, cssTiming(owner.easing, label, unsupported));
    }
  }

  if (timingConflict) {
    unsupported.push(`${label}: two properties ease differently out of the same keyframe; CSS allows one curve per stop`);
  }

  if (stops.size === 0) return null;
  return [...stops.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([percent, stop]) => {
      const declarations = [...stop.declarations];
      if (stop.timing) declarations.push(`animation-timing-function: ${stop.timing}`);
      return `  ${percent}% { ${declarations.join("; ")}; }`;
    })
    .join("\n");
}

function buildMotionCss(doc: DesignDocument, boxes: LayoutMap, unsupported: string[]): MotionCss {
  const rules: string[] = [];
  const classByNode = new Map<NodeId, string>();
  const tokensByNode = new Map<NodeId, string[]>();
  const tokenByAnimation = new Map<AnimationId, string>();
  const perNode = new Map<NodeId, { keyframes: string; animation: MotionAnimation }[]>();

  /** Animations something in the prototype can start. Everything else runs on
   *  load, because an animation nothing triggers and nothing plays is an
   *  animation this file would never show. */
  const triggered = new Set<AnimationId>(
    Object.values(doc.interactions).flatMap((interaction) =>
      interaction.action.type === "play-animation" ? [interaction.action.animationId] : []
    )
  );

  let animationIndex = 0;
  let keyframesIndex = 0;

  for (const animation of Object.values(doc.animations)) {
    const token = `a${animationIndex++}`;
    tokenByAnimation.set(animation.id, token);
    // A zero-length animation would divide by zero on the way to a percentage
    // and render as nothing anyway.
    const durationMs = Math.max(1, Math.round(animation.durationMs));

    const byNode = new Map<NodeId, MotionTrack[]>();
    for (const track of animation.tracks) {
      // One keyframe is a value, not motion.
      if (track.keyframes.length < 2) continue;
      if (!doc.nodes[track.nodeId] || !boxes.has(track.nodeId)) continue; // a layer on another page
      const list = byNode.get(track.nodeId);
      if (list) list.push(track);
      else byNode.set(track.nodeId, [track]);
    }

    for (const [nodeId, tracks] of byNode) {
      const node = doc.nodes[nodeId];
      const base = motionBase(doc, boxes, node);
      if (!base) continue;
      const body = keyframesBody(node, base, tracks, durationMs, `${animation.name} · ${node.name}`, unsupported);
      if (!body) continue;
      const name = `juno-k${keyframesIndex++}`;
      rules.push(`@keyframes ${name} {\n${body}\n}`);
      const entries = perNode.get(nodeId);
      if (entries) entries.push({ keyframes: name, animation });
      else perNode.set(nodeId, [{ keyframes: name, animation }]);
      const tokens = tokensByNode.get(nodeId);
      if (tokens) tokens.push(token);
      else tokensByNode.set(nodeId, [token]);
    }
  }

  /** Paused until something starts it — a hover, or a `play-animation` link. */
  const restingState = (animation: MotionAnimation) =>
    animation.state === "hover" || triggered.has(animation.id) ? "paused" : "running";

  let classIndex = 0;
  for (const [nodeId, entries] of perNode) {
    const className = `juno-a${classIndex++}`;
    classByNode.set(nodeId, className);
    rules.push(
      [
        `.${className} {`,
        `  animation-name: ${entries.map((entry) => entry.keyframes).join(", ")};`,
        `  animation-duration: ${entries.map((entry) => `${Math.max(1, Math.round(entry.animation.durationMs))}ms`).join(", ")};`,
        // linear at the shorthand level: the per-stop timing functions above are
        // the real curves, and a shorthand easing would compose with them.
        `  animation-timing-function: ${entries.map(() => "linear").join(", ")};`,
        `  animation-iteration-count: ${entries.map((entry) => (entry.animation.loop ? "infinite" : "1")).join(", ")};`,
        // `both`, so a paused animation shows its first keyframe rather than the
        // layer's authored state and a finished one holds its last.
        `  animation-fill-mode: ${entries.map(() => "both").join(", ")};`,
        `  animation-play-state: ${entries.map((entry) => restingState(entry.animation)).join(", ")};`,
        `}`,
      ].join("\n")
    );

    if (entries.some((entry) => entry.animation.state === "hover")) {
      rules.push(
        `.${className}:hover { animation-play-state: ${entries
          .map((entry) => (entry.animation.state === "hover" ? "running" : restingState(entry.animation)))
          .join(", ")}; }`
      );
    }

    // Restarting is per element, not per animation — the reflow trick clears the
    // element's whole `animation-name`. Only worth saying when a layer actually
    // carries more than one.
    if (entries.length > 1 && entries.some((entry) => triggered.has(entry.animation.id))) {
      unsupported.push(`${doc.nodes[nodeId]?.name ?? nodeId}: playing one animation on this layer restarts the others on it`);
    }
  }

  return { rules, classByNode, tokensByNode, tokenByAnimation };
}

/**
 * A standalone, runnable HTML prototype.
 *
 * Interactions become data attributes plus one small inert script: navigating
 * between frames is showing one root and hiding the others, which is the honest
 * translation of what a prototype link means. No framework, no network.
 *
 * The document's animations become real `@keyframes` — see `buildMotionCss`.
 */
export function exportHtmlPrototype(doc: DesignDocument, pageId: PageId): GeneratedCode {
  const boxes = layoutPage(doc, pageId);
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const mappings: CodeSymbolMapping[] = [];
  const unsupported: string[] = [];
  const file = "index.html";

  const lines: string[] = [];
  const push = (text: string) => lines.push(text);
  const motion = buildMotionCss(doc, boxes, unsupported);

  const emit = (node: DesignNode, parent: LayoutBox | null, depth: number) => {
    const box = boxes.get(node.id);
    if (!box || !node.visible) return;
    const resolved = applyBoundVariables(doc, node);
    const indent = "  ".repeat(depth);
    const style = styleString(cssFor(doc, node, box, parent, unsupported));
    const interactions = Object.values(doc.interactions).filter((i) => i.sourceNodeId === node.id);
    const animationClass = motion.classByNode.get(node.id);
    const attrs = [
      `id="${escapeXml(node.id)}"`,
      `data-juno-node="${escapeXml(node.id)}"`,
      `data-juno-name="${escapeXml(node.name)}"`,
      ...(animationClass ? [`class="${animationClass}"`] : []),
      ...(motion.tokensByNode.has(node.id) ? [`data-juno-animation="${motion.tokensByNode.get(node.id)!.join(" ")}"`] : []),
      `style="${escapeXml(style)}"`,
    ];
    for (const interaction of interactions) {
      // The TRIGGER used to be dropped on the floor: every interaction became a
      // click, so "after 2 seconds, go to Screen 2" exported as a prototype that
      // waits for a click, and a hover link could not be tried at all. Emitting
      // it lets the runtime below bind the right event, and lets an unsupported
      // trigger say so instead of silently becoming a different one.
      const trigger = interaction.trigger;
      const bindable =
        trigger.type === "click" ||
        trigger.type === "press" ||
        trigger.type === "hover" ||
        trigger.type === "key" ||
        trigger.type === "delay" ||
        trigger.type === "scroll-into-view";
      if (!bindable) {
        unsupported.push(`${node.name}: ${trigger.type} trigger is not represented in the HTML prototype`);
      }

      if (interaction.action.type === "navigate") {
        attrs.push(`data-navigate="${escapeXml(interaction.action.targetNodeId)}"`);
      } else if (interaction.action.type === "open-url") {
        attrs.push(`data-open-url="${escapeXml(interaction.action.url)}"`);
      } else if (interaction.action.type === "play-animation" && motion.tokenByAnimation.has(interaction.action.animationId)) {
        // Now that the animations are in the file, the action that starts one
        // is expressible. It carries the generated token rather than the
        // animation's id, so the runtime's selector is safe by construction.
        attrs.push(`data-play-animation="${motion.tokenByAnimation.get(interaction.action.animationId)!}"`);
        if (interaction.action.reverse) attrs.push(`data-play-reverse="1"`);
      } else {
        unsupported.push(`${node.name}: ${interaction.action.type} interaction not represented`);
        continue;
      }

      if (bindable) {
        attrs.push(`data-trigger="${escapeXml(trigger.type)}"`);
        if (trigger.type === "key") attrs.push(`data-trigger-key="${escapeXml(trigger.key)}"`);
        if (trigger.type === "delay") attrs.push(`data-trigger-ms="${Math.max(0, Math.round(trigger.ms))}"`);
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
  push("[data-navigate], [data-open-url], [data-play-animation] { cursor: pointer; }");
  if (motion.rules.length > 0) {
    // Motion the reader did not ask for is motion that should not run. The
    // keyframes stay in the file so the same document still describes them.
    push("@media (prefers-reduced-motion: reduce) { [data-juno-animation] { animation: none !important; } }");
    for (const rule of motion.rules) push(rule);
  }
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
  push(`(function () {
  function play(token, reverse) {
    var targets = document.querySelectorAll('[data-juno-animation~="' + token + '"]');
    for (var t = 0; t < targets.length; t++) {
      var el = targets[t];
      // Clearing the name and reading a layout property forces the restart CSS
      // otherwise refuses: an animation that has already run to its end will not
      // run again just because its play-state was set to running.
      el.style.animationName = 'none';
      void el.offsetWidth;
      el.style.animationName = '';
      if (reverse) el.style.animationDirection = 'reverse';
      el.style.animationPlayState = 'running';
    }
  }

  function fire(target) {
    var token = target.getAttribute('data-play-animation');
    if (token) { play(token, target.hasAttribute('data-play-reverse')); return; }
    var url = target.getAttribute('data-open-url');
    if (url) { window.open(url, '_blank', 'noopener'); return; }
    var destination = target.getAttribute('data-navigate');
    if (!destination) return;
    var roots = document.querySelectorAll('.juno-root');
    for (var i = 0; i < roots.length; i++) {
      roots[i].hidden = roots[i].getAttribute('data-root') !== destination;
    }
  }

  var nodes = document.querySelectorAll('[data-navigate], [data-open-url], [data-play-animation]');
  for (var i = 0; i < nodes.length; i++) {
    (function (node) {
      var trigger = node.getAttribute('data-trigger') || 'click';
      if (trigger === 'hover') {
        node.addEventListener('mouseenter', function () { fire(node); });
      } else if (trigger === 'key') {
        var key = node.getAttribute('data-trigger-key');
        document.addEventListener('keydown', function (event) {
          if (key && event.key === key) fire(node);
        });
      } else if (trigger === 'delay') {
        var ms = parseInt(node.getAttribute('data-trigger-ms') || '0', 10);
        window.setTimeout(function () { fire(node); }, isNaN(ms) ? 0 : ms);
      } else if (trigger === 'scroll-into-view') {
        // No IntersectionObserver fallback on purpose: an environment without it
        // gets nothing rather than a link that fires at the wrong moment.
        if (typeof IntersectionObserver === 'function') {
          var seen = false;
          new IntersectionObserver(function (entries) {
            for (var e = 0; e < entries.length; e++) {
              if (entries[e].isIntersecting && !seen) { seen = true; fire(node); }
            }
          }).observe(node);
        }
      } else {
        node.addEventListener('click', function () { fire(node); });
      }
    })(nodes[i]);
  }
})();`);
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
    /**
     * The corner, as the one shape SwiftUI has for it.
     *
     * `RoundedRectangle` takes a single radius, so a per-corner tuple has to
     * collapse. `Math.max` keeps the largest corner rather than averaging,
     * because the radius is also what the clip and every shadow below are cast
     * from and a too-small silhouette clips artwork off — but a collapse is a
     * loss either way, so it is named instead of being taken silently, which is
     * what this line did for as long as the tuple has existed.
     */
    const corners = cornerValues(resolved.cornerRadius);
    const radius = Math.max(...corners);
    if (radius > 0 && corners.some((value) => value !== radius)) {
      unsupported.push(
        `${resolved.name}: SwiftUI's RoundedRectangle has one radius; corners ${corners.map((value) => round(value)).join("/")} were emitted as ${round(radius)}`
      );
    }
    /**
     * `.continuous` *is* the squircle. It is one fixed curve with no parameter —
     * roughly what this document model calls a smoothing of
     * `APPLE_CONTINUOUS_SMOOTHING` — and `.circular` is the arc. Two positions,
     * no dial, so a smoothing anywhere between them lands on the nearer one.
     *
     * `.continuous` used to be emitted unconditionally, which meant an unsmoothed
     * design — every design, until the field existed — was handed a file that drew
     * squircles where the artboard drew arcs, with only an `unsupported` line at
     * the end telling the reader to go and fix every one of them by hand. That was
     * the wrong repair: SwiftUI has the exact corner the document asked for, so the
     * fix is to emit it, not to file a chore. The chore note is gone with it,
     * because a caveat that describes a substitution the exporter no longer makes
     * is a second lie on top of the first.
     *
     * The midpoint (not `smoothing > 0`) picks the side: this is a nearest-of-two
     * snap, and a corner at 0.1 is visibly nearer the arc than the squircle, so
     * rounding it up to `.continuous` would overshoot the artboard by half the
     * scale. Whichever pole it snaps to, anything that is not already sitting on
     * that pole files a note naming the smoothing it actually asked for — the
     * `.circular` side of that is new, and without it a 20%-smoothed corner would
     * flatten to an arc as silently as it used to inflate to a squircle.
     */
    const smoothing = resolved.cornerSmoothing ?? 0;
    const cornerStyle = smoothing < APPLE_CONTINUOUS_SMOOTHING / 2 ? ".circular" : ".continuous";
    if (radius > 0) {
      if (cornerStyle === ".circular" && smoothing > 0) {
        unsupported.push(
          `${resolved.name}: corner smoothing ${Math.round(smoothing * 100)}% exported as .circular — SwiftUI's corner styles are not parameterised (its only smoothed corner is about ${Math.round(APPLE_CONTINUOUS_SMOOTHING * 100)}%)`
        );
      } else if (cornerStyle === ".continuous" && Math.abs(smoothing - APPLE_CONTINUOUS_SMOOTHING) > 0.15) {
        unsupported.push(
          `${resolved.name}: corner smoothing ${Math.round(smoothing * 100)}% exported as .continuous — SwiftUI's corner styles are not parameterised (its curve is about ${Math.round(APPLE_CONTINUOUS_SMOOTHING * 100)}%)`
        );
      }
      out.push(`${indent}    .clipShape(RoundedRectangle(cornerRadius: ${round(radius)}, style: ${cornerStyle}))`);
    }

    // Effects come after the clip so a shadow is cast by the rounded silhouette
    // rather than by the square frame behind it — and they are emitted in list
    // order, because SwiftUI modifiers compose in the order they are written and
    // that is the same claim the model's ordering makes.
    //
    // Same radius *and* same style as the clip above, from the same two variables:
    // the rim is stroked around the silhouette the layer is clipped to, and a rim
    // built from its own literal drifts from the clip the moment either changes —
    // which is exactly what a hard-coded `.continuous` here did once the clip
    // learned to say `.circular`.
    const swiftShape = radius > 0 ? `RoundedRectangle(cornerRadius: ${round(radius)}, style: ${cornerStyle})` : "Rectangle()";
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
 * Where SwiftUI's `.continuous` corner sits on the document's smoothing scale.
 *
 * `.continuous` is a single fixed curve with no knob, and it is the same corner
 * an iOS app icon is cut with — which is the corner a smoothing of about 0.6
 * draws here, because both scales stretch the corner's run along the edge by
 * `1 + s` and this one solves for the exponent that keeps the visual radius put.
 * Used for two different jobs and so named once: choosing between the two styles
 * SwiftUI has, and deciding whether the choice is close enough to go unremarked.
 */
const APPLE_CONTINUOUS_SMOOTHING = 0.6;

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
