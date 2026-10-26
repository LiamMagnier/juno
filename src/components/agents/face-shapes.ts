/**
 * How the nine bodies are constructed (docs/design/AGENTS.md §4.1). Offline:
 * nothing in the app imports this module. `tests/agents-face.test.ts` traces
 * every body from here and checks the table the app draws from
 * (face-outlines.ts) still matches; `UPDATE_FACE_OUTLINES=1` rewrites it.
 *
 * Every body is a signed distance field, a geometric construction rather than
 * a hand path. Its outline is taken by marching squares, resampled by arc
 * length from 12 o'clock clockwise (y down), centred on its bounding box and
 * scaled so the nine carry one visual weight (`WEIGHT`, in orbs).
 */

import { AGENT_SHAPES, type AgentShape } from "@/lib/agents/avatar";
import { D2R, OUTLINE_POINTS, clamp, clamp01, lerp } from "./face-geometry";

const len = Math.hypot;

/** Spark construction (see SPARK below). */
const SPARK_INNER = 0.74;
const SPARK_TIP = 1.12;
const SPARK_ROUND = 0.16;
/** Petal's lean off upright, degrees clockwise (its tip to the upper right). */
const PETAL_LEAN = 35;

type Sdf = (x: number, y: number) => number;

function smin(a: number, b: number, k: number) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sdPoly(px: number, py: number, V: ReadonlyArray<readonly [number, number]>) {
  let d = (px - V[0][0]) ** 2 + (py - V[0][1]) ** 2;
  let s = 1;
  for (let i = 0, j = V.length - 1; i < V.length; j = i, i++) {
    const ex = V[j][0] - V[i][0];
    const ey = V[j][1] - V[i][1];
    const wx = px - V[i][0];
    const wy = py - V[i][1];
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= V[i][1];
    const c2 = py < V[j][1];
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/** iq's uneven capsule: circles r1 at the origin and r2 at (0, h), y up, x ≥ 0. */
function sdUnevenCapsule(x: number, y: number, r1: number, r2: number, h: number) {
  const b = (r1 - r2) / h;
  const a = Math.sqrt(1 - b * b);
  const k = -b * x + a * y;
  if (k < 0) return len(x, y) - r1;
  if (k > a * h) return len(x, y - h) - r2;
  return a * x + b * y - r1;
}

/**
 * Halo is one closed mass of its own, nothing cut out of it and nothing
 * resting in it: a soft rounded triangle, apex up, its sides bowed out and its
 * corners well rounded (a rounded triangle blended a third of the way toward
 * the disc), so it reads as a gumdrop at 20 px and never as a warning sign.
 * Its broad lower half holds the face. (It was a disc with a bite and a ball
 * in it, the logo's ring as a solid; at roster sizes that healed into a second
 * orb, and at hero sizes the ball read as a third eye.)
 */
const HALO = { tip: 0.68, round: 0.36, disc: 0.35 };
const TRI: ReadonlyArray<readonly [number, number]> = Array.from({ length: 3 }, (_, k) => {
  const a = (-90 + 120 * k) * D2R;
  return [HALO.tip * Math.cos(a), HALO.tip * Math.sin(a)] as const;
});
const HEX: ReadonlyArray<readonly [number, number]> = Array.from({ length: 6 }, (_, k) => {
  const a = (-90 + 60 * k) * D2R;
  return [0.84 * Math.cos(a), 0.84 * Math.sin(a)] as const;
});
const QUADS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;
/* The brand spark, fattened to hold a face: four concave flanks, each an arc
   through two tips and the valley between them (the logo's flank, drawn as a
   circle), then grown by `round` so every tip is a true round. `inner` and
   `tip` are the sharp spark's valley and tip, from the centre; the valley
   must stay inside the chord between two tips (inner < tip / √2) or the
   flanks turn convex and it stops being a spark. Short blunt tips and a full
   centre, so it is a body with a face and not the "AI sparkle" glyph. */
const SPARK = (() => {
  const inner = SPARK_INNER;
  const tip = SPARK_TIP;
  const c = (tip * tip - inner * inner) / (2 * (tip - Math.SQRT2 * inner));
  return { tip, c, rho: Math.SQRT2 * c - inner, round: SPARK_ROUND };
})();

/** The exact distance to the sharp spark: inside, the nearest flank; outside, a flank's arc or a tip. */
function sdSharpSpark(x: number, y: number) {
  const { tip, c, rho } = SPARK;
  let inside = -1e9;
  let outside = 1e9;
  let isIn = true;
  for (const [sx, sy] of QUADS) {
    const vx = x - sx * c;
    const vy = y - sy * c;
    const L = len(vx, vy);
    inside = Math.max(inside, rho - L);
    if (L < rho) isIn = false;
    const qx = sx * c + (vx / L) * rho;
    const qy = sy * c + (vy / L) * rho;
    if (qx * sx >= 0 && qy * sy >= 0 && len(qx, qy) <= tip) outside = Math.min(outside, Math.abs(L - rho));
  }
  if (isIn) return inside;
  for (const [tx, ty] of [[0, -tip], [tip, 0], [0, tip], [-tip, 0]] as const) outside = Math.min(outside, len(x - tx, y - ty));
  return outside;
}

const SHAPE_SDF: Record<AgentShape, Sdf> = {
  orb: (x, y) => len(x, y) - 1,
  /* A symmetric superellipse, a little wider than tall: a smooth stone. */
  pebble: (x, y) => {
    const n = 2.5;
    return Math.pow(Math.pow(Math.abs(x) / 1.06, n) + Math.pow(Math.abs(y) / 0.92, n), 1 / n) - 1;
  },
  /* A stadium. */
  capsule: (x, y) => len(x, y - clamp(y, -0.37, 0.37)) - 0.7,
  /* Juno's petal: a drop leaning PETAL_LEAN degrees, its tight end to the
     upper right like a petal off its stem, never Grok's upright teardrop.
     Two circles (r 0.80, and r 0.17 at the tip) joined by their common
     tangents (iq's uneven capsule), evaluated on coordinates turned back by
     the lean. The face sits in the round, lower left. */
  petal: (x, y) => {
    const c = Math.cos(PETAL_LEAN * D2R);
    const s = Math.sin(PETAL_LEAN * D2R);
    const u = c * x + s * y;
    const v = -s * x + c * y;
    return sdUnevenCapsule(Math.abs(u), 0.2 - v, 0.8, 0.17, 1);
  },
  /* Four lobes joined with a smooth minimum: a cushion, not a clover. */
  bloom: (x, y) => {
    let d = 1e9;
    for (const [sx, sy] of QUADS) d = smin(d, len(x - sx * 0.42, y - sy * 0.42) - 0.61, 0.3);
    return d;
  },
  spark: (x, y) => sdSharpSpark(x, y) - SPARK.round,
  /* A squircle. */
  tile: (x, y) => {
    const n = 4.4;
    return Math.pow(Math.pow(Math.abs(x), n) + Math.pow(Math.abs(y), n), 1 / n) - 0.9;
  },
  halo: (x, y) => (1 - HALO.disc) * (sdPoly(x, y, TRI) - HALO.round) + HALO.disc * (len(x, y) - 1),
  /* A hexagon with soft corners. */
  prism: (x, y) => sdPoly(x, y, HEX) - 0.25,
};

/**
 * Below 48 px a body may be drawn from a construction of its own, tuned to
 * read in a 20 px row (bodyOf takes it for the xs and sm sizes): the same
 * character, with what tells it apart made big enough to survive the pixel
 * grid, as type is optically sized.
 */
const SMALL_SDF: Partial<Record<AgentShape, Sdf>> = {
  /* Bloom's cushion has waists a third of a pixel deep at 20 px, and reads
     as tile there. Small, it is a rounder four-lobe clover: tighter lobes,
     still covering the centre, joined with a smaller blend, so each waist is
     a device pixel deep at 20 px. */
  bloom: (x, y) => {
    let d = 1e9;
    for (const [sx, sy] of QUADS) d = smin(d, len(x - sx * 0.45, y - sy * 0.45) - 0.64, 0.06);
    return d;
  },
};

/** Marching squares over the field; returns the longest closed loop. */
function contour(sdf: Sdf, G = 480, ext = 1.6): Array<[number, number]> {
  const n = G + 1;
  const h = (2 * ext) / G;
  const v = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) v[j * n + i] = sdf(-ext + i * h, -ext + j * h);
  const P = new Map<number, [number, number]>();
  const adj = new Map<number, number[]>();
  const H = (i: number, j: number) => (j * n + i) * 2;
  const V = (i: number, j: number) => (j * n + i) * 2 + 1;
  const point = (id: number): [number, number] => {
    const hit = P.get(id);
    if (hit) return hit;
    const k = id >> 1;
    const i = k % n;
    const j = (k / n) | 0;
    const a = v[j * n + i];
    const b = id & 1 ? v[(j + 1) * n + i] : v[j * n + i + 1];
    const t = a / (a - b);
    const p: [number, number] = id & 1 ? [-ext + i * h, -ext + (j + t) * h] : [-ext + (i + t) * h, -ext + j * h];
    P.set(id, p);
    return p;
  };
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  };
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const a = v[j * n + i] < 0;
      const b = v[j * n + i + 1] < 0;
      const c = v[(j + 1) * n + i + 1] < 0;
      const d = v[(j + 1) * n + i] < 0;
      const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const T = H(i, j);
      const R = V(i + 1, j);
      const B = H(i, j + 1);
      const L = V(i, j);
      const mid = sdf(-ext + (i + 0.5) * h, -ext + (j + 0.5) * h) < 0;
      switch (code) {
        case 1: link(L, T); break;
        case 2: link(T, R); break;
        case 3: link(L, R); break;
        case 4: link(R, B); break;
        case 6: link(T, B); break;
        case 7: link(L, B); break;
        case 8: link(B, L); break;
        case 9: link(T, B); break;
        case 11: link(R, B); break;
        case 12: link(L, R); break;
        case 13: link(T, R); break;
        case 14: link(L, T); break;
        case 5:
          if (mid) { link(T, R); link(L, B); } else { link(L, T); link(R, B); }
          break;
        case 10:
          if (mid) { link(L, T); link(R, B); } else { link(T, R); link(L, B); }
          break;
      }
    }
  }
  const seen = new Set<number>();
  let best: Array<[number, number]> = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: Array<[number, number]> = [];
    let prev = -1;
    let cur: number | undefined = start;
    while (cur !== undefined && !seen.has(cur)) {
      seen.add(cur);
      loop.push(point(cur));
      const nb: number[] = adj.get(cur)!;
      const next: number | undefined = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/** Clockwise (y down), starting straight above the centre, N points by arc length. */
function resample(input: Array<[number, number]>, N: number): { pts: Float64Array; area: number } {
  let loop = input;
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i];
    const [x2, y2] = loop[(i + 1) % loop.length];
    area += x1 * y2 - x2 * y1;
  }
  if (area < 0) loop = loop.slice().reverse();
  let s = 0;
  let bestA = 1e9;
  loop.forEach(([x, y], i) => {
    if (y < 0) {
      const a = Math.abs(Math.atan2(y, x) + Math.PI / 2);
      if (a < bestA) {
        bestA = a;
        s = i;
      }
    }
  });
  loop = loop.slice(s).concat(loop.slice(0, s));
  const cum = [0];
  for (let i = 1; i <= loop.length; i++) {
    const p = loop[i - 1];
    const q = loop[i % loop.length];
    cum.push(cum[i - 1] + len(q[0] - p[0], q[1] - p[1]));
  }
  const total = cum[cum.length - 1];
  const out = new Float64Array(N * 2);
  let k = 0;
  for (let m = 0; m < N; m++) {
    const target = (total * m) / N;
    while (cum[k + 1] < target) k++;
    const t = (target - cum[k]) / (cum[k + 1] - cum[k] || 1);
    const p = loop[k];
    const q = loop[(k + 1) % loop.length];
    out[m * 2] = lerp(p[0], q[0], t);
    out[m * 2 + 1] = lerp(p[1], q[1], t);
  }
  return { pts: out, area: Math.abs(area) / 2 };
}


