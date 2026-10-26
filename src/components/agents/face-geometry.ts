/**
 * The geometry of an agent's face (docs/design/AGENTS.md §4): pure, no React,
 * no DOM, so the server draws the same still frame the client animates.
 *
 * Everything is measured in R, the radius of the resting orb (R = 1, y down).
 * The <svg> scales R to the face's size class (`SizeClass.Ru`, in a 64-unit
 * viewBox centred on the origin).
 *
 *  - BODIES are signed distance fields, traced offline (face-shapes.ts) into
 *    a table of outline points (face-outlines.ts) and drawn as a smooth closed
 *    Catmull-Rom path. Same point count for every body, so any body can morph
 *    into the thinking dot point for point. Every body is one closed mass:
 *    nothing is cut out of it and nothing rests on it.
 *  - EYES are two ink cuts on a sphere with a real head frame (yaw, pitch,
 *    roll): the lean and the narrower far eye come from the projection, and on
 *    a turn the eyes slide behind the limb. Expressions restyle the stored
 *    cut (smile lifts the lower lid into a bowed capsule; worry shortens and
 *    leans it, as Grok's sad does), so `eyes` keeps its character in every
 *    state and no expression ever draws a corner.
 *  - THE ORBIT is Juno's open ring with its ball terminal, seen from just
 *    above: the back half passes behind the body, the front half is cut clear
 *    of it through a mask, like stacked paper.
 *
 * `drawFace(spec, pose)` turns a pose (face-rig.ts) into attribute strings for
 * the fixed set of parts the component renders.
 */

import type { AgentEyes, AgentShape } from "@/lib/agents/avatar";
import { OUTLINES } from "./face-outlines";

export const D2R = Math.PI / 180;
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Three decimals in R: under a hundredth of a pixel at 160 px. */
export const f3 = (n: number) => String(Math.round(n * 1000) / 1000);
/** Smoothstep: 0 → 1 with a soft start and end. */
export const smooth01 = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------------ */
/* Bodies                                                                    */
/* ------------------------------------------------------------------------ */

/** A closed Catmull-Rom spline through the points, as cubic Béziers. */
export function outlinePath(pts: ArrayLike<number>): string {
  const N = pts.length / 2;
  const X = (i: number) => pts[((i + N) % N) * 2];
  const Y = (i: number) => pts[((i + N) % N) * 2 + 1];
  let d = `M${f3(X(0))} ${f3(Y(0))}`;
  for (let i = 0; i < N; i++) {
    const c1x = X(i) + (X(i + 1) - X(i - 1)) / 6;
    const c1y = Y(i) + (Y(i + 1) - Y(i - 1)) / 6;
    const c2x = X(i + 1) - (X(i + 2) - X(i)) / 6;
    const c2y = Y(i + 1) - (Y(i + 2) - Y(i)) / 6;
    d += `C${f3(c1x)} ${f3(c1y)} ${f3(c2x)} ${f3(c2y)} ${f3(X(i + 1))} ${f3(Y(i + 1))}`;
  }
  return `${d}Z`;
}

/** Where the eyes sit on a body: offset, layout scale, eye scale, and how much a head roll tilts it. */
export interface Seat {
  ox: number;
  oy: number;
  s: number;
  e: number;
  tilt: number;
}

/** Outline samples per body: enough for the tightest corner (spark tips, prism) at 160 px. */
export const OUTLINE_POINTS = 96;

/**
 * Where the eyes sit on each body, and the angle of the needs-you notch: upper
 * left, never Grok's upper-right corner. Petal's face sits in the round of the
 * drop and halo's in the broad lower half of its gumdrop; spark's notch sits
 * in the pocket between its top and left arms, never on a tip.
 */
const FIT: Record<AgentShape, { seat: Seat; badge: number }> = {
  orb: { seat: { ox: 0, oy: 0, s: 1, e: 1, tilt: 1 }, badge: -132 },
  pebble: { seat: { ox: 0, oy: 0.01, s: 1, e: 1, tilt: 1 }, badge: -138 },
  capsule: { seat: { ox: 0, oy: -0.1, s: 0.8, e: 0.9, tilt: 0.8 }, badge: -122 },
  petal: { seat: { ox: -0.02, oy: 0.1, s: 0.9, e: 0.94, tilt: 0.9 }, badge: -140 },
  bloom: { seat: { ox: 0, oy: 0.01, s: 0.93, e: 0.96, tilt: 0.8 }, badge: -135 },
  spark: { seat: { ox: 0, oy: 0.02, s: 0.8, e: 0.92, tilt: 0.5 }, badge: -135 },
  tile: { seat: { ox: 0, oy: 0, s: 0.98, e: 1, tilt: 0.55 }, badge: -135 },
  halo: { seat: { ox: 0, oy: 0.14, s: 0.86, e: 0.93, tilt: 0.8 }, badge: -128 },
  prism: { seat: { ox: 0, oy: 0.02, s: 0.92, e: 0.96, tilt: 0.8 }, badge: -120 },
};

export interface Body {
  /** The outline, clockwise from 12 o'clock, x,y interleaved. */
  pts: Float64Array;
  /** The resting outline as a path. */
  d: string;
  /** The lowest point of the outline (largest y): the orbit is fitted under it. */
  yMax: number;
  /** Centre of the needs-you notch. */
  badge: { x: number; y: number };
  seat: Seat;
}

const BODIES = new Map<string, Body>();
const parse = (list: string) => Float64Array.from(list.split(" "), Number);

/**
 * A body's geometry, from the traced table (face-shapes.ts → face-outlines.ts),
 * parsed once. `small` (20 to 40 px) takes the body's small-size outline where
 * it has one (bloom's clover), else its own.
 */
export function bodyOf(shape: AgentShape, small = false): Body {
  const row = OUTLINES[shape] ?? OUTLINES.orb;
  const list = small && row.small ? row.small : row.pts;
  const key = list === row.pts ? shape : `${shape}:small`;
  const hit = BODIES.get(key);
  if (hit) return hit;
  const fit = FIT[shape] ?? FIT.orb;
  const pts = parse(list);
  const [bx, by] = rimAt(pts, fit.badge, 0.07);
  let yMax = -Infinity;
  for (let i = 1; i < pts.length; i += 2) yMax = Math.max(yMax, pts[i]);
  const body: Body = {
    pts,
    d: outlinePath(pts),
    yMax,
    badge: { x: bx, y: by },
    seat: fit.seat,
  };
  BODIES.set(key, body);
  return body;
}

/** The body a face is drawn with: its small-size outline below 48 px. */
export const bodyFor = (spec: { shape: AgentShape; size: SizeClass }) => bodyOf(spec.shape, !spec.size.ring);

