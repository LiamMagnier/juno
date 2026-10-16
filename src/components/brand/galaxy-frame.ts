/*
 * ONE FRAME OF THE GALAXY, AS DATA.
 *
 * The canvas (while a mark animates) and the static SVG still frame (every
 * other moment, spec D9) draw the same dots from this function, so the hand-off
 * from one to the other at a stop is invisible: the still frame is rendered at
 * the galaxy clock the canvas stopped on.
 *
 * The still frame is a CSS mask over a currentColor fill (galaxy-mark.tsx):
 * one element, no canvas, inked by `color` like any glyph, so it follows the
 * row's ink, high contrast and forced colours (where the mark is Highlight).
 * The SVG for a (size, clock, dim) triple is cached; a row of fifty running
 * marks shares one string.
 */

import {
  GALAXY_COUNT_SMALL,
  GALAXY_STATIC_TIME,
  GALAXY_TRAIL_FADES,
  GALAXY_TRAIL_STEP,
  galaxyAngle,
  galaxyCoreBreath,
  galaxyField,
  galaxyProject,
  galaxyTwinkle,
  type GalaxyField,
} from "./galaxy-field";

export interface GalaxyDot {
  x: number;
  y: number;
  r: number;
  alpha: number;
  /** One of the ~8% presence-accent stars. */
  accent: boolean;
  /** Part of the warm core. */
  core: boolean;
}

let FIELD: GalaxyField | null = null;
export const sharedField = () => (FIELD ??= galaxyField());

export interface GalaxyFrameOptions {
  /** Galaxy clock, seconds. */
  s?: number;
  /** Entrance progress 0..1 (1 = arrived). */
  enter?: number;
  /** Step-back multiplier: 1 live, 0.6 settled. */
  dim?: number;
  /** Core breath; 1 when still. */
  breath?: number;
  /** Device pixel ratio, for the minimum dot size. */
  dpr?: number;
}

/** Every dot of the mark at `size` CSS px, in mark coordinates (0..size). */
export function galaxyDots(size: number, { s = GALAXY_STATIC_TIME, enter = 1, dim = 1, breath = 1, dpr = 1 }: GalaxyFrameOptions = {}): GalaxyDot[] {
  const { particles, core } = sharedField();
  const list = size < 18 ? particles.slice(0, GALAXY_COUNT_SMALL) : particles;
  const half = (size / 2) * 0.95;
  const unit = size / 24;
  const c = size / 2;
  const lift = size < 20 ? 1.18 : 1;
  const dotScale = size <= 24 ? 0.5 : 0.5 * Math.sqrt(24 / size);
  const minDot = 0.5 / dpr + 0.2;
  const out: GalaxyDot[] = [];
  for (const p of list) {
    const rr = p.r * (0.6 + 0.4 * enter);
    const angle = galaxyAngle(p.theta, p.r, s) + (1 - enter) * 0.9;
    const a = Math.min(1, p.alpha * galaxyTwinkle(p.i, s) * enter * dim * lift);
    if (a < 0.01) continue;
    if (!p.dust) {
      const step = GALAXY_TRAIL_STEP * (0.6 + 0.8 * (1 - Math.min(p.r, 1)));
      GALAXY_TRAIL_FADES.forEach((fade, k) => {
        const w = galaxyProject(rr, angle + step * (k + 1));
        out.push({
          x: c + w.x * half,
          y: c + w.y * half,
          r: Math.max(minDot, p.size * unit * dotScale * (0.85 - 0.12 * k)),
          alpha: a * fade,
          accent: p.accent,
          core: false,
        });
      });
    }
    const { x, y } = galaxyProject(rr, angle);
    out.push({ x: c + x * half, y: c + y * half, r: Math.max(minDot, p.size * unit * dotScale), alpha: a, accent: p.accent, core: false });
  }
  const coreAlpha = 0.9 * breath * enter * dim;
  for (const p of core) {
    const { x, y } = galaxyProject(p.r, galaxyAngle(p.theta, p.r, s));
    out.push({ x: c + x * half, y: c + y * half, r: Math.max(minDot, p.size * unit * dotScale), alpha: coreAlpha, accent: false, core: true });
  }
  return out;
}

/** The radius of the soft core disc, in mark px. */
export const galaxyCoreRadius = (size: number) => 0.11 * ((size / 2) * 0.95) * 1.6;

/** Breath of the core at clock `s` (1 when the galaxy is still). */
export const breathAt = (s: number, still: boolean) => (still ? 1 : galaxyCoreBreath(s));

const r1 = (n: number) => Math.round(n * 10) / 10;
const cache = new Map<string, string>();

/**
 * The clock a still frame is drawn at, quantised to 0.1s: at rest the galaxy
 * does not move, so a 0.05s difference is invisible, and the quantum bounds
 * how many distinct still frames (and style rules) a long session creates.
 */
export const stillClock = (s: number) => Math.round(s * 10) / 10;

/** The key of the still frame for a size and clock: one style rule per key. */
export const galaxyStillKey = (size: number, s: number = GALAXY_STATIC_TIME) => `${size}-${Math.round(stillClock(s) * 10)}`;

/**
 * The still frame as an SVG document (white on transparent: used as an alpha
 * mask). Dots are grouped by opacity (ten steps) so the document stays a few
 * kilobytes even at hero sizes; anything fainter than 4% is dropped.
 */
export function galaxyStillSvg(size: number, { s = GALAXY_STATIC_TIME }: { s?: number } = {}): string {
  const key = galaxyStillKey(size, s);
  const hit = cache.get(key);
  if (hit) return hit;
  const dots = galaxyDots(size, { s: stillClock(s), dpr: 2 });
  const groups = new Map<number, string[]>();
  for (const d of dots) {
    if (d.alpha < 0.04) continue;
    const step = Math.min(10, Math.max(1, Math.round(d.alpha * 10)));
    const list = groups.get(step) ?? [];
    list.push(`<circle cx='${r1(d.x)}' cy='${r1(d.y)}' r='${r1(Math.max(0.3, d.r))}'/>`);
    groups.set(step, list);
  }
  const c = size / 2;
  const coreR = galaxyCoreRadius(size);
  const body = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([step, circles]) => `<g fill-opacity='${step / 10}'>${circles.join("")}</g>`)
    .join("");
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' viewBox='0 0 ${size} ${size}' fill='white'>` +
    `<defs><radialGradient id='c'><stop offset='.45' stop-color='white'/><stop offset='1' stop-color='white' stop-opacity='0'/></radialGradient></defs>` +
    `<ellipse cx='${c}' cy='${c}' rx='${r1(coreR)}' ry='${r1(coreR * 0.78)}' fill='url(#c)' fill-opacity='.9'/>` +
    body +
    `</svg>`;
  if (cache.size > 256) cache.clear();
  cache.set(key, svg);
  return svg;
}

/** The still frame as a CSS url() for `mask-image`; only the characters a data URL needs are escaped. */
export function galaxyStillMask(size: number, opts?: { s?: number }): string {
  const svg = galaxyStillSvg(size, opts).replace(/</g, "%3C").replace(/>/g, "%3E").replace(/#/g, "%23");
  return `url("data:image/svg+xml,${svg}")`;
}

/** The style rule that gives `[data-galaxy-still="<key>"]` its mask: rendered once per key and hoisted. */
export function galaxyStillRule(size: number, s: number = GALAXY_STATIC_TIME): string {
  const key = galaxyStillKey(size, s);
  const mask = galaxyStillMask(size, { s });
  return `.alevr-galaxy-still[data-galaxy-still="${key}"]{-webkit-mask-image:${mask};mask-image:${mask}}`;
}
