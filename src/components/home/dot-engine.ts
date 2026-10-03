/**
 * The dot-matrix renderer behind the construction (dot-construction.tsx).
 *
 * Every drawing is rasterised onto a grid of dots (one dot per cell, the
 * prototype's 2×4 sub-cells of a 13px mono cell, so ~3.9px apart), each dot
 * sized and lit by the brightest thing that crossed its cell. Near halves of a
 * ring land bigger and brighter than far halves; the one presence trajectory
 * is the only thing drawn in blue.
 *
 * One scheduler drives every instance on one requestAnimationFrame. An
 * instance only asks for frames while it is on screen, the tab is visible and
 * something is actually moving; once a drawing settles it asks for frames at a
 * lower rate (the slow sway and the trajectory need far fewer than 60), and a
 * still drawing asks for none. No React state is touched per frame.
 *
 * Colours and geometry come from CSS (dot-construction.css), read once per
 * resize or theme change, so `.dark`, surface overrides and media queries all
 * work without props.
 */

export type Rgb = readonly [number, number, number];

export interface Palette {
  ink: Rgb;
  presence: Rgb;
  sub: Rgb;
  /** Overall ink opacity multiplier (light paper wants less than dark). */
  strength: number;
  /** Presence glow opacity. */
  glow: number;
  /** How bright the far half of a ring stays (0..1): paper wants a higher floor than the dark ground. */
  floor: number;
  /** Dot size multiplier. */
  size: number;
  /** Number-line opacity multiplier. */
  axis: number;
  font: string;
}

export interface Frame {
  /** Seconds on this instance's own clock (advances only while it is shown). */
  t: number;
  /** Seconds since the previous rendered frame (0 on the first). */
  dt: number;
  w: number;
  h: number;
  /** Drawing origin, px. */
  ox: number;
  oy: number;
  /** Px per unit of the old 1500 × 1000 viewBox. */
  u: number;
  pitch: number;
  still: boolean;
  palette: Palette;
  pointer: { x: number; y: number };
}

export interface Scene {
  /** Plot into the raster; draw anything that sits under the dots (glows). Returns ms until the next frame is wanted, or Infinity when at rest. */
  render(f: Frame, r: Raster, ctx: CanvasRenderingContext2D): number;
  /** Text and anything above the dots. */
  over?(f: Frame, ctx: CanvasRenderingContext2D): void;
  /** Uses the shared pointer. */
  parallax?: boolean;
}

/* ───────────────────────────── Easing ───────────────────────────── */

/** cubic-bezier(.16, 1, .3, 1), the homepage's expo ease, and its inverse, from one table. */
const EASE_N = 1024;
const EASE_X = new Float32Array(EASE_N + 1);
const EASE_Y = new Float32Array(EASE_N + 1);
(() => {
  const [x1, y1, x2, y2] = [0.16, 1, 0.3, 1];
  for (let i = 0; i <= EASE_N; i++) {
    const s = i / EASE_N;
    const m = 1 - s;
    EASE_X[i] = 3 * m * m * s * x1 + 3 * m * s * s * x2 + s * s * s;
    EASE_Y[i] = 3 * m * m * s * y1 + 3 * m * s * s * y2 + s * s * s;
  }
})();

function lookup(from: Float32Array, to: Float32Array, v: number) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  let lo = 0;
  let hi = EASE_N;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (from[mid] < v) lo = mid;
    else hi = mid;
  }
  const a = from[lo];
  const b = from[hi];
  const k = b === a ? 0 : (v - a) / (b - a);
  return to[lo] + (to[hi] - to[lo]) * k;
}

export const ease = (x: number) => lookup(EASE_X, EASE_Y, x);
export const easeInverse = (y: number) => lookup(EASE_Y, EASE_X, y);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How a dot arrives: it grows and brightens from nothing, glinting a little
 * past its resting value as the pen passes, then settles. `age` in seconds
 * since the sweep reached it.
 */
export const SETTLE = 0.55;
export function settle(base: number, age: number) {
  if (age >= SETTLE) return base;
  if (age <= 0) return 0;
  const s = age / SETTLE;
  const grown = 1 - (1 - s) * (1 - s) * (1 - s);
  return base * grown + 0.3 * Math.sin(Math.PI * s) * (1 - s * 0.5);
}

/* ───────────────────────────── Raster ───────────────────────────── */

const LEVELS = 24;

export class Raster {
  pitch = 3.9;
  gw = 0;
  gh = 0;
  lum = new Float32Array(0);
  blue = new Uint8Array(0);
  lit = new Int32Array(0);
  n = 0;
  private order = new Int32Array(0);
  private counts = new Int32Array(LEVELS * 2 + 1);