/** Target area per body, in orbs (π): spiky and long bodies read heavier per unit of area, so they get less. */
const WEIGHT: Record<AgentShape, number> = {
  orb: 1,
  pebble: 0.97,
  capsule: 0.86,
  petal: 0.93,
  bloom: 0.97,
  spark: 0.86,
  tile: 0.94,
  halo: 0.92,
  prism: 0.95,
};

export interface TracedBody {
  pts: number[];
  /** The outline for 20 to 40 px, where the body has a construction of its own (SMALL_SDF). */
  small?: number[];
}

/** One construction traced: centred on its box and scaled to its body's weight. */
function trace(shape: AgentShape, sdf: Sdf): number[] {
  const N = OUTLINE_POINTS;
  const raw = resample(contour(sdf), N);
  let x0 = 9;
  let x1 = -9;
  let y0 = 9;
  let y1 = -9;
  for (let i = 0; i < N; i++) {
    x0 = Math.min(x0, raw.pts[i * 2]);
    x1 = Math.max(x1, raw.pts[i * 2]);
    y0 = Math.min(y0, raw.pts[i * 2 + 1]);
    y1 = Math.max(y1, raw.pts[i * 2 + 1]);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const k = shape === "orb" ? 1 : Math.sqrt((WEIGHT[shape] * Math.PI) / raw.area);
  return Array.from(raw.pts, (v, i) => (v - (i % 2 ? cy : cx)) * k);
}

/** Every body, traced. Slow (a few hundred ms): run it offline. */
export function traceBodies(): Record<AgentShape, TracedBody> {
  const out = {} as Record<AgentShape, TracedBody>;
  for (const shape of AGENT_SHAPES) {
    const small = SMALL_SDF[shape];
    out[shape] = small ? { pts: trace(shape, SHAPE_SDF[shape]), small: trace(shape, small) } : { pts: trace(shape, SHAPE_SDF[shape]) };
  }
  return out;
}

/** The source of face-outlines.ts. */
export function outlinesModule(bodies: Record<AgentShape, TracedBody>): string {
  const num = (v: number) => String(Math.round(v * 10000) / 10000);
  const list = (a: number[]) => `"${a.map(num).join(" ")}"`;
  const rows = AGENT_SHAPES.map((shape) => {
    const small = bodies[shape].small;
    return `  ${shape}: { pts: ${list(bodies[shape].pts)}${small ? `, small: ${list(small)}` : ""} },`;
  });
  return [
    "/**",
    " * Generated by tests/agents-face.test.ts from face-shapes.ts (UPDATE_FACE_OUTLINES=1). Do not edit.",
    ` * ${OUTLINE_POINTS} points per body, x y interleaved, in R, clockwise from 12 o'clock (y down).`,
    " * `small`, where a body has one, is its outline from 20 to 40 px.",
    " */",
    "",
    'import type { AgentShape } from "@/lib/agents/avatar";',
    "",
    "export const OUTLINES: Record<AgentShape, { pts: string; small?: string }> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}