/** The outline point in a direction from the centre (degrees, y down), pulled in by `inset`. */
export function rimAt(pts: ArrayLike<number>, deg: number, inset = 0): [number, number] {
  const a = deg * D2R;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const N = pts.length / 2;
  // March the polygon for the ray's crossing: robust for every body here (all star-shaped).
  let best = 0;
  for (let i = 0; i < N; i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const bx = pts[((i + 1) % N) * 2];
    const by = pts[((i + 1) % N) * 2 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ey - ay * ex) / den;
    const s = (ax * uy - ay * ux) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  const r = Math.max(0, best - inset);
  return [ux * r, uy * r];
}

/* ------------------------------------------------------------------------ */
/* Eyes                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * The stored `eyes` value: four cuts of one family, every one a vertical
 * capsule (Grok keeps one, about 0.19 × 0.41 R). No disc, no slit, nothing
 * landscape: a horizontal pill reads bored or as sunglasses, a thin one as a
 * pause glyph. w × h in R; split is each eye's angle off centre.
 *
 *   soft   the default capsule
 *   round  a full, short oval, nearly as wide as it is tall
 *   tall   a long, slimmer capsule
 *   wide   broad capsules set well apart
 *
 * The four must tell apart in the studio's swatches (a crop of a 64 px face),
 * so each differs from soft by more than a pixel there in width, height or
 * spacing.
 */
export const CUT: Record<AgentEyes, { w: number; h: number; split: number }> = {
  soft: { w: 0.25, h: 0.46, split: 17 },
  round: { w: 0.34, h: 0.36, split: 18 },
  tall: { w: 0.21, h: 0.62, split: 15.5 },
  wide: { w: 0.28, h: 0.42, split: 26 },
};

/**
 * At 20 and 28 px the long cuts are capped at this height over width (round
 * and wide never reach it): drawn 2 × 4 or 2 × 6 px, two centred upright bars
 * are the pause glyph, and the product draws its own pause glyph beside them.
 */
export const SMALL_ASPECT: Partial<Record<AgentEyes, number>> = { soft: 1.45, tall: 1.75 };

/**
 * The least lean (degrees off upright) a pair of long cuts keeps, toward its
 * agent's side (`Pose.eyeLean`), in every pose at every size: two upright,
 * parallel, equal bars side by side are the pause glyph (⏸), never a pair of
 * eyes. Grok's eyes lean about 26° because its head rests rolled on a
 * sphere; Juno's calmer rest leans 10 to 13° the same way, and a pose that
 * would stand the pair up (facing the viewer, looking down at the work, a
 * pointer across the face) keeps at least this, as a roll of the pair about
 * its middle (drawFace). The longer the cut the more it keeps; round eyes are
 * not bars, and a state whose eyes are not a pair of open bars (worry and
 * the happy capsules lean them apart, paused closes them, thinking closes or
 * turns them away) lets it go on the clock (`Pose.leanW`).
 */
export const EYE_LEAN: Record<AgentEyes, number> = { soft: 9, round: 8, tall: 12, wide: 8 };
/** The knee of the lean floor (degrees): a pose leaning well past the floor keeps its own lean. */
const LEAN_KNEE = 2;
/** softplus, overflow-safe. */
const softplus = (x: number) => (x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x)));
/** At 20 and 28 px the happy capsule's ends drop this much of its width below its middle (0.1 from 48 px). */
export const SMALL_BEND = 0.24;

/** How far the eye line sits above the face's equator, on the sphere. */
const EYE_RAISE = 6;

export interface EyeFrame {
  x: number;
  y: number;
  /** Toward the viewer: below zero the eye has gone round the back. */
  z: number;
  /** The sphere's tangent "right" and "down" at the eye, projected. */
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  side: -1 | 1;
}

type V3 = [number, number, number];
function spin(u: V3, v: V3, a: number): [V3, V3] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

/** Head frame to two eyes, orthographic. Screen x right, y down, z toward the viewer. */
export function eyeFrames(yaw: number, pitch: number, roll: number, split: number): [EyeFrame, EyeFrame] {
  let f: V3 = [0, 0, 1];
  let r: V3 = [1, 0, 0];
  let d: V3 = [0, 1, 0];
  [f, r] = spin(f, r, yaw * D2R);
  [d, f] = spin(d, f, pitch * D2R);
  [r, d] = spin(r, d, roll * D2R);
  const one = (side: -1 | 1): EyeFrame => {
    const [ef0, er] = spin(f, r, split * side * D2R);
    const [ed, ef] = spin(d, ef0, EYE_RAISE * D2R);
    return { x: ef[0], y: ef[1], z: ef[2], ux: er[0], uy: er[1], vx: ed[0], vy: ed[1], side };
  };
  return [one(-1), one(1)];
}

/**
 * One eye: a capsule w × h, centred. `smile` lifts the lower lid: the cut
 * becomes a squashed capsule about half as thick as it is wide, bowed a little
 * (its ends `bend` × its width lower than its middle), with round caps: the
 * same family as the other cuts, never a `^ ^` caret (Grok's happy is a
 * capsule restyle too). There is no other lid cut: blocked's worry is the
 * same capsule shortened and leaned (the pose's eH and tilt), as Grok's sad
 * is, so no expression ever draws a corner. A closing lid is the cut at a
 * smaller `h`: a closed eye is a round-ended dash. `minT` keeps a cut eye a
 * readable thickness while the happy capsule forms, and `happyMin` is the
 * happy capsule's least thickness (drawFace keeps it well over a closed eye's
 * dash, so done never reads as asleep).
 */

/** Samples along each eye's top (and its bottom): 2 × 29 outline points, the same in every state, so any pose blends point for point. */
const EYE_SAMPLES = 28;

/** A closed polygon through x,y interleaved points. */
function polyPath(pts: ArrayLike<number>): string {
  let d = "";
  for (let i = 0; i < pts.length; i += 2) d += `${i ? "L" : "M"}${f3(pts[i])} ${f3(pts[i + 1])}`;
  return `${d}Z`;
}

/** The eye's outline as x,y interleaved points, clockwise from the left end of its top. */
export function eyePoints(w: number, h: number, smile: number, minT: number, happyMin = 0, bendK = 0.1): number[] {
  const r = Math.min(w, h) / 2;
  const c = w / 2 - r;
  const top = (x: number) => {
    const ax = Math.abs(x);
    return -h / 2 + (ax > c ? r - Math.sqrt(Math.max(0, r * r - (ax - c) ** 2)) : 0);
  };
  // Happy: a squashed capsule `t0` thick, its ends dropping only `bend`
  // below its middle (a lift of the lower lid, not an arch), its top where
  // the eye's top was.
  const t0 = Math.max(0.6 * Math.min(w, h), happyMin);
  const bend = bendK * w;
  const y0 = -h / 2 + t0 / 2;
  // Sampled by arc length along a capsule whose end caps have the radius of
  // the shape's own ends (the cut's, or the happy capsule's), so a round end
  // is drawn in even steps of under 12° however long and thin the eye is
  // (an upright cut is its cap all the way across, sampled by angle).
  const rc = Math.max(1e-6, Math.min(w / 2, lerp(r, t0 / 2, clamp01(smile))));
  const flat = w / 2 - rc;
  const arc = (Math.PI * rc) / 2;
  const total = 2 * arc + 2 * flat;
  const xAt = (s: number) => {
    const l = s * total;
    if (l <= arc) return -w / 2 + rc * (1 - Math.cos(l / rc));
    if (l >= total - arc) return w / 2 - rc * (1 - Math.cos((total - l) / rc));
    return -flat + (l - arc);
  };
  const xs: number[] = [];
  const tops: number[] = [];
  const bottoms: number[] = [];
  let thickest = 0;
  for (let i = 0; i <= EYE_SAMPLES; i++) {
    const x = xAt(i / EYE_SAMPLES);
    let yt = top(x);
    let yb = -yt;
    if (smile > 0.001) {
      const ax = Math.abs(x);
      const cap = w / 2 - t0 / 2;
      const half = ax <= cap ? t0 / 2 : Math.sqrt(Math.max(0, (t0 / 2) ** 2 - (ax - cap) ** 2));
      const mid = y0 + bend * ((2 * x) / w) ** 2;
      yt = lerp(yt, mid - half, smile);
      yb = lerp(yb, mid + half, smile);
    }
    xs.push(x);
    tops.push(yt);
    bottoms.push(yb);
    thickest = Math.max(thickest, yb - yt);
  }
  // The floor holds only while the happy capsule forms (its own round caps
  // are its ends). It thickens the whole profile about its centre line, never
  // sample by sample: clamping each sample squared the round ends into a bar.
  const floorT = minT * (1 - clamp01(smile));
  const k = thickest > 1e-9 && thickest < floorT ? floorT / thickest : 1;
  const T: number[] = [];
  const B: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const m = (tops[i] + bottoms[i]) / 2;
    const half = thickest > 1e-9 ? ((bottoms[i] - tops[i]) / 2) * k : floorT / 2;
    T.push(xs[i], m - half);
    B.push(xs[i], m + half);
  }
  for (let i = B.length - 2; i >= 0; i -= 2) T.push(B[i], B[i + 1]);
  return T;
}