  resize(w: number, h: number, pitch: number) {
    this.pitch = pitch;
    this.gw = Math.max(1, Math.ceil(w / pitch));
    this.gh = Math.max(1, Math.ceil(h / pitch));
    const size = this.gw * this.gh;
    if (this.lum.length !== size) {
      this.lum = new Float32Array(size);
      this.blue = new Uint8Array(size);
      this.lit = new Int32Array(size);
      this.order = new Int32Array(size);
    }
    this.n = 0;
  }

  clear() {
    const { lit, lum, blue } = this;
    for (let i = 0; i < this.n; i++) {
      lum[lit[i]] = 0;
      blue[lit[i]] = 0;
    }
    this.n = 0;
  }

  plot(x: number, y: number, v: number, isBlue = false) {
    if (v <= 0.004 || x < 0 || y < 0) return;
    const gx = (x / this.pitch) | 0;
    const gy = (y / this.pitch) | 0;
    if (gx >= this.gw || gy >= this.gh) return;
    const i = gy * this.gw + gx;
    const was = this.lum[i];
    if (was === 0) this.lit[this.n++] = i;
    if (v > was) this.lum[i] = v > 1 ? 1 : v;
    if (isBlue) this.blue[i] = 1;
  }

  /** One path per brightness level and tone: ~48 fills for the whole drawing. */
  draw(ctx: CanvasRenderingContext2D, p: Palette, glowSprite: HTMLCanvasElement | null) {
    const { n, lit, lum, blue, gw, pitch, counts, order } = this;
    if (!n) return;
    counts.fill(0);
    const key = (i: number) => {
      const level = Math.min(LEVELS - 1, Math.max(0, Math.ceil(lum[i] * LEVELS) - 1));
      return blue[i] ? LEVELS + level : level;
    };
    for (let j = 0; j < n; j++) counts[key(lit[j]) + 1]++;
    for (let k = 1; k <= LEVELS * 2; k++) counts[k] += counts[k - 1];
    const cursor = counts.slice(0, LEVELS * 2);
    for (let j = 0; j < n; j++) {
      const i = lit[j];
      order[cursor[key(i)]++] = i;
    }

    // The presence glow sits under the dots.
    if (glowSprite && p.glow > 0) {
      const g = pitch * 2.6;
      for (let k = LEVELS + 6; k < LEVELS * 2; k++) {
        const lv = (k - LEVELS + 1) / LEVELS;
        ctx.globalAlpha = p.glow * lv * 0.42;
        for (let j = counts[k]; j < counts[k + 1]; j++) {
          const i = order[j];
          const x = ((i % gw) + 0.5) * pitch;
          const y = (((i / gw) | 0) + 0.5) * pitch;
          ctx.drawImage(glowSprite, x - g, y - g, g * 2, g * 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    const TAU = Math.PI * 2;
    for (let k = 0; k < LEVELS * 2; k++) {
      const from = counts[k];
      const to = counts[k + 1];
      if (from === to) continue;
      const isBlue = k >= LEVELS;
      const lv = ((isBlue ? k - LEVELS : k) + 1) / LEVELS;
      const rad = pitch * (0.13 + 0.33 * lv + (isBlue ? 0.08 : 0)) * p.size;
      const [r, g, b] = isBlue ? p.presence : p.ink;
      const a = isBlue ? Math.min(1, lv + 0.22) : Math.min(1, lv * 1.15) * p.strength;
      ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      ctx.beginPath();
      for (let j = from; j < to; j++) {
        const i = order[j];
        const x = ((i % gw) + 0.5) * pitch;
        const y = (((i / gw) | 0) + 0.5) * pitch;
        ctx.moveTo(x + rad, y);
        ctx.arc(x, y, rad, 0, TAU);
      }
      ctx.fill();
    }
  }
}

/* ───────────────────────────── Shared state ───────────────────────────── */

const instances = new Set<DotCanvas>();
let raf = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let io: IntersectionObserver | null = null;
let reduceQuery: MediaQueryList | null = null;
let themeObserver: MutationObserver | null = null;
let parallaxUsers = 0;
const pointer = { x: 0, y: 0 };

type Stats = { frames: number; renders: number; ms: number; instances: number; active: number };
const stats: Stats = { frames: 0, renders: 0, ms: 0, instances: 0, active: 0 };

export function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

let timerAt = 0;
function schedule(delay: number) {
  if (typeof document === "undefined" || document.hidden) return;
  if (delay <= 17) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!raf) raf = requestAnimationFrame(tick);
    return;
  }
  if (raf) return;
  const at = performance.now() + delay;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    if (!raf) raf = requestAnimationFrame(tick);
  }, Math.max(0, delay - 12));
}

