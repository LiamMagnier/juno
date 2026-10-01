/**
 * The character rig: how a crew member moves. Pure TypeScript (no three.js),
 * so it is small, testable and mirrored one to one by the Swift port.
 *
 * Contract (INTERACTION_SPEC §2.9 as amended by D-032). A character moves
 * because something happened:
 *
 *   arrival        pops up from the ground with squash and stretch, lands, settles
 *   state change   a pose change on a spring, punctuated by one blink
 *   waiting        one hop that turns it to face you, then attentive stillness
 *   thanked        a happy double bounce and a few hearts in its own colour
 *   the pointer    eyes and a slight body turn follow it (faces of 28 px and up)
 *   typing         one blink when the person starts typing in its thread
 *   editor         drag to turn it; it wobbles back; each change gets a small boing
 *
 * Loops run only where the brief allows them, and only while the view is on
 * screen, the tab is visible and motion is allowed:
 *
 *   thinking       eyes look around, a gentle sway             (focused context)
 *   working        a focused bob; headphone wearers nod to it   (focused context)
 *   paused         slow breathing, eyes closed                  (focused context)
 *   talking        a bob driven by the voice level              (voice mode)
 *   idle           breathing and an occasional blink            (the large character
 *                                                                in its own thread only)
 *
 * Secondary motion (fur, antennae, googly pupils) is simulated here from the
 * head's own movement, so it settles when the character does.
 *
 * Reduced motion: every state keeps its pose, nothing travels. Poses snap and
 * the view cross-fades; events and loops do nothing.
 *
 * Springs use the duration + bounce form shared with framer and SwiftUI.
 */

export type CrewState = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";
export type Facing = "right" | "left" | "front";

export interface Pose {
  /** Body rotation, radians. Positive yaw turns the face toward the viewer's right; positive pitch looks down. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical offset in body units. */
  lift: number;
  /** Vertical scale about the ground (1 at rest; < 1 squashed, > 1 stretched). Volume is kept. */
  squash: number;
  /** Eyelids: 1 open, 0 closed. Above 1 opens a touch wider. */
  eyeOpen: number;
  /** Where the eyes look, -1..1 across and up. */
  lookX: number;
  lookY: number;
  /** Brows: raise (-1 lowered .. 1 raised) and tilt (inner ends up, positive = asking). */
  brow: number;
  browTilt: number;
  /** Mouth openness while talking, 0..1. */
  mouth: number;
  /** 0 full colour .. 1 grey. */
  desat: number;
  /** 0 as made .. 1 flattened and matte (offline). */
  matte: number;
  /** Uniform scale and opacity (arrival). */
  scale: number;
  opacity: number;
  /** Secondary motion: the fur and anything springy lag behind the head (body units). */
  lagX: number;
  lagY: number;
  /** Googly pupils, -1..1 inside the eye. */
  googX: number;
  googY: number;
  /** The happy reaction's progress, 0..1 while it plays, -1 otherwise (the view draws hearts from it). */
  hearts: number;
}

const KEYS = ["yaw", "pitch", "roll", "lift", "squash", "eyeOpen", "lookX", "lookY", "brow", "browTilt", "desat", "matte"] as const;
type PoseKey = (typeof KEYS)[number];

