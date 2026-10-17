/**
 * Colour-vision deficiency simulation and the shape-mask comparator (spec §9,
 * "Colour-vision deficiency": hand vs circle-x distinguishable by shape mask
 * under deuteranopia and protanopia).
 *
 * The matrices are Machado, Oliveira and Fernandes (2009) at severity 1.0,
 * the same ones the spec's contrast arithmetic used. They operate on linear
 * RGB, which is why the SVG filters set color-interpolation-filters=linearRGB
 * and `simulateCvd` linearises before multiplying.
 *
 * Two ways to apply them:
 * - `applyCvdFilter(page, kind)` filters the live page through an SVG
 *   feColorMatrix, for screenshots a person looks at;
 * - `simulateCvd(bitmap, kind)` applies the same matrix to a screenshot's
 *   pixels in Node, for comparisons that must be deterministic.
 *
 * `compareShapeMasks(a, b)` then decides whether two glyphs differ by shape
 * alone: status is never told apart by hue (spec §3.4).
 */

import type { Page } from "@playwright/test";
import type { Bitmap } from "./png";

export type CvdKind = "deuteranopia" | "protanopia" | "tritanopia";

/** Row-major 3×3 matrices on linear RGB (Machado 2009, severity 1.0). */
export const CVD_MATRICES: Record<CvdKind, readonly number[]> = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

/** The gate's two required filters. */
export const CVD_GATE_KINDS: readonly CvdKind[] = ["deuteranopia", "protanopia"];

export function cvdFilterId(kind: CvdKind): string {
  return `alevr-cvd-${kind}`;
}

