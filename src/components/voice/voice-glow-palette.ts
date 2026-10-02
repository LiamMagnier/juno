/**
 * THE VOICE LIGHT'S PALETTE: two voices and an off state, per theme.
 *
 * The CSS tokens in globals.css (`.voice-glow { --voice-glow-* }`) are the
 * source of truth; the renderer reads them off the glow's own element, so a
 * `.dark` subtree (the lab draws both themes on one page) resolves its own
 * values. These constants are the fallback for a browser that cannot resolve
 * them, and the numbers the tests and RATIONALE.md check contrast against.
 *
 * - ALEVR is presence ink, the brand's one live colour: #2d49c9 on ivory,
 *   #97a6e6 on charcoal (BRAND_IDENTITY.md). The assistant's light is the
 *   same ink the composer's focus and live work already use, so no new hue
 *   enters the shell for it.
 * - YOU is ember, a burnt orange chosen opposite presence. OKLCH hue 50 sits
 *   between danger (29, a red) and attention (64, an amber kept to text), so
 *   it reads as neither an error nor a request; blue and orange are the pair
 *   the common colour-vision deficiencies still tell apart; and the light
 *   ember is matched to presence in OKLCH chroma (0.15 vs 0.20) and kept at
 *   4.5:1 on the ground, so the two voices weigh the same. Never pink: the
 *   stock palette's rose and the old "dawn" both read as candy on ivory.
 * - MUTED is the decorative graphite ink, held still.
 *
 * `line` paints the composer's 1px edge, `glow` the soft light outside it,
 * `hot` the core of the lit edge at a peak on charcoal (light only gets
 * brighter on a dark ground; on ivory a peak is deeper, never whiter).
 *
 * The glow is lighter and more chromatic than the line, on purpose. Any
 * colour laid over ivory darkens it, and a dark tint around an object reads
 * as its shadow; a high-lightness, high-chroma tint (OKLCH L 0.64-0.75)
 * reads as coloured light instead. On charcoal the falloff's tail is where an
 * orange turns brown, so the dark ember glow leans yellower (hue 60) and the
 * falloff stays short.
 */

export type GlowTheme = "light" | "dark";

export interface GlowVoiceColors {
  line: string;
  glow: string;
  hot: string;
}

export interface GlowPalette {
  you: GlowVoiceColors;
  alevr: GlowVoiceColors;
  muted: string;
}

export const GLOW_PALETTE: Record<GlowTheme, GlowPalette> = {
  light: {
    // oklch(0.575 0.150 50): 4.51:1 on #fcfcfd.
    you: { line: "#bc5806", glow: "#f69147", hot: "#bc5806" },
    // Presence ink: 7.04:1 on #fcfcfd.
    alevr: { line: "#2d49c9", glow: "#6782f2", hot: "#2d49c9" },
    muted: "#9a9ca0",
  },
  dark: {
    // oklch(0.781 0.120 54): 8.54:1 on #18191b.
    you: { line: "#f3a26b", glow: "#fba962", hot: "#fdcfa6" },
    // Presence ink: 7.47:1 on #18191b.
    alevr: { line: "#97a6e6", glow: "#90a6f7", hot: "#ced7fb" },
    // Decorative ink lifted one step: #6c6e72 vanishes into a 22% border.
    muted: "#84868a",
  },
};

/** The CSS custom properties the renderer reads, in the order it uploads them. */
export const GLOW_TOKENS = {
  youLine: "--voice-glow-you",
  youGlow: "--voice-glow-you-light",
  youHot: "--voice-glow-you-core",
  alevrLine: "--voice-glow-alevr",
  alevrGlow: "--voice-glow-alevr-light",
  alevrHot: "--voice-glow-alevr-core",
  muted: "--voice-glow-muted",
  dark: "--voice-glow-dark",
} as const;

export type Rgb = [number, number, number];

/** `#rgb` / `#rrggbb` to linear-free sRGB 0..1, or null. */
export function parseHex(value: string): Rgb | null {
  const v = value.trim();
  const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v);
  if (m3) return [m3[1], m3[2], m3[3]].map((h) => parseInt(h + h, 16) / 255) as Rgb;
  const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  if (m6) return [m6[1], m6[2], m6[3]].map((h) => parseInt(h, 16) / 255) as Rgb;
  return null;
}

export interface ResolvedGlowPalette {
  dark: boolean;
  you: { line: Rgb; glow: Rgb; hot: Rgb };
  alevr: { line: Rgb; glow: Rgb; hot: Rgb };
  muted: Rgb;
}

function rgb(value: string | undefined, fallback: string): Rgb {
  return (value && parseHex(value)) || (parseHex(fallback) as Rgb);
}

/**
 * The palette as the element sees it. `read` is `getComputedStyle(el)
 * .getPropertyValue` in the browser; anything it cannot resolve falls back to
 * the constants above for the theme the tokens say (or `fallbackTheme`).
 */
export function resolveGlowPalette(read: (token: string) => string, fallbackTheme: GlowTheme = "light"): ResolvedGlowPalette {
  const flag = read(GLOW_TOKENS.dark).trim();
  const dark = flag === "" ? fallbackTheme === "dark" : flag === "1";
  const base = GLOW_PALETTE[dark ? "dark" : "light"];
  return {
    dark,
    you: {
      line: rgb(read(GLOW_TOKENS.youLine), base.you.line),
      glow: rgb(read(GLOW_TOKENS.youGlow), base.you.glow),
      hot: rgb(read(GLOW_TOKENS.youHot), base.you.hot),
    },
    alevr: {
      line: rgb(read(GLOW_TOKENS.alevrLine), base.alevr.line),
      glow: rgb(read(GLOW_TOKENS.alevrGlow), base.alevr.glow),
      hot: rgb(read(GLOW_TOKENS.alevrHot), base.alevr.hot),
    },
    muted: rgb(read(GLOW_TOKENS.muted), base.muted),
  };
}

/* ———————————————————— contrast, for the tests and the rationale ———————————————————— */

function channel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = (parseHex(hex) as Rgb).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