/** Resting poses. `yaw` is for facing right; `facing` mirrors or centres it. */
const STATE_POSE: Record<CrewState, Record<PoseKey, number>> = {
  // At ease: three-quarter, eyes ahead.
  available: { yaw: 0.34, pitch: 0.02, roll: 0, lift: 0, squash: 1, eyeOpen: 1, lookX: 0.05, lookY: 0, brow: 0, browTilt: 0, desat: 0, matte: 0 },
  // Attention inward: looking up and aside, a slight tilt, one brow asking.
  thinking: { yaw: 0.16, pitch: -0.16, roll: -0.08, lift: 0.01, squash: 1.01, eyeOpen: 0.94, lookX: -0.55, lookY: 0.6, brow: 0.35, browTilt: 0.5, desat: 0, matte: 0 },
  // Attention on the work: forward and down, lids lowered, settled.
  working: { yaw: 0.22, pitch: 0.2, roll: 0.02, lift: -0.02, squash: 0.985, eyeOpen: 0.72, lookX: 0.2, lookY: -0.55, brow: -0.25, browTilt: -0.2, desat: 0, matte: 0 },
  // Turned to you, eyes a touch wider, brows up. Still.
  waiting: { yaw: 0, pitch: -0.06, roll: 0, lift: 0.02, squash: 1.01, eyeOpen: 1.1, lookX: 0, lookY: 0.08, brow: 0.6, browTilt: 0.15, desat: 0, matte: 0 },
  // Eyes closed, settled lower, colour quieted.
  paused: { yaw: 0.2, pitch: 0.12, roll: 0.03, lift: -0.03, squash: 0.975, eyeOpen: 0, lookX: 0, lookY: -0.2, brow: -0.1, browTilt: 0, desat: 0.5, matte: 0.2 },
  // Grey and still, eyes half lidded, the fur flattened.
  offline: { yaw: 0.2, pitch: 0.14, roll: 0, lift: -0.035, squash: 0.97, eyeOpen: 0.4, lookX: 0, lookY: -0.4, brow: -0.2, browTilt: 0, desat: 0.9, matte: 1 },
};

export function restingPose(state: CrewState, facing: Facing = "right", small = false): Pose {
  const s = STATE_POSE[state];
  const dir = facing === "left" ? -1 : facing === "front" ? 0 : 1;
  // Small faces turn less (a three-quarter view at 20 px hides the far eye) and look less far.
  const yawK = small ? 0.55 : 1;
  const yaw = state === "waiting" ? 0 : facing === "front" ? (s.yaw - 0.34) * 0.4 + 0.06 : s.yaw * dir * yawK;
  const mirror = facing === "left" ? -1 : 1;
  const lookK = small ? 0.5 : 1;
  return {
    yaw,
    pitch: s.pitch * (small ? 0.5 : 1),
    roll: s.roll * mirror,
    lift: s.lift,
    squash: s.squash,
    eyeOpen: s.eyeOpen,
    lookX: s.lookX * mirror * lookK,
    lookY: s.lookY * lookK,
    brow: s.brow,
    browTilt: s.browTilt,
    mouth: 0,
    desat: s.desat,
    matte: s.matte,
    scale: 1,
    opacity: 1,
    lagX: 0,
    lagY: 0,
    googX: 0,
    googY: -0.35,
    hearts: -1,
  };
}

/* ——————————————————————————— Springs and curves ——————————————————————————— */

export interface SpringSpec {
  duration: number;
  bounce: number;
}
export const SPRING = {
  standard: { duration: 0.24, bounce: 0.08 },
  emphasized: { duration: 0.38, bounce: 0.14 },
  interactive: { duration: 0.32, bounce: 0.15 },
  look: { duration: 0.2, bounce: 0.05 },
  slow: { duration: 0.6, bounce: 0 },
} satisfies Record<string, SpringSpec>;

export class Spring {
  x: number;
  v = 0;
  target: number;
  private k = 0;
  private c = 0;
  constructor(x: number, spec: SpringSpec) {
    this.x = x;
    this.target = x;
    this.set(spec);
  }
  set(spec: SpringSpec) {
    // SwiftUI / framer mapping: response = duration, damping ratio = 1 - bounce (mass 1).
    this.k = Math.pow((2 * Math.PI) / spec.duration, 2);
    this.c = (4 * Math.PI * (1 - spec.bounce)) / spec.duration;
  }
  /** Raw stiffness and damping, for physical parts (pupils, fur). */
  setRaw(k: number, c: number) {
    this.k = k;
    this.c = c;
  }
  step(dt: number, force = 0) {
    // Semi-implicit Euler in fixed sub-steps: stable at any frame time.
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.target) - this.c * this.v + force;
      this.v += a * h;
      this.x += this.v * h;
    }
  }
  settled(eps = 1e-4) {
    return Math.abs(this.x - this.target) < eps && Math.abs(this.v) < eps * 10;
  }
  snap() {
    this.x = this.target;
    this.v = 0;
  }
}

