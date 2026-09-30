/**
 * The form grammars as pure math (no three.js, no DOM).
 *
 * Every body is one closed surface: a two-exponent superellipsoid
 *
 *     ( |x/a|^nh + |z/c|^nh )^(nv/nh) + |y/b|^nv = 1
 *
 * whose upper and lower halves have their own height `b` and profile exponent
 * `nv` (so a body can be domed on top and sit on a broad base), followed by
 * two gentle deformations: a taper (narrower toward the top) and a bend (the
 * lean). The horizontal exponent `nh` sets how square the cross-section is.
 *
 * The same functions build the three.js mesh, place the eyes on the surface,
 * draw the flat silhouette used as the no-WebGL fallback, and are what the
 * RealityKit port reimplements (RATIONALE.md, "Native").
 */

import type { AvatarEyes, AvatarProportions, AvatarShape } from "./avatar";

export interface FormParams {
  a: number;
  c: number;
  bTop: number;
  bBot: number;
  nh: number;
  nvTop: number;
  nvBot: number;
  taper: number;
  bend: number;
  /** Where the ground is (the lowest point of the body), in body units. */
  ground: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Each grammar maps the shared 0..1 proportions into its own narrow bands.
 * Bands were tuned by eye in the lab at 20 to 256 px: past them a pebble
 * reads as a bean, a bean as a pickle, a dome as a bell, an orb as a ball.
 */
export function formParams(shape: AvatarShape, p: AvatarProportions): FormParams {
  let f: Omit<FormParams, "ground">;
  switch (shape) {
    case "bean":
      f = {
        a: lerp(0.74, 0.86, p.width),
        bTop: lerp(1.06, 1.16, p.height),
        bBot: lerp(1.0, 1.08, p.height),
        c: lerp(0.66, 0.78, p.depth),
        nh: 2,
        nvTop: lerp(2.35, 2.0, p.round),
        nvBot: lerp(2.5, 2.1, p.round),
        taper: lerp(0.0, 0.06, p.taper),
        bend: (p.lean >= 0 ? 1 : -1) * lerp(0.07, 0.15, Math.abs(p.lean)),
      };
      break;
    case "dome":
      f = {
        a: lerp(0.98, 1.1, p.width),
        bTop: lerp(1.3, 1.44, p.height),
        bBot: 0.62,
        c: lerp(0.86, 0.98, p.depth),
        nh: lerp(2.35, 2.0, p.round),
        nvTop: lerp(2.25, 1.95, p.round),
        nvBot: 4.6,
        taper: lerp(0.02, 0.12, p.taper),
        bend: p.lean * 0.05,
      };
      break;
    case "orb":
      f = {
        a: lerp(0.97, 1.03, p.width),
        bTop: lerp(0.99, 1.04, p.height),
        bBot: 0.97,
        c: lerp(0.9, 0.98, p.depth),
        nh: 2,
        nvTop: 2,
        nvBot: 2.3,
        taper: 0,
        bend: 0,
      };
      break;
    case "cushion":
      f = {
        a: lerp(0.94, 1.02, p.width),
        bTop: lerp(0.92, 1.0, p.height),
        bBot: lerp(0.92, 1.0, p.height),
        c: lerp(0.76, 0.86, p.depth),
        nh: lerp(4.4, 3.4, p.round),
        nvTop: lerp(4.4, 3.4, p.round),
        nvBot: lerp(4.6, 3.6, p.round),
        taper: lerp(0.0, 0.05, p.taper),
        bend: p.lean * 0.04,
      };
      break;
    case "pebble":
    default:
      f = {
        a: lerp(0.86, 1.06, p.width),
        bTop: lerp(0.98, 1.14, p.height),
        bBot: lerp(0.88, 0.98, p.height),
        c: lerp(0.68, 0.84, p.depth),
        nh: lerp(2.6, 2.1, p.round),
        nvTop: lerp(2.55, 2.05, p.round),
        nvBot: lerp(3.4, 2.8, p.round),
        taper: lerp(0.02, 0.2, p.taper),
        bend: p.lean * 0.13,
      };
  }
  // Normalise every grammar to the same visual size: total height ~2.1, half width <= 1.05.
  const h = f.bTop + f.bBot;
  const k = Math.min(2.1 / h, 1.05 / f.a);
  const g = {
    a: f.a * k,
    c: f.c * k,
    bTop: f.bTop * k,
    bBot: f.bBot * k,
    nh: f.nh,
    nvTop: f.nvTop,
    nvBot: f.nvBot,
    taper: f.taper,
    bend: f.bend,
  };
  // Centre the body vertically on the origin.
  return { ...g, ground: -(g.bTop + g.bBot) / 2 };
}

/** Distance from the implicit centre to the surface along a unit direction. */
function radius(f: FormParams, dx: number, dy: number, dz: number): number {
  const up = dy >= 0;
  const b = up ? f.bTop : f.bBot;
  const nv = up ? f.nvTop : f.nvBot;
  const hx = Math.pow(Math.abs(dx) / f.a, f.nh) + Math.pow(Math.abs(dz) / f.c, f.nh);
  const g = Math.pow(hx, nv / f.nh) + Math.pow(Math.abs(dy) / b, nv);
  return Math.pow(g, -1 / nv);
}

/**
 * The surface point for a unit direction, after taper and bend, with the body
 * centred vertically (so y runs from -H/2 to H/2).
 */
export function surfacePoint(f: FormParams, dx: number, dy: number, dz: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const r = radius(f, dx, dy, dz);
  let x = dx * r;
  let y = dy * r;
  let z = dz * r;
  // Taper: narrow the width progressively toward the top (0 at the base).
  const tNorm = (y + f.bBot) / (f.bTop + f.bBot);
  const k = 1 - f.taper * tNorm * tNorm;
  x *= k;
  z *= 1 - f.taper * 0.5 * tNorm * tNorm;
  // Bend: shift sideways with height (quadratic from the base), so the base stays put.
  x += f.bend * tNorm * tNorm;
  // Re-centre vertically.
  y += (f.bBot - f.bTop) / 2;
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
  return v;
}

/** Surface normal by central differences on the direction sphere (smooth after the deformations). */
export function surfaceNormal(f: FormParams, dx: number, dy: number, dz: number): [number, number, number] {
  // Two tangents on the direction sphere.
  const d: [number, number, number] = normalize3([dx, dy, dz]);
  const ref: [number, number, number] = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const t1 = normalize3([d[1] * ref[2] - d[2] * ref[1], d[2] * ref[0] - d[0] * ref[2], d[0] * ref[1] - d[1] * ref[0]]);
  const t2 = normalize3([d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]]);
  const e = 1e-3;
  const p = (s1: number, s2: number) => {
    const q = normalize3([d[0] + t1[0] * s1 + t2[0] * s2, d[1] + t1[1] * s1 + t2[1] * s2, d[2] + t1[2] * s1 + t2[2] * s2]);
    return surfacePoint(f, q[0], q[1], q[2], [0, 0, 0]);
  };
  const a1 = p(e, 0);
  const a0 = p(-e, 0);
  const b1 = p(0, e);
  const b0 = p(0, -e);
  const u = [a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]];
  const v = [b1[0] - b0[0], b1[1] - b0[1], b1[2] - b0[2]];
  const n = normalize3([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
  // Point outward.
  const s = surfacePoint(f, d[0], d[1], d[2]);
  if (n[0] * s[0] + n[1] * s[1] + n[2] * s[2] < 0) {
    n[0] = -n[0];
    n[1] = -n[1];
    n[2] = -n[2];
  }
  return n;
}

/** The front silhouette (the body seen from the front, at z = 0) as 2D points, y up. */
export function frontOutline(f: FormParams, samples = 72): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const q = surfacePoint(f, Math.cos(t), Math.sin(t), 0);
    pts.push([q[0], q[1]]);
  }
  return pts;
}

