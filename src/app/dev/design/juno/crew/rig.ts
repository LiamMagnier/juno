/**
 * The presence rig: how a crew face moves. Pure TypeScript (no three.js), so
 * it is unit-sized, testable, and mirrored one to one by the Swift port.
 *
 * Contract (INTERACTION_SPEC §2.9, amended P4): the face is an instrument of
 * state. It moves only in response to events: a state change, the person's
 * pointer coming near, the face first appearing, the person typing in its
 * thread, a new member arriving. Nothing runs on an idle timer. The one loop
 * is §1.6 item 2: thinking or working, at 32 px or larger, in the focused
 * context only, on the `breathe` curve over 2400 ms.
 *
 * Springs use the duration + bounce form shared with framer and SwiftUI:
 *   standard     0.22 s, bounce 0.05   a pose change
 *   emphasized   0.36 s, bounce 0.10   turning toward you (waiting)
 *   interactive  0.32 s, bounce 0.15   following the pointer, drag release
 */

export type CrewState = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";
export type Facing = "right" | "left" | "front";

export interface Pose {
  /** Head rotation, radians. Positive yaw turns the face toward the viewer's right. Positive pitch looks down. */
  yaw: number;
  pitch: number;
  roll: number;
  /** Vertical offset in body units (negative settles). */
  lift: number;
  /** Vertical scale (1 at rest; < 1 settles). */
  squash: number;
  /** Eye openness, 1 open; 0 closed (a line). */
  eyeOpen: number;
  /** Eye travel across the face (radians on the direction sphere). */
  eyeX: number;
  eyeY: number;
  /** 0 full colour .. 1 grey. */
  desat: number;
  /** 1 eyes on .. 0 eyes gone into the glaze. */
  eyesOn: number;
  /** 0 as made .. 1 fully matte (offline loses its clearcoat). */
  matte: number;
  /** Uniform scale (arrival). */
  scale: number;
  /** Whole-face opacity (arrival). */
  opacity: number;
}

const KEYS = ["yaw", "pitch", "roll", "lift", "squash", "eyeOpen", "eyeX", "eyeY", "desat", "eyesOn", "matte"] as const;
type PoseKey = (typeof KEYS)[number];

/** Resting poses. `yaw` here is for facing right; `facing` mirrors or centres it. */
const STATE_POSE: Record<CrewState, Record<PoseKey, number>> = {
  available: { yaw: 0.3, pitch: 0.02, roll: 0, lift: 0, squash: 1, eyeOpen: 1, eyeX: 0.03, eyeY: 0, desat: 0, eyesOn: 1, matte: 0 },
  // Attention inward: eyes up and aside, the head tilted and lifted a little.
  thinking: { yaw: 0.08, pitch: -0.24, roll: -0.09, lift: 0.015, squash: 1, eyeOpen: 0.92, eyeX: -0.12, eyeY: 0.11, desat: 0, eyesOn: 1, matte: 0 },
  // Attention on the work: settled, forward and down, lids lowered.
  working: { yaw: 0.2, pitch: 0.24, roll: 0.02, lift: -0.03, squash: 0.99, eyeOpen: 0.7, eyeX: 0.05, eyeY: -0.1, desat: 0, eyesOn: 1, matte: 0 },
  // Turned to you, eyes a touch more open, then still.
  waiting: { yaw: 0, pitch: -0.06, roll: 0, lift: 0.03, squash: 1, eyeOpen: 1.18, eyeX: 0, eyeY: 0.02, desat: 0, eyesOn: 1, matte: 0 },
  // Eyes closed, settled a little lower, the colour quieted.
  paused: { yaw: 0.18, pitch: 0.14, roll: 0, lift: -0.045, squash: 0.972, eyeOpen: 0.08, eyeX: 0, eyeY: -0.04, desat: 0.55, eyesOn: 1, matte: 0.3 },
  // Matte and grey, eyes out.
  offline: { yaw: 0.18, pitch: 0.16, roll: 0, lift: -0.045, squash: 0.972, eyeOpen: 0.7, eyeX: 0, eyeY: -0.04, desat: 0.92, eyesOn: 0, matte: 1 },
};

