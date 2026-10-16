/**
 * Project the web's design tokens onto every other client.
 *
 * `src/app/globals.css` is the source of truth for colour, motion and the
 * shell and gesture constants, and `tailwind.config.ts` for the radius, type
 * and spacing ladders. Both are hand-authored, both are heavily commented,
 * and neither is going to be generated from something else — the comments
 * beside those values are the most useful documentation in the repository and
 * a generator would flatten them.
 *
 * What was NOT true is that anything kept the other clients honest.
 * `JunoDesignTokens.swift` opens by saying its values are "converted from the
 * web's own custom properties in src/app/globals.css so the two platforms
 * cannot drift" — but the conversion was done by hand, once, and nothing had
 * re-checked it since. That comment described an intention, not a mechanism.
 *
 * This is the mechanism. It parses the CSS, redoes the HSL -> sRGB conversion
 * exactly, follows `var()` aliases (the status roles, the washes), reads the
 * high-contrast block as a third and fourth appearance, and emits the Swift and
 * TypeScript projections. It also WRITES one thing back into globals.css: the
 * CSS twin of every spring (`--spring-<name>` as a linear() easing and its
 * settle time `--spring-<name>-dur`), computed from the one place each spring
 * is defined (`--spring-<name>-params: <visualDuration> <bounce>`), so the CSS
 * curve and the framer / SwiftUI spring are one definition.
 *
 * `--check` re-derives all of it and exits non-zero on any difference, so drift
 * fails CI instead of failing on a user's Mac.
 *
 *   npx tsx scripts/generate-design-tokens.ts           # write
 *   npx tsx scripts/generate-design-tokens.ts --check   # verify, exit 1 on drift
 *
 * The parsing and colour maths are exported for scripts/check-contrast-matrix.ts
 * and the tests; importing this module does not run the generator.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import defaultTheme from "tailwindcss/defaultTheme";

import { ACCENTS as ACCENT_LIST, ACCENT_IDS } from "../src/lib/accents";
import tailwindConfig from "../tailwind.config";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `54 18% 97%` or `48 12% 18% / 0.06`. */
const HSL = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?$/;
/** `var(--presence)` or `var(--presence) / 0.10`. */
const VAR_COLOR = /^var\(--([\w-]+)\)(?:\s*\/\s*([\d.]+))?$/;
const DURATION = /^([\d.]+)ms$/;
const CUBIC = /^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/;

export type Block = {
  selector: string;
  /** The conditional at-rules around the block, outermost first ("" when unconditional). */
  condition: string;
  decls: Map<string, string>;
};

/**
 * `@layer` is transparent — it groups without changing when a rule applies, so
 * a `:root` inside it is the same `:root`. Every other at-rule is CONDITIONAL,
 * and a `:root` inside one is a different set of values that only sometimes
 * applies.
 *
 * This distinction is the whole reason this is a real parser and not a regex.
 * globals.css declares `--ease-out-strong`, `--ease-out-expo` and `--dur-slow`
 * a second time inside `@media (prefers-reduced-motion: reduce)`, flattening
 * them onto softer curves. A flat scan merges those over the base values and
 * silently drops all three from the output — which is exactly the kind of
 * quiet, plausible-looking wrongness a generator exists to prevent. The
 * condition is kept on each block, so the one conditional set the projection
 * DOES read — high contrast — is read on purpose and nothing else leaks in.
 */
const TRANSPARENT_AT_RULE = /^@layer\b/;

/** The high-contrast appearance's block condition (globals.css, `@layer base`). */
export const HIGH_CONTRAST_CONDITION = "@media (prefers-contrast: more)";

