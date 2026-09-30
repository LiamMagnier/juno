/**
 * A crew member's identity, derived from its seed.
 *
 * Pure and deterministic (no Math.random, no DOM), so the server render, the
 * client render and the Swift port all draw the same member from the same
 * seed. Two independent choices come out of the seed:
 *
 *  - FAMILY: one of eight curated colour families, each tuned for both
 *    themes (crew.css holds the values as OKLCH tokens).
 *  - FORM: a small set of continuous proportions (how wide, how square, how
 *    much the top narrows, how far it leans, where the eyes sit). Every value
 *    is clamped to a narrow band so the crew reads as one family with
 *    individual faces, never as a set of unrelated blobs.
 *
 * A person can override the family when they pick a colour; the form always
 * follows the seed, so renaming does not reshape a member.
 */

export const CREW_FAMILIES = ["clay", "rose", "plum", "iris", "slate", "lagoon", "sage", "olive"] as const;
export type CrewFamily = (typeof CREW_FAMILIES)[number];

export const CREW_FAMILY_LABEL: Record<CrewFamily, string> = {
  clay: "Clay",
  rose: "Rose",
  plum: "Plum",
  iris: "Iris",
  slate: "Slate",
  lagoon: "Lagoon",
  sage: "Sage",
  olive: "Olive",
};

/** 32-bit FNV-1a. Stable across JS engines and trivially ported to Swift. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, well-distributed PRNG seeded by the hash. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const round = (n: number, p = 100) => Math.round(n * p) / p;

export interface CrewForm {
  /** Half width and half height of the body, in the 64-unit drawing. */
  rx: number;
  ry: number;
  /** Superellipse exponent of the upper and lower halves (2 = ellipse, 4 = squircle). */
  nTop: number;
  nBottom: number;
  /** How much narrower the top is than the bottom, 0..0.1 (a stone resting on its broad side). */
  taper: number;
  /** Resting lean in degrees. Small: a person at a desk, not a toy. */
  lean: number;
  /** Eye centre offset from the body centre, drawing units. */
  eyeY: number;
  /** Half the distance between the eyes. */
  eyeGap: number;
  /** Eye proportions. */
  eyeW: number;
  eyeH: number;
}

export interface CrewIdentity {
  family: CrewFamily;
  form: CrewForm;
}

/**
 * The form bands. Tuned by eye in the lab at 16, 20, 28, 40 and 96px: wider
 * than about 1.14 reads as a bean, squarer than n 3.6 reads as an app icon,
 * a taper past 0.1 reads as an egg, a lean past 4 degrees reads as a toy.
 */
export function formFromSeed(seed: string): CrewForm {
  const r = prng(hashSeed(`form:${seed}`));
  const width = lerp(1.0, 1.12, r());
  const ry = round(lerp(23.2, 24.4, r()));
  const rx = round(Math.min(27.6, ry * width));
  const nTop = round(lerp(2.25, 2.9, r()));
  const nBottom = round(nTop + lerp(0.35, 0.95, r()));
  const taper = round(lerp(0.02, 0.085, r()), 1000);
  const lean = round(lerp(-3.2, 3.2, r()), 10);
  const eyeY = round(lerp(-3.6, -0.8, r()));
  const eyeGap = round(lerp(6.6, 8.2, r()));
  const eyeW = round(lerp(4.6, 5.4, r()));
  const eyeH = round(eyeW * lerp(1.34, 1.6, r()));
  return { rx, ry, nTop, nBottom, taper, lean, eyeY, eyeGap, eyeW, eyeH };
}

export function familyFromSeed(seed: string): CrewFamily {
  return CREW_FAMILIES[hashSeed(`family:${seed}`) % CREW_FAMILIES.length];
}

export function identityFromSeed(seed: string, family?: CrewFamily): CrewIdentity {
  return { family: family ?? familyFromSeed(seed), form: formFromSeed(seed) };
}

/**
 * The body outline: a superellipse whose upper and lower halves have their
 * own exponent (the top rounder, the base flatter, so the body sits), with a
 * slight taper toward the top. Sampled and joined with Catmull-Rom cubics so
 * the curve stays continuous at every size. Centred on (32, 32 + drop).
 */
export function bodyPath(form: CrewForm, cx = 32, cy = 33, samples = 40): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const upper = s < 0; // y grows downward
    const n = upper ? form.nTop : form.nBottom;
    const ex = 2 / n;
    const x = Math.sign(c) * Math.pow(Math.abs(c), ex);
    const y = Math.sign(s) * Math.pow(Math.abs(s), ex);
    // Taper: narrow the width progressively toward the top.
    const k = upper ? 1 - form.taper * Math.abs(y) : 1;
    pts.push([cx + x * form.rx * k, cy + y * form.ry]);
  }
  return catmullRom(pts);
}

function catmullRom(pts: [number, number][]): string {
  const n = pts.length;
  const p = (i: number) => pts[(i + n) % n];
  let d = `M${round(p(0)[0])} ${round(p(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p(i - 1);
    const p1 = p(i);
    const p2 = p(i + 1);
    const p3 = p(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d}Z`;
}

/** A plain superellipse for the lab grammars. */
export function superellipse(cx: number, cy: number, rx: number, ry: number, n: number, samples = 40): string {
  return bodyPath({ rx, ry, nTop: n, nBottom: n, taper: 0, lean: 0, eyeY: 0, eyeGap: 0, eyeW: 0, eyeH: 0 }, cx, cy, samples);
}
