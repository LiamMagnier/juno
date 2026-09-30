/**
 * Body shapes as pure math (no three.js, no DOM).
 *
 * Each shape is a signed distance field built from a few soft primitives
 * (ellipsoids, round cones, a pillowed star) joined with smooth unions, so
 * every body is one closed, squashy surface with no seams or hard creases.
 * The same field:
 *
 *   builds the mesh       each vertex of a spherified cube is pushed along its
 *                         direction until it meets the surface (bisection),
 *                         so every shape has the same topology and one shape
 *                         can morph into another vertex for vertex;
 *   places the features   eyes, cheeks, brows and mouth are found by casting
 *                         from inside the body at the face's height;
 *   fits the accessories  hats read the body's cross-section where they sit,
 *                         glasses the eye line, headphones the ear points,
 *                         scarves the neck, so every accessory sits correctly
 *                         on every shape without per-pair tuning;
 *   draws the silhouette  the flat fallback where WebGL is missing.
 *
 * Units: the body rests on y = -1 (the ground); a typical body is about two
 * units tall. The face looks down +z.
 *
 * RealityKit reimplements exactly these functions (RATIONALE.md, "Native").
 */

import type { AvatarEyes, BodyShape } from "./avatar2";

export type V3 = [number, number, number];

/* ——————————————————————————— Primitives ——————————————————————————— */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}
function sphere(x: number, y: number, z: number, r: number) {
  return Math.hypot(x, y, z) - r;
}
function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number) {
  return -smin(-a, -b, k);
}
/** Round cone along +y: a sphere of r1 at the origin blended into a sphere of r2 at height h. */
function roundCone(x: number, y: number, z: number, r1: number, r2: number, h: number) {
  const qx = Math.hypot(x, z);
  const b = (r1 - r2) / h;
  const a = Math.sqrt(1 - b * b);
  const k = -b * qx + a * y;
  if (k < 0) return Math.hypot(qx, y) - r1;
  if (k > a * h) return Math.hypot(qx, y - h) - r2;
  return qx * a + y * b - r1;
}
/** The 2D five-pointed star (Inigo Quilez), one point up. */
function star2(px: number, py: number, r: number, rf: number) {
  const k1x = 0.809016994375;
  const k1y = -0.587785252292;
  const k2x = -k1x;
  const k2y = k1y;
  let x = Math.abs(px);
  let y = py;
  let d = Math.max(k1x * x + k1y * y, 0);
  x -= 2 * d * k1x;
  y -= 2 * d * k1y;
  d = Math.max(k2x * x + k2y * y, 0);
  x -= 2 * d * k2x;
  y -= 2 * d * k2y;
  x = Math.abs(x);
  y -= r;
  const bax = rf * -k1y - 0;
  const bay = rf * k1x - 1;
  const h = clamp((x * bax + y * bay) / (bax * bax + bay * bay), 0, r);
  return Math.hypot(x - bax * h, y - bay * h) * Math.sign(y * bax - x * bay);
}
/** A flat-bottomed seat: the body settles onto the ground with a soft edge. */
function seat(d: number, y: number, ground: number, k: number) {
  return smax(d, ground - y, k);
}

/* ——————————————————————————— The shapes ——————————————————————————— */

export interface ShapeSpec {
  /** Raw field, before stretch. */
  sdf: (x: number, y: number, z: number) => number;
  /** Where the eye line sits, 0 (ground) .. 1 (top), for eyes.y = 0.5. */
  eyeLine: number;
  /** Half the angle between the eyes (radians) at eyes.gap = 0.5. */
  eyeSpread: number;
  /** Eye size multiplier for the shape's face. */
  eyeScale: number;
  /** Where headwear's band sits, measured down from the top as a fraction of height. */
  hatDepth: number;
  /** Where neckwear sits, 0 (ground) .. 1 (top). */
  neckLine: number;
  /** The inside point the face is cast from (x, y offsets are absolute; y is a fraction of height). */
  core?: [number, number];
}

const G = -1; // ground

