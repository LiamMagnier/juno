/**
 * The contrast matrix (spec §3.1, §3.2): every text, glyph and boundary pair
 * the product draws, measured from globals.css in all four appearances.
 *
 * WHY A MATRIX AND NOT A HANDFUL OF ASSERTIONS. The token comments in
 * globals.css quote ratios ("5.35 on a card, 4.84 on --muted"), and those
 * numbers were right when they were written. Then a ground moved a point and
 * nothing re-measured the inks on it: `--muted-foreground` on `--selected`
 * fell to 4.32:1 — an AA failure on every selected row's caption — with every
 * comment still saying it passed. This measures every pair on every ground
 * from the CSS itself, so a moved ground fails here rather than in an audit.
 *
 * Rules (WCAG 2.x relative luminance):
 *   - Text: at least 4.5:1. Foreground and muted on the base grounds; muted-
 *     on-fill and foreground on every fill; signal-ink, presence-ink and
 *     destructive as text on background, card and popover only.
 *   - High contrast: muted (and muted-on-fill) and body text at least 7:1 on
 *     EVERY ground.
 *   - Glyph inks (presence, signal, destructive, success): at least 3:1 on
 *     every ground, selected included.
 *   - Control boundaries (`--input`, `--ring`): at least 3:1 against the
 *     grounds a control sits on. `--border` and `--hairline` are decorative
 *     separators and are exempt (WCAG 1.4.11).
 *   - The known misuse: muted on selected (light) is RECORDED as failing, and
 *     the check fails if it ever starts passing unnoticed or if anyone "fixes"
 *     it by moving the ground instead of using muted-on-fill.
 *
 * Also the colour-vision check from D3: signal and destructive at least
 * 2.0:1 apart in luminance under simulated deuteranopia (Machado 2009), in
 * both themes, so needs-you and blocked never rely on hue.
 *
 *   npx tsx scripts/check-contrast-matrix.ts           # print, exit 1 on a failure
 *   npx tsx scripts/check-contrast-matrix.ts --json    # machine-readable
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APPEARANCES,
  type Appearance,
  type Rgba,
  appearanceTables,
  composite,
  contrastRatio,
  hex,
  parseBlocks,
  resolveColor,
} from "./generate-design-tokens";

export const GROUNDS = [
  "background",
  "card",
  "popover",
  "sidebar",
  "sidebar-hover",
  "sidebar-selected",
  "selected",
  "user-bubble",
  "user-bubble-hover",
  "muted",
] as const;
export type Ground = (typeof GROUNDS)[number];

/** Where muted text may sit (spec §3.1 role notes). */
export const BASE_GROUNDS: readonly Ground[] = ["background", "card", "popover", "sidebar", "user-bubble", "muted"];
/** Hover and selected fills: text on them is muted-on-fill or foreground. */
export const FILLS: readonly Ground[] = ["sidebar-hover", "sidebar-selected", "selected", "user-bubble-hover"];
/** Status inks are text only here. */
export const TEXT_STATUS_GROUNDS: readonly Ground[] = ["background", "card", "popover"];
export const STATUS_TEXT_INKS = ["signal-ink", "presence-ink", "destructive-ink"] as const;
export const GLYPH_INKS = ["presence", "signal", "destructive", "success"] as const;
/** Grounds a control with an `--input` edge or a focus ring sits on. */
export const BOUNDARY_GROUNDS: readonly Ground[] = ["background", "card", "popover"];

export const TEXT_MIN = 4.5;
export const HC_TEXT_MIN = 7;
export const GLYPH_MIN = 3;
export const BOUNDARY_MIN = 3;
export const CVD_MIN = 2;

/**
 * The pairs the matrix keeps as RECORDED failures, with why they stay failing.
 * Each is measured on every run and fails the check if it starts PASSING, so
 * an entry cannot outlive the reason for it.
 */
