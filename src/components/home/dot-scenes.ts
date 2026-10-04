import { bloom, clamp01, ease, easeInverse, settle, SETTLE, type Frame, type Raster, type Scene } from "./dot-engine";

/*
 * The two drawings the dot matrix knows.
 *
 * The construction: seven orbits growing by 1.5, as circles on a plane seen
 * at an isometric diagonal (tilted 58°, rolled −20°), the ℵ number line along
 * the plane's x axis, and one presence trajectory travelling the fourth orbit
 * with a soft comet tail. Radii in units of the old 1500 × 1000 viewBox, so a
 * placement that framed the hairline drawing frames this one the same way.
 *
 * Rings: flat ellipses placed in fractions of the box (Orbit's map, Memory's
 * constellation, the frame chooser), with the same near-side shading, optional
 * lines (spokes, axes) and presence arcs that end on a point.
 */

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/* ───────────────────────────── Motion spec ───────────────────────────── */

/** The homepage's beat: rings start 110ms apart and draw over 2.2s on the expo ease. */
export const MOTION = {
  delay: 0.2,
  stagger: 0.11,
  draw: 2.2,
  /** Ticks fade in once their ring has mostly drawn. */
  tickDelay: 1.3,
  tickFade: 0.9,
  /** The sway: ±7° of yaw over 80s, easing in after the draw. Barely perceptible, never drifting off its composition. */
  swayAmp: 7 * DEG,
  swayPeriod: 80,
  /** The trajectory: one revolution every ~31s, a tail a fifth of the orbit long. */
  travel: 0.032,
  tail: 0.2,
  /** Each ring fades in whole over 1.5s while a band of light travels round it in .55s more. */
  ringIn: 1.5,
  ringLag: 0.55,
  /** Frame budgets once settled. */
  settledTravelMs: 33,
  settledSwayMs: 50,
} as const;

/* ───────────────────────────── The construction ───────────────────────────── */

const BASE = 132;
const RATIO = 1.5;
const COUNT = 7;
const TILT = 58 * DEG;
const YAW0 = -24 * DEG;
const ROLL = -20 * DEG;
const TRAJ_RING = 3;
/** Where the head rests (and starts travelling from): the near right flank, past ℵ₃. */
const LEAD0 = 0.2;
const SUBSCRIPT = "₀₁₂₃₄";

export interface ConstructionOptions {
  ticks: boolean;
  trajectory: boolean;
  axis: boolean;
  animate: boolean;
  parallax: boolean;
  /** A live zoom (the hero's scroll), read each frame. */
  zoom?: () => number;
}

export class ConstructionScene implements Scene {
  opts: ConstructionOptions;
  parallax: boolean;
  private proj = { ax: 0, ay: 0, bx: 0, by: 0, dx: 0, dy: 0 };
  private labels: { x: number; y: number; a: number }[] = [];

  constructor(opts: ConstructionOptions) {
    this.opts = opts;
    this.parallax = opts.parallax;
  }

