/**
 * Contrast reader (spec §3.1, §9, P0 (4)): WCAG 2.x relative luminance and
 * contrast ratio, plus a page helper that reads an element's computed text
 * colour against the background it actually sits on.
 *
 * The background is found by walking up from the element and compositing
 * every translucent background over the next opaque one, so text on a
 * `hsl(... / 0.6)` wash is measured against what a reader sees. Background
 * images and gradients are reported, not guessed at.
 */

import type { Locator } from "@playwright/test";

export type Rgba = [number, number, number, number];

/** Parses the colour forms getComputedStyle returns: rgb(), rgba(), color(srgb …), #hex, transparent. */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return [parseFloat(rgb[1]), parseFloat(rgb[2]), parseFloat(rgb[3]), alpha];
  }
  const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (srgb) {
    const alpha = srgb[4] === undefined ? 1 : srgb[4].endsWith("%") ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
    return [parseFloat(srgb[1]) * 255, parseFloat(srgb[2]) * 255, parseFloat(srgb[3]) * 255, alpha];
  }
  return null;
}

/** `top` over `bottom` (bottom treated as opaque). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

export function relativeLuminance([r, g, b]: Rgba | [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgba | [number, number, number], b: Rgba | [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The §3.1 text rule: 4.5:1, or 3:1 at 24px regular or 18.66px bold. */
export function requiredTextContrast(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
  return large ? 3 : 4.5;
}

export interface ContrastReading {
  foreground: Rgba;
  background: Rgba;
  ratio: number;
  required: number;
  pass: boolean;
  fontSizePx: number;
  fontWeight: number;
  /** True when a background image or gradient sat under the text and was ignored. */
  backgroundImage: boolean;
}

/** Reads the contrast of an element's text against its effective background. */
export async function readContrast(locator: Locator): Promise<ContrastReading> {
  const raw = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    const layers: string[] = [];
    let image = false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.backgroundImage && s.backgroundImage !== "none") image = true;
      layers.push(s.backgroundColor);
    }
    const root = getComputedStyle(document.documentElement).backgroundColor;
    return {
      color: style.color,
      layers,
      root,
      fontSize: parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight) || 400,
      image,
    };
  });
  let background: Rgba = [255, 255, 255, 1];
  const rootColor = parseCssColor(raw.root);
  if (rootColor && rootColor[3] > 0) background = composite(rootColor, background);
  for (const layer of [...raw.layers].reverse()) {
    const c = parseCssColor(layer);
    if (c && c[3] > 0) background = composite(c, background);
  }
  const fg = parseCssColor(raw.color) ?? [0, 0, 0, 1];
  const foreground = fg[3] < 1 ? composite(fg, background) : fg;
  const ratio = contrastRatio(foreground, background);
  const required = requiredTextContrast(raw.fontSize, raw.fontWeight);
  return {
    foreground,
    background,
    ratio,
    required,
    pass: ratio >= required,
    fontSizePx: raw.fontSize,
    fontWeight: raw.fontWeight,
    backgroundImage: raw.image,
  };
}