function tick(now: number) {
  raf = 0;
  const start = performance.now();
  let next = Infinity;
  let rendered = 0;
  let active = 0;
  for (const inst of instances) {
    if (!inst.active) continue;
    active++;
    const wait = inst.step(now);
    if (wait === 0) rendered++;
    else next = Math.min(next, wait);
    next = Math.min(next, inst.wantsIn(now));
  }
  stats.ms += performance.now() - start;
  stats.frames++;
  stats.renders += rendered;
  stats.instances = instances.size;
  stats.active = active;
  if (next < Infinity) schedule(next);
}

function onVisibility() {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
    raf = 0;
    timer = null;
    for (const inst of instances) inst.pause();
  } else {
    for (const inst of instances) inst.invalidate(false);
    schedule(0);
  }
}

function onPointer(e: PointerEvent) {
  pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
  pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
  for (const inst of instances) if (inst.scene.parallax) inst.invalidate(false);
}

let themeQueued = false;
function onTheme() {
  if (themeQueued) return;
  themeQueued = true;
  requestAnimationFrame(() => {
    themeQueued = false;
    for (const inst of instances) inst.refresh();
  });
}

function setup() {
  if (io) return;
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        for (const inst of instances) if (inst.host === entry.target) inst.setVisible(entry.isIntersecting);
      }
    },
    { rootMargin: "48px" },
  );
  document.addEventListener("visibilitychange", onVisibility);
  reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduceQuery.addEventListener("change", onTheme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
  themeObserver = new MutationObserver(onTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
  if (process.env.NODE_ENV !== "production") (window as unknown as { __alvDots: Stats }).__alvDots = stats;
}

function teardown() {
  if (instances.size) return;
  io?.disconnect();
  io = null;
  themeObserver?.disconnect();
  themeObserver = null;
  document.removeEventListener("visibilitychange", onVisibility);
  reduceQuery?.removeEventListener("change", onTheme);
  reduceQuery = null;
}

/* ───────────────────────────── Colour reading ───────────────────────────── */

let probe: CanvasRenderingContext2D | null = null;
function parseColor(value: string, fallback: Rgb): Rgb {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  // Anything else (color(), oklch()): let a canvas normalise it.
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return fallback;
  probe.fillStyle = "#000";
  probe.fillStyle = value;
  const hex = String(probe.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(hex)) return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  const n = hex.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return n ? [+n[1], +n[2], +n[3]] : fallback;
}

function num(cs: CSSStyleDeclaration, name: string, fallback: number) {
  const v = parseFloat(cs.getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

/* ───────────────────────────── Instance ───────────────────────────── */

export class DotCanvas {
  readonly host: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  scene: Scene;
  private ctx: CanvasRenderingContext2D | null;
  private raster = new Raster();
  private ro: ResizeObserver;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private t = 0;
  private lastNow = 0;
  private dueAt = 0;
  private dirty = true;
  private visible = false;
  private still = false;
  private palette: Palette = { ink: [26, 28, 30], presence: [45, 73, 201], sub: [107, 109, 113], strength: 0.8, glow: 0.3, floor: 0.35, size: 1, axis: 1, font: "monospace" };
  private geo = { x: 0.5, y: 0.5, span: 0, zoom: 1 };
  private glowSprite: HTMLCanvasElement | null = null;
  private eased = { x: 0, y: 0 };

  constructor(host: HTMLElement, canvas: HTMLCanvasElement, scene: Scene) {
    this.host = host;
    this.canvas = canvas;
    this.scene = scene;
    this.ctx = canvas.getContext("2d");
    setup();
    instances.add(this);
    if (scene.parallax) this.addParallax();
    this.ro = new ResizeObserver(() => this.refresh());
    this.ro.observe(host);
    io?.observe(host);
    this.refresh();
  }

  /** Held still by the caller (a field faded out under another view). */
  paused = false;

  setPaused(on: boolean) {
    if (this.paused === on) return;
    this.paused = on;
    if (on) this.pause();
    else this.invalidate(false);
  }

  get active() {
    return this.visible && !this.paused && this.w > 0 && this.h > 0 && !!this.ctx;
  }

  setScene(scene: Scene) {
    if (scene.parallax !== this.scene.parallax) {
      if (scene.parallax) this.addParallax();
      else this.removeParallax();
    }
    this.scene = scene;
    this.invalidate();
  }

  /** Restart the instance's clock: the drawing plays its arrival again. */
  replay() {
    this.t = 0;
    this.lastNow = 0;
    this.invalidate();
  }

  private addParallax() {
    if (parallaxUsers++ === 0) window.addEventListener("pointermove", onPointer, { passive: true });
  }
  private removeParallax() {
    if (--parallaxUsers === 0) window.removeEventListener("pointermove", onPointer);
  }

  setVisible(on: boolean) {
    this.visible = on;
    if (on) this.invalidate(false);
    else this.pause();
  }

  pause() {
    this.lastNow = 0;
  }

  invalidate(now = true) {
    this.dirty = true;
    this.dueAt = 0;
    if (now || this.active) schedule(0);
  }

  /** Re-read size, colours and geometry from CSS. */
  refresh() {
    const rect = this.host.getBoundingClientRect();
    // getBoundingClientRect includes ancestors' transforms; the layout size is what we draw at.
    const w = this.host.clientWidth || rect.width;
    const h = this.host.clientHeight || rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    const cw = Math.max(1, Math.round(w * this.dpr));
    const ch = Math.max(1, Math.round(h * this.dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const cs = getComputedStyle(this.host);
    const ink = parseColor(cs.color, this.palette.ink);
    const presence = parseColor(cs.borderTopColor, this.palette.presence);
    const sub = parseColor(cs.outlineColor, this.palette.sub);
    this.palette = {
      ink,
      presence,
      sub,
      strength: num(cs, "--_dots-strength", 0.7),
      glow: num(cs, "--_dots-glow", 0.4),
      floor: num(cs, "--_dots-floor", 0.35),
      size: num(cs, "--_dots-size", 1),
      axis: num(cs, "--_dots-axis", 1),
      font: cs.fontFamily || "monospace",
    };
    this.geo = {
      x: num(cs, "--construction-x", 0.5),
      y: num(cs, "--construction-y", 0.5),
      span: num(cs, "--construction-span", 0),
      zoom: num(cs, "--construction-zoom", 1),
    };
    const pitch = num(cs, "--dots-pitch", 3.9);
    this.raster.resize(w, h, pitch > 1 ? pitch : 3.9);
    this.glowSprite = makeGlow(presence);
    this.still = prefersReducedMotion();
    this.invalidate();
  }

  /** ms until this instance wants its next frame (for the scheduler's sleep). */
  wantsIn(now: number) {
    if (!this.active) return Infinity;
    if (this.dirty) return 0;
    return this.dueAt ? Math.max(0, this.dueAt - now) : Infinity;
  }

  /** Render if due. Returns 0 when it rendered, otherwise ms until due (Infinity at rest). */
  step(now: number): number {
    if (!this.active) return Infinity;
    if (!this.dirty && (!this.dueAt || now < this.dueAt)) return this.dueAt ? this.dueAt - now : Infinity;
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    if (!this.still) this.t += dt;
    const ctx = this.ctx!;
    if (this.scene.parallax && !this.still) {
      const k = 1 - Math.exp(-dt * 3.2);
      this.eased.x += (pointer.x - this.eased.x) * k;
      this.eased.y += (pointer.y - this.eased.y) * k;
    }
    const span = this.geo.span > 0 ? this.geo.span : this.w;
    const f: Frame = {
      t: this.still ? 1e4 : this.t,
      dt,
      w: this.w,
      h: this.h,
      ox: this.geo.x * this.w,
      oy: this.geo.y * this.h,
      u: (span * this.geo.zoom) / 1500,
      pitch: this.raster.pitch,
      still: this.still,
      palette: this.palette,
      pointer: this.scene.parallax && !this.still ? this.eased : { x: 0, y: 0 },
    };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.raster.clear();
    let wait = this.scene.render(f, this.raster, ctx);
    this.raster.draw(ctx, this.palette, this.glowSprite);
    this.scene.over?.(f, ctx);
    if (this.scene.parallax && !this.still) {
      const settling = Math.abs(pointer.x - this.eased.x) + Math.abs(pointer.y - this.eased.y) > 0.002;
      if (settling) wait = Math.min(wait, 16);
    }
    if (this.still) wait = Infinity;
    this.dirty = false;
    this.dueAt = wait < Infinity ? now + wait : 0;
    if (!this.dueAt) this.lastNow = 0;
    return 0;
  }

  destroy() {
    this.ro.disconnect();
    io?.unobserve(this.host);
    if (this.scene.parallax) this.removeParallax();
    instances.delete(this);
    teardown();
  }
}

function makeGlow([r, g, b]: Rgb) {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  return c;
}

/** A soft presence bloom at an exact (sub-dot) position: the comet's head. */
export function bloom(ctx: CanvasRenderingContext2D, f: Frame, x: number, y: number, radius: number, alpha: number) {
  if (alpha <= 0.01) return;
  const [r, g, b] = f.palette.presence;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, `rgba(${r},${g},${b},${(alpha * 0.55).toFixed(3)})`);
  grad.addColorStop(0.4, `rgba(${r},${g},${b},${(alpha * 0.16).toFixed(3)})`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}