  render(f: Frame, r: Raster, ctx: CanvasRenderingContext2D) {
    const { opts } = this;
    const animate = opts.animate && !f.still;
    const t = animate ? f.t : 1e4;
    const u = f.u * (opts.zoom?.() ?? 1);
    const { ox, oy, pitch } = f;
    const step = pitch * 0.42;

    const swayT = t - (MOTION.delay + MOTION.stagger * COUNT + MOTION.draw * 0.6);
    const swayIn = animate ? clamp01(swayT / 6) : 0;
    const sway = MOTION.swayAmp * Math.sin((TAU * Math.max(0, swayT)) / MOTION.swayPeriod) * swayIn * swayIn;
    const yaw = YAW0 + sway + f.pointer.x * 0.06;
    const tilt = TILT + f.pointer.y * 0.05;
    const roll = ROLL + f.pointer.x * 0.03;

    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cT = Math.cos(tilt);
    const sT = Math.sin(tilt);
    const cR = Math.cos(roll);
    const sR = Math.sin(roll);
    const P = this.proj;
    P.ax = cy * cR - sy * cT * sR;
    P.bx = -sy * cR - cy * cT * sR;
    P.ay = cy * sR + sy * cT * cR;
    P.by = -sy * sR + cy * cT * cR;
    P.dx = sy * sT;
    P.dy = cy * sT;

    const R = (k: number) => BASE * RATIO ** k * u;
    let busy = false;

    const floor = f.palette.floor;

    // The number line: short of the outer rings, faint, growing out from the
    // centre both ways as the first ring arrives.
    if (opts.axis && f.palette.axis > 0) {
      const L = R(COUNT - 2) * 1.08;
      const p = ease((t - MOTION.delay) / MOTION.ringIn);
      if (p < 1) busy = true;
      const n = Math.ceil(L / step);
      const strength = 0.2 * f.palette.axis;
      for (let i = -n; i <= n; i++) {
        const s = i / n;
        const as = Math.abs(s);
        if (as > p) continue;
        // Fades towards its ends, so it never stops in a hard cut.
        r.plot(ox + P.ax * s * L, oy + P.ay * s * L, strength * (1 - as * as * 0.7) * ease(clamp01((p - as) / 0.25 + 0.2)));
      }
    }

    // The orbits arrive whole, centre first: each ring fades and grows in
    // (a 3.5% swell to its radius), its dots settling from nothing, while a
    // band of brightness travels once round it. Every frame of the arrival
    // reads as complete rings at different stages, never as broken arcs.
    for (let k = 0; k < COUNT; k++) {
      const t0 = MOTION.delay + MOTION.stagger * k;
      const lt = t - t0;
      if (lt <= 0) {
        busy = true;
        continue;
      }
      const done = lt > MOTION.ringIn + MOTION.ringLag;
      if (!done) busy = true;
      const global = done ? 1 : ease(lt / MOTION.ringIn);
      const radius = R(k) * (done ? 1 : 0.965 + 0.035 * global);
      const faint = k >= 5;
      const strength = faint ? 0.3 : 0.62;
      const n = Math.max(24, Math.ceil((TAU * radius) / step));
      const soft = radius * 0.6;
      for (let s = 0; s < n; s++) {
        const q = s / n;
        const a = q * TAU;
        const px = radius * Math.cos(a);
        const py = radius * Math.sin(a);
        const X = ox + P.ax * px + P.bx * py;
        const Y = oy + P.ay * px + P.by * py;
        if (X < -4 || Y < -4 || X > f.w + 4 || Y > f.h + 4) continue;
        const near = 0.5 + 0.5 * Math.tanh((P.dx * px + P.dy * py) / soft);
        const base = strength * (floor + (1 - floor) * near);
        let v = base;
        if (!done) {
          const local = (lt - MOTION.ringLag * q) / (MOTION.ringIn * 0.6);
          const arrived = ease(clamp01(local));
          const band = local > -0.2 && local < 0.6 ? Math.exp(-(((local - 0.12) / 0.14) ** 2)) : 0;
          v = base * global * (0.45 + 0.55 * arrived) + 0.34 * band * (0.5 + 0.5 * near);
        }
        r.plot(X, Y, v);
      }
    }

    // The trajectory: a comet on the fourth orbit, its head blooming.
    let travelling = false;
    if (opts.trajectory) {
      const radius = R(TRAJ_RING);
      const tT0 = MOTION.delay + MOTION.stagger * (TRAJ_RING + 2) + 0.4;
      const tp = ease((t - tT0) / 1.6);
      if (tp > 0) {
        travelling = animate;
        const lead = LEAD0 + (animate ? MOTION.travel * Math.max(0, t - tT0) : 0);
        const span = MOTION.tail * tp;
        const n = Math.max(8, Math.ceil((span * TAU * radius) / step));
        const soft = radius * 0.6;
        let hx = 0;
        let hy = 0;
        let hn = 1;
        for (let i = 0; i <= n; i++) {
          const s = i / n;
          const a = (lead - span * (1 - s)) * TAU;
          const px = radius * Math.cos(a);
          const py = radius * Math.sin(a);
          const X = ox + P.ax * px + P.bx * py;
          const Y = oy + P.ay * px + P.by * py;
          const near = 0.5 + 0.5 * Math.tanh((P.dx * px + P.dy * py) / soft);
          r.plot(X, Y, (0.28 + 0.72 * s ** 1.6) * (0.62 + 0.38 * near), true);
          if (i === n) {
            hx = X;
            hy = Y;
            hn = near;
          }
        }
        bloom(ctx, f, hx, hy, pitch * 7, f.palette.glow * tp * (0.55 + 0.45 * hn));
      } else busy = true;
    }

    // ℵ marks where the first five rings cross the number line.
    this.labels.length = 0;
    if (opts.ticks) {
      for (let k = 0; k < 5; k++) {
        const a = ease((t - (MOTION.tickDelay + MOTION.stagger * k)) / MOTION.tickFade) * f.palette.axis ** 0.5;
        if (a < 1) busy = true;
        if (a <= 0) continue;
        const rk = R(k);
        this.labels.push({ x: ox + P.ax * rk, y: oy + P.ay * rk, a });
      }
    }

    if (!animate) return Infinity;
    if (busy) return 16;
    if (f.pointer.x || f.pointer.y) return MOTION.settledTravelMs;
    return travelling ? MOTION.settledTravelMs : MOTION.settledSwayMs;
  }