/* ------------------------------------------------------------------------ */
/* Sizes                                                                     */
/* ------------------------------------------------------------------------ */

export interface SizeClass {
  key: "xs" | "sm" | "md" | "lg";
  /** R in the 64-unit viewBox. */
  Ru: number;
  /** Small faces look at the viewer, with larger cuts. */
  front: boolean;
  eye: number;
  /** The tilted orbit; below it the ball rides the rim in its own notch. */
  ring: boolean;
  /** The face spin as it kicks into gear. */
  spin: boolean;
  blinkSlow: boolean;
  /** Thinking dots and badges grow so they still read. */
  glyph: number;
  badge: number;
}

export function sizeClass(px: number): SizeClass {
  // Small thinking dots are zoomed so they still read, and span the slot
  // (a thinking agent keeps the weight of the faces beside it) but never
  // paint past it: the three dots stay a pixel inside the box on each side.
  if (px <= 24) return { key: "xs", Ru: 25, front: true, eye: 1.18, ring: false, spin: false, blinkSlow: true, glyph: 1.25, badge: 1.3 };
  if (px <= 40) return { key: "sm", Ru: 24.5, front: true, eye: 1.08, ring: false, spin: false, blinkSlow: true, glyph: 1.3, badge: 1.15 };
  if (px <= 64) return { key: "md", Ru: 22.5, front: false, eye: 1, ring: true, spin: true, blinkSlow: false, glyph: 1, badge: 1 };
  return { key: "lg", Ru: 22.5, front: false, eye: 1, ring: true, spin: true, blinkSlow: false, glyph: 1, badge: 1 };
}

/** The thinking dot's radius in R: the scale the body winds down to. */
export const morphScale = (size: SizeClass) => 0.23 * size.glyph;

/**
 * A point of a body winding into the thinking dot (`m` 0 → 1, toward a dot of
 * radius `dotR`): it slides onto the unit circle at its own angle over the
 * first 62% of the wind-down (every body is star-shaped) while the whole
 * shrinks, so the middle dot ends as round as its two neighbours and the
 * three read as an ellipsis, never ●◆● or ●■●. The turn away starts from the
 * body's own silhouette.
 */
export function morphPoint(x: number, y: number, m: number, dotR: number): [number, number] {
  const k = lerp(1, dotR, m);
  const c = smooth01(m / 0.62);
  const r = Math.hypot(x, y) || 1;
  return [lerp(x, x / r, c) * k, lerp(y, y / r, c) * k];
}

/** A body's outline as drawn `m` of the way into the thinking dot (x,y interleaved). */
export function morphOutline(src: ArrayLike<number>, m: number, dotR: number): Float64Array {
  const pts = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 2) {
    const [x, y] = morphPoint(src[i], src[i + 1], m, dotR);
    pts[i] = x;
    pts[i + 1] = y;
  }
  return pts;
}

/** Pixels per R for a face drawn at `px`. */
export const pxPerR = (px: number, size: SizeClass) => (px / 64) * size.Ru;

/* ------------------------------------------------------------------------ */
/* The pose, and drawing it                                                  */
/* ------------------------------------------------------------------------ */

/** Everything a frame needs, in R and degrees. face-rig.ts computes it; drawFace draws it. */
export interface Pose {
  /** 0 body, 1 the middle thinking dot. */
  morph: number;
  think: number;
  bx: number;
  by: number;
  bs: number;
  bsx: number;
  bsy: number;
  brot: number;
  yaw: number;
  pitch: number;
  froll: number;
  split: number;
  eS: number;
  eW: number;
  eH: number;
  tilt: number;
  lid: number;
  smile: number;
  ex: number;
  ey: number;
  ringP: number;
  ringGap: number;
  ringA: number;
  ringO: number;
  ballS: number;
  /** Below 48 px: 0 the rim ball rides its swing over the lower right, 1 it is parked at the upper right (rimBallAngle). */
  ballPark: number;
  badgeS: number;
  /** Weights for rest life: pointer look, blinks. */
  lookW: number;
  blinkW: number;
  /**
   * Which way the pair of eyes leans at the least (EYE_LEAN): the agent's
   * side, 1 `\` or −1 `/`. Blended, so a look saved under a running state
   * that rests the other way turns the lean over smoothly.
   */
  eyeLean: number;
  /**
   * How much of the lean floor (EYE_LEAN) the state keeps: 1 where its eyes
   * are a pair of open cuts, 0 where they are not bars (worry and the happy
   * capsules lean them apart, paused and a small face thinking close them, a
   * face thinking turns them away). Blended on the clock, so a change of
   * state rolls the pair over its own ease, never in a frame.
   */
  leanW: number;
  /* Raw (not blended): */
  ringPhase: number;
  ringSpeed: number;
  blinkMul: number;
  /**
   * On a snapshot (face-rig.ts): how shut the eyes were when the state
   * changed (1 open, every blink under way multiplied in), and whether that
   * blink was reopening (1) or closing or shut (−1), so the next state carries
   * it on instead of cutting it.
   */
  blinkC: number;
  blinkDir: number;
  spinYaw: number;
  badgeKind: "ball" | "bar" | null;
  /** The orbit's paint: `live` in the presence colour, `stalled` (blocked) in muted ink with its ball in the blocked red. */
  ringKind: "live" | "stalled";
  pulse: number;
}

/** The fields a state change blends; the rest are taken from the new state as they are. */
export const BLENDED = [
  "morph", "think", "bx", "by", "bs", "bsx", "bsy", "brot", "yaw", "pitch", "froll", "split",
  "eS", "eW", "eH", "tilt", "lid", "smile", "ex", "ey",
  "ringP", "ringGap", "ringA", "ringO", "ballS", "ballPark", "badgeS", "lookW", "blinkW", "eyeLean", "leanW",
] as const satisfies ReadonlyArray<keyof Pose>;
export type BlendedField = (typeof BLENDED)[number];

/**
 * The orbit, a 3D circle seen from above: long axis, aspect, roll, the least
 * drop below centre (orbitFrame drops it further under a long body), and the
 * stroke, cut-paper gap and ball at their largest sizes (each has a pixel
 * floor, see orbitFrame). Low and wide on purpose: the near half passes under
 * the body, never across the face (an arc under the eyes reads as a mouth)
 * and never through it, and the far half goes behind it.
 */
export const RING = { a: 1.38, ba: 0.44, roll: -11, oy: 0.5, w: 0.068, gap: 0.035, ball: 0.122 };
/** The lowest point of the tilted ring, as an angle on it (degrees): where a ball comes to rest when the orbit stalls. */
export const RING_LOWEST = Math.atan2(RING.ba * Math.cos(RING.roll * D2R), Math.sin(RING.roll * D2R)) / D2R;