/** The SVG holding every filter, ready to inject into a page. */
export function cvdFilterSvg(): string {
  const filters = (Object.keys(CVD_MATRICES) as CvdKind[])
    .map((kind) => {
      const m = CVD_MATRICES[kind];
      const values = [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0].join(" ");
      return `<filter id="${cvdFilterId(kind)}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${values}"/></filter>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute;width:0;height:0;overflow:hidden" data-alevr-cvd="">${filters}</svg>`;
}

/**
 * Filters the page through a CVD simulation until `clearCvdFilter`. The
 * filter goes on <body> rather than <html> so it does not disturb the root's
 * fixed-position containing block more than it must.
 */
export async function applyCvdFilter(page: Page, kind: CvdKind): Promise<void> {
  await page.evaluate(
    ({ svg, id }) => {
      if (!document.querySelector("svg[data-alevr-cvd]")) document.body.insertAdjacentHTML("afterbegin", svg);
      document.body.style.filter = `url(#${id})`;
    },
    { svg: cvdFilterSvg(), id: cvdFilterId(kind) }
  );
}

export async function clearCvdFilter(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.body.style.filter = "";
    document.querySelector("svg[data-alevr-cvd]")?.remove();
  });
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toSrgb(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** One sRGB colour through the simulation. */
export function simulateColor(rgb: readonly [number, number, number], kind: CvdKind): [number, number, number] {
  const m = CVD_MATRICES[kind];
  const [r, g, b] = rgb.map(toLinear);
  return [toSrgb(m[0] * r + m[1] * g + m[2] * b), toSrgb(m[3] * r + m[4] * g + m[5] * b), toSrgb(m[6] * r + m[7] * g + m[8] * b)];
}

/** A screenshot's pixels through the simulation (alpha unchanged). */
export function simulateCvd(bitmap: Bitmap, kind: CvdKind): Bitmap {
  const data = new Uint8Array(bitmap.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = simulateColor([bitmap.data[i], bitmap.data[i + 1], bitmap.data[i + 2]], kind);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = bitmap.data[i + 3];
  }
  return { width: bitmap.width, height: bitmap.height, data };
}

export interface ShapeMask {
  width: number;
  height: number;
  bits: Uint8Array;
  count: number;
}

function pixelAt(bitmap: Bitmap, x: number, y: number): [number, number, number, number] {
  const o = (y * bitmap.width + x) * 4;
  return [bitmap.data[o], bitmap.data[o + 1], bitmap.data[o + 2], bitmap.data[o + 3]];
}

/** The background: the most common of the four corner pixels. */
export function backgroundOf(bitmap: Bitmap): [number, number, number, number] {
  const corners = [
    pixelAt(bitmap, 0, 0),
    pixelAt(bitmap, bitmap.width - 1, 0),
    pixelAt(bitmap, 0, bitmap.height - 1),
    pixelAt(bitmap, bitmap.width - 1, bitmap.height - 1),
  ];
  let best = corners[0];
  let bestCount = 0;
  for (const c of corners) {
    const count = corners.filter((d) => d.every((v, i) => Math.abs(v - c[i]) <= 4)).length;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

/** Pixels that differ from the background by more than `threshold` (Euclidean RGBA). */
export function shapeMask(bitmap: Bitmap, threshold = 48): ShapeMask {
  const bg = backgroundOf(bitmap);
  const bits = new Uint8Array(bitmap.width * bitmap.height);
  let count = 0;
  for (let i = 0; i < bits.length; i += 1) {
    const o = i * 4;
    const d = Math.hypot(bitmap.data[o] - bg[0], bitmap.data[o + 1] - bg[1], bitmap.data[o + 2] - bg[2], bitmap.data[o + 3] - bg[3]);
    if (d > threshold) {
      bits[i] = 1;
      count += 1;
    }
  }
  return { width: bitmap.width, height: bitmap.height, bits, count };
}

/** Crops a mask to its ink and resamples it onto a size×size grid. */
export function normalizeMask(mask: ShapeMask, size = 32): ShapeMask {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.bits[y * mask.width + x]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const bits = new Uint8Array(size * size);
  if (maxX < 0) return { width: size, height: size, bits, count: 0 };
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  // Keep the aspect ratio: fit the longer side, centre the shorter.
  const scale = Math.max(w, h) / size;
  const offsetX = (size - w / scale) / 2;
  const offsetY = (size - h / scale) / 2;
  let count = 0;
  for (let gy = 0; gy < size; gy += 1) {
    for (let gx = 0; gx < size; gx += 1) {
      const sx = Math.floor((gx - offsetX + 0.5) * scale) + minX;
      const sy = Math.floor((gy - offsetY + 0.5) * scale) + minY;
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      if (mask.bits[sy * mask.width + sx]) {
        bits[gy * size + gx] = 1;
        count += 1;
      }
    }
  }
  return { width: size, height: size, bits, count };
}

export function intersectionOverUnion(a: ShapeMask, b: ShapeMask): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error("Masks must share a size; normalise them first.");
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.bits.length; i += 1) {
    if (a.bits[i] && b.bits[i]) intersection += 1;
    if (a.bits[i] || b.bits[i]) union += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function meanInk(bitmap: Bitmap, mask: ShapeMask): [number, number, number] | null {
  if (mask.count === 0) return null;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < mask.bits.length; i += 1) {
    if (!mask.bits[i]) continue;
    r += bitmap.data[i * 4];
    g += bitmap.data[i * 4 + 1];
    b += bitmap.data[i * 4 + 2];
  }
  return [r / mask.count, g / mask.count, b / mask.count];
}

export interface ShapeComparison {
  /** Overlap of the two normalised masks: 1 is the same shape. */
  iou: number;
  distinguishable: boolean;
  inkA: number;
  inkB: number;
  /** Euclidean RGB distance between the two glyphs' mean ink, for the report. Shape decides the gate, not this. */
  inkDistance: number | null;
  detail: string;
}

/**
 * Whether two glyph captures differ by shape. Both must have ink, and their
 * normalised masks must overlap by less than `maxIou`.
 */
export function compareShapeMasks(a: Bitmap, b: Bitmap, options: { threshold?: number; maxIou?: number; grid?: number } = {}): ShapeComparison {
  const threshold = options.threshold ?? 48;
  const maxIou = options.maxIou ?? 0.8;
  const grid = options.grid ?? 32;
  const maskA = shapeMask(a, threshold);
  const maskB = shapeMask(b, threshold);
  const iou = intersectionOverUnion(normalizeMask(maskA, grid), normalizeMask(maskB, grid));
  const inkA = meanInk(a, maskA);
  const inkB = meanInk(b, maskB);
  const inkDistance = inkA && inkB ? Math.hypot(inkA[0] - inkB[0], inkA[1] - inkB[1], inkA[2] - inkB[2]) : null;
  const hasInk = maskA.count > 0 && maskB.count > 0;
  const distinguishable = hasInk && iou < maxIou;
  const detail = !hasInk
    ? `a glyph rendered no ink (${maskA.count} and ${maskB.count} pixels)`
    : `shape overlap ${iou.toFixed(3)} (must be < ${maxIou})${inkDistance === null ? "" : `, ink distance ${inkDistance.toFixed(1)}`}`;
  return { iou, distinguishable, inkA: maskA.count, inkB: maskB.count, inkDistance, detail };
}
