/*
 * The galaxy thinking mark's particle field and motion (GALAXY_SPEC.md, shared
 * with JunoGalaxyMark.swift). Pure and deterministic: the same seed draws the
 * same galaxy on the web, macOS and iOS, so this file is the reference the
 * native ports are checked against.
 *
 * PRNG draw order per particle (load-bearing for native parity):
 *   1. t        = rand() ^ 0.85
 *   2. g1       = gaussian()        (Box-Muller: consumes two rand())
 *   3. g2       = gaussian()        (two more rand())
 *   4. dust     = rand() < 0.18
 *   5. if dust: theta = rand() * 2π, then r = 0.15 + rand() * 0.85
 *   6. size     = 0.55 + (1 - t) * 0.9 + rand() * 0.35
 *   7. alpha    = 0.35 + (1 - t) * 0.55 + (rand() - 0.5) * 0.2
 * After the 120 arm/dust particles, the 6 core particles draw
 * r = rand() * 0.06, theta = rand() * 2π, size = 0.9 + rand() * 0.4.
 * A small mark (< 18 px) draws the FIRST 72 of the 120, so it is the same
 * galaxy with fewer stars, not a different one.
 *
 * Motion. The spec's differential rotation, ω(r) = ω0 (0.35 + 0.65 (1 - r)),
 * integrated literally winds the arms tighter forever (inner stars gain ~0.67
 * rad a second on the rim), so after a minute of research the spiral is a
 * set of rings. The differential part therefore winds and unwinds: the angle
 * at time s is
 *   θ(s) = θ0 + ω0 · (0.35 s + 0.65 (1 - r) · W(s)),  W(s) = (P / 2π) sin(2π s / P)
 * with P = 11 s, and the turn runs against the winding so the arms trail
 * (JunoGalaxyRenderer.angle is the same function). At s = 0, dθ/ds is exactly the spec's ω(r); the rim turns at
 * a steady 0.35 ω0 (one turn in ~15.7 s) and the arms wind by up to ~70 degrees
 * at the core and unwind again, every 12 s.
 */

export const GALAXY_SEED = 0xa1e7;
export const GALAXY_COUNT = 120;
export const GALAXY_COUNT_SMALL = 72;
export const GALAXY_TILT = 0.62;
export const GALAXY_ROTATION = (-18 * Math.PI) / 180;
export const GALAXY_OMEGA0 = (2 * Math.PI) / 5.5;
export const GALAXY_WIND_PERIOD = 11;
/** Wake behind each arm star (matches JunoGalaxyRenderer.trailStep / trailFades). */
export const GALAXY_TRAIL_STEP = 0.075;
export const GALAXY_TRAIL_FADES = [0.42, 0.22, 0.1] as const;
export const GALAXY_CORE_BREATH = 2.8;
export const GALAXY_ENTER_MS = 420;
export const GALAXY_EXIT_MS = 240;
/** The frame drawn when motion is reduced (spec: t = 1.2 s). */
export const GALAXY_STATIC_TIME = 1.2;

export type GalaxyParticle = {
  /** Normalised radius, 0 core to ~1 rim (half the mark). */
  r: number;
  /** Angle at time zero, radians. */
  theta: number;
  /** Radius in units of size/24 px. */
  size: number;
  alpha: number;
  /** Presence-blue accent (i % 13 == 0, arm particles only). */
  accent: boolean;
  dust: boolean;
  /** Index, for the twinkle phase. */
  i: number;
};

export type GalaxyField = { particles: GalaxyParticle[]; core: GalaxyParticle[] };

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianFrom(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function galaxyField(seed: number = GALAXY_SEED): GalaxyField {
  const rand = mulberry32(seed);
  const gaussian = gaussianFrom(rand);
  const particles: GalaxyParticle[] = [];
  for (let i = 0; i < GALAXY_COUNT; i++) {
    const arm = i % 2;
    const t = Math.pow(rand(), 0.85);
    const g1 = gaussian();
    const g2 = gaussian();
    let r = 0.08 + 0.92 * t + g2 * 0.035;
    let theta = arm * Math.PI + t * 2.4 * Math.PI + g1 * (0.22 + 0.25 * (1 - t));
    const dust = rand() < 0.18;
    if (dust) {
      theta = rand() * 2 * Math.PI;
      r = 0.15 + rand() * 0.85;
    }
    const size = 0.55 + (1 - t) * 0.9 + rand() * 0.35;
    let alpha = clamp01(0.35 + (1 - t) * 0.55 + (rand() - 0.5) * 0.2);
    if (dust) alpha *= 0.45;
    particles.push({ r: Math.max(0.02, r), theta, size, alpha, accent: !dust && i % 13 === 0, dust, i });
  }
  const core: GalaxyParticle[] = [];
  for (let k = 0; k < 6; k++) {
    const r = rand() * 0.06;
    const theta = rand() * 2 * Math.PI;
    const size = 0.9 + rand() * 0.4;
    core.push({ r, theta, size, alpha: 0.9, accent: false, dust: false, i: GALAXY_COUNT + k });
  }
  return { particles, core };
}

/** Angle of a particle at time `s` seconds (see the header for the winding term). */
export function galaxyAngle(theta0: number, r: number, s: number): number {
  const P = GALAXY_WIND_PERIOD;
  const wind = (P / (2 * Math.PI)) * Math.sin((2 * Math.PI * s) / P);
  // Turns against the arms' winding (screen counter-clockwise) so the arms trail, as on native.
  return theta0 - GALAXY_OMEGA0 * (0.35 * s + 0.65 * Math.max(0, 1 - r) * wind);
}

/** Galaxy-space point (r, angle) → mark-space unit coordinates, tilted and turned. */
export function galaxyProject(r: number, angle: number): { x: number; y: number } {
  const x0 = r * Math.cos(angle);
  const y0 = r * Math.sin(angle) * GALAXY_TILT;
  const c = Math.cos(GALAXY_ROTATION);
  const s = Math.sin(GALAXY_ROTATION);
  return { x: x0 * c - y0 * s, y: x0 * s + y0 * c };
}

/** Per-star twinkle multiplier. */
export const galaxyTwinkle = (i: number, s: number) => 0.85 + 0.15 * Math.sin(s * 1.7 + i);

/** Core alpha, 0.75 ↔ 1.0 over 2.8 s, eased (a cosine is ease-in-out). */
export const galaxyCoreBreath = (s: number) => 0.875 - 0.125 * Math.cos((2 * Math.PI * s) / GALAXY_CORE_BREATH);

/** Ease-out cubic, for the enter spiral. */
export const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