export interface FaceSpec {
  shape: AgentShape;
  eyes: AgentEyes;
  size: SizeClass;
  px: number;
}

/** What drawFace adds on top of the pose: rest life, already resolved. */
export interface FaceExtras {
  /** Degrees added to yaw, pitch and roll (the pointer look). */
  yaw: number;
  pitch: number;
  roll: number;
  /** 1 open, toward 0 closed. */
  blink: number;
  /** Body lean toward the pointer, in R, and the roll that goes with it, in degrees. */
  lean: number;
  tilt: number;
}

export const NO_EXTRAS: FaceExtras = { yaw: 0, pitch: 0, roll: 0, blink: 1, lean: 0, tilt: 0 };

/** The parts the component renders, each a bag of attributes. */
export const PARTS = [
  "g",
  "rBack",
  "bBack",
  "masked",
  "d0",
  "d1",
  "bodyT",
  "body",
  "eyes",
  "e0",
  "e1",
  "rFront",
  "bFront",
  "badgeT",
  "badgeBall",
  "badgeBar",
  "kRing",
  "kBall",
  "kBodyT",
  "kBadge",
] as const;
export type Part = (typeof PARTS)[number];
export type FaceFrame = Record<Part, Record<string, string>>;

const HIDDEN_CIRCLE = { r: "0" };
const HIDDEN_RECT = { x: "0", y: "0", width: "0", height: "0", rx: "0" };
const thinkPulse = (P: Pose, i: number) => {
  if (P.think <= 0) return 0;
  // The chat's thinking rhythm: 1.4 s, each dot rising in turn.
  const l = (((P.pulse - 0.15 - i * 0.2) % 1.4) + 1.4) % 1.4;
  return l < 0.6 ? 0.5 - 0.5 * Math.cos((2 * Math.PI * l) / 0.6) : 0;
};

/**
 * Distance from a point to a horizontal stadium (a rounded rect whose corner
 * radius is its shorter half side) centred at (cx, cy); a disc when hw = hh.
 * Negative inside.
 */
export function stadiumDistance(x: number, y: number, cx: number, cy: number, hw: number, hh: number): number {
  const r = Math.min(hw, hh);
  const ax = Math.max(0, hw - r);
  const ay = Math.max(0, hh - r);
  const dx = Math.max(0, Math.abs(x - cx) - ax);
  const dy = Math.max(0, Math.abs(y - cy) - ay);
  return Math.hypot(dx, dy) - r;
}

/** A clamp with a soft knee: 0 well clear, the deficit itself well inside, smooth between. */
function softPush(deficit: number, knee: number) {
  if (deficit >= knee) return deficit;
  if (deficit <= -knee) return 0;
  return ((deficit + knee) * (deficit + knee)) / (4 * knee);
}

/** The needs-you notch (in the body's frame): its centre and half sizes, and the glyph inside it. */
export interface BadgeGeometry {
  x: number;
  y: number;
  /** Knockout half width and height: a disc round the ball, a stadium round the bar. */
  hw: number;
  hh: number;
  ballR: number;
  barW: number;
  barH: number;
}

/**
 * The notch for a pose, or null when there is none. Below 48 px it keeps at
 * least 1.25 CSS px of page round the glyph and the blocked bar is a real bar
 * (2.5 balls wide), so blocked and waiting differ by shape, not hue alone.
 * From 48 px the air is a cut (a pixel, or 5% of the badge), never a ring of
 * page round a sticker; blocked carries no badge there (the stalled orbit).
 */
export function badgeGeometry(spec: FaceSpec, P: Pose): BadgeGeometry | null {
  if (!P.badgeKind || P.badgeS <= 0.001) return null;
  const sz = spec.size;
  const B = bodyFor(spec);
  const pxR = pxPerR(spec.px, sz);
  const small = sz.key === "xs" || sz.key === "sm";
  const bS = P.badgeS * sz.badge;
  // Grows in with the badge, so the hole never appears before its glyph.
  const ramp = clamp01(P.badgeS / 0.3);
  const ballR = 0.19 * bS;
  const air = small ? Math.max(0.08 * bS + (sz.badge - 1) * 0.04, (1.25 / pxR) * ramp) : Math.max(0.05 * bS, (1 / pxR) * ramp);
  const barW = ballR * (small ? 2.5 : 1.9);
  const barH = small ? Math.max(ballR * 0.9, (1.6 / pxR) * ramp) : ballR * 0.82;
  const bar = P.badgeKind === "bar";
  return {
    x: B.badge.x,
    y: B.badge.y,
    hw: Math.max(0, (bar ? barW / 2 : ballR) + air),
    hh: Math.max(0, (bar ? barH / 2 : ballR) + air),
    ballR,
    barW,
    barH,
  };
}

/** How much page an eye keeps round the needs-you notch, in R: never under one pixel. */
export const eyeNotchMargin = (spec: FaceSpec) => Math.max(0.06, 1 / pxPerR(spec.px, spec.size));
/**
 * The pair's lean as drawn, in degrees off upright (+ is `\`): the mean of
 * the two eyes' long axes on the sphere, less the body's own turn (the eyes
 * ride inside it). Their mirrored tilt (worry, happiness) cancels out.
 */
export function pairLean(frames: readonly [EyeFrame, EyeFrame], bodyRot: number) {
  return (Math.atan2(frames[0].vx, frames[0].vy) + Math.atan2(frames[1].vx, frames[1].vy)) / (2 * D2R) - bodyRot;
}

/**
 * The extra roll (degrees, SVG's sense) that keeps a pair of long cuts off
 * upright (EYE_LEAN). Continuous in every input, and let go only on the
 * clock: its weight is the state's `leanW`, blended over the change's own
 * ease, never a threshold on the lid, the smile or the worry, whose eases
 * start steep enough to release the whole roll in a frame or two. `aspect`
 * is the stored cut's (as the size draws it): a round cut is not a bar and
 * keeps none. It also fades as the head turns far enough that the far eye is
 * plainly the narrower (the two no longer alike: under 0.7 of the near one's
 * depth, gone by 0.3; the face spin coming home eases into its lean this
 * way), as either eye nears the limb, and with `eyeLean` itself. A blink
 * never turns the eyes.
 */
function pairRoll(spec: FaceSpec, P: Pose, frames: readonly [EyeFrame, EyeFrame], aspect: number, bodyRot: number) {
  const dir = clamp(P.eyeLean ?? 0, -1, 1);
  const held = clamp01(P.leanW ?? 1);
  if (dir === 0 || held === 0) return 0;
  const long = smooth01((aspect - 1.2) / 0.3);
  // Depth toward the viewer of the far eye and of the near one.
  const zFar = Math.min(frames[0].z, frames[1].z);
  const zNear = Math.max(frames[0].z, frames[1].z);
  const facing = zNear > 0 ? smooth01((zFar - 0.1) / 0.25) * smooth01((zFar / zNear - 0.3) / 0.4) : 0;
  const weight = Math.abs(dir) * held * long * facing;
  if (weight <= 0) return 0;
  const side = Math.sign(dir);
  const F = EYE_LEAN[spec.eyes] ?? EYE_LEAN.soft;
  const y = side * pairLean(frames, bodyRot);
  const floored = F + LEAN_KNEE * softplus((y - F) / LEAN_KNEE);
  // More lean (`\` is +) is a counter-clockwise turn on screen (y down).
  return -side * weight * (floored - y);
}