export function restingPose(state: CrewState, facing: Facing = "right", small = false): Pose {
  const s = STATE_POSE[state];
  const dir = facing === "left" ? -1 : facing === "front" ? 0 : 1;
  // Small faces turn less: a three-quarter view at 20 px hides the far eye.
  const yawK = small ? 0.62 : 1;
  // "front" still turns a touch, so the form reads as a solid rather than a disc.
  const yaw = state === "waiting" ? 0 : facing === "front" ? 0.1 + (s.yaw - 0.3) * 0.5 : s.yaw * dir * yawK;
  return {
    yaw,
    pitch: s.pitch * (small ? 0.6 : 1),
    roll: s.roll * (facing === "left" ? -1 : 1),
    lift: s.lift,
    squash: s.squash,
    eyeOpen: s.eyeOpen,
    eyeX: s.eyeX * (facing === "left" ? -1 : 1),
    eyeY: s.eyeY,
    desat: s.desat,
    eyesOn: s.eyesOn,
    matte: s.matte,
    scale: 1,
    opacity: 1,
  };
}

/* ——————————————————————————— Springs ——————————————————————————— */

export interface SpringSpec {
  duration: number;
  bounce: number;
}
export const SPRING = {
  standard: { duration: 0.22, bounce: 0.05 },
  emphasized: { duration: 0.36, bounce: 0.1 },
  interactive: { duration: 0.32, bounce: 0.15 },
  layout: { duration: 0.36, bounce: 0 },
} satisfies Record<string, SpringSpec>;