function bezier(x1: number, y1: number, x2: number, y2: number, t: number) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let u = t;
  for (let i = 0; i < 6; i++) {
    const x = ((ax * u + bx) * u + cx) * u - t;
    const dx = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(dx) < 1e-6) break;
    u -= x / dx;
  }
  u = Math.min(1, Math.max(0, u));
  return ((ay * u + by) * u + cy) * u;
}
/** cubic-bezier(0.45, 0, 0.55, 1), the `breathe` curve. */
export const breathe = (t: number) => bezier(0.45, 0, 0.55, 1, t);
/** cubic-bezier(0.16, 1, 0.3, 1), `out-expo`. */
export const outExpo = (t: number) => bezier(0.16, 1, 0.3, 1, t);
const easeOut = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const easeIn = (t: number) => Math.pow(Math.min(1, Math.max(0, t)), 2);
/** A symmetric loop: 0 → 1 → 0 over two periods, on the breathe curve. */
function wave(now: number, period: number, phase = 0) {
  const c = (((now / period + phase) % 2) + 2) % 2;
  return c < 1 ? breathe(c) : 1 - breathe(c - 1);
}

/** A small deterministic hash for idle timings (no Math.random: the Swift port must agree). */
function hash01(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ——————————————————————————— Timelines ——————————————————————————— */

/*
 * Event timelines return offsets on top of the springs. Squash keeps volume
 * (the view scales width by 1 / sqrt(squash)).
 */

export const ARRIVE_MS = 760;
/** Pop up from the ground: rise stretched, fall, land squashed, settle. */
function arrival(t: number) {
  if (t < 0.34) {
    const u = easeOut(t / 0.34);
    return { lift: -0.25 + u * 0.6, squash: 0.7 + u * 0.48, scale: 0.35 + u * 0.65, opacity: Math.min(1, t / 0.1) };
  }
  if (t < 0.56) {
    const u = easeIn((t - 0.34) / 0.22);
    return { lift: 0.35 - u * 0.35, squash: 1.18 - u * 0.2, scale: 1, opacity: 1 };
  }
  if (t < 0.7) {
    const u = (t - 0.56) / 0.14;
    return { lift: 0, squash: 0.98 - Math.sin(u * Math.PI) * 0.16, scale: 1, opacity: 1 };
  }
  const u = (t - 0.7) / 0.3;
  const s = Math.sin(u * Math.PI) * (1 - u);
  return { lift: s * 0.03, squash: 1 + s * 0.05, scale: 1, opacity: 1 };
}

export const HOP_MS = 640;
/** Waiting: a quick crouch, one hop that turns to face you, a soft landing. */
function hop(t: number) {
  if (t < 0.14) {
    const u = Math.sin((t / 0.14) * Math.PI * 0.5);
    return { lift: 0, squash: 1 - u * 0.12, turn: 0 };
  }
  if (t < 0.62) {
    const u = (t - 0.14) / 0.48;
    const arc = Math.sin(u * Math.PI);
    return { lift: arc * 0.3, squash: 0.88 + Math.min(1, u * 3) * 0.26 - Math.max(0, u - 0.5) * 0.3, turn: easeOut(u * 1.2) };
  }
  if (t < 0.78) {
    const u = (t - 0.62) / 0.16;
    return { lift: 0, squash: 1 - Math.sin(u * Math.PI) * 0.13, turn: 1 };
  }
  const u = (t - 0.78) / 0.22;
  return { lift: Math.sin(u * Math.PI) * 0.015, squash: 1 + Math.sin(u * Math.PI) * 0.03 * (1 - u), turn: 1 };
}

export const HAPPY_MS = 1300;
/** Thanked: two quick bounces, eyes smiling shut for a beat, hearts rising. */
function happy(t: number) {
  const b = (u: number, h: number) => {
    if (u < 0 || u > 1) return { lift: 0, squash: 1 };
    if (u < 0.18) return { lift: 0, squash: 1 - Math.sin((u / 0.18) * Math.PI * 0.5) * 0.1 };
    if (u < 0.75) {
      const a = (u - 0.18) / 0.57;
      return { lift: Math.sin(a * Math.PI) * h, squash: 1.1 - a * 0.14 };
    }
    const a = (u - 0.75) / 0.25;
    return { lift: 0, squash: 1 - Math.sin(a * Math.PI) * 0.09 };
  };
  const first = b(t / 0.34, 0.2);
  const second = b((t - 0.32) / 0.28, 0.12);
  const squint = t < 0.7 ? Math.sin(Math.min(1, t / 0.7) * Math.PI) : 0;
  return { lift: first.lift + second.lift, squash: first.squash * second.squash, squint };
}

const BOING_MS = 420;
/** An editor change: a small squash that springs back. */
function boing(t: number) {
  const s = Math.sin(t * Math.PI * 2.2) * Math.pow(1 - t, 2);
  return { squash: 1 - s * 0.09 };
}

/* ——————————————————————————— The rig ——————————————————————————— */

export interface RigOptions {
  state: CrewState;
  facing: Facing;
  small: boolean;
  /** Reduced motion: poses change without movement (the view cross-fades instead). */
  reduced: boolean;
  /** State loops are allowed here (focused context, 32 px and up). */
  loop: boolean;
  /** The idle is allowed here (the large character in the member's own thread). */
  idle: boolean;
  /** Wears headphones: working nods to a beat. */
  headphones: boolean;
  /** Has googly eyes: simulate the pupils. */
  googly: boolean;
  /** A seed for idle timings, so two characters never blink together. */
  seed: number;
}

const BLINK_MS = 170;
const BLINK_GAP_MS = 4000;
const LOOK_POINTS: [number, number][] = [
  [-0.55, 0.6],
  [0.35, 0.72],
  [0.7, 0.2],
  [-0.2, 0.45],
  [0.1, 0.85],
];

export class Rig {
  private springs: Record<PoseKey, Spring>;
  private gazeX = new Spring(0, SPRING.interactive);
  private gazeY = new Spring(0, SPRING.interactive);
  private dragYaw = new Spring(0, SPRING.interactive);
  private dragPitch = new Spring(0, SPRING.interactive);
  private dragging = false;
  private loopW: Spring;
  private idleW: Spring;
  private levelS = new Spring(0, { duration: 0.12, bounce: 0 });
  private lookAroundX = new Spring(0, SPRING.look);
  private lookAroundY = new Spring(0, SPRING.look);
  private nextLook = 0;
  private lookIdx = 0;
  /* secondary motion */
  private lagX = new Spring(0, SPRING.standard);
  private lagY = new Spring(0, SPRING.standard);
  private googX = new Spring(0, SPRING.standard);
  private googY = new Spring(-0.35, SPRING.standard);
  private prevHeadX = 0;
  private prevHeadY = 0;
  private prevVX = 0;
  private prevVY = 0;
  private primed = false;
  /* events */
  private blinkAt = -1e9;
  private lastBlink = -1e9;
  private nextIdleBlink = 0;
  private arriveAt = -1;
  private hopAt = -1;
  private happyAt = -1;
  private boingAt = -1;
  private scratch = {} as Pose;
  opts: RigOptions;

  constructor(opts: RigOptions) {
    this.opts = { ...opts };
    const p = restingPose(opts.state, opts.facing, opts.small);
    this.springs = Object.fromEntries(KEYS.map((k) => [k, new Spring(p[k], SPRING.standard)])) as Record<PoseKey, Spring>;
    this.loopW = new Spring(this.loopOn() ? 1 : 0, SPRING.slow);
    this.idleW = new Spring(this.idleOn() ? 1 : 0, SPRING.slow);
    // Pupils hang on a soft pendulum; fur is stiffer and well damped.
    this.googX.setRaw(70, 4.2);
    this.googY.setRaw(70, 4.2);
    this.googY.target = -0.35;
    this.lagX.setRaw(240, 15);
    this.lagY.setRaw(240, 15);
  }

  private loopOn() {
    const s = this.opts.state;
    return this.opts.loop && !this.opts.reduced && (s === "thinking" || s === "working" || s === "paused");
  }
  private idleOn() {
    const s = this.opts.state;
    return this.opts.idle && !this.opts.reduced && (s === "available" || s === "waiting");
  }

  /** Apply new options. Returns true if the pose target changed (a state or facing change). */
  update(next: Partial<RigOptions>, now: number): boolean {
    const prevState = this.opts.state;
    const prevFacing = this.opts.facing;
    this.opts = { ...this.opts, ...next };
    const changed = prevState !== this.opts.state || prevFacing !== this.opts.facing;
    if (changed) {
      const p = restingPose(this.opts.state, this.opts.facing, this.opts.small);
      const toWaiting = this.opts.state === "waiting" && prevState !== "waiting";
      const spec = toWaiting ? SPRING.emphasized : SPRING.standard;
      for (const k of KEYS) {
        const s = this.springs[k];
        s.set(spec);
        s.target = p[k];
        if (this.opts.reduced) s.snap();
      }
      if (!this.opts.reduced && prevState !== this.opts.state) {
        // Waiting: one hop that turns to face you (P3). Everything else: one blink.
        if (toWaiting && !this.opts.small) this.hopAt = now;
        else if (this.opts.state !== "paused" && this.opts.state !== "offline") this.blink(now);
      }
      this.nextLook = now + 900;
    }
    this.loopW.target = this.loopOn() ? 1 : 0;
    this.idleW.target = this.idleOn() ? 1 : 0;
    if (this.opts.reduced) {
      this.loopW.snap();
      this.idleW.snap();
      this.levelS.target = 0;
      this.levelS.snap();
    }
    if (this.nextIdleBlink === 0) this.nextIdleBlink = now + 2500 + hash01(this.opts.seed) * 4000;
    return changed;
  }

  /** Pointer-proximity gaze, as offsets in -1..1. Zero returns to centre. */
  gaze(nx: number, ny: number) {
    if (this.opts.reduced || this.opts.small) {
      this.gazeX.target = 0;
      this.gazeY.target = 0;
      return;
    }
    this.gazeX.target = Math.max(-1, Math.min(1, nx));
    this.gazeY.target = Math.max(-1, Math.min(1, ny));
  }

  /** A single blink, at most one per 4 s. Returns whether it played. */
  blink(now: number): boolean {
    if (this.opts.reduced) return false;
    if (now - this.lastBlink < BLINK_GAP_MS) return false;
    const s = this.opts.state;
    if (s === "paused" || s === "offline") return false;
    this.blinkAt = now;
    this.lastBlink = now;
    return true;
  }

  arrive(now: number) {
    this.arriveAt = now;
    if (this.opts.reduced) return;
    // One blink as it lands.
    this.blinkAt = now + ARRIVE_MS * 0.78;
    this.lastBlink = this.blinkAt;
  }

  /** The waiting hop, on demand. */
  hop(now: number) {
    if (!this.opts.reduced) this.hopAt = now;
  }

  /** Thanked. */
  happy(now: number) {
    if (!this.opts.reduced) this.happyAt = now;
  }

  /** An editor change. */
  boing(now: number) {
    if (!this.opts.reduced) this.boingAt = now;
  }

  /** Voice level, 0..1 (talking). */
  level(l: number) {
    this.levelS.target = this.opts.reduced ? 0 : Math.max(0, Math.min(1, l));
  }

  drag(yaw: number, pitch: number) {
    this.dragging = true;
    this.dragYaw.target = yaw;
    this.dragPitch.target = pitch;
    this.dragYaw.snap();
    this.dragPitch.snap();
  }
  release(vYaw = 0, vPitch = 0) {
    this.dragging = false;
    this.dragYaw.v = vYaw;
    this.dragPitch.v = vPitch;
    this.dragYaw.target = 0;
    this.dragPitch.target = 0;
  }

  private eventActive(now: number) {
    return (
      (this.arriveAt >= 0 && now - this.arriveAt < ARRIVE_MS + 60) ||
      (this.hopAt >= 0 && now - this.hopAt < HOP_MS + 40) ||
      (this.happyAt >= 0 && now - this.happyAt < HAPPY_MS + 40) ||
      (this.boingAt >= 0 && now - this.boingAt < BOING_MS + 20) ||
      (now >= this.blinkAt && now - this.blinkAt < BLINK_MS)
    );
  }

  /** Advance by dt seconds. Returns whether anything is still moving. */
  step(dt: number, now: number): boolean {
    let moving = false;
    for (const k of KEYS) {
      const s = this.springs[k];
      if (!s.settled()) {
        s.step(dt);
        moving = true;
      } else s.snap();
    }
    for (const s of [this.gazeX, this.gazeY, this.loopW, this.idleW, this.levelS, this.lookAroundX, this.lookAroundY]) {
      if (!s.settled(5e-4)) {
        s.step(dt);
        moving = true;
      } else s.snap();
    }
    if (!this.dragging) {
      for (const s of [this.dragYaw, this.dragPitch]) {
        if (!s.settled(5e-4)) {
          s.step(dt);
          moving = true;
        } else s.snap();
      }
    }
    // Thinking: the eyes visit a few points in turn.
    if (this.loopW.x > 0.01 && this.loopW.target > 0 && this.opts.state === "thinking") {
      if (now > this.nextLook) {
        const [x, y] = LOOK_POINTS[this.lookIdx % LOOK_POINTS.length];
        this.lookIdx++;
        this.lookAroundX.target = x - STATE_POSE.thinking.lookX;
        this.lookAroundY.target = y - STATE_POSE.thinking.lookY;
        this.nextLook = now + 1100 + hash01(this.opts.seed + this.lookIdx) * 900;
      }
    } else {
      this.lookAroundX.target = 0;
      this.lookAroundY.target = 0;
    }
    // The idle blink, on the large thread character only.
    if (this.idleW.x > 0.5 && now > this.nextIdleBlink) {
      this.blinkAt = now;
      this.lastBlink = now;
      this.nextIdleBlink = now + 3800 + hash01(this.opts.seed + Math.floor(now / 1000)) * 5200;
    }
    if (this.eventActive(now)) moving = true;
    if (this.arriveAt >= 0 && now - this.arriveAt >= ARRIVE_MS + 60) this.arriveAt = -1;
    if (this.hopAt >= 0 && now - this.hopAt >= HOP_MS + 40) this.hopAt = -1;
    if (this.happyAt >= 0 && now - this.happyAt >= HAPPY_MS + 40) this.happyAt = -1;
    if (this.boingAt >= 0 && now - this.boingAt >= BOING_MS + 20) this.boingAt = -1;
    if (this.loopW.x > 0.001 || this.idleW.x > 0.001 || this.levelS.x > 0.001) moving = true;

    // Secondary motion, driven by the head's acceleration.
    const p = this.sample(now, this.scratch, true);
    const hx = p.yaw * 0.9 + p.roll * 0.6;
    const hy = p.lift * 3 + (p.squash - 1) * 2 + p.pitch * 0.5;
    const idt = 1 / Math.max(1e-3, dt);
    if (!this.primed) {
      this.prevHeadX = hx;
      this.prevHeadY = hy;
      this.primed = true;
    }
    const vx = (hx - this.prevHeadX) * idt;
    const vy = (hy - this.prevHeadY) * idt;
    const ax = Math.max(-80, Math.min(80, (vx - this.prevVX) * idt));
    const ay = Math.max(-80, Math.min(80, (vy - this.prevVY) * idt));
    this.prevHeadX = hx;
    this.prevHeadY = hy;
    this.prevVX = vx;
    this.prevVY = vy;
    if (!this.opts.reduced) {
      this.lagX.step(dt, -ax * 0.3);
      this.lagY.step(dt, -ay * 0.3);
      if (this.opts.googly) {
        this.googX.target = this.gazeX.x * 0.45;
        this.googY.target = -0.35 - this.gazeY.x * 0.3;
        this.googX.step(dt, -ax * 3.4);
        this.googY.step(dt, -ay * 3.4);
      }
    } else {
      for (const s of [this.lagX, this.lagY, this.googX, this.googY]) s.snap();
    }
    for (const s of [this.lagX, this.lagY]) if (!s.settled(8e-4)) moving = true;
    if (this.opts.googly) for (const s of [this.googX, this.googY]) if (!s.settled(8e-4)) moving = true;
    return moving;
  }

  /** A blink or event is scheduled but has not started (keep ticking, nothing new to draw). */
  pending(now: number): boolean {
    return now < this.blinkAt || (this.idleW.x > 0.5 && now < this.nextIdleBlink);
  }

  /** Whether the only thing moving is a slow loop (the view may render it at a lower rate). */
  loopOnly(now: number): boolean {
    if (this.loopW.x < 0.001 && this.idleW.x < 0.001) return false;
    if (this.dragging || this.eventActive(now)) return false;
    for (const k of KEYS) if (!this.springs[k].settled()) return false;
    for (const s of [this.gazeX, this.gazeY, this.dragYaw, this.dragPitch, this.levelS]) if (!s.settled(5e-4)) return false;
    return true;
  }

  sample(now: number, out?: Pose, raw = false): Pose {
    const p = out ?? ({} as Pose);
    for (const k of KEYS) p[k] = this.springs[k].x;
    p.mouth = 0;
    p.scale = 1;
    p.opacity = 1;
    p.hearts = -1;
    p.lagX = raw ? 0 : this.lagX.x;
    p.lagY = raw ? 0 : this.lagY.x;
    p.googX = this.googX.x;
    p.googY = this.googY.x;

    // Gaze: the eyes lead, the body follows a little.
    const gx = this.gazeX.x;
    const gy = this.gazeY.x;
    p.lookX += gx * 0.85;
    p.lookY -= gy * 0.7;
    p.yaw += gx * 0.16 + this.dragYaw.x;
    p.pitch += gy * 0.08 + this.dragPitch.x;

    // Loops.
    const w = this.loopW.x;
    if (w > 0.001) {
      const st = this.opts.state;
      if (st === "thinking") {
        const s = wave(now, 1600, (this.opts.seed % 97) / 97) * 2 - 1;
        p.yaw += s * 0.06 * w;
        p.roll += s * 0.025 * w;
        p.lookX += this.lookAroundX.x * w;
        p.lookY += this.lookAroundY.x * w;
      } else if (st === "working") {
        if (this.opts.headphones) {
          // A nod to the beat: quicker, with a little pitch.
          const b = wave(now, 430);
          p.pitch += (b - 0.5) * 0.09 * w;
          p.lift += b * 0.018 * w;
          p.squash *= 1 - b * 0.012 * w;
        } else {
          const b = wave(now, 560);
          p.lift += b * 0.014 * w;
          p.squash *= 1 + (b - 0.5) * 0.012 * w;
        }
      } else if (st === "paused") {
        const b = wave(now, 2100);
        p.squash *= 1 + (b - 0.5) * 0.022 * w;
        p.lift += (b - 0.5) * 0.008 * w;
      }
    }
    const iw = this.idleW.x;
    if (iw > 0.001) {
      const b = wave(now, 2200, 0.3);
      p.squash *= 1 + (b - 0.5) * 0.012 * iw;
    }
    // Talking.
    const lv = this.levelS.x;
    if (lv > 0.001) {
      p.lift += lv * 0.05;
      p.squash *= 1 + lv * 0.035;
      p.mouth = lv;
      p.pitch -= lv * 0.03;
    }

    // Events.
    if (this.arriveAt >= 0) {
      const t = Math.min(1, (now - this.arriveAt) / ARRIVE_MS);
      if (this.opts.reduced) p.opacity = Math.min(1, t * 4);
      else {
        const a = arrival(t);
        p.lift += a.lift;
        p.squash *= a.squash;
        p.scale = a.scale;
        p.opacity = a.opacity;
      }
    }
    if (this.hopAt >= 0) {
      const t = Math.min(1, (now - this.hopAt) / HOP_MS);
      const h = hop(t);
      p.lift += h.lift;
      p.squash *= h.squash;
      // The turn: from its three-quarter view to facing you.
      p.yaw += (1 - h.turn) * 0.45 * (this.opts.facing === "left" ? -1 : 1);
    }
    if (this.happyAt >= 0) {
      const t = Math.min(1, (now - this.happyAt) / HAPPY_MS);
      const h = happy(t);
      p.lift += h.lift;
      p.squash *= h.squash;
      p.eyeOpen = p.eyeOpen * (1 - h.squint * 0.8);
      p.brow += h.squint * 0.4;
      p.hearts = t;
    }
    if (this.boingAt >= 0) {
      const t = Math.min(1, (now - this.boingAt) / BOING_MS);
      p.squash *= boing(t).squash;
    }

    // Blink: close in 60 ms, open in 110 ms.
    const bt = now - this.blinkAt;
    if (bt >= 0 && bt < BLINK_MS) {
      const c = bt < 60 ? bt / 60 : 1 - (bt - 60) / (BLINK_MS - 60);
      p.eyeOpen *= 1 - Math.max(0, Math.min(1, c));
    }
    return p;
  }
}