/** The least body kept between the two eyes at 20 to 40 px (CSS px): at 1x, a column of body that reads, so two cuts never fuse into one shape. */
export const EYE_GAP_PX = 1.25;

/** An eye as drawFace places it: its open outline, the open eye's frame, and its centre. */
interface PlacedEye {
  open: ArrayLike<number>;
  o00: number;
  o01: number;
  o10: number;
  o11: number;
  cx: number;
  cy: number;
}

/**
 * The body between two open eyes, measured along the line joining their
 * centres (in R). Never more than the true distance between the outlines,
 * so a pair kept this far apart is at least as far apart everywhere.
 */
function pairGap(a: PlacedEye, b: PlacedEye) {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L;
  const uy = dy / L;
  let hiA = -Infinity;
  let loB = Infinity;
  for (let i = 0; i < a.open.length; i += 2) {
    const x = a.open[i];
    const y = a.open[i + 1];
    hiA = Math.max(hiA, (a.o00 * x + a.o01 * y) * ux + (a.o10 * x + a.o11 * y) * uy);
  }
  for (let i = 0; i < b.open.length; i += 2) {
    const x = b.open[i];
    const y = b.open[i + 1];
    loB = Math.min(loB, (b.o00 * x + b.o01 * y) * ux + (b.o10 * x + b.o11 * y) * uy);
  }
  return L + loB - hiA;
}

/** The nearest an eye centre is ever pushed to the body's edge to keep clear of a notch, in R. */
export const EYE_EDGE_INSET = 0.1;

/**
 * One frame. `ids` are the face's mask and clip ids (the component's useId).
 * Pure: the same pose draws the same strings on the server and the client.
 */
