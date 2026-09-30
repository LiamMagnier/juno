/**
 * The crew palette and the colour maths behind it (pure, no DOM).
 *
 * Sixteen body colours, chosen as a set: characterful enough to tell twelve
 * members apart across a room, refined enough to sit on Juno's bright neutral
 * ground and its layered charcoal without shouting. Every hue is a little
 * greyed from its pure form (plush fibres add their own sheen, which reads
 * brighter than the albedo), and the set spans warm, cool and neutral so a
 * crew never looks like one brand's swatch card.
 *
 * A person can also pick any colour (a custom hex). Everything downstream,
 * the fur, the eye colour, the thread theme, is derived from the hex, so a
 * custom colour is as complete as a curated one.
 */

export const PALETTE = {
  marigold: { label: "Marigold", hex: "#efb23f" },
  apricot: { label: "Apricot", hex: "#f09f72" },
  coral: { label: "Coral", hex: "#e4715e" },
  raspberry: { label: "Raspberry", hex: "#c9486b" },
  blossom: { label: "Blossom", hex: "#eeb0c2" },
  lilac: { label: "Lilac", hex: "#b7a5e3" },
  iris: { label: "Iris", hex: "#6c71d8" },
  cobalt: { label: "Cobalt", hex: "#3d69cf" },
  sky: { label: "Sky", hex: "#93c4e6" },
  lagoon: { label: "Lagoon", hex: "#2e968d" },
  mint: { label: "Mint", hex: "#a6d9c1" },
  moss: { label: "Moss", hex: "#84a456" },
  oat: { label: "Oat", hex: "#e4d7c1" },
  cocoa: { label: "Cocoa", hex: "#8a5d47" },
  graphite: { label: "Graphite", hex: "#3e4045" },
  cloud: { label: "Cloud", hex: "#efefec" },
} as const;

export type PaletteId = keyof typeof PALETTE;
export const PALETTE_IDS = Object.keys(PALETTE) as PaletteId[];

/** A body colour: a palette id, or a custom `#rrggbb`. */
export type ColorValue = PaletteId | `#${string}`;

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === "string" && v in PALETTE;
}
export function isHex(v: unknown): v is `#${string}` {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}
export function isColorValue(v: unknown): v is ColorValue {
  return isPaletteId(v) || isHex(v);
}
export function colorHex(c: ColorValue): string {
  return isPaletteId(c) ? PALETTE[c].hex : c.toLowerCase();
}
export function colorLabel(c: ColorValue): string {
  return isPaletteId(c) ? PALETTE[c].label : "Custom colour";
}

/* ——————————————————————————— Colour maths ——————————————————————————— */

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]: RGB): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

const toLin = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};
const fromLin = (l: number) => 255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(Math.max(0, l), 1 / 2.4) - 0.055);

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
}
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* OKLab / OKLCH, for moving lightness and chroma without shifting hue. */
export interface LCH {
  l: number;
  c: number;
  h: number;
}
export function hexToOklch(hex: string): LCH {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = toLin(r8);
  const g = toLin(g8);
  const b = toLin(b8);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: (Math.atan2(B, A) * 180) / Math.PI };
}
export function oklchToHex({ l, c, h }: LCH): string {
  // Reduce chroma until the colour is inside sRGB (keeps hue and lightness honest).
  let cc = c;
  for (let i = 0; i < 24; i++) {
    const rgb = oklchToLinear(l, cc, h);
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return rgbToHex(rgb.map(fromLin) as RGB);
    cc *= 0.92;
  }
  return rgbToHex(oklchToLinear(l, 0, h).map(fromLin) as RGB);
}
function oklchToLinear(L: number, C: number, H: number): [number, number, number] {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** A version of the colour at a given OKLCH lightness, chroma scaled by `k`. */
export function atLightness(hex: string, l: number, k = 1): string {
  const c = hexToOklch(hex);
  return oklchToHex({ l, c: c.c * k, h: c.h });
}

/* ——————————————————————————— Derived colours ——————————————————————————— */

/** The colour a character's features are sewn in: near-black, faintly warm or cool with the body. */
export function featureInk(bodyHex: string): string {
  const c = hexToOklch(bodyHex);
  return oklchToHex({ l: 0.2, c: Math.min(0.02, c.c * 0.15), h: c.h });
}

/** A contrasting accent for accessories when the person has not chosen one: the body's complement, calmed. */
export function complement(bodyHex: string): string {
  const c = hexToOklch(bodyHex);
  if (c.c < 0.03) return c.l > 0.6 ? "#3e4045" : "#e9e3d6";
  return oklchToHex({ l: c.l > 0.7 ? 0.42 : 0.78, c: Math.min(0.11, c.c * 0.8), h: (c.h + 180) % 360 });
}

/** A second colour that sits with the body for two-tone and patterns: a light cream for most, deeper for pale bodies. */
export function patternPartner(bodyHex: string): string {
  const c = hexToOklch(bodyHex);
  if (c.l > 0.86) return oklchToHex({ l: 0.62, c: Math.max(0.06, c.c * 1.6), h: c.h });
  return oklchToHex({ l: 0.95, c: 0.018, h: c.h });
}

/** The blush a character wears on its cheeks: a warm pink pulled a little toward the body. */
export function blush(bodyHex: string): string {
  const c = hexToOklch(bodyHex);
  const target = { l: Math.min(0.8, Math.max(0.68, c.l)), c: 0.1, h: 12 };
  return oklchToHex({ l: target.l, c: target.c, h: c.c > 0.05 ? target.h + Math.sin(((c.h - 12) * Math.PI) / 180) * 8 : target.h });
}
