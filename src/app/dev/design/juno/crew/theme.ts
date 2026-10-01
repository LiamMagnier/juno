/**
 * A member's thread theme (D-032): the character's colour carried into its
 * own thread as the person's bubbles, the armed send disc, the selection and
 * focus ring and the state word under the peek. Pure (no DOM), derived from
 * any body colour (curated or custom) with measured contrast:
 *
 *   bubble text   4.5:1 or better on the bubble, both themes
 *   send glyph    4.5:1 on the disc; the disc itself 3:1 against the ground
 *   accent text   4.5:1 on the thread's ground (the state word, links)
 *
 * Light: a calm mid-tone of the body's hue carrying white text; pale bodies
 * (blossom, mint, oat, cloud...) keep their honest lightness as a tinted
 * bubble with dark text, and their disc deepens so it still reads as a
 * control. Dark: the same hue, deeper and quieter for the bubble (a thread
 * never glows), lifted for the disc, which then carries a dark glyph, the way
 * the ink disc turns light in dark. Never a gradient.
 */

import { colorHex, contrast, hexToOklch, oklchToHex, type ColorValue } from "./palette";
import type { AvatarConfig } from "./avatar2";

export interface ThreadTheme {
  bubble: string;
  onBubble: string;
  disc: string;
  onDisc: string;
  discHover: string;
  discPress: string;
  /** Selection and quiet fills. */
  soft: string;
  /** The focus ring. */
  ring: string;
  /** Accent text on the ground: the peek's state word, inline links. */
  ink: string;
}

export interface CrewTheme {
  light: ThreadTheme;
  dark: ThreadTheme;
  /** CSS custom properties with `light-dark()` values, for the thread's root element. */
  style: Record<string, string>;
  /** Whether light bubbles carry dark text (a pale body). */
  pale: boolean;
}

/** Juno's grounds (tokens.css): the thread sits on --ground. */
const GROUND = { light: "#fcfcfd", dark: "#18191b" } as const;
const WHITE = "#ffffff";

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}

/** The lightest (or darkest) version of a hue/chroma that meets a contrast target against `other`. */
function fit(h: number, c: number, startL: number, step: number, other: string, target: number): string {
  let l = startL;
  for (let i = 0; i < 80; i++) {
    const hex = oklchToHex({ l, c, h });
    if (contrast(hex, other) >= target) return hex;
    l += step;
    if (l < 0.05 || l > 0.98) break;
  }
  return oklchToHex({ l: Math.max(0.05, Math.min(0.98, l)), c, h });
}

const shift = (hex: string, dl: number) => {
  const o = hexToOklch(hex);
  return oklchToHex({ l: Math.max(0, Math.min(1, o.l + dl)), c: o.c, h: o.h });
};

/** The thread theme for a body colour. */
export function themeForColor(color: ColorValue | string): CrewTheme {
  const hex = color.startsWith("#") ? color.toLowerCase() : colorHex(color as ColorValue);
  const o = hexToOklch(hex);
  const neutral = o.c < 0.02;
  const h = neutral ? 250 : o.h;
  const c = neutral ? Math.min(o.c, 0.012) : Math.min(o.c, 0.13);
  const pale = o.l > 0.8;

  /* Light. */
  let light: ThreadTheme;
  {
    const disc = fit(h, c, Math.min(0.6, o.l), -0.01, WHITE, 4.6);
    const bubble = pale ? oklchToHex({ l: Math.min(0.93, Math.max(0.86, o.l)), c: c * 0.75, h }) : disc;
    const onBubble = pale ? fit(h, Math.min(c, 0.06), 0.32, -0.02, bubble, 7) : WHITE;
    light = {
      bubble,
      onBubble,
      disc,
      onDisc: WHITE,
      discHover: shift(disc, -0.04),
      discPress: shift(disc, -0.075),
      soft: rgba(disc, 0.13),
      ring: rgba(disc, 0.42),
      ink: fit(h, c, Math.min(0.55, o.l), -0.01, GROUND.light, 4.6),
    };
  }

  /* Dark. */
  let dark: ThreadTheme;
  {
    const bubble = oklchToHex({ l: neutral ? 0.36 : 0.4, c: c * 0.62, h });
    const onBubble = fit(h, Math.min(c * 0.15, 0.02), 0.94, 0.01, bubble, 4.8);
    const disc = fit(h, c * 0.72, 0.74, 0.01, "#121314", 6);
    const onDisc = fit(h, Math.min(c, 0.05), 0.22, -0.02, disc, 4.8);
    dark = {
      bubble,
      onBubble,
      disc,
      onDisc,
      discHover: shift(disc, 0.04),
      discPress: shift(disc, -0.05),
      soft: rgba(disc, 0.2),
      ring: rgba(disc, 0.5),
      ink: fit(h, c * 0.8, 0.72, 0.01, GROUND.dark, 4.8),
    };
  }

  const ld = (k: keyof ThreadTheme) => `light-dark(${light[k]}, ${dark[k]})`;
  return {
    light,
    dark,
    pale,
    style: {
      "--m-bubble": ld("bubble"),
      "--m-on-bubble": ld("onBubble"),
      "--m-disc": ld("disc"),
      "--m-on-disc": ld("onDisc"),
      "--m-disc-hover": ld("discHover"),
      "--m-disc-press": ld("discPress"),
      "--m-soft": ld("soft"),
      "--m-ring": ld("ring"),
      "--m-ink": ld("ink"),
    },
  };
}

/** The thread theme for a member's look. */
export function getCrewTheme(cfg: Pick<AvatarConfig, "color">): CrewTheme {
  return themeForColor(cfg.color);
}

/** Measured contrast for a theme (the gallery prints it; tests assert it). */
export function themeContrast(t: CrewTheme) {
  const m = (a: string, b: string) => Math.round(contrast(a, b) * 100) / 100;
  return {
    light: { bubbleText: m(t.light.bubble, t.light.onBubble), discGlyph: m(t.light.disc, t.light.onDisc), discEdge: m(t.light.disc, GROUND.light), ink: m(t.light.ink, GROUND.light) },
    dark: { bubbleText: m(t.dark.bubble, t.dark.onBubble), discGlyph: m(t.dark.disc, t.dark.onDisc), discEdge: m(t.dark.disc, GROUND.dark), ink: m(t.dark.ink, GROUND.dark) },
  };
}