export function drawFace(spec: FaceSpec, P: Pose, X: FaceExtras, ids: { mask: string; clip: string; body: string }): FaceFrame {
  const sz = spec.size;
  const B = bodyFor(spec);
  const seat = B.seat;
  const cut = CUT[spec.eyes];
  const pxR = pxPerR(spec.px, sz);
  const out = {} as FaceFrame;
  out.g = { transform: `scale(${sz.Ru})` };

  /* Thinking: the body is the middle of three dots. */
  const think = P.think;
  const gl = sz.glyph;
  const dotR = morphScale(sz);
  const pm = thinkPulse(P, 1);
  const bx = P.bx + X.lean;
  const bodyT = `translate(${f3(bx)} ${f3(P.by - 0.16 * pm * think * gl)}) rotate(${f3(P.brot * seat.tilt + X.tilt)}) scale(${f3(P.bs * (1 + 0.16 * pm * think))}) translate(0 1) scale(${f3(P.bsx)} ${f3(P.bsy)}) translate(0 -1)`;
  out.bodyT = { transform: bodyT };
  out.kBodyT = { transform: bodyT };
  out.badgeT = { transform: bodyT };

  /* The body path: resting, or winding down into the middle dot. It rounds
     as it shrinks (morphPoint), so the middle dot is a dot like the two
     beside it and every agent thinks with the same ellipsis. */
  const m = P.morph;
  let d = B.d;
  if (m > 0.0005) d = outlinePath(morphOutline(B.pts, m, dotR));
  out.body = { id: ids.body, d };

  /* The two side dots grow out of the flanks from nothing, and shrink back into them. */
  ([0, 2] as const).forEach((i, j) => {
    const key = j === 0 ? "d0" : "d1";
    if (think < 0.001) {
      out[key] = { ...HIDDEN_CIRCLE, cx: "0", cy: "0" };
      return;
    }
    const side = i === 0 ? -1 : 1;
    const pv = thinkPulse(P, i);
    const sp = 1 - Math.pow(1 - clamp01(think), 3);
    out[key] = {
      cx: f3(bx + side * lerp(0.3, 0.64, sp) * gl),
      cy: f3(P.by - 0.16 * pv * gl * think),
      r: f3(dotR * sp * (1 + 0.16 * pv)),
    };
  });

  /* The needs-you notch, measured before the eyes so they can keep clear of it. */
  const badge = badgeGeometry(spec, P);

  /* Eyes on a sphere. */
  const yaw = P.yaw + P.spinYaw + X.yaw;
  const pitch = P.pitch + X.pitch;
  const roll = P.froll + X.roll;
  const frames = eyeFrames(yaw, pitch, roll, P.split);
  const eyeK = seat.e * sz.eye * P.eS;
  // Pixel floors: an eye never thins below what 20 px can show, and a closed
  // eye (a dash) covers at least one whole device row at 1x when small.
  const small = sz.key === "xs" || sz.key === "sm";
  const wCut = small ? Math.max(cut.w * eyeK, 1.8 / pxR) : cut.w * eyeK;
  // Small, a long cut is shortened (before the state's own stretch) so the
  // pair reads as eyes, never as two bars: two equal upright bars side by
  // side are the pause glyph.
  const hCut = small ? Math.min(cut.h * eyeK, (SMALL_ASPECT[spec.eyes] ?? Infinity) * wCut) : cut.h * eyeK;
  let w = cut.w * eyeK * P.eW;
  const h = hCut * P.eH;
  const floor = Math.max(0.07, (small ? 1.8 : 1.2) / pxR);
  // Small, the happy capsule is a little thinner (1.25 dashes rather than
  // 1.4), so it reads as a bowed capsule and not as a smaller dot, and still
  // thicker than paused's dash.
  const happyMin = floor * (small ? 1.25 : 1.4);
  if (small) {
    w = Math.max(w, 1.8 / pxR);
    // Done widens the eyes into happy capsules; small, never so far that the
    // capsule is thinner than 0.45 of its width (a caret). (However wide, the
    // pair never touches: below.)
    if (P.smile > 0.01) {
      const thick = Math.max(0.6 * Math.min(w, h), happyMin);
      w = Math.min(w, Math.max(wCut, thick / 0.47));
    }
  }
  let needClip = m > 0.01;
  // The lid closes the cut itself (never a squash of it), so a closing eye
  // ends as a round-ended dash, not a lens with pointed ends.
  const lidDrawn = Math.max(P.lid * X.blink * P.blinkMul, floor / h);
  // The lid without blinks: what the eyes keep clear of must not twitch when the face blinks.
  const lidOpen = Math.max(P.lid, floor / h);
  /* One cut, the same for both eyes, at a width. Small, the happy capsule
     bows more (its ends at least 0.9 px below its middle), so the curve still
     shows at 20 px. The thickness a cut eye keeps while the happy capsule
     forms or lets go: continuous in the smile (no step as it starts or ends),
     and taken from the eye as drawn, so a blink or a closing lid ends on the
     same round-ended dash as everywhere else, never held open as a bar. */
  const cutAt = (wE: number) => {
    const bend = small ? Math.max(SMALL_BEND, 0.9 / (pxR * wE)) : 0.1;
    const cutMin = Math.max(Math.min(wE, h * lidDrawn) * 0.5, floor * 1.1) * smooth01(P.smile / 0.3);
    const pts = eyePoints(wE, h * lidDrawn, P.smile, cutMin, happyMin, bend);
    return { pts, open: lidOpen === lidDrawn ? pts : eyePoints(wE, h * lidOpen, P.smile, cutMin, happyMin, bend) };
  };
  let cut0 = cutAt(w);
  // An expression's lean (worry, happiness) levels as a blink shuts the eye,
  // in the shorter half of its closing, so a shut eye is a level dash: as
  // Grok's blink, a squash on screen, turns a leaned cut level as it thins
  // (never a lens: the lid still closes the cut itself). A worried pair
  // mid-blink never reads `\ /`, the scowl. Only what is drawn levels; what
  // the eyes keep clear of is measured on the open eye.
  const level = smooth01((X.blink * P.blinkMul - 0.06) / 0.6);
  const eyes = frames.map((F) => {
    // Hidden by the turn (the limb), and only late in the wind-down by fading:
    // a face that turns away is seen going round, never deleted.
    const vis = clamp01((F.z - 0.03) / 0.14) * (1 - clamp01((m - 0.4) / 0.25));
    if (vis <= 0.001) return null;
    if (F.z < 0.62) needClip = true;
    const tau = (F.side < 0 ? 1 : -1) * P.tilt * D2R;
    const c = Math.cos(tau * level);
    const s = Math.sin(tau * level);
    const co = Math.cos(tau);
    const so = Math.sin(tau);
    return {
      F,
      vis,
      pts: cut0.pts,
      open: cut0.open,
      a00: F.ux * c + F.vx * s,
      a01: -F.ux * s + F.vx * c,
      a10: F.uy * c + F.vy * s,
      a11: -F.uy * s + F.vy * c,
      // The open eye's frame.
      o00: F.ux * co + F.vx * so,
      o01: -F.ux * so + F.vx * co,
      o10: F.uy * co + F.vy * so,
      o11: -F.uy * so + F.vy * co,
      cx: seat.ox + seat.s * F.x + P.ex,
      cy: seat.oy + seat.s * F.y + P.ey,
    };
  });

  /* Small, the two eyes never touch: at least EYE_GAP_PX of body between
     them along the line joining them, in every state (a round cut is nearly
     as wide as the space between two eyes on a narrow seat; at 20 px a pair
     closer than that fuses into one blob, or paused's dashes into a minus).
     Both narrow together, never under the 1.8 px floor, and never move: the
     pair keeps its spacing, so the four cuts still tell apart. */
  const [ea, eb] = eyes;
  if (small && ea && eb) {
    // In the body's frame, which the body's own scale (blocked sinks to 0.97) shrinks on screen.
    const need = EYE_GAP_PX / (pxR * P.bs * Math.min(P.bsx, P.bsy)) + 0.002;
    const wMin = Math.min(w, 1.8 / pxR);
    let g = pairGap(ea, eb);
    let wPrev = w;
    let gPrev = g;
    for (let it = 0; it < 4 && g < need - 1e-4 && w > wMin + 1e-6; it++) {
      // Narrowing both eyes by δ opens the gap by about δ (less on a turned,
      // foreshortened pair): a first step at that, then by the secant.
      const slope = it === 0 ? 1 : clamp((g - gPrev) / Math.max(1e-6, wPrev - w), 0.2, 2);
      wPrev = w;
      gPrev = g;
      w = Math.max(wMin, w - (need - g) / slope);
      cut0 = cutAt(w);
      for (const e of [ea, eb]) {
        e.pts = cut0.pts;
        e.open = cut0.open;
      }
      g = pairGap(ea, eb);
    }
  }

  /* Never the pause glyph: a pair of long cuts that would stand upright and
     parallel rolls about its middle until it leans the agent's way by at
     least EYE_LEAN (a soft floor: a pose already leaning past it is left as
     it is). Before the clearance below, so what the eyes keep clear of is
     measured as they are drawn. A rigid turn of the pair: their gap holds. */
  const roll2 = pairRoll(spec, P, frames, hCut / wCut, P.brot * seat.tilt + X.tilt);
  if (roll2 !== 0) {
    const c = Math.cos(roll2 * D2R);
    const s = Math.sin(roll2 * D2R);
    // About the middle of the pair, both eyes counted, seen or not, so the pivot never jumps.
    const mx = seat.ox + (seat.s * (frames[0].x + frames[1].x)) / 2 + P.ex;
    const my = seat.oy + (seat.s * (frames[0].y + frames[1].y)) / 2 + P.ey;
    for (const e of eyes) {
      if (!e) continue;
      [e.a00, e.a10] = [c * e.a00 - s * e.a10, s * e.a00 + c * e.a10];
      [e.a01, e.a11] = [c * e.a01 - s * e.a11, s * e.a01 + c * e.a11];
      [e.o00, e.o10] = [c * e.o00 - s * e.o10, s * e.o00 + c * e.o10];
      [e.o01, e.o11] = [c * e.o01 - s * e.o11, s * e.o01 + c * e.o11];
      const dx = e.cx - mx;
      const dy = e.cy - my;
      e.cx = mx + c * dx - s * dy;
      e.cy = my + s * dx + c * dy;
    }
  }

  /* Clearance: what the eyes keep clear of, in the body's frame. The
     needs-you notch (the waiting glance goes right at it) or, with no notch,
     the small faces' working ball on the rim (once a notch opens, a rim ball
     still sinking is not chased: the rig sinks it before the notch opens).
     When an eye comes near one, both slide away from it together rather than
     be bitten. */
  let ob: { x: number; y: number; hw: number; hh: number } | null = badge;
  if (!badge && !sz.ring && P.ballS > 0.002 && P.ringO > 0.002) {
    const [rx0, ry0] = rimAt(B.pts, rimBallAngle(P.ringPhase, P.ballPark), -0.02);
    const [rx, ry] = m > 0.0005 ? morphPoint(rx0, ry0, clamp01(m), dotR) : [rx0, ry0];
    const rk = (rimBallR(sz, P) + rimBallAir(pxR, P)) / P.bs;
    ob = { x: rx, y: ry, hw: rk, hh: rk };
  }
  let sx = 0;
  let sy = 0;
  const live = eyes.filter((e) => e !== null);
  if (ob && live.length) {
    const o = ob;
    const margin = eyeNotchMargin(spec);
    const gap = () => {
      let min = Infinity;
      for (const e of live) {
        for (let i = 0; i < e.open.length; i += 2) {
          const x = e.open[i];
          const y = e.open[i + 1];
          const X2 = e.o00 * x + e.o01 * y + e.cx + sx;
          const Y2 = e.o10 * x + e.o11 * y + e.cy + sy;
          min = Math.min(min, stadiumDistance(X2, Y2, o.x, o.y, o.hw, o.hh));
        }
      }
      return min;
    };
    // Away from it, along the line from it to the middle of the pair. Both
    // eye frames count, seen or not, so the direction never switches as an
    // eye comes into view.
    const dx = seat.ox + (seat.s * (frames[0].x + frames[1].x)) / 2 + P.ex - o.x;
    const dy = seat.oy + (seat.s * (frames[0].y + frames[1].y)) / 2 + P.ey - o.y;
    const L = Math.hypot(dx, dy) || 1;
    // A hair over the margin, so the frame as written (three decimals) still keeps it.
    for (let it = 0; it < 12; it++) {
      const deficit = margin + 0.002 - gap();
      const push = it === 0 ? softPush(deficit, 0.04) : deficit > 0 ? deficit + 0.001 : 0;
      if (push <= 1e-4) break;
      sx += (dx / L) * push;
      sy += (dy / L) * push;
    }
    // A slide, never an eviction: no eye centre is pushed nearer the edge
    // than EYE_EDGE_INSET (one that already sits nearer may go no further
    // than just inside it), so whatever the notch asks, the face keeps its eyes.
    if (sx !== 0 || sy !== 0) {
      const outline = m > 0.0005 ? morphOutline(B.pts, m, dotR) : B.pts;
      const limit = live.map((e) => {
        const at = outsideBy(outline, e.cx, e.cy);
        return at <= -EYE_EDGE_INSET ? -EYE_EDGE_INSET : Math.max(at, -0.02);
      });
      const fits = (k: number) => live.every((e, j) => outsideBy(outline, e.cx + sx * k, e.cy + sy * k) <= limit[j]);
      if (!fits(1)) {
        let lo = 0;
        let hi = 1;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        sx *= lo;
        sy *= lo;
      }
    }
    if (Math.hypot(sx, sy) > 0.01) needClip = true;
  }

  eyes.forEach((e, j) => {
    const key = j === 0 ? "e0" : "e1";
    if (!e) {
      out[key] = { d: "", transform: "", opacity: "0" };
      return;
    }
    out[key] = {
      d: polyPath(e.pts),
      transform: `matrix(${f3(e.a00)} ${f3(e.a10)} ${f3(e.a01)} ${f3(e.a11)} ${f3(e.cx + sx)} ${f3(e.cy + sy)})`,
      opacity: e.vis >= 0.999 ? "1" : f3(e.vis),
    };
  });
  out.eyes = needClip ? { "clip-path": `url(#${ids.clip})` } : {};

  /* The orbit (md and up) or the ball riding the rim (below). */
  const ring = drawOrbit(spec, P, B, bx);
  out.rBack = ring.rBack;
  out.rFront = ring.rFront;
  out.kRing = ring.kRing;
  out.bBack = ring.bBack;
  out.bFront = ring.bFront;
  out.kBall = ring.kBall;

  /* Needs you, in a notch at the upper left: the ember ball (waiting) or a bar in the blocked ink. */
  let knock = ring.knock;
  if (badge) {
    const { x, y, hw, hh } = badge;
    out.kBadge = { x: f3(x - hw), y: f3(y - hh), width: f3(2 * hw), height: f3(2 * hh), rx: f3(Math.min(hw, hh)) };
    if (P.badgeKind === "ball") {
      out.badgeBall = { cx: f3(x), cy: f3(y), r: f3(badge.ballR) };
      out.badgeBar = { ...HIDDEN_RECT };
    } else {
      out.badgeBall = { ...HIDDEN_CIRCLE, cx: "0", cy: "0" };
      out.badgeBar = { x: f3(x - badge.barW / 2), y: f3(y - badge.barH / 2), width: f3(badge.barW), height: f3(badge.barH), rx: f3(badge.barH / 2) };
    }
    knock = true;
  } else {
    out.kBadge = { ...HIDDEN_RECT };
    out.badgeBall = { ...HIDDEN_CIRCLE, cx: "0", cy: "0" };
    out.badgeBar = { ...HIDDEN_RECT };
  }
  out.badgeT["data-kind"] = P.badgeKind ?? "";
  out.masked = knock ? { mask: `url(#${ids.mask})` } : {};
  return out;
}