export const KNOWN_MISUSES: Array<{ ink: string; ground: Ground; appearance: Appearance; why: string }> = [
  {
    ink: "muted-foreground",
    ground: "selected",
    appearance: "light",
    why: "muted on a selected fill is 4.32:1; text on a fill uses --muted-foreground-on-fill (the no-muted-on-fill lint keeps it out of class names)",
  },
  // The spec's ember glyph (#D36317, pinned by the P1 acceptance) clears 3:1
  // on --selected (3.06) but not on the sidebar's selected row, which is a
  // point and a half darker. A needs-you hand on the open conversation's row
  // is the case. Open for the S1 sign-off: darken the light signal a point
  // (24 80% 45% clears it and keeps the deuteranopia gap over 2.0) or accept.
  {
    ink: "signal",
    ground: "sidebar-selected",
    appearance: "light",
    why: "ember glyph on the sidebar's selected row is 2.94:1 (spec value; awaiting S1)",
  },
  {
    ink: "signal",
    ground: "sidebar-selected",
    appearance: "hcLight",
    why: "high contrast does not change the glyph; same 2.94:1 (awaiting S1)",
  },
];

export type Check = {
  rule: string;
  ink: string;
  ground: string;
  appearance: Appearance;
  ratio: number;
  min: number;
  pass: boolean;
  /** A recorded misuse: expected to fail, and the matrix fails if it passes. */
  recorded?: boolean;
};

// ---------------------------------------------------------------------------
// Colour-vision deficiency (Machado, Oliveira & Fernandes 2009, severity 1.0)
// ---------------------------------------------------------------------------

const MACHADO = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
} as const;
export type Deficiency = keyof typeof MACHADO;

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * The colour as a viewer with `deficiency` sees it.
 *
 * TWO WAYS TO APPLY THE MATRIX, AND THEY DISAGREE. `"srgb"` multiplies the
 * gamma-encoded sRGB channels, which is the arithmetic the spec's D3 figures
 * were computed with (2.30:1 light, 2.00:1 dark, old 1.61 / 1.17), so it is
 * the gate. `"linear"` multiplies linear-light channels, which is how Machado
 * et al. and most simulators (DaltonLens, colorspacious) apply it; it gives a
 * smaller separation (about 1.6 and 1.7 for the same colours) and is reported
 * alongside so nobody reads the gate as stronger than it is. Under either,
 * needs-you and blocked also differ by glyph (hand against circle-x, D4).
 */