export const SHAPES: Record<BodyShape, ShapeSpec> = {
  /* An egg that has sat down: broad base, softly narrowing crown. The default. */
  pebble: {
    sdf: (x, y, z) => {
      const t = 1 - 0.1 * y;
      return seat(ellipsoid(x / t, y + 0.02, z / (1 - 0.05 * y), 0.96, 1.02, 0.84) * t, y, G, 0.28);
    },
    eyeLine: 0.56,
    eyeSpread: 0.3,
    eyeScale: 1,
    hatDepth: 0.2,
    neckLine: 0.26,
  },
  /* A rice cake: wide and low, the base spreading under its own softness. */
  mochi: {
    sdf: (x, y, z) => {
      const sag = 1 + 0.12 * smoothstep(0.1, -0.9, y);
      return seat(ellipsoid(x / sag, y + 0.34, z / sag, 1.12, 0.86, 0.94) * sag, y, G, 0.4);
    },
    eyeLine: 0.5,
    eyeSpread: 0.3,
    eyeScale: 1.02,
    hatDepth: 0.26,
    neckLine: 0.2,
  },
  /* A jelly bean standing up, curved a little like a kidney. */
  bean: {
    sdf: (x, y, z) => {
      const bx = x - 0.13 * (y * y - 0.35) + 0.06 * y;
      const q = Math.max(Math.abs(y) - 0.42, 0);
      return seat(Math.hypot(bx, q * Math.sign(y), z / 0.9) * 1 - 0.66, y, G, 0.22);
    },
    eyeLine: 0.64,
    eyeSpread: 0.34,
    eyeScale: 0.94,
    hatDepth: 0.18,
    neckLine: 0.3,
  },
  /* A drop with its tip leaning, the way a drop just let go. */
  drop: {
    sdf: (x, y, z) => {
      const lean = 0.24 * Math.pow(smoothstep(0.1, 1.2, y), 2);
      return seat(roundCone(x - lean, y + 0.28, z / 0.92, 0.9, 0.08, 1.3), y, G, 0.3);
    },
    eyeLine: 0.4,
    eyeSpread: 0.32,
    eyeScale: 1,
    hatDepth: 0.3,
    neckLine: 0.18,
  },
  /* A gumdrop: tall rounded top, a skirt that flares a touch into the ground. */
  gumdrop: {
    sdf: (x, y, z) => {
      const flare = 1 + 0.1 * smoothstep(-0.35, -0.98, y);
      return smax(ellipsoid(x / flare, y + 0.78, z / flare, 1.0, 1.95, 0.92) * flare, G + 0.02 - y, 0.1);
    },
    eyeLine: 0.52,
    eyeSpread: 0.3,
    eyeScale: 1,
    hatDepth: 0.2,
    neckLine: 0.2,
  },
  /* A loaf, a cat's loaf or a bread one: long, low, domed along the top. */
  loaf: {
    sdf: (x, y, z) => {
      const qx = Math.abs(x) - 0.62;
      const qy = Math.abs(y + 0.38) - 0.18;
      const qz = Math.abs(z) - 0.34;
      const box = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - 0.46;
      const dome = ellipsoid(x, y + 0.24, z, 1.02, 0.62, 0.78);
      return seat(smin(box, dome, 0.3), y, G, 0.24);
    },
    eyeLine: 0.56,
    eyeSpread: 0.26,
    eyeScale: 1,
    hatDepth: 0.3,
    neckLine: 0.2,
  },
  /* A peanut: a head and a body in one squashy piece. */
  peanut: {
    sdf: (x, y, z) => {
      const body = sphere(x, (y + 0.46) / 0.95, z / 0.92, 0.8);
      const head = sphere(x, y - 0.5, z / 0.92, 0.7);
      return seat(smin(body, head, 0.5), y, G, 0.2);
    },
    eyeLine: 0.72,
    eyeSpread: 0.32,
    eyeScale: 0.94,
    hatDepth: 0.17,
    neckLine: 0.42,
    core: [0, 0.72],
  },
  /* A star pillow with very round points, standing on two of them. */
  star: {
    sdf: (x, y, z) => {
      const py = y + 0.02;
      const d2 = star2(x, py, 0.98, 0.56) - 0.26;
      const r = Math.hypot(x, py);
      const th = 0.5 * (1 - 0.34 * clamp(r / 1.2, 0, 1));
      // A pillow: thickness rises with the distance inside the edge.
      const inside = clamp(-d2 / 0.5, 0, 1);
      const zt = th * Math.sqrt(inside);
      return Math.max(d2, Math.abs(z) - zt - 0.06 * inside) * 0.8;
    },
    eyeLine: 0.52,
    eyeSpread: 0.36,
    eyeScale: 0.92,
    hatDepth: 0.22,
    neckLine: 0.26,
  },
  /* A ball that has settled, nearly round. */
  orb: {
    sdf: (x, y, z) => seat(ellipsoid(x, y + 0.04, z, 0.98, 0.96, 0.94), y, G, 0.2),
    eyeLine: 0.55,
    eyeSpread: 0.3,
    eyeScale: 1,
    hatDepth: 0.2,
    neckLine: 0.22,
  },
  /* A cub: a pebble with two round ears. */
  cub: {
    sdf: (x, y, z) => {
      const t = 1 - 0.06 * y;
      const body = seat(ellipsoid(x / t, y + 0.1, z, 0.98, 0.92, 0.86) * t, y, G, 0.26);
      const ex = Math.abs(x) - 0.56;
      const ear = ellipsoid(ex, y - 0.62, z + 0.04, 0.28, 0.27, 0.19);
      return smin(body, ear, 0.14);
    },
    eyeLine: 0.5,
    eyeSpread: 0.3,
    eyeScale: 1,
    hatDepth: 0.22,
    neckLine: 0.22,
  },
};