type Attrs = Record<string, string>;
interface OrbitParts {
  rBack: Attrs;
  rFront: Attrs;
  kRing: Attrs;
  bBack: Attrs;
  bFront: Attrs;
  kBall: Attrs;
  /** Whether anything is cut out of the body (so the mask is needed). */
  knock: boolean;
}

/**
 * Where the small faces' rim ball sits (degrees, y down). Riding, it swings
 * over the lower right (24° to 68°), never under the eyes (a mouth) or on the
 * eye line (a third eye). Parked (the reduced-motion still, a still copy), it
 * waits at the upper right, where the logo's ball terminal sits: a ball held
 * still at the lower right is every chat app's online dot, and the upper left
 * is the needs-you notch's.
 */
export const RIM_PARK = -60;
export const rimBallAngle = (ringPhase: number, park = 0) => lerp(46 + 22 * Math.sin(ringPhase * D2R), RIM_PARK, park);
/** The small faces' rim ball, and the page kept round it (at least 1.25 CSS px). */
const rimBallR = (sz: SizeClass, P: Pose) => 0.2 * sz.badge * P.ballS;
const rimBallAir = (pxR: number, P: Pose) => Math.max(0.08, 1.25 / pxR) * P.ballS;

const DROPS = new Map<string, number>();

/**
 * How far below the body's centre the orbit's centre sits, fitted to the body
 * as drawn (its scale, squash and roll): at the bottom, the stroke, its
 * cut-paper gap, a pixel and 0.03 R of air under the lowest point; and
 * nowhere along the near half less than the stroke and its gap (a lobe or a
 * corner off the centre line can sit lower than the line under the middle).
 * Cached: the fit is the same for every frame of a steady state.
 */
function ringDrop(shape: AgentShape, B: Body, P: Pose, A: number, Bv: number, need: number, px1: number): number {
  const rot = P.brot * B.seat.tilt;
  const key = `${shape}|${f3(A)}|${f3(need)}|${f3(px1)}|${f3(P.bs)}|${f3(P.bsx)}|${f3(P.bsy)}|${rot.toFixed(1)}`;
  const hit = DROPS.get(key);
  if (hit !== undefined) return hit;
  // The outline as drawn, relative to the body's centre (drawFace's bodyT, less its translation).
  const c = Math.cos(rot * D2R);
  const sn = Math.sin(rot * D2R);
  const N = B.pts.length / 2;
  const pts = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    const x = B.pts[i * 2] * P.bsx * P.bs;
    const y = ((B.pts[i * 2 + 1] - 1) * P.bsy + 1) * P.bs;
    pts[i * 2] = x * c - y * sn;
    pts[i * 2 + 1] = x * sn + y * c;
  }
  const rr = RING.roll * D2R;
  const cr = Math.cos(rr);
  const sr = Math.sin(rr);
  // The least clearance of the near half, at a drop.
  const clearance = (oy: number) => {
    let min = Infinity;
    for (let k = 1; k < 72; k++) {
      const phi = (Math.PI * k) / 72;
      const ex = A * Math.cos(phi);
      const ey = Bv * Math.sin(phi);
      min = Math.min(min, outsideBy(pts, ex * cr - ey * sr, oy + ex * sr + ey * cr));
    }
    return min;
  };
  let yMax = -Infinity;
  for (let i = 1; i < pts.length; i += 2) yMax = Math.max(yMax, pts[i]);
  let oy = Math.max(RING.oy, yMax + need + px1 + 0.03 - Bv);
  // Then down until the whole near half keeps its gap (with a hair to spare between samples).
  for (let it = 0; it < 8; it++) {
    const deficit = need + 0.012 - clearance(oy);
    if (deficit <= 0) break;
    oy += deficit + 0.004;
  }
  if (DROPS.size > 400) DROPS.clear();
  DROPS.set(key, oy);
  return oy;
}

/** How far a point lies outside a closed polygon (x,y interleaved); negative inside. */
function outsideBy(pts: ArrayLike<number>, x: number, y: number): number {
  const n = pts.length / 2;
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const ex = pts[j * 2] - ax;
    const ey = pts[j * 2 + 1] - ay;
    const t = clamp01(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
    if (ay > y !== ay + ey > y && x < (ex * (y - ay)) / ey + ax) inside = !inside;
  }
  return inside ? -d : d;
}

/** How far round from the ring's phase its ball sits, in degrees: one ball-width from the far terminal. */
export const BALL_LEAD = 12;

/** The orbit as drawn for a pose (md and up): the ellipse, its paint widths, and where its ball and arc run. */
export interface OrbitFrame {
  A: number;
  Bv: number;
  /** Centre drop below the body's centre, fitted under its lowest point. */
  oy: number;
  sw: number;
  gapK: number;
  ballR: number;
  /** The ball's angle and the drawn arc [start, end], in radians; the arc runs forward from the ball. */
  ballPhi: number;
  start: number;
  end: number;
  pt(phi: number): [number, number];
}