class Spring {
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
  step(dt: number) {
    // Semi-implicit Euler in fixed sub-steps: stable at any frame time.
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = -this.k * (this.x - this.target) - this.c * this.v;
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

/** cubic-bezier(0.45, 0, 0.55, 1), the `breathe` curve, sampled by Newton's method. */
function breathe(t: number) {
  return bezier(0.45, 0, 0.55, 1, t);
}
/** cubic-bezier(0.16, 1, 0.3, 1), `out-expo`. */
export function outExpo(t: number) {
  return bezier(0.16, 1, 0.3, 1, t);
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

/* ——————————————————————————— The rig ——————————————————————————— */

export interface RigOptions {
  state: CrewState;
  facing: Facing;
  small: boolean;
  /** Reduced motion: poses change without movement (the view cross-fades instead). */
  reduced: boolean;
  /** The thinking/working loop is allowed here (focused context, >= 32 px). */
  loop: boolean;
}

const BLINK_MS = 190;
const BLINK_GAP_MS = 4000;
const ARRIVE_MS = 560;
const LOOP_MS = 2400;

export class Rig {
  private springs: Record<PoseKey, Spring>;
  private gazeX: Spring;
  private gazeY: Spring;
  /** Drag rotation in the editor: follows the finger directly, springs home on release. */
  private dragYaw: Spring;
  private dragPitch: Spring;
  private dragging = false;
  private squashKick: Spring;
  private loopWeight: Spring;
  private blinkAt = -1e9;
  private lastBlink = -1e9;
  private arriveAt = -1;
  private kicked = false;
  opts: RigOptions;

  constructor(opts: RigOptions) {
    this.opts = { ...opts };
    const p = restingPose(opts.state, opts.facing, opts.small);
    this.springs = Object.fromEntries(KEYS.map((k) => [k, new Spring(p[k], SPRING.standard)])) as Record<PoseKey, Spring>;
    this.gazeX = new Spring(0, SPRING.interactive);
    this.gazeY = new Spring(0, SPRING.interactive);
    this.dragYaw = new Spring(0, SPRING.interactive);
    this.dragPitch = new Spring(0, SPRING.interactive);
    this.squashKick = new Spring(0, { duration: 0.34, bounce: 0.2 });
    this.loopWeight = new Spring(this.loopOn() ? 1 : 0, { duration: 0.6, bounce: 0 });
  }

  private loopOn() {
    return this.opts.loop && !this.opts.reduced && (this.opts.state === "thinking" || this.opts.state === "working");
  }

  /** Apply new options. Returns true if the pose target changed (a state change). */
  update(next: Partial<RigOptions>, now: number): boolean {
    const prevState = this.opts.state;
    const prevFacing = this.opts.facing;
    this.opts = { ...this.opts, ...next };
    const changed = prevState !== this.opts.state || prevFacing !== this.opts.facing;
    if (changed) {
      const p = restingPose(this.opts.state, this.opts.facing, this.opts.small);
      const spec = this.opts.state === "waiting" && prevState !== "waiting" ? SPRING.emphasized : SPRING.standard;
      for (const k of KEYS) {
        const s = this.springs[k];
        s.set(spec);
        s.target = p[k];
        if (this.opts.reduced) s.snap();
      }
      // A single blink punctuates the change (never while closing the eyes).
      if (this.opts.state !== "paused" && this.opts.state !== "offline") this.blink(now);
    }
    this.loopWeight.target = this.loopOn() ? 1 : 0;
    if (this.opts.reduced) this.loopWeight.snap();
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

  /** The new-member arrival: drops in and settles softly. */
  arrive(now: number) {
    this.arriveAt = now;
    this.kicked = false;
    this.lastBlink = -1e9;
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
    for (const s of [this.gazeX, this.gazeY, this.squashKick, this.loopWeight]) {
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
    if (now >= this.blinkAt && now - this.blinkAt < BLINK_MS) moving = true;
    if (this.arriveAt >= 0) {
      const t = (now - this.arriveAt) / ARRIVE_MS;
      if (t < 1.2) moving = true;
      if (!this.kicked && t > 0.55 && !this.opts.reduced) {
        // Landing: a small squash that springs back.
        this.squashKick.v = -10;
        this.kicked = true;
      }
      if (t >= 1.2 && this.squashKick.settled(5e-4)) this.arriveAt = -1;
    }
    if (this.loopWeight.x > 0.001) moving = true;
    return moving;
  }

  /** A blink is scheduled but has not started (keep ticking, nothing to draw yet). */
  pending(now: number): boolean {
    return now < this.blinkAt;
  }

  /** Whether the only thing moving is the slow loop (the view may render it at a lower rate). */
  loopOnly(now: number): boolean {
    if (this.loopWeight.x < 0.001) return false;
    if (now - this.blinkAt < BLINK_MS || this.arriveAt >= 0 || this.dragging) return false;
    for (const k of KEYS) if (!this.springs[k].settled()) return false;
    for (const s of [this.gazeX, this.gazeY, this.squashKick, this.dragYaw, this.dragPitch]) if (!s.settled(5e-4)) return false;
    return true;
  }

  sample(now: number, out?: Pose): Pose {
    const p = out ?? ({} as Pose);
    for (const k of KEYS) p[k] = this.springs[k].x;
    // Gaze: a small head turn plus a smaller eye travel. The total eye
    // displacement stays within 1.5 px at 32 px (4.7% of the face).
    const gx = this.gazeX.x;
    const gy = this.gazeY.x;
    p.yaw += gx * 0.1 + this.dragYaw.x;
    p.pitch += gy * 0.07 + this.dragPitch.x;
    p.eyeX += gx * 0.035;
    p.eyeY -= gy * 0.03;
    // The loop: thinking drifts aside and back; working settles in a slow nod.
    const w = this.loopWeight.x;
    if (w > 0.001) {
      const cyc = (now % (LOOP_MS * 2)) / LOOP_MS;
      const e = cyc < 1 ? breathe(cyc) : 1 - breathe(cyc - 1);
      const s = e * 2 - 1;
      if (this.opts.state === "thinking") {
        p.yaw += s * 0.05 * w;
        p.roll += s * 0.018 * w;
        p.eyeX += s * 0.02 * w;
      } else {
        p.pitch += s * 0.028 * w;
        p.lift += (e - 0.5) * 0.012 * w;
      }
    }
    // Blink: close in 70 ms, open in 120 ms.
    const bt = now - this.blinkAt;
    if (bt >= 0 && bt < BLINK_MS) {
      const c = bt < 70 ? bt / 70 : 1 - (bt - 70) / (BLINK_MS - 70);
      p.eyeOpen *= 1 - 0.9 * Math.max(0, Math.min(1, c));
    }
    p.squash *= 1 + this.squashKick.x * 0.06;
    p.scale = 1;
    p.opacity = 1;
    if (this.arriveAt >= 0) {
      const t = Math.min(1, (now - this.arriveAt) / ARRIVE_MS);
      const e = outExpo(t);
      if (this.opts.reduced) {
        p.opacity = e;
      } else {
        p.opacity = Math.min(1, t * 2.2);
        p.scale = 0.9 + 0.1 * e;
        p.lift += (1 - e) * 0.55;
      }
    }
    return p;
  }
}