  over(f: Frame, ctx: CanvasRenderingContext2D) {
    if (!this.labels.length) return;
    const [r, g, b] = f.palette.sub;
    ctx.font = `10px ${f.palette.font}`;
    ctx.textBaseline = "alphabetic";
    this.labels.forEach((l, k) => {
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.85 * l.a).toFixed(3)})`;
      ctx.fillText(`ℵ${SUBSCRIPT[k]}`, l.x + 6, l.y - 5 + (1 - l.a) * 4);
    });
  }
}

/* ───────────────────────────── Flat rings ───────────────────────────── */

export interface RingSpec {
  /** Centre and radii as fractions of the box (rx of its width, ry of its height). */
  cx?: number;
  cy?: number;
  rx: number;
  ry: number;
  faint?: boolean;
}

export interface LineSpec {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  tone?: "ink" | "presence";
  /** 0..1, brightness of the line's dots (default .26). */
  strength?: number;
  /** Lines can come and go (a source being read); they draw on from (x1, y1). */
  on?: boolean;
}

/** A presence arc on a ring, drawn towards `to` (degrees), where its head blooms. */
export interface ArcSpec {
  ring: number;
  from: number;
  to: number;
}

export interface RingsOptions {
  rings: RingSpec[];
  lines?: LineSpec[];
  arcs?: ArcSpec[];
  animate: boolean;
  /** Drive the draw-on from outside (scroll), 0..1, instead of the clock. */
  progress?: () => number;
  /** Seconds between rings (default .09) and the draw time (default 1.8). */
  stagger?: number;
  draw?: number;
  delay?: number;
  /** Where each ring's sweep starts, degrees (default 180: the left, read like the number line). */
  start?: number;
}

const LINE_DRAW = 0.7;
const LINE_FADE = 0.4;

export class RingsScene implements Scene {
  opts: RingsOptions;
  private lastT = 0;
  private lineOn: { on: boolean; at: number }[] = [];
  /** When each arc last moved (another ring or other angles): it draws on again from there. */
  private arcMoved: { key: string; at: number | null }[] = [];

  constructor(opts: RingsOptions) {
    this.opts = opts;
    this.syncLines(opts);
    this.syncArcs(opts);
  }

  update(opts: RingsOptions) {
    this.opts = opts;
    this.syncLines(opts);
    this.syncArcs(opts);
  }

  /**
   * An arc that moves draws itself on again, on the instance's own clock,
   * the way a line switched on does: a chooser (the plans page) sends the
   * presence trajectory to the orbit just picked instead of teleporting it.
   */
  private syncArcs(opts: RingsOptions) {
    this.arcMoved = (opts.arcs ?? []).map((arc, i) => {
      const key = `${arc.ring}:${arc.from}:${arc.to}`;
      const was = this.arcMoved[i];
      if (!was) return { key, at: null };
      return was.key === key ? was : { key, at: opts.animate ? this.lastT : null };
    });
  }

  private syncLines(opts: RingsOptions) {
    const lines = opts.lines ?? [];
    const next = lines.map((line, i) => {
      const on = line.on !== false;
      const was = this.lineOn[i];
      if (!was) return { on, at: on && opts.animate ? this.defaultLineStart(i) : -1e4 };
      if (was.on === on) return was;
      return { on, at: this.lastT };
    });
    this.lineOn = next;
  }

  private defaultLineStart(i: number) {
    const o = this.opts;
    return (o.delay ?? 0.12) + (o.stagger ?? 0.09) * (o.rings.length + i * 0.5);
  }

  render(f: Frame, r: Raster, ctx: CanvasRenderingContext2D) {
    const o = this.opts;
    const animate = o.animate && !f.still;
    const driven = !!o.progress && !f.still;
    const t = animate && !driven ? f.t : 1e4;
    this.lastT = f.t;
    const P = driven ? clamp01(o.progress!()) : 1;
    const delay = o.delay ?? 0.12;
    const stagger = o.stagger ?? 0.09;
    const draw = o.draw ?? 1.8;
    const start = (o.start ?? 180) * DEG;
    const step = f.pitch * 0.42;
    const { w, h } = f;
    let busy = false;

    const ringAt = (ring: RingSpec, a: number) => ({
      x: (ring.cx ?? 0.5) * w + ring.rx * w * Math.cos(a),
      y: (ring.cy ?? 0.5) * h + ring.ry * h * Math.sin(a),
      near: 0.5 + 0.5 * Math.sin(a),
    });

    const floor = Math.max(0.5, f.palette.floor);
    // Clock-driven rings arrive whole (fade and settle in, a band of light
    // travelling once round), as the construction's do; scroll-driven rings
    // (Orbit) are revealed along their path by the reader's scroll.
    const ringIn = draw * 0.8;
    const lag = draw * 0.3;
    o.rings.forEach((ring, k) => {
      const t0 = delay + stagger * k;
      const lt = t - t0;
      if (!driven && lt <= 0) {
        busy = true;
        return;
      }
      const done = driven ? P >= 1 : lt > ringIn + lag;
      if (!done && !driven) busy = true;
      const global = done || driven ? 1 : ease(lt / ringIn);
      const grow = done || driven ? 1 : 0.96 + 0.04 * global;
      const strength = ring.faint ? 0.26 : 0.5;
      const len = TAU * Math.sqrt(((ring.rx * w) ** 2 + (ring.ry * h) ** 2) / 2);
      const n = Math.max(24, Math.ceil(len / step));
      const scaled = { ...ring, rx: ring.rx * grow, ry: ring.ry * grow };
      const last = driven && !done ? Math.floor(P * n) : n;
      for (let s = 0; s < last; s++) {
        const q = s / n;
        const pt = ringAt(scaled, start + q * TAU);
        const base = strength * (floor + (1 - floor) * pt.near);
        let v = base;
        if (!done) {
          if (driven) {
            const sDist = clamp01((P - q) / 0.06);
            v = base * (1 - (1 - sDist) ** 3);
          } else {
            const local = (lt - lag * q) / (ringIn * 0.6);
            const arrived = ease(clamp01(local));
            const band = local > -0.2 && local < 0.6 ? Math.exp(-(((local - 0.12) / 0.14) ** 2)) : 0;
            v = base * global * (0.45 + 0.55 * arrived) + 0.3 * band;
          }
        }
        r.plot(pt.x, pt.y, v);
      }
    });

    // Lines run on the instance's own clock even in a still drawing, so a
    // line switched on later (a source being read) still draws itself on.
    const clock = !f.still && !driven;
    (o.lines ?? []).forEach((line, i) => {
      const state = this.lineOn[i] ?? { on: true, at: -1e4 };
      const strength = line.strength ?? 0.26;
      const blue = line.tone === "presence";
      const x1 = line.x1 * w;
      const y1 = line.y1 * h;
      const dx = line.x2 * w - x1;
      const dy = line.y2 * h - y1;
      const n = Math.max(2, Math.ceil(Math.hypot(dx, dy) / step));
      let p = driven ? P : 1;
      let fade = 1;
      const age = f.t - state.at;
      if (clock) {
        if (state.on) {
          p = ease(age / LINE_DRAW);
          if (age < LINE_DRAW + SETTLE) busy = true;
        } else {
          fade = 1 - clamp01(age / LINE_FADE);
          if (fade > 0) busy = true;
        }
      } else if (!state.on) return;
      if (fade <= 0 || p <= 0) return;
      const settled = !clock || !state.on || age > LINE_DRAW + SETTLE;
      const last = Math.floor(p * n);
      for (let s = 0; s <= last; s++) {
        const q = s / n;
        const v = settled ? strength : settle(strength, age - LINE_DRAW * easeInverse(q));
        r.plot(x1 + dx * q, y1 + dy * q, v * fade, blue);
      }
    });

    (o.arcs ?? []).forEach((arc) => {
      const ring = o.rings[arc.ring];
      if (!ring) return;
      const moved = this.arcMoved[o.arcs!.indexOf(arc)]?.at ?? null;
      const t0 = moved ?? delay + stagger * (o.rings.length + 3);
      const clockT = moved != null && !f.still ? f.t : t;
      const p = driven ? P : ease((clockT - t0) / draw);
      if (p <= 0) {
        busy = true;
        return;
      }
      if (!driven && clockT - t0 < draw) busy = true;
      const from = arc.from * DEG;
      const to = arc.to * DEG;
      const end = from + (to - from) * p;
      const len = Math.abs(end - from) * Math.sqrt(((ring.rx * w) ** 2 + (ring.ry * h) ** 2) / 2);
      const n = Math.max(4, Math.ceil(len / step));
      let head = ringAt(ring, end);
      for (let i = 0; i <= n; i++) {
        const s = i / n;
        const pt = ringAt(ring, from + (end - from) * s);
        if (i === n) head = pt;
        r.plot(pt.x, pt.y, (0.28 + 0.72 * s ** 1.6) * (0.65 + 0.35 * pt.near), true);
      }
      bloom(ctx, f, head.x, head.y, f.pitch * 6, f.palette.glow * p);
    });

    if (f.still || driven) return Infinity;
    return busy ? 16 : Infinity;
  }
}