export function simulate(c: Rgba, deficiency: Deficiency, space: "srgb" | "linear" = "srgb"): Rgba {
  const m = MACHADO[deficiency];
  if (space === "srgb") {
    const out = m.map((row) => clamp01(row[0] * c.r + row[1] * c.g + row[2] * c.b));
    return { r: out[0], g: out[1], b: out[2], a: c.a };
  }
  const lin = [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
  const out = m.map((row) => clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
  return { r: toGamma(out[0]), g: toGamma(out[1]), b: toGamma(out[2]), a: c.a };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

export function runMatrix(css: string) {
  const tables = appearanceTables(parseBlocks(css));
  const colour = (name: string, a: Appearance): Rgba => {
    const c = resolveColor(tables[a], name);
    if (!c) throw new Error(`--${name} does not resolve to a colour in ${a}`);
    return c;
  };
  /** An opaque ground (a translucent token is composited over the page). */
  const ground = (name: Ground, a: Appearance): Rgba => {
    const c = colour(name, a);
    return c.a < 1 ? composite(c, colour("background", a)) : c;
  };

  const checks: Check[] = [];
  const add = (rule: string, ink: string, g: Ground, a: Appearance, min: number) => {
    const ratio = contrastRatio(colour(ink, a), ground(g, a));
    const recorded = KNOWN_MISUSES.some((k) => k.ink === ink && k.ground === g && k.appearance === a);
    checks.push({ rule, ink, ground: g, appearance: a, ratio, min, pass: ratio >= min, recorded: recorded || undefined });
  };

  for (const a of APPEARANCES) {
    const hc = a === "hcLight" || a === "hcDark";
    const textMin = hc ? HC_TEXT_MIN : TEXT_MIN;
    // Text.
    for (const g of hc ? GROUNDS : BASE_GROUNDS) {
      add("text: foreground", "foreground", g, a, textMin);
      add("text: muted", "muted-foreground", g, a, textMin);
    }
    for (const g of hc ? GROUNDS : FILLS) {
      add("text: muted-on-fill", "muted-foreground-on-fill", g, a, textMin);
      if (!hc) add("text: foreground on fill", "foreground", g, a, TEXT_MIN);
    }
    for (const g of TEXT_STATUS_GROUNDS) {
      for (const ink of STATUS_TEXT_INKS) add("text: status ink", ink, g, a, TEXT_MIN);
    }
    // Glyphs.
    for (const g of GROUNDS) {
      for (const ink of GLYPH_INKS) add("glyph", ink, g, a, GLYPH_MIN);
    }
    // Control boundaries.
    for (const g of BOUNDARY_GROUNDS) {
      add("boundary: input", "input", g, a, BOUNDARY_MIN);
      add("boundary: ring", "ring", g, a, BOUNDARY_MIN);
    }
  }
  // The recorded misuse is measured even though muted never belongs on a fill.
  for (const k of KNOWN_MISUSES) {
    if (!checks.some((c) => c.ink === k.ink && c.ground === k.ground && c.appearance === k.appearance)) {
      add("recorded misuse", k.ink, k.ground, k.appearance, TEXT_MIN);
    }
  }

  // Signal versus destructive, by luminance alone, as a deuteranope or
  // protanope sees them (D3). Deuteranopia is the gate; protanopia is
  // reported.
  const cvd = (["light", "dark"] as const).flatMap((a) =>
    (Object.keys(MACHADO) as Deficiency[]).flatMap((deficiency) =>
      (["srgb", "linear"] as const).map((space) => {
        const ratio = contrastRatio(
          simulate(colour("signal", a), deficiency, space),
          simulate(colour("destructive", a), deficiency, space)
        );
        const gate = deficiency === "deuteranopia" && space === "srgb";
        return { appearance: a, deficiency, space, ratio, min: CVD_MIN, gate, pass: !gate || ratio >= CVD_MIN };
      })
    )
  );
  const plain = (["light", "dark"] as const).map((a) => ({
    appearance: a,
    ratio: contrastRatio(colour("signal", a), colour("destructive", a)),
  }));

  const failures = checks.filter((c) => (c.recorded ? c.pass : !c.pass));
  const cvdFailures = cvd.filter((c) => !c.pass);
  return { checks, cvd, plain, failures, cvdFailures, ok: failures.length === 0 && cvdFailures.length === 0, colour };
}

function main() {
  const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
  const result = runMatrix(css);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ checks: result.checks, cvd: result.cvd, ok: result.ok }, null, 2));
    process.exit(result.ok ? 0 : 1);
  }
  const fmt = (n: number) => n.toFixed(2);
  const byAppearance = new Map<Appearance, Check[]>();
  for (const c of result.checks) byAppearance.set(c.appearance, [...(byAppearance.get(c.appearance) ?? []), c]);
  for (const [a, checks] of byAppearance) {
    const worst = [...checks].filter((c) => !c.recorded).sort((x, y) => x.ratio / x.min - y.ratio / y.min).slice(0, 3);
    console.log(
      `[contrast] ${a.padEnd(7)} ${checks.length} pairs; tightest: ${worst.map((c) => `${c.ink} on ${c.ground} ${fmt(c.ratio)} (≥${c.min})`).join(", ")}`
    );
  }
  for (const k of KNOWN_MISUSES) {
    const c = result.checks.find((x) => x.ink === k.ink && x.ground === k.ground && x.appearance === k.appearance)!;
    console.log(`[contrast] recorded misuse: ${k.ink} on ${k.ground} (${k.appearance}) ${fmt(c.ratio)} — ${k.why}`);
  }
  for (const c of result.cvd) {
    console.log(`[contrast] signal vs destructive, ${c.appearance}, ${c.deficiency} (${c.space}): ${fmt(c.ratio)}${c.gate ? ` (gate ≥${c.min})` : " (reported)"}`);
  }
  if (!result.ok) {
    for (const c of result.failures) {
      const hint = c.recorded ? "now PASSES — a recorded misuse moved; re-measure and update KNOWN_MISUSES" : `below ${c.min}`;
      console.error(
        `[contrast] FAIL ${c.appearance} ${c.rule}: --${c.ink} ${hex(result.colour(c.ink, c.appearance))} on --${c.ground} = ${fmt(c.ratio)} (${hint})`
      );
    }
    for (const c of result.cvdFailures) {
      console.error(`[contrast] FAIL ${c.appearance} ${c.deficiency}: signal and destructive are ${fmt(c.ratio)} apart (≥${c.min})`);
    }
    process.exit(1);
  }
  console.log(`[contrast] ${result.checks.length} pairs and the CVD gate hold.`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url || fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) main();