/** Walk brace depth, tracking the at-rule chain each block sits inside. */
export function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const stack: string[] = [];
  let buffer = "";

  const flushDecls = () => {
    const prelude = stack[stack.length - 1];
    if (prelude === undefined || prelude.startsWith("@")) return;
    const condition = stack
      .slice(0, -1)
      .filter((p) => p.startsWith("@") && !TRANSPARENT_AT_RULE.test(p))
      .join(" ");

    const decls = new Map<string, string>();
    for (const raw of buffer.split(";")) {
      const i = raw.indexOf(":");
      if (i === -1) continue;
      const name = raw.slice(0, i).trim();
      if (!name.startsWith("--")) continue;
      decls.set(name.slice(2), raw.slice(i + 1).trim());
    }
    if (decls.size) blocks.push({ selector: prelude, condition, decls });
  };

  for (const ch of stripped) {
    if (ch === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (ch === "}") {
      flushDecls();
      stack.pop();
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

/** Every declaration of `selector` under exactly `condition`, later blocks winning. */
export function declsFor(blocks: Block[], selector: string, condition = ""): Map<string, string> {
  const merged = new Map<string, string>();
  for (const b of blocks) {
    if (b.selector !== selector || b.condition !== condition) continue;
    for (const [k, v] of b.decls) merged.set(k, v);
  }
  return merged;
}

export type Appearance = "light" | "dark" | "hcLight" | "hcDark";
export const APPEARANCES: readonly Appearance[] = ["light", "dark", "hcLight", "hcDark"];

/**
 * The declarations in force on <html> in each appearance, in cascade order.
 *
 * High contrast in dark mode is `.dark`, then the high-contrast `:root`
 * block (which also matches <html> in dark mode), then the high-contrast
 * `.dark` block — the order globals.css declares them in, at equal
 * specificity, so the last one wins.
 */
export function appearanceTables(blocks: Block[]): Record<Appearance, Map<string, string>> {
  const root = declsFor(blocks, ":root");
  const dark = declsFor(blocks, ".dark");
  const hcRoot = declsFor(blocks, ":root", HIGH_CONTRAST_CONDITION);
  const hcDark = declsFor(blocks, ".dark", HIGH_CONTRAST_CONDITION);
  const merge = (...maps: Map<string, string>[]) => {
    const out = new Map<string, string>();
    for (const m of maps) for (const [k, v] of m) out.set(k, v);
    return out;
  };
  return {
    light: root,
    dark: merge(root, dark),
    hcLight: merge(root, hcRoot),
    hcDark: merge(root, dark, hcRoot, hcDark),
  };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

/** CSS Color Level 3 HSL -> sRGB. Same maths the browser runs. */
export function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = L - c / 2;
  const round = (v: number) => Math.round((v + m) * 1e4) / 1e4;
  return { r: round(r1), g: round(g1), b: round(b1), a };
}

export function asColor(value: string): Rgba | null {
  const m = HSL.exec(value);
  if (!m) return null;
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
}

/**
 * The colour `--name` resolves to in `table`, following `var()` aliases the
 * way the browser substitutes them. `var(--x) / 0.10` is the alias at that
 * alpha (the washes). Null when the token is not a colour.
 */
export function resolveColor(table: Map<string, string>, name: string, seen: Set<string> = new Set()): Rgba | null {
  const raw = table.get(name);
  if (raw === undefined || seen.has(name)) return null;
  const direct = asColor(raw);
  if (direct) return direct;
  const alias = VAR_COLOR.exec(raw);
  if (!alias) return null;
  seen.add(name);
  const base = resolveColor(table, alias[1], seen);
  if (!base) return null;
  return alias[2] === undefined ? base : { ...base, a: Number(alias[2]) };
}

/** `#rrggbb`, sRGB, alpha ignored. */
export const hex = (c: Rgba) =>
  `#${[c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

/** Paint `top` (possibly translucent) over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG 2.x relative luminance of an sRGB colour (alpha ignored). */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.x contrast ratio, 1..21. A translucent foreground is composited over the ground first. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const top = fg.a < 1 ? composite(fg, bg) : fg;
  const a = relativeLuminance(top);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// ---------------------------------------------------------------------------
// Springs
// ---------------------------------------------------------------------------

/**
 * framer's `{ visualDuration, bounce }` spring (motion-dom `getSpringOptions`):
 * ω₀ = 2π / (1.2 · visualDuration), ζ = clamp(0.05, 1, 1 − bounce), mass 1,
 * from rest at 0 to 1. Returns position at `t` seconds.
 */
export function springPosition(visualDuration: number, bounce: number): (t: number) => number {
  const w = (2 * Math.PI) / (visualDuration * 1.2);
  const z = Math.min(1, Math.max(0.05, 1 - bounce));
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    const A = (z * w) / wd;
    return (t) => 1 - Math.exp(-z * w * t) * (A * Math.sin(wd * t) + Math.cos(wd * t));
  }
  return (t) => 1 - Math.exp(-w * t) * (1 + w * t);
}

/**
 * The spring's rest: framer stops a 0→1 spring once it stays within 0.005 of
 * its target (`restDelta.granular`). The settle time is the last moment it is
 * further than that, to the millisecond.
 */
export const SPRING_REST_DELTA = 0.005;

export type SpringTwin = { settleMs: number; points: number[]; linear: string };

/**
 * A spring as a CSS `linear()` easing over its settle time. Evenly spaced
 * samples, as few as keep the piecewise-linear curve within 0.002 of the
 * spring everywhere; the last point is the rest value, 1.
 */
export function springTwin(visualDuration: number, bounce: number): SpringTwin {
  const x = springPosition(visualDuration, bounce);
  let last = 0;
  for (let ms = 0; ms <= 5000; ms += 0.5) if (Math.abs(1 - x(ms / 1000)) > SPRING_REST_DELTA) last = ms;
  const settleMs = Math.ceil(last);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  for (const n of [16, 24, 32, 48, 64, 96]) {
    const points = Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : round(x(((i / n) * settleMs) / 1000))));
    // Within 0.002 of the spring everywhere, except the last segment, which
    // lands on the rest value (1) where the spring itself is still up to
    // SPRING_REST_DELTA short of it.
    let fits = true;
    for (let ms = 0; ms <= settleMs; ms += 1) {
      const p = (ms / settleMs) * n;
      const i = Math.min(n - 1, Math.floor(p));
      const interpolated = points[i] + (points[i + 1] - points[i]) * (p - i);
      const tolerance = i === n - 1 ? SPRING_REST_DELTA + 0.002 : 0.002;
      if (Math.abs(interpolated - x(ms / 1000)) > tolerance) fits = false;
    }
    if (fits || n === 96) {
      return { settleMs, points, linear: `linear(${points.map((v) => String(v)).join(", ")})` };
    }
  }
  throw new Error("unreachable");
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

const camel = (s: string) =>
  s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^([A-Z])/, (c) => c.toLowerCase());

/**
 * Aliases that already project under the name they alias. The aura's three
 * inks point at the accent, `--ultra` and `--source`, each emitted on its own;
 * a second copy under the aura's name would be a token the apps must classify
 * and never paint.
 */
const SKIP_ALIASES = new Set(["aura-you", "aura-thinking", "aura-juno"]);

/** The timing families of spec §4.2 (and the stagger), by prefix. */
const TIMING_FAMILIES = ["delay", "hold", "loop", "settle", "stream", "stagger"] as const;
type TimingFamily = (typeof TIMING_FAMILIES)[number];

/**
 * The shell and gesture tokens of spec §3.12, read by name. A token in this
 * list that globals.css stops declaring is a hard error.
 */
const SHELL_PX = ["sidebar-min", "sidebar-default", "sidebar-max", "edge-zone", "edge-strip-native", "snap-zone", "header-h", "transcript-fade"] as const;
const SHELL_NUMBER = ["drawer-parallax", "galaxy-max-animating", "dock-panes-max"] as const;
const SHELL_MS = ["dock-pane-evict"] as const;
const GESTURE = {
  slopPx: "gesture-slop",
  dismissVelocity: "gesture-dismiss-velocity",
  dismissFraction: "gesture-dismiss-fraction",
  openVelocity: "gesture-open-velocity",
  openFraction: "gesture-open-fraction",
  edgeZonePx: "edge-zone",
  rubberBandLimitPx: "rubber-band-limit",
  rubberBandC: "rubber-band-c",
  settleMinMs: "settle-min",
  settleMaxMs: "settle-max",
} as const;

const PX = /^(-?[\d.]+)px$/;
const NUMBER = /^-?[\d.]+$/;
const SECONDS = /^([\d.]+)s$/;
const REM_VALUE = /^([\d.]+)rem$/;
const MIN_VW_PX = /^min\(\s*([\d.]+)vw\s*,\s*([\d.]+)px\s*\)$/;

export type Projection = ReturnType<typeof project>;

/** Everything the clients receive, from the CSS text (and the Tailwind config the module imports). */
export function project(css: string) {
  const blocks = parseBlocks(css);
  const tables = appearanceTables(blocks);
  const rootDecls = tables.light;
  const darkDecls = declsFor(blocks, ".dark");

  if (rootDecls.size === 0) throw new Error("No :root token block found in globals.css");
  if (darkDecls.size === 0) throw new Error("No .dark token block found in globals.css");

  // ---- Colour ------------------------------------------------------------

  /** Every token that resolves to a colour (dark and high contrast fall back to light). */
  const colorNames = [...rootDecls.keys()]
    .filter((name) => !SKIP_ALIASES.has(name) && resolveColor(rootDecls, name) !== null)
    .sort();

  const colors = colorNames.map((name) => {
    const light = resolveColor(tables.light, name)!;
    const at = (a: Appearance) => resolveColor(tables[a], name) ?? light;
    return {
      name,
      light,
      dark: at("dark"),
      hcLight: at("hcLight"),
      hcDark: at("hcDark"),
      inherited: !darkDecls.has(name),
    };
  });

  // ---- Accents -------------------------------------------------------------

  const ACCENT_TOKENS = ["primary", "ring", "primary-foreground", "primary-ink"] as const;
  const accents = ACCENT_IDS.map((accent) => {
    const light = declsFor(blocks, `:root[data-accent="${accent}"]`);
    const dark = declsFor(blocks, `.dark[data-accent="${accent}"]`);
    if (light.size === 0) throw new Error(`Accent "${accent}" has no :root[data-accent] block`);
    if (dark.size === 0) throw new Error(`Accent "${accent}" has no .dark[data-accent] block`);
    const pick = (from: Map<string, string>, token: string) => {
      const raw = from.get(token);
      if (!raw) throw new Error(`Accent "${accent}" is missing --${token}`);
      const rgba = asColor(raw);
      if (!rgba) throw new Error(`Accent "${accent}" --${token} is not an HSL triple: ${raw}`);
      return rgba;
    };
    const entry = ACCENT_LIST.find((a) => a.id === accent);
    if (!entry) throw new Error(`Accent "${accent}" is in ACCENT_IDS but not ACCENTS (src/lib/accents.ts)`);
    return {
      accent,
      label: entry.label,
      light: Object.fromEntries(ACCENT_TOKENS.map((t) => [t, pick(light, t)])) as Record<(typeof ACCENT_TOKENS)[number], Rgba>,
      dark: Object.fromEntries(ACCENT_TOKENS.map((t) => [t, pick(dark, t)])) as Record<(typeof ACCENT_TOKENS)[number], Rgba>,
    };
  });

  // ---- Motion --------------------------------------------------------------

  const durations = [...rootDecls.entries()]
    .filter(([name, v]) => name.startsWith("dur-") && DURATION.test(v))
    .map(([name, v]) => ({ name: name.slice(4), ms: Number(DURATION.exec(v)![1]) }))
    .sort((a, b) => a.ms - b.ms);

  const easings = [...rootDecls.entries()]
    .filter(([name, v]) => name.startsWith("ease-") && CUBIC.test(v))
    .map(([name, v]) => {
      const m = CUBIC.exec(v)!;
      return {
        name: name.slice(5),
        points: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!durations.length) throw new Error("No --dur-* tokens found");
  if (!easings.length) throw new Error("No --ease-* tokens found");

  /** A timing value: milliseconds for time, a plain number for counts and rates. */
  const timingValue = (name: string, seen = new Set<string>()): { value: number; unit: "ms" | "count" } => {
    const raw = rootDecls.get(name);
    if (raw === undefined) throw new Error(`--${name} is not declared on :root`);
    const ms = DURATION.exec(raw);
    if (ms) return { value: Number(ms[1]), unit: "ms" };
    const s = SECONDS.exec(raw);
    if (s) return { value: Math.round(Number(s[1]) * 1000), unit: "ms" };
    if (NUMBER.test(raw)) return { value: Number(raw), unit: "count" };
    const alias = /^var\(--([\w-]+)\)$/.exec(raw);
    if (alias && !seen.has(name)) return timingValue(alias[1], new Set([...seen, name]));
    throw new Error(`--${name} is neither a time nor a number: ${raw}`);
  };

  const timing = TIMING_FAMILIES.flatMap((family: TimingFamily) =>
    [...rootDecls.keys()]
      .filter((name) => name === family || name.startsWith(`${family}-`))
      .sort()
      .map((name) => ({ family, name, key: name === family ? "default" : camel(name.slice(family.length + 1)), ...timingValue(name) }))
  );

  const springs = [...rootDecls.entries()]
    .filter(([name]) => /^spring-[a-z]+-params$/.test(name))
    .map(([name, v]) => {
      const m = /^([\d.]+)\s+([\d.]+)$/.exec(v);
      if (!m) throw new Error(`--${name} must be "<visualDuration> <bounce>": ${v}`);
      const id = name.slice("spring-".length, -"-params".length);
      const visualDuration = Number(m[1]);
      const bounce = Number(m[2]);
      return { id, visualDuration, bounce, ...springTwin(visualDuration, bounce) };
    });

  if (!springs.length) throw new Error("No --spring-<name>-params found");

  // ---- Shell and gesture --------------------------------------------------

  const need = (name: string) => {
    const raw = rootDecls.get(name);
    if (raw === undefined) throw new Error(`--${name} (spec §3.12) is not declared on :root`);
    return raw;
  };
  const px = (name: string) => {
    const m = PX.exec(need(name));
    if (!m) throw new Error(`--${name} is not in px: ${need(name)}`);
    return Number(m[1]);
  };
  const num = (name: string) => {
    const raw = need(name);
    if (!NUMBER.test(raw)) throw new Error(`--${name} is not a plain number: ${raw}`);
    return Number(raw);
  };
  const ms = (name: string) => {
    const m = DURATION.exec(need(name));
    if (!m) throw new Error(`--${name} is not in ms: ${need(name)}`);
    return Number(m[1]);
  };
  const drawer = MIN_VW_PX.exec(need("drawer-width"));
  if (!drawer) throw new Error(`--drawer-width must be min(<n>vw, <n>px): ${need("drawer-width")}`);
  const darkTable = tables.dark;
  const transcriptMax = (selector: string) => {
    const raw = selector === ":root" ? rootDecls.get("transcript-max") : declsFor(blocks, selector).get("transcript-max");
    const m = raw === undefined ? null : REM_VALUE.exec(raw);
    if (!m) throw new Error(`--transcript-max under ${selector} is not in rem: ${raw}`);
    return Number(m[1]) * 16;
  };
  const shell = {
    px: Object.fromEntries(SHELL_PX.map((n) => [camel(n), px(n)])) as Record<string, number>,
    number: Object.fromEntries(SHELL_NUMBER.map((n) => [camel(n), num(n)])) as Record<string, number>,
    ms: Object.fromEntries(SHELL_MS.map((n) => [camel(n), ms(n)])) as Record<string, number>,
    drawerWidth: { viewportFraction: Number(drawer[1]) / 100, maxPx: Number(drawer[2]) },
    drawerDim: { light: num("drawer-dim"), dark: Number(darkTable.get("drawer-dim") ?? need("drawer-dim")) },
    transcriptMax: {
      narrow: transcriptMax('html[data-transcript-width="narrow"]'),
      medium: transcriptMax(":root"),
      wide: transcriptMax('html[data-transcript-width="wide"]'),
    },
  };
  const gesture = Object.fromEntries(
    Object.entries(GESTURE).map(([key, name]) => {
      const raw = need(name);
      const value = PX.test(raw) ? px(name) : DURATION.test(raw) ? ms(name) : num(name);
      return [key, value];
    })
  ) as Record<keyof typeof GESTURE, number>;

  // ---- Radius (from the Tailwind config, which is where the ladder is declared)

  const rawRadius = (tailwindConfig.theme?.extend?.borderRadius ?? {}) as Record<string, string>;
  const radii = Object.entries(rawRadius)
    .map(([name, value]) => ({ name, value }))
    .filter(({ value }) => /^\d+px$/.test(value))
    .map(({ name, value }) => ({ name, px: Number(value.replace("px", "")) }))
    .sort((a, b) => a.px - b.px);

  if (!radii.length) throw new Error("No px radii found in tailwind.config.ts");

  return { colors, colorNames, accents, durations, easings, timing, springs, shell, gesture, radii, typeRungs: typeLadder(), spaceSteps: spacingSteps() };
}

// ---------------------------------------------------------------------------
// Type (from the Tailwind config's `fontSize` ladder)
// ---------------------------------------------------------------------------

/**
 * The ladder is written in rem (16px) with one of two shapes:
 *
 *   "1.375rem"                                   a fixed rung
 *   "clamp(1.625rem, 1rem + 1.5625cqi, 2rem)"    a fluid rung, keyed to the
 *                                                content column (`cqi`), or to
 *                                                the window (`vw`) for `hero`
 *
 * Both are projected to points (the web's px, 1:1) and the fluid term is kept
 * as `intercept + slope × width` so a native column can land on exactly the
 * size the web's column would at the same width. Anything else is a hard
 * error: a rung the parser cannot read would otherwise vanish from the Swift
 * ladder with every check still green.
 */
const REM = /^([\d.]+)rem$/;
const CLAMP = /^clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)rem\s*\+\s*([\d.]+)(cqi|vw)\s*,\s*([\d.]+)rem\s*\)$/;
const EM = /^(-?[\d.]+)em$/;

type TypeRung = {
  name: string;
  minSize: number;
  maxSize: number;
  intercept: number;
  slope: number;
  lineHeight: number;
  tracking: number;
  weight: number | null;
};

type FontSizeMeta = { lineHeight?: string; letterSpacing?: string; fontWeight?: string };

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function typeLadder(): TypeRung[] {
  const rawFontSize = (tailwindConfig.theme?.extend?.fontSize ?? {}) as Record<string, string | [string, FontSizeMeta]>;
  const rungs = Object.entries(rawFontSize).map(([name, value]) => {
    const [size, meta]: [string, FontSizeMeta] = Array.isArray(value) ? value : [value, {}];
    let minSize: number;
    let maxSize: number;
    let intercept: number;
    let slope: number;
    const fixed = REM.exec(size);
    const fluid = CLAMP.exec(size);
    if (fixed) {
      minSize = maxSize = intercept = Number(fixed[1]) * 16;
      slope = 0;
    } else if (fluid) {
      minSize = Number(fluid[1]) * 16;
      intercept = Number(fluid[2]) * 16;
      // `1cqi` is 1% of the container's inline size, so the per-point slope is
      // the coefficient over 100 — the same for `vw` against the window.
      slope = Number(fluid[3]) / 100;
      maxSize = Number(fluid[5]) * 16;
    } else {
      throw new Error(`fontSize "${name}" is neither a rem size nor a rem clamp: ${size}`);
    }
    // Unitless, as CSS means it: a multiple of the size. A fixed rung may also
    // state its line in rem (`nav`: 14px on a 20px line, because every use sits
    // centred in a fixed-height row); at its one size that is one multiple, so it
    // is projected as that. A fluid rung's rem line would be a different multiple
    // at every width, which the native ladder cannot say, so it stays an error.
    const remLine = meta.lineHeight === undefined ? null : REM.exec(meta.lineHeight);
    let lineHeight = meta.lineHeight === undefined ? NaN : Number(meta.lineHeight);
    if (remLine) lineHeight = fixed ? Math.round(((Number(remLine[1]) * 16) / minSize) * 1e6) / 1e6 : NaN;
    if (!Number.isFinite(lineHeight)) {
      throw new Error(`fontSize "${name}" has no unitless lineHeight (or rem, on a fixed size): ${meta.lineHeight}`);
    }
    let tracking = 0;
    if (meta.letterSpacing !== undefined) {
      const em = EM.exec(meta.letterSpacing);
      if (!em) throw new Error(`fontSize "${name}" letterSpacing is not in em: ${meta.letterSpacing}`);
      tracking = Number(em[1]);
    }
    const weight = meta.fontWeight === undefined ? null : Number(meta.fontWeight);
    return {
      name,
      minSize: round4(minSize),
      maxSize: round4(maxSize),
      intercept: round4(intercept),
      // Six places rather than four: the slope is multiplied by a column width
      // in the hundreds, so a fourth-place rounding lands a fluid rung a few
      // hundredths of a point off the web's size at the anchor widths.
      slope: Math.round(slope * 1e6) / 1e6,
      lineHeight,
      tracking,
      weight,
    };
  });
  if (!rungs.length) throw new Error("No fontSize ladder found in tailwind.config.ts");
  return rungs;
}

// ---------------------------------------------------------------------------
// Spacing (Tailwind's default scale, plus the config's own `4.5` step)
// ---------------------------------------------------------------------------

/**
 * The steps a native surface is allowed to use. Tailwind's scale runs to 96
 * and has a `px` and a `0`; the native ladder is the web's 4pt grid from 2 to
 * 48 plus the 18 the config adds, which is every gap the app shell and the
 * chat surfaces actually spend. Listed by utility suffix, so `gap-3` on the
 * web reads as `step3` in Swift. A step the theme stops defining is a hard
 * error rather than a silently shorter ladder.
 */
const SPACE_STEPS = ["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "6", "7", "8", "10", "12"];

function spacingSteps() {
  const rawSpacing: Record<string, string> = {
    ...(defaultTheme.spacing as Record<string, string>),
    ...((tailwindConfig.theme?.extend?.spacing ?? {}) as Record<string, string>),
  };
  return SPACE_STEPS.map((key) => {
    const raw = rawSpacing[key];
    const rem = raw === undefined ? null : REM.exec(raw);
    if (!rem) throw new Error(`spacing "${key}" is missing or not in rem: ${raw}`);
    return { key, px: round4(Number(rem[1]) * 16) };
  });
}

// ---------------------------------------------------------------------------
// The spring twins, written into globals.css
// ---------------------------------------------------------------------------

const SPRING_BLOCK = /(\/\* @generated-springs:begin[^*]*\*\/\n)([\s\S]*?)([ \t]*\/\* @generated-springs:end \*\/)/;

/** globals.css with the block between the spring markers rewritten from the params. */
export function withSpringTwins(css: string, springs: Projection["springs"]): string {
  const m = SPRING_BLOCK.exec(css);
  if (!m) throw new Error("globals.css has no `@generated-springs:begin` / `:end` markers in :root");
  const indent = /^([ \t]*)/.exec(m[3])![1];
  const body = springs.map((s) => `${indent}--spring-${s.id}: ${s.linear};\n${indent}--spring-${s.id}-dur: ${s.settleMs}ms;\n`).join("");
  return css.replace(SPRING_BLOCK, `$1${body}$3`);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Swift keywords a token name can realistically collide with. `--ease-in`
 * produces `in`, which is a hard parse error rather than a warning, so this is
 * escaped at emit time rather than by renaming the CSS token — the CSS name is
 * the one users of the design system read.
 */
const SWIFT_KEYWORDS = new Set([
  "in", "is", "as", "any", "some", "self", "super", "default", "case", "class", "struct",
  "enum", "protocol", "extension", "func", "let", "var", "if", "else", "for", "while",
  "repeat", "switch", "break", "continue", "fallthrough", "return", "throw", "throws",
  "try", "catch", "defer", "guard", "where", "init", "deinit", "subscript", "operator",
  "import", "typealias", "associatedtype", "inout", "internal", "private", "fileprivate",
  "public", "open", "static", "final", "lazy", "weak", "unowned", "true", "false", "nil",
]);

/** Swift identifier for a token name, backticked when it collides with a keyword. */
const swiftName = (s: string) => {
  const name = camel(s);
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
};

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * The colours a script has to paint WITHOUT the stylesheet: a canvas (the
 * galaxy, the image-edit selection, the sketch pad), the OS chrome
 * (`themeColor`, the manifest), an OpenGraph image and the global error page,
 * none of which can read a custom property. They were hand-typed hex in each
 * of those files. The page reads the variables; only these read this table.
 */
const SCRIPT_COLORS = ["background", "presence", "presence-ink", "galaxy-core"] as const;

/** The status roles (spec §3.4), as hex per appearance, for scripts that paint status. */
const STATUS_ROLES = ["status-running", "status-needs-you", "status-needs-you-ink", "status-ready", "status-blocked"] as const;

export function render(p: Projection): { swift: string; ts: string; digest: string } {
  const {
    colors, accents, durations, easings, timing, springs, shell, gesture, radii, typeRungs, spaceSteps,
  } = p;

  /**
   * Over the projected values only, the numbers the clients actually receive. It
   * used to hash the whole of globals.css, so a comment, a reflowed line or a
   * rule that declares no token failed `--check` with nothing for a client to
   * pick up. Now the digest moves exactly when a generated value does.
   */
  const digest = createHash("sha256")
    .update(JSON.stringify({ colors, accents, durations, easings, timing, springs, shell, gesture, radii, typeRungs, spaceSteps }))
    .digest("hex")
    .slice(0, 16);

  const BANNER = `// Generated by scripts/generate-design-tokens.ts — DO NOT EDIT.
//
// Source: src/app/globals.css (colour, motion, shell and gesture) +
// tailwind.config.ts (radius, type, spacing). Regenerate with
// \`npm run design:tokens\`; \`npm run design:tokens:check\` fails CI when this
// file no longer matches its sources.
//
// tokens-digest: ${digest}
//`;

  // ---- Swift ---------------------------------------------------------------

  const swiftColor = (c: Rgba) =>
    `JunoColorToken(unchecked: ${f(c.r)}, ${f(c.g)}, ${f(c.b)}${c.a === 1 ? "" : `, ${f(c.a)}`})`;

  const swiftColorCases = colors
    .map(({ name, light, dark, hcLight, hcDark, inherited }) => {
      const note = inherited ? "  // no .dark override; light value applies to both" : "";
      return `    /// \`--${name}\`${note}
    public static let ${swiftName(name)} = JunoGeneratedPair(
        light: ${swiftColor(light)},
        dark: ${swiftColor(dark)},
        highContrastLight: ${swiftColor(hcLight)},
        highContrastDark: ${swiftColor(hcDark)}
    )`;
    })
    .join("\n\n");

  const swiftAccentCases = accents
    .map(
      ({ accent, light, dark }) => `        case .${accent}:
            JunoGeneratedAccentPalette(
                primary: JunoGeneratedPair(light: ${swiftColor(light.primary)}, dark: ${swiftColor(dark.primary)}),
                ring: JunoGeneratedPair(light: ${swiftColor(light.ring)}, dark: ${swiftColor(dark.ring)}),
                onPrimary: JunoGeneratedPair(light: ${swiftColor(light["primary-foreground"])}, dark: ${swiftColor(dark["primary-foreground"])}),
                ink: JunoGeneratedPair(light: ${swiftColor(light["primary-ink"])}, dark: ${swiftColor(dark["primary-ink"])})
            )`
    )
    .join("\n");

  const swiftString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const timingSwiftName = (t: (typeof timing)[number]) => swiftName(`${t.family}-${t.key === "default" ? "period" : t.key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  const timingLine = (t: (typeof timing)[number]) =>
    t.unit === "ms"
      ? `    /// \`--${t.name}\`: ${t.value}ms\n    public static let ${timingSwiftName(t)}: TimeInterval = ${t.value / 1000}`
      : `    /// \`--${t.name}\`: ${t.value}\n    public static let ${timingSwiftName(t)}: Double = ${f(t.value)}`;

  const swift = `${BANNER}

import CoreGraphics
import Foundation

/// A token that resolves differently per appearance. Every half is always
/// present: a single value that "works in both" is how the themes drift. The
/// high-contrast halves are globals.css's \`@media (prefers-contrast: more)\`
/// block (Increase Contrast natively); a token that block does not change
/// carries its standard value there.
public struct JunoGeneratedPair: Hashable, Sendable {
    public let light: JunoColorToken
    public let dark: JunoColorToken
    public let highContrastLight: JunoColorToken
    public let highContrastDark: JunoColorToken

    public init(
        light: JunoColorToken,
        dark: JunoColorToken,
        highContrastLight: JunoColorToken? = nil,
        highContrastDark: JunoColorToken? = nil
    ) {
        self.light = light
        self.dark = dark
        self.highContrastLight = highContrastLight ?? light
        self.highContrastDark = highContrastDark ?? dark
    }

    public func resolve(dark isDark: Bool) -> JunoColorToken { isDark ? dark : light }

    public func resolve(dark isDark: Bool, highContrast: Bool) -> JunoColorToken {
        switch (isDark, highContrast) {
        case (false, false): light
        case (true, false): dark
        case (false, true): highContrastLight
        case (true, true): highContrastDark
        }
    }
}

/// The four values an accent overrides. Mirrors the \`[data-accent]\` blocks.
public struct JunoGeneratedAccentPalette: Hashable, Sendable {
    public let primary: JunoGeneratedPair
    public let ring: JunoGeneratedPair
    public let onPrimary: JunoGeneratedPair
    public let ink: JunoGeneratedPair
}

/// Every colour custom property declared on \`:root\` (aliases resolved), with
/// its \`.dark\` override and both high-contrast values.
public enum JunoGeneratedColors {
${swiftColorCases}
}

public extension JunoAccent {
    /// The generated palette for this accent, projected from globals.css.
    var generatedPalette: JunoGeneratedAccentPalette {
        switch self {
${swiftAccentCases}
        }
    }

    /// The web's label for this accent (\`ACCENTS\` in src/lib/accents.ts).
    var generatedLabel: String {
        switch self {
${accents.map((a) => `        case .${a.accent}: ${swiftString(a.label)}`).join("\n")}
        }
    }
}

/// \`--dur-*\`, in seconds (SwiftUI's unit), sorted fastest first. The only
/// transition and animation lengths (spec D2).
public enum JunoGeneratedDuration {
${durations.map((d) => `    /// \`--dur-${d.name}: ${d.ms}ms\`\n    public static let ${swiftName(d.name)}: TimeInterval = ${d.ms / 1000}`).join("\n")}
}

/// \`--ease-*\` as raw cubic-bezier control points, so a client can build the
/// platform curve of its choice (CAMediaTimingFunction, a SwiftUI timing curve,
/// or a hand-rolled solver) from the same four numbers the browser uses.
public enum JunoGeneratedEasing {
${easings
  .map(
    (e) =>
      `    /// \`--ease-${e.name}\`\n    public static let ${swiftName(e.name)}: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat) = (${e.points.map((pt) => f(pt)).join(", ")})`
  )
  .join("\n")}
}

/// The named timing families (spec §4.2): delays, holds, loops, release
/// settle, stream pacing and stagger. Not durations; times in seconds, counts
/// and rates as plain numbers.
public enum JunoGeneratedTiming {
${timing.map(timingLine).join("\n")}
}

/// One spring, defined once: SwiftUI's \`.spring(duration: visualDuration,
/// bounce: bounce)\` is framer's \`{ visualDuration, bounce }\`. \`settle\` is the
/// time it takes to stay within 0.005 of rest, the length of its CSS twin.
public struct JunoGeneratedSpring: Hashable, Sendable {
    public let visualDuration: TimeInterval
    public let bounce: Double
    public let settle: TimeInterval
}

/// \`--spring-<name>-params\` (spec §4.4).
public enum JunoGeneratedSprings {
${springs.map((s) => `    /// \`--spring-${s.id}\`: ${s.visualDuration}s / ${s.bounce}, settles in ${s.settleMs}ms\n    public static let ${swiftName(s.id)} = JunoGeneratedSpring(visualDuration: ${f(s.visualDuration)}, bounce: ${f(s.bounce)}, settle: ${s.settleMs / 1000})`).join("\n")}
}

/// The shell tokens of spec §3.12, in points (the web's px, 1:1).
public enum JunoGeneratedShell {
${Object.entries(shell.px).map(([k, v]) => `    public static let ${swiftName(k)}: CGFloat = ${f(v)}`).join("\n")}
${Object.entries(shell.number).map(([k, v]) => `    public static let ${swiftName(k)}: Double = ${f(v)}`).join("\n")}
${Object.entries(shell.ms).map(([k, v]) => `    public static let ${swiftName(k)}: TimeInterval = ${v / 1000}`).join("\n")}
    /// \`--drawer-width: min(${shell.drawerWidth.viewportFraction * 100}vw, ${shell.drawerWidth.maxPx}px)\`
    public static let drawerWidthFraction: CGFloat = ${f(shell.drawerWidth.viewportFraction)}
    public static let drawerWidthMax: CGFloat = ${f(shell.drawerWidth.maxPx)}
    /// \`--drawer-dim\`, per theme.
    public static let drawerDimLight: Double = ${f(shell.drawerDim.light)}
    public static let drawerDimDark: Double = ${f(shell.drawerDim.dark)}
    /// \`--transcript-max\` for the stored widths narrow, medium and wide.
    public static let transcriptNarrow: CGFloat = ${f(shell.transcriptMax.narrow)}
    public static let transcriptMedium: CGFloat = ${f(shell.transcriptMax.medium)}
    public static let transcriptWide: CGFloat = ${f(shell.transcriptMax.wide)}
}

/// The sheet and drawer gesture (spec D18), wave 1's values. Velocities are
/// points per millisecond; fractions are of the panel's travel. The rubber band
/// is \`(1 − 1 / (x · rubberBandC / rubberBandLimit + 1)) · rubberBandLimit\`.
public enum JunoGeneratedGesture {
${Object.entries(gesture).map(([k, v]) => (k.endsWith("Ms") ? `    public static let ${swiftName(k.slice(0, -2))}: TimeInterval = ${v / 1000}` : `    public static let ${swiftName(k.replace(/Px$/, ""))}: CGFloat = ${f(v)}`)).join("\n")}
}

/// The radius ladder, in points.
public enum JunoGeneratedRadius {
${radii.map((r) => `    public static let ${swiftName(r.name)}: CGFloat = ${f(r.px)}`).join("\n")}
}

/// One rung of the web's type ladder (\`tailwind.config.ts\` → \`fontSize\`), in
/// points: the web's px, 1:1.
///
/// A fixed rung has \`minSize == maxSize\` and a zero \`fluidSlope\`. A fluid rung
/// is \`clamp(minSize, fluidIntercept + fluidSlope × width, maxSize)\`, where
/// \`width\` is the content column in points — the web's \`cqi\` container (or the
/// window, \`vw\`, for the one marketing rung).
public struct JunoGeneratedTypeRung: Hashable, Sendable {
    public let minSize: CGFloat
    public let maxSize: CGFloat
    public let fluidIntercept: CGFloat
    public let fluidSlope: CGFloat
    /// Unitless, as in CSS: a multiple of the font size.
    public let lineHeight: CGFloat
    /// In em, as in CSS; multiply by the size for points.
    public let tracking: CGFloat
    /// The CSS numeric weight, or nil where the rung leaves weight to the caller (400).
    public let weight: Int?
}

/// The type ladder, in the config's order.
public enum JunoGeneratedType {
${typeRungs
  .map(
    (t) =>
      `    /// \`text-${t.name}\`\n    public static let ${swiftName(t.name)} = JunoGeneratedTypeRung(minSize: ${f(t.minSize)}, maxSize: ${f(t.maxSize)}, fluidIntercept: ${f(t.intercept)}, fluidSlope: ${f(t.slope)}, lineHeight: ${f(t.lineHeight)}, tracking: ${f(t.tracking)}, weight: ${t.weight === null ? "nil" : t.weight})`
  )
  .join("\n")}
}

/// The spacing steps native surfaces may use, in points, named for the
/// Tailwind utility suffix they come from: \`step3\` is \`p-3\` / \`gap-3\`.
public enum JunoGeneratedSpace {
${spaceSteps.map((s) => `    /// \`${s.key}\`\n    public static let step${s.key.replace(".", "_")}: CGFloat = ${f(s.px)}`).join("\n")}

    /// Every step, smallest first.
    public static let all: [CGFloat] = [${spaceSteps.map((s) => f(s.px)).join(", ")}]
}
`;

  // ---- TypeScript ----------------------------------------------------------

  const colorOf = (name: string) => {
    const entry = colors.find((c) => c.name === name);
    if (!entry) throw new Error(`--${name} is not a colour token on :root`);
    return entry;
  };
  const scriptColors = SCRIPT_COLORS.map((name) => {
    const entry = colorOf(name);
    return { name, light: hex(entry.light), dark: hex(entry.dark) };
  });
  const statusColors = STATUS_ROLES.map((name) => {
    const e = colorOf(name);
    return { name, light: hex(e.light), dark: hex(e.dark), hcLight: hex(e.hcLight), hcDark: hex(e.hcDark) };
  });

  const timingByFamily = TIMING_FAMILIES.map((family) => ({ family, entries: timing.filter((t) => t.family === family) }));

  const ts = `${BANNER}

/** The accent ids, in the order the web lists them (src/lib/accents.ts). */
export const ACCENT_IDS = [${accents.map((a) => JSON.stringify(a.accent)).join(", ")}] as const;

/** Colours for code that paints without the stylesheet (canvas, OS chrome, OG images), as sRGB hex per theme. */
export const SCRIPT_COLOR = {
${scriptColors.map((c) => `  ${camel(c.name)}: { light: ${JSON.stringify(c.light)}, dark: ${JSON.stringify(c.dark)} },`).join("\n")}
} as const;

/** The status roles (spec §3.4) as sRGB hex in each appearance, for code that paints status without the stylesheet. */
export const STATUS_COLOR = {
${statusColors.map((c) => `  ${camel(c.name.replace(/^status-/, ""))}: { light: ${JSON.stringify(c.light)}, dark: ${JSON.stringify(c.dark)}, hcLight: ${JSON.stringify(c.hcLight)}, hcDark: ${JSON.stringify(c.hcDark)} },`).join("\n")}
} as const;

/** \`--dur-*\` in milliseconds: the only transition and animation lengths (spec D2). */
export const DURATION = {
${durations.map((d) => `  ${camel(d.name)}: ${d.ms},`).join("\n")}
} as const;

/** \`--ease-*\` as cubic-bezier control points. */
export const EASING = {
${easings.map((e) => `  ${camel(e.name)}: [${e.points.join(", ")}] as const,`).join("\n")}
} as const;

/** The named timing families (spec §4.2): milliseconds for times, plain numbers for counts and rates. */
export const TIMING_TOKENS = {
${timingByFamily.map(({ family, entries }) => `  ${family}: {\n${entries.map((t) => `    ${t.key}: ${t.value},`).join("\n")}\n  },`).join("\n")}
} as const;

/**
 * The springs (spec §4.4), each defined once: framer \`{ visualDuration, bounce }\`
 * (= SwiftUI \`.spring(duration:bounce:)\`), its settle time in ms, and the CSS
 * twin globals.css carries as \`--spring-<name>\`.
 */
export const SPRING = {
${springs.map((s) => `  ${camel(s.id)}: { visualDuration: ${s.visualDuration}, bounce: ${s.bounce}, settleMs: ${s.settleMs}, linear: ${JSON.stringify(s.linear)} },`).join("\n")}
} as const;

/** The shell tokens (spec §3.12), in px unless named otherwise. */
export const SHELL = {
${Object.entries(shell.px).map(([k, v]) => `  ${k}: ${v},`).join("\n")}
${Object.entries(shell.number).map(([k, v]) => `  ${k}: ${v},`).join("\n")}
${Object.entries(shell.ms).map(([k, v]) => `  ${k}Ms: ${v},`).join("\n")}
  drawerWidth: { viewportFraction: ${shell.drawerWidth.viewportFraction}, maxPx: ${shell.drawerWidth.maxPx} },
  drawerDim: { light: ${shell.drawerDim.light}, dark: ${shell.drawerDim.dark} },
  transcriptMax: { narrow: ${shell.transcriptMax.narrow}, medium: ${shell.transcriptMax.medium}, wide: ${shell.transcriptMax.wide} },
} as const;

/** The sheet and drawer gesture (spec D18): px, px/ms, fractions of travel and ms. src/lib/sheet-gesture.ts reads these. */
export const GESTURE = {
${Object.entries(gesture).map(([k, v]) => `  ${k}: ${v},`).join("\n")}
} as const;

/** The radius ladder, in pixels. */
export const RADIUS = {
${radii.map((r) => `  ${JSON.stringify(camel(r.name))}: ${r.px},`).join("\n")}
} as const;

export type DurationToken = keyof typeof DURATION;
export type EasingToken = keyof typeof EASING;
export type RadiusToken = keyof typeof RADIUS;
export type SpringToken = keyof typeof SPRING;
`;

  return { swift, ts, digest };
}

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

/** The `case` names of `enum JunoAccent`, in declaration order. */
function junoAccentEnumCases(source: string): string[] {
  const start = source.search(/\benum JunoAccent\b[^{]*\{/);
  if (start === -1) throw new Error("JunoAccent.swift declares no `enum JunoAccent`");
  const body = source.slice(source.indexOf("{", start) + 1);
  // The cases sit before the first member; stop at the first `var`/`init`/`func`.
  const head = body.slice(0, body.search(/\n\s*(?:public\s+)?(?:var|init|func|static)\b/));
  return [...head.matchAll(/^\s*case\s+([a-z][A-Za-z0-9]*)\s*$/gm)].map((m) => m[1]);
}

/**
 * `--check` compares everything but the digest line.
 *
 * The digest moves with the projected values, but checking it byte for byte
 * made a change of digest ALGORITHM a native change too: the Swift file had to
 * be regenerated by someone allowed to touch `native/`. Every colour,
 * duration, easing, spring, shell value and radius is still compared exactly;
 * the digest is refreshed the next time the files are written.
 */
const withoutDigest = (text: string) => text.replace(/^\/\/ tokens-digest: [0-9a-f]+$/m, "");

function main() {
  const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
  const SWIFT_OUT = resolve(process.cwd(), "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift");
  const TS_OUT = resolve(process.cwd(), "src/lib/design/tokens.generated.ts");
  const JUNO_ACCENT_SWIFT = resolve(process.cwd(), "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoAccent.swift");

  const css = readFileSync(CSS_PATH, "utf8");
  const projection = project(css);
  const cssWithTwins = withSpringTwins(css, projection.springs);
  const { swift, ts, digest } = render(projection);

  const outputs: Array<[string, string]> = [
    [SWIFT_OUT, swift],
    [TS_OUT, ts],
  ];

  /**
   * The accent list must be the same on every client, not merely projected.
   * The generated `generatedPalette` switch already fails to compile when
   * JunoAccent lacks a case the web has, but only on a machine that builds the
   * Swift package; this fails the token check itself, which CI runs everywhere,
   * and also catches a case the app has and the web dropped.
   */
  // A scratch checkout with only globals.css (tests/design-tokens-digest.test.ts)
  // has no native tree; tests/presence-token.test.ts reads the enum by path, so a
  // moved file still fails there.
  const swiftCases = existsSync(JUNO_ACCENT_SWIFT) ? junoAccentEnumCases(readFileSync(JUNO_ACCENT_SWIFT, "utf8")) : [...ACCENT_IDS];
  const accentDrift = JSON.stringify(swiftCases) !== JSON.stringify([...ACCENT_IDS]);
  if (accentDrift) {
    console.error(
      `[design-tokens] ACCENTS JunoAccent.swift lists [${swiftCases.join(", ")}] but src/lib/accents.ts lists [${ACCENT_IDS.join(", ")}].` +
        " Add or remove the case (same order) in JunoAccent.swift."
    );
  }

  const p = projection;
  const summary =
    `${p.colorNames.length} colours (4 appearances), ${p.accents.length} accents, ${p.durations.length} durations, ` +
    `${p.easings.length} easings, ${p.timing.length} timing tokens, ${p.springs.length} springs, ${p.radii.length} radii, ` +
    `${p.typeRungs.length} type rungs, ${p.spaceSteps.length} spacing steps (digest ${digest})`;

  if (process.argv.includes("--check")) {
    let drifted = accentDrift;
    if (cssWithTwins !== css) {
      console.error(`[design-tokens] DRIFT   ${CSS_PATH} (the spring twins no longer match --spring-*-params)`);
      drifted = true;
    }
    for (const [path, expected] of outputs) {
      let actual: string | null = null;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        console.error(`[design-tokens] MISSING ${path}`);
        drifted = true;
        continue;
      }
      if (withoutDigest(actual) !== withoutDigest(expected)) {
        console.error(`[design-tokens] DRIFT   ${path}`);
        drifted = true;
      }
    }
    if (drifted) {
      console.error("\n[design-tokens] A client no longer matches globals.css. Run: npm run design:tokens");
      process.exit(1);
    }
    console.log(`[design-tokens] up to date — ${summary}`);
  } else {
    if (cssWithTwins !== css) {
      writeFileSync(CSS_PATH, cssWithTwins);
      console.log(`[design-tokens] wrote the spring twins into ${CSS_PATH}`);
    }
    for (const [path, contents] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
      console.log(`[design-tokens] wrote ${path}`);
    }
    console.log(`[design-tokens] ${summary}`);
    // Written anyway (the projection is right); the enum is what has to move.
    if (accentDrift) process.exit(1);
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url || fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) main();