/* ——————————————————————————— Fields ——————————————————————————— */

export interface BodyField {
  shape: BodyShape;
  stretch: number;
  spec: ShapeSpec;
  sdf: (x: number, y: number, z: number) => number;
  /** Lowest and highest points of the body. */
  bottom: number;
  top: number;
  /** Half extents at the widest. */
  halfWidth: number;
  halfDepth: number;
}

const fieldCache = new Map<string, BodyField>();

/**
 * The field for a shape and stretch. Stretch scales height by up to 12% and
 * width by the inverse half, about the ground, so the body stays seated.
 */
export function bodyField(shape: BodyShape, stretch = 0): BodyField {
  const key = `${shape}|${Math.round(stretch * 100)}`;
  const hit = fieldCache.get(key);
  if (hit) return hit;
  const spec = SHAPES[shape] ?? SHAPES.pebble;
  const sy = 1 + 0.12 * stretch;
  const sx = 1 - 0.06 * stretch;
  const sdf = (x: number, y: number, z: number) => spec.sdf(x / sx, (y - G) / sy + G, z / sx) * Math.min(sx, sy);
  const f: BodyField = { shape, stretch, spec, sdf, bottom: G, top: 1, halfWidth: 1, halfDepth: 1 };
  // Extents by casting from a point well inside.
  const cy = G + 0.7;
  f.top = cy + castRay(f, 0, cy, 0, 0, 1, 0, 3);
  // The highest point may not be on the axis (a cub's ears, a drop's leaning tip): scan a fan.
  for (let i = -8; i <= 8; i++) {
    const a = (i / 8) * 1.1;
    const t = castRay(f, 0, cy, 0, Math.sin(a), Math.cos(a), 0, 3);
    f.top = Math.max(f.top, cy + Math.cos(a) * t);
  }
  f.bottom = cy - castRay(f, 0, cy, 0, 0, -1, 0, 3);
  let hw = 0;
  let hd = 0;
  for (let i = 0; i < 12; i++) {
    const y = f.bottom + ((i + 0.5) / 12) * (f.top - f.bottom);
    hw = Math.max(hw, castRay(f, 0, y, 0, 1, 0, 0, 3), castRay(f, 0, y, 0, -1, 0, 0, 3));
    hd = Math.max(hd, castRay(f, 0, y, 0, 0, 0, 1, 3));
  }
  f.halfWidth = hw;
  f.halfDepth = hd;
  if (fieldCache.size > 64) fieldCache.clear();
  fieldCache.set(key, f);
  return f;
}

/**
 * Distance from (ox, oy, oz) along a unit direction to the surface, by
 * bisection on the field's sign. The origin must be inside the body; the
 * bodies are star-shaped about their core, so there is exactly one crossing.
 */