export interface EyePlacement {
  /** Unit direction from the body centre toward each eye, left then right. */
  dirs: [[number, number, number], [number, number, number]];
  /** Capsule radius and straight length, in body units. */
  radius: number;
  length: number;
}

/**
 * Where the eyes sit: a pair on the front, a little above the equator,
 * mirrored about the centre line. `sizeBoost` enlarges them for small faces
 * (optical compensation, tuned at 16 and 20 px).
 */
export function eyePlacement(f: FormParams, eyes: AvatarEyes, sizeBoost = 1, gazeX = 0, gazeY = 0): EyePlacement {
  const az = lerp(0.23, 0.33, eyes.gap) * (1 / Math.max(0.8, f.a));
  const el = lerp(0.16, 0.34, eyes.y) + gazeY;
  const round = eyes.style === "round";
  const radius = lerp(0.064, 0.08, eyes.size) * sizeBoost * (round ? 1.12 : 1);
  const length = round ? 0 : radius * 1.25;
  const dir = (side: number): [number, number, number] => {
    const a = side * az + gazeX;
    return normalize3([Math.sin(a) * Math.cos(el), Math.sin(el), Math.cos(a) * Math.cos(el)]);
  };
  return { dirs: [dir(-1), dir(1)], radius, length };
}

/** Catmull-Rom through closed points, as an SVG path (for the silhouette). */
export function outlinePath(pts: [number, number][], map: (p: [number, number]) => [number, number]): string {
  const n = pts.length;
  const q = pts.map(map);
  const P = (i: number) => q[(i + n) % n];
  const r = (v: number) => Math.round(v * 100) / 100;
  let d = `M${r(P(0)[0])} ${r(P(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    d += `C${r(p1[0] + (p2[0] - p0[0]) / 6)} ${r(p1[1] + (p2[1] - p0[1]) / 6)} ${r(p2[0] - (p3[0] - p1[0]) / 6)} ${r(p2[1] - (p3[1] - p1[1]) / 6)} ${r(p2[0])} ${r(p2[1])}`;
  }
  return `${d}Z`;
}