/**
 * The orbit for a pose. The near half must pass under the body, never across
 * it (an arc under the eyes reads as a mouth, and an arc through the body
 * reads as a rendering bug), so its centre is dropped per body until the
 * front arc keeps its cut-paper gap and a pixel of air below the body's
 * lowest point.
 */
export function orbitFrame(spec: FaceSpec, P: Pose, bx = P.bx): OrbitFrame {
  const sz = spec.size;
  const B = bodyFor(spec);
  const pxR = pxPerR(spec.px, sz);
  // Pixel floors: at 48 px a 1.6 px ring and a 2.6 px ball; at 160 px the
  // knockout is a hairline separation, not a slice out of the body.
  const sw = Math.max(RING.w, 1.6 / pxR);
  const gapK = Math.max(RING.gap, 0.9 / pxR);
  // While the body winds down into the thinking dot, an orbit still on its
  // way out winds down with it, about the body's centre: the whole agent
  // goes small as one, and no ring or ball is left hanging at full size
  // round a body that has already shrunk.
  const km = lerp(1, morphScale(sz), clamp01(P.morph));
  const ballR = Math.max(RING.ball, 2.6 / pxR) * km;
  const A0 = RING.a * P.ringA;
  const oy = ringDrop(spec.shape, B, P, A0, A0 * RING.ba, sw / 2 + gapK, 1 / pxR) * km;
  const A = A0 * km;
  const Bv = A * RING.ba;
  const rot = RING.roll * D2R;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  const pt = (phi: number): [number, number] => {
    const x = A * Math.cos(phi);
    const y = Bv * Math.sin(phi);
    return [bx + x * cr - y * sr, P.by + oy + x * sr + y * cr];
  };
  const ballPhi = (P.ringPhase + BALL_LEAD) * D2R;
  // The gap closes as the ring gets short, so its last stub reels into the
  // ball itself (never a dash left floating a gap ahead of it), and a ring
  // being thrown leaves the ball before the brand's gap opens.
  const gap = P.ringGap * D2R * Math.min(1, P.ringP / 0.25);
  // Anchored at the FRONT of the ball, so the ring grows in the ball's
  // direction of travel and reels back into it; whole, it is the same either way.
  const start = ballPhi + gap / 2;
  const end = start + (2 * Math.PI - gap) * P.ringP;
  return { A, Bv, oy, sw, gapK, ballR, ballPhi, start, end, pt };
}

function drawOrbit(spec: FaceSpec, P: Pose, B: Body, bx: number): OrbitParts {
  const sz = spec.size;
  const pxR = pxPerR(spec.px, sz);
  // The paint is set even while nothing is drawn, so an orbit about to appear
  // is already in its own colours (blocked never flashes the running blue).
  // `data-off` marks the parts as hidden: agent-face.css switches their paint
  // without a transition then, so the colour only ever blends on a visible
  // orbit that changes kind (working to blocked).
  const tone = P.ringKind === "stalled" ? "stalled" : "live";
  const none = { d: "", "data-tone": tone, "data-off": "" };
  const hidden = { ...HIDDEN_CIRCLE, cx: "0", cy: "0", "data-tone": tone, "data-off": "" };
  const empty: OrbitParts = {
    rBack: none,
    rFront: none,
    kRing: { d: "" },
    bBack: hidden,
    bFront: hidden,
    kBall: { ...HIDDEN_CIRCLE, cx: "0", cy: "0" },
    knock: false,
  };
  const show = P.ringO > 0.002 && (P.ringP > 0.002 || P.ballS > 0.002);
  if (!show) return empty;
  const op = P.ringO >= 0.999 ? "1" : f3(P.ringO);

  if (!sz.ring) {
    /* Small: the presence ball rides just outside the rim, a satellite in its
       own notch, always in front, swinging to and fro over the lower right.
       Working reads in every frame, and the eyes keep clear of its notch
       (drawFace). */
    if (P.ballS <= 0.002) return empty;
    const [rx0, ry0] = rimAt(B.pts, rimBallAngle(P.ringPhase, P.ballPark), -0.02);
    // On the rim as drawn: it rides in as the body winds into the dot.
    const [rx, ry] = P.morph > 0.0005 ? morphPoint(rx0, ry0, clamp01(P.morph), morphScale(sz)) : [rx0, ry0];
    const r = rimBallR(sz, P);
    const c = { cx: f3(bx + rx * P.bs), cy: f3(P.by + ry * P.bs) };
    return {
      ...empty,
      bFront: { ...c, r: f3(r), opacity: op, "data-tone": tone },
      // On teal, juniper and sage the presence blue is close in lightness,
      // so the page round it is what separates it.
      kBall: { ...c, r: f3(r + rimBallAir(pxR, P)) },
      knock: true,
    };
  }

  const O = orbitFrame(spec, P, bx);
  const { A, Bv, sw, gapK, start, end, ballPhi, pt } = O;
  let front = "";
  let back = "";
  if (end - start > 0.001) {
    // Split at the limb (phi = k·π): sin(phi) > 0 is the near half.
    const cuts = [start];
    let c = Math.ceil(start / Math.PI) * Math.PI;
    while (c < end) {
      if (c > start) cuts.push(c);
      c += Math.PI;
    }
    cuts.push(end);
    for (let i = 0; i < cuts.length - 1; i++) {
      const a0 = cuts[i];
      const a1 = cuts[i + 1];
      if (a1 - a0 < 1e-4) continue;
      const near = Math.sin((a0 + a1) / 2) > 0;
      const p0 = pt(a0);
      const p1 = pt(a1);
      const seg = `M${f3(p0[0])} ${f3(p0[1])}A${f3(A)} ${f3(Bv)} ${f3(RING.roll)} ${a1 - a0 > Math.PI ? 1 : 0} 1 ${f3(p1[0])} ${f3(p1[1])}`;
      if (near) front += seg;
      else back += seg;
    }
  }
  const bp = pt(ballPhi);
  const depth = Math.sin(ballPhi);
  const br = O.ballR * (1 + 0.1 * depth) * P.ballS;
  const inFront = depth > 0;
  const ball = { cx: f3(bp[0]), cy: f3(bp[1]), opacity: op, "data-tone": tone };
  // The ring is never seen without its ball: while it reels in, whatever is
  // left of it fades as the ball sinks below half size, so no stub of ring
  // outlives it. A whole ring keeps its opacity: a ball dipping to change its
  // paint (working ↔ blocked) never ghosts the ring pale.
  const ringO = P.ringO * (P.ringP < 0.999 ? clamp01(P.ballS / 0.5) : 1);
  const rop = ringO >= 0.999 ? "1" : f3(ringO);
  return {
    rBack: { d: back, "stroke-width": f3(sw), opacity: rop, "data-tone": tone },
    rFront: { d: front, "stroke-width": f3(sw), opacity: rop, "data-tone": tone },
    kRing: { d: front, "stroke-width": f3(sw + 2 * gapK), opacity: rop },
    bBack: { ...ball, r: inFront ? "0" : f3(Math.max(0, br)) },
    bFront: { ...ball, r: inFront ? f3(Math.max(0, br)) : "0" },
    kBall: { cx: ball.cx, cy: ball.cy, r: inFront && br > 0.001 ? f3(br + gapK) : "0", opacity: op },
    knock: front !== "" || (inFront && br > 0.001),
  };
}