export function castRay(f: Pick<BodyField, "sdf">, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMax = 3): number {
  let lo = 0;
  let hi = tMax;
  // March out until we are outside, then bisect.
  let t = 0.05;
  while (t < tMax && f.sdf(ox + dx * t, oy + dy * t, oz + dz * t) < 0) t *= 1.35;
  hi = Math.min(t, tMax);
  lo = t / 1.35;
  if (lo < 0.05) lo = 0;
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2;
    if (f.sdf(ox + dx * m, oy + dy * m, oz + dz * m) < 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** The outward normal at a surface point (central differences on the field). */
export function fieldNormal(f: Pick<BodyField, "sdf">, x: number, y: number, z: number, e = 2e-3): V3 {
  const nx = f.sdf(x + e, y, z) - f.sdf(x - e, y, z);
  const ny = f.sdf(x, y + e, z) - f.sdf(x, y - e, z);
  const nz = f.sdf(x, y, z + e) - f.sdf(x, y, z - e);
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

/** The point every direction is cast from when building the mesh: the body's core. */
export function coreOf(f: BodyField): V3 {
  const h = f.top - f.bottom;
  const c = f.spec.core;
  // Peanuts and cubs are cast from their middle; everything else from 40% up.
  const y = f.bottom + h * (f.shape === "peanut" ? 0.45 : f.shape === "star" ? 0.47 : 0.4);
  return [c ? c[0] : 0, y, 0];
}

/* ——————————————————————————— Anchors ——————————————————————————— */

export interface Frame {
  /** Position on (or just off) the surface. */
  p: V3;
  /** Outward normal. */
  n: V3;
}

export interface Ring {
  /** Height of the ring. */
  y: number;
  /** Half extents of the body's cross-section there (x, then front and back z). */
  a: number;
  front: number;
  back: number;
  /** Centre offset in z of the cross-section. */
  cz: number;
}

export interface Anchors {
  height: number;
  top: V3;
  /** Eyes, left then right (viewer's left is -x). */
  eyes: [Frame, Frame];
  eyeRadius: number;
  /** The face's centre between the eyes. */
  face: Frame;
  mouth: Frame;
  cheeks: [Frame, Frame];
  brows: [Frame, Frame];
  /** Where headwear sits. */
  hat: Ring;
  /** The widest point of the head at eye height, left and right (ears). */
  ears: [Frame, Frame];
  /** Neckwear ring. */
  neck: Ring;
  /** A point high on the side of the head, for a flower pin. */
  pin: Frame;
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function frameAt(f: BodyField, o: V3, d: V3): Frame {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const u: V3 = [d[0] / l, d[1] / l, d[2] / l];
  const t = castRay(f, o[0], o[1], o[2], u[0], u[1], u[2], 3);
  const p: V3 = [o[0] + u[0] * t, o[1] + u[1] * t, o[2] + u[2] * t];
  return { p, n: fieldNormal(f, p[0], p[1], p[2]) };
}

function ringAt(f: BodyField, y: number): Ring {
  const a = Math.max(castRay(f, 0, y, 0, 1, 0, 0, 3), castRay(f, 0, y, 0, -1, 0, 0, 3));
  const front = castRay(f, 0, y, 0, 0, 0, 1, 3);
  const back = castRay(f, 0, y, 0, 0, 0, -1, 3);
  return { y, a, front, back, cz: (front - back) / 2 };
}

const anchorCache = new Map<string, Anchors>();

/**
 * Every place a feature or accessory attaches, for a shape, stretch and eye
 * setting. Cached; cheap enough to recompute when the editor changes a slider.
 */
export function anchors(shape: BodyShape, stretch: number, eyes: Pick<AvatarEyes, "gap" | "y" | "size">): Anchors {
  const key = `${shape}|${Math.round(stretch * 100)}|${Math.round(eyes.gap * 100)}|${Math.round(eyes.y * 100)}|${Math.round(eyes.size * 100)}`;
  const hit = anchorCache.get(key);
  if (hit) return hit;
  const f = bodyField(shape, stretch);
  const s = f.spec;
  const h = f.top - f.bottom;
  const yAt = (frac: number) => f.bottom + h * frac;
  const core = s.core ? s.core : null;

  // Eyes: cast from inside the head at the eye line.
  const eyeY = yAt(s.eyeLine + (eyes.y - 0.5) * 0.16);
  const spread = s.eyeSpread * (0.72 + eyes.gap * 0.56);
  const oy = core ? yAt(core[1]) : eyeY;
  const origin: V3 = [0, Math.min(oy, eyeY), -0.05];
  const dirTo = (az: number, y: number): V3 => {
    // Aim at the eye height on a cylinder in front of the origin.
    const dy = (y - origin[1]) * 1.1;
    return [Math.sin(az), dy, Math.cos(az)];
  };
  const eyeL = frameAt(f, origin, dirTo(-spread, eyeY));
  const eyeR = frameAt(f, origin, dirTo(spread, eyeY));
  const eyeRadius = (0.1 + eyes.size * 0.075) * s.eyeScale;
  const faceF = frameAt(f, origin, dirTo(0, eyeY));
  const mouthY = eyeY - eyeRadius * 2.1;
  const mouth = frameAt(f, [0, Math.min(origin[1], mouthY), -0.05], [0, (mouthY - Math.min(origin[1], mouthY)) * 1.1, 1]);
  const cheekY = eyeY - eyeRadius * 1.55;
  const cheekSpread = spread + 0.2;
  const cheeks: [Frame, Frame] = [
    frameAt(f, [0, Math.min(origin[1], cheekY), -0.05], [Math.sin(-cheekSpread), (cheekY - Math.min(origin[1], cheekY)) * 1.1, Math.cos(cheekSpread)]),
    frameAt(f, [0, Math.min(origin[1], cheekY), -0.05], [Math.sin(cheekSpread), (cheekY - Math.min(origin[1], cheekY)) * 1.1, Math.cos(cheekSpread)]),
  ];
  const browY = eyeY + eyeRadius * 1.9;
  const browO: V3 = [0, Math.min(origin[1], browY), -0.05];
  const brows: [Frame, Frame] = [
    frameAt(f, browO, [Math.sin(-spread * 1.05), (browY - browO[1]) * 1.1, Math.cos(spread)]),
    frameAt(f, browO, [Math.sin(spread * 1.05), (browY - browO[1]) * 1.1, Math.cos(spread)]),
  ];

  // Headwear: the band sits hatDepth below the top, never lower than just above the brows.
  const topF = frameAt(f, [0, f.top - h * 0.3, 0], [0, 1, 0]);
  let hatY = f.top - h * s.hatDepth;
  hatY = Math.max(hatY, browY + eyeRadius * 0.9);
  hatY = Math.min(hatY, f.top - 0.14);
  const hat = ringAt(f, hatY);

  // Ears: the sides of the head, a little above the eye line.
  const earY = eyeY + eyeRadius * 0.4;
  const earO: V3 = [0, earY, core ? 0 : -0.02];
  const ears: [Frame, Frame] = [frameAt(f, earO, [-1, 0, -0.08]), frameAt(f, earO, [1, 0, -0.08])];

  const neck = ringAt(f, yAt(s.neckLine));

  const pinY = Math.min(f.top - 0.12, hatY + (f.top - hatY) * 0.2);
  const pin = frameAt(f, [0, Math.min(pinY, f.top - h * 0.3), 0], [0.78, (pinY - Math.min(pinY, f.top - h * 0.3)) * 1.3 + 0.45, 0.42]);

  const out: Anchors = {
    height: h,
    top: topF.p,
    eyes: [eyeL, eyeR],
    eyeRadius,
    face: faceF,
    mouth,
    cheeks,
    brows,
    hat,
    ears,
    neck,
    pin,
  };
  if (anchorCache.size > 128) anchorCache.clear();
  anchorCache.set(key, out);
  return out;
}

/** An orthonormal basis on the surface: x across (to the viewer's right), y up along the surface, z the normal. */
export function surfaceBasis(n: V3): { x: V3; y: V3; z: V3 } {
  let x = cross([0, 1, 0], n);
  const lx = Math.hypot(x[0], x[1], x[2]);
  x = lx < 1e-4 ? [1, 0, 0] : [x[0] / lx, x[1] / lx, x[2] / lx];
  const y = cross(n, x);
  return { x, y, z: n };
}

/* ——————————————————————————— Silhouette ——————————————————————————— */

/** The front outline at z = 0 (or through the thickest slice), as 2D points, y up. */
export function frontOutline(shape: BodyShape, stretch = 0, samples = 72): [number, number][] {
  const f = bodyField(shape, stretch);
  const c = coreOf(f);
  const pts: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const t = castRay(f, c[0], c[1], 0, dx, dy, 0, 3);
    pts.push([c[0] + dx * t, c[1] + dy * t]);
  }
  return pts;
}

/** Catmull-Rom through closed points, as an SVG path. */
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
