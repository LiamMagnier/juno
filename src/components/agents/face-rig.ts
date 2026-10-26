/**
 * The face rig: how an agent's face moves (docs/design/AGENTS.md §4.2).
 *
 * Two halves:
 *
 *  1. THE POSE ENGINE, pure. Each state is a target pose as a function of the
 *     time since it began, and every change of state blends each field from a
 *     frozen snapshot of the old pose with its own delay, duration and ease.
 *     Ease-outs only; the body never overshoots, and the one pop is the
 *     needs-you ball. `stillPose(state)` is the reduced-motion frame for each
 *     state, which must read on its own.
 *
 *  2. THE RUNTIME, client only. One shared clock (requestAnimationFrame) for
 *     every face on the page, one pointer listener and one
 *     IntersectionObserver: a face off screen costs nothing. Rest is event
 *     driven: a face whose pose is not changing leaves the clock and sets a
 *     timer for its next blink or glance, so nothing floats at rest and an
 *     idle page costs nothing between events. Frames are written as
 *     attribute diffs with a quarter-pixel dead band.
 *
 * Rest life (blinks, glances, looking at the pointer) belongs to `live` faces.
 * State motion (the orbit, the thinking dots, the waiting glance at its badge)
 * plays on every face unless motion is reduced. State changes are smoothed
 * (`gateAt`): a request to think is held for 250 ms (2.5 s out of working, so
 * a model turn between two tool calls stays working), a request to work out of
 * thinking for 400 ms (a tool blip never throws a ring), a state stays on
 * screen for at least 700 ms (1.4 s between thinking and working, whose
 * transitions are longer), and the working face spin is never interrupted
 * except by a state that needs you, so the flips of a voice turn or an agent
 * loop never play as a flicker and every transition that plays runs to its end.
 *
 * Previews a person drives (`direct`: the studio, the hire flow) skip the
 * smoothing: a click is answered in the next frame.
 *
 * Faces mounted together never move as one machine: each agent runs its
 * orbit (and, from 48 px, its thinking wave) at its own pace, within ±10% of
 * the house speed, so their phases drift apart within seconds, and a thinking
 * face arriving on a page starts its wave after a beat of its own. Faces
 * handed one change in one frame (a poll of the roster) each acknowledge it
 * after a beat of their own, clear of each other (`staggeredAt`). What makes
 * an agent itself (the way it rests, its pace) comes from its identity, never
 * from the mount, so one agent is the same agent in every place it is drawn.
 */

import type { AgentMark } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import { reducedMotionAt, subscribeReducedMotion } from "@/lib/motion-preference";
import {
  BALL_LEAD,
  BLENDED,
  RING_LOWEST,
  CUT,
  D2R,
  NO_EXTRAS,
  PARTS,
  clamp,
  clamp01,
  drawFace,
  lerp,
  pxPerR,
  type BlendedField,
  type FaceExtras,
  type FaceFrame,
  type FaceSpec,
  type Part,
  type Pose,
  type SizeClass,
} from "./face-geometry";

/* ------------------------------------------------------------------------ */
/* Easing                                                                    */
/* ------------------------------------------------------------------------ */

type Ease = (x: number) => number;
const outQuint: Ease = (x) => 1 - Math.pow(1 - clamp01(x), 5);
const outCubic: Ease = (x) => 1 - Math.pow(1 - clamp01(x), 3);
const inOutCubic: Ease = (x) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const inOutSine: Ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x));

/** A blink: close fast, hold a beat, reopen softer. x is 0..1 over the blink. */
function blinkCurve(x: number) {
  if (x < 0 || x >= 1) return 1;
  if (x < 0.36) return 1 - 0.94 * (x / 0.36) ** 2;
  if (x < 0.46) return 0.06;
  return 0.06 + 0.94 * outCubic((x - 0.46) / 0.54);
}
const BLINK_S = 0.24;
/** The acknowledgement blink's length, and the pace a blink carried across a change of state runs on at (s). */
const ACK_S = 0.22;
/** Where on blinkCurve's closing side (shut included) the eyes are `c` open. */
const closingPhase = (c: number) => 0.36 * Math.sqrt(clamp01((1 - c) / 0.94));
/** …and where on its reopening side (outCubic inverted). */
const reopeningPhase = (c: number) => 0.46 + 0.54 * (1 - Math.cbrt(1 - clamp01((c - 0.06) / 0.94)));
/** A blink reopening this far counts as open: a state's acknowledgement may close the eyes again from there (a double blink, never a stutter). */
const REOPENED = 0.9;

/**
 * Where on blinkCurve a new state's eyes start, from the blink under way when
 * it began (`snap.blinkC`, `snap.blinkDir`, recorded by `snapshot`), or null
 * when nothing is under way and the state has no blink of its own. A blink is
 * never cut, and never restarted from open: one that was closing (or shut)
 * goes on to shut and reopens; one reopening reopens. `ack`: the state
 * acknowledges with a blink of its own, and the blink under way is that
 * blink, unless it had all but reopened, when the acknowledgement closes the
 * eyes again from where they are. Eyes the old state's lid had closed (a
 * small face thinking, paused) need no blink to acknowledge: their opening is it.
 * How far a blink has got is judged by the blink alone, never by the lid: a
 * temper that rests its lid low (`visor`, 0.86) is open, and acknowledges
 * like every other.
 */
function blinkPhase(snap: Pose | null, ack: boolean): number | null {
  const c = snap?.blinkC ?? 1;
  const acks = ack && (snap?.lid ?? 1) >= 0.5 && c >= REOPENED;
  if (c >= 0.999) return acks ? 0 : null;
  const reopening = (snap?.blinkDir ?? -1) > 0;
  if (reopening && !acks) return reopeningPhase(c);
  return closingPhase(c);
}

/** A blink starting at `phase` of blinkCurve, `ts` s into a state. */
const blinkFrom = (phase: number | null, ts: number) => (phase === null || ts < 0 ? 1 : blinkCurve(phase + ts / ACK_S));

/**
 * Every acknowledgement hides behind a blink (none when a state is only
 * rebased: nothing new happened), and joins a blink already under way
 * (blinkPhase) rather than reopening the eyes to close them again.
 */
const forcedBlink = (ts: number, snap: Pose | null, rebase = false) => (rebase ? 1 : blinkFrom(blinkPhase(snap, true), ts));

/** Deterministic noise in [0, 1) for slot `n` of a face's schedule. */
function noise(seed: number, n: number, salt: number) {
  let h = (seed ^ Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------------ */
/* The pose engine                                                           */
/* ------------------------------------------------------------------------ */

/** The stored `mark` is drawn as nothing; it biases rest life, so a choice still means something. */
const TEMPER: Record<AgentMark, { blink: [number, number]; lid: number; glanceUp: number; glance: number }> = {
  none: { blink: [3.2, 7.5], lid: 1, glanceUp: 0, glance: 1 },
  ring: { blink: [3.2, 7.5], lid: 1, glanceUp: 0, glance: 1.5 },
  spark: { blink: [2.4, 5.5], lid: 1, glanceUp: 0, glance: 1.2 },
  leaf: { blink: [4.5, 9.5], lid: 1, glanceUp: 0, glance: 0.7 },
  antenna: { blink: [3.2, 7.5], lid: 1, glanceUp: 5, glance: 1 },
  visor: { blink: [3.6, 8.0], lid: 0.86, glanceUp: 0, glance: 0.8 },
};

export interface FaceCtx {
  size: SizeClass;
  split: number;
  /** Eye height over width of the stored cut. */
  aspect: number;
  temper: (typeof TEMPER)[AgentMark];
  /** This copy's own noise: blink and glance phases, so two copies of one agent never blink as one. */
  seed: number;
  /** Rest life on: blinks, glances. */
  live: boolean;
  /** The voice level (0..1) while listening. */
  level: number;
  /** The agent's own pace (0.9 to 1.1, from its identity): its orbit speed and (from 48 px) its thinking wave, so agents side by side never move in lockstep and one agent moves alike wherever it is shown. */
  pace: number;
  /** The way the agent rests (from its identity): −1 up-left, 1 up-right. */
  side: -1 | 1;
}

/**
 * `identity` is the agent's, not the mount's (`faceIdentity`): what stays the
 * same for an agent wherever it is drawn (which way it rests, its pace) comes
 * from it, so the server's frame, a roster still and the live face agree and
 * nothing turns after hydration. `seed` is this copy's own noise.
 */
export function faceCtx(spec: FaceSpec, mark: AgentMark, seed: number, live: boolean, identity = seed): FaceCtx {
  const cut = CUT[spec.eyes];
  const pace = 0.9 + 0.2 * noise(identity, 0, 97);
  const side = noise(identity, 0, 131) < 0.5 ? -1 : 1;
  return { size: spec.size, split: cut.split, aspect: cut.h / cut.w, temper: TEMPER[mark] ?? TEMPER.none, seed, live, level: 0, pace, side };
}

/** An agent's identity for the rig: a stable hash (FNV-1a) of its stored face. */
export function faceIdentity(avatar: { shape: string; tone: string; eyes: string; mark: string }): number {
  const key = `${avatar.shape}|${avatar.tone}|${avatar.eyes}|${avatar.mark}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The orbit's cruising speed, °/s: calm, and this agent's own. */
const orbitSpeed = (ctx: FaceCtx) => 96 * ctx.pace;
/**
 * How fast this copy's fresh orbit spins up to speed (the time constant, s):
 * 0.45 to 2 s, the copy's own, so faces that start working in the same frame
 * (a team handed one job) part within a turn instead of riding the same curve.
 */
const spinUpTau = (ctx: FaceCtx) => 0.45 + 1.55 * noise(ctx.seed, 4, 67);
/**
 * …and an orbit arriving on a page, off its painted spot: 0.63 to 1.17 s.
 * Narrower, because every copy starts from that one spot and its beat of
 * hold already parts them: a slow spin-up would keep balls on the spot.
 */
const arriveTau = (ctx: FaceCtx) => 0.9 * (0.7 + 0.6 * noise(ctx.seed, 4, 67));
/** The thinking wave's rate: the chat's 1.4 s rhythm at roster sizes (it sits beside the chat's own indicator), and within ±6% of it from 48 px. */
const waveRate = (ctx: FaceCtx) => (ctx.size.ring ? 1 + (ctx.pace - 1) * 0.6 : 1);

/** Which way a face rests: half the agents look up-left, half up-right, so a stage of them never stares into one corner; one agent always the same way. */
const sideOf = (ctx: FaceCtx) => ctx.side;

/** The gap in the open ring, in degrees: about one ball-width either side of the ball, so it reads as the brand's ball terminal. */
const RING_GAP = 38;

/** How far (R) a small face's pair of eyes is set toward its agent's side, on top of its slight turn that way (3°): about 0.08 R in all. */
const SMALL_NUDGE = 0.025;

/**
 * Blocked's worry, the way done's happiness is drawn: the stored cut itself,
 * shortened and leaned, mirrored per eye with the tops toward the middle, so
 * the outer top of each eye is the low one (the droop a lid cut used to draw,
 * without its corners; leaned the other way the pair reads cross). Grok's sad
 * is the same restyle (height × 0.78, a 12° lean). Never shorter than a
 * capsule 1.25 times as tall as it is wide, or the lean stops reading, and a
 * round cut is never stretched.
 */
const WORRY = { eH: 0.75, tilt: 14, minAspect: 1.25 };
/** Blocked's eye width: a touch wider, so the shortened cut keeps its weight. */
const WORRY_W = 1.06;
const worryHeight = (ctx: FaceCtx) => clamp((WORRY.minAspect * WORRY_W) / ctx.aspect, WORRY.eH, 1);

function restPose(ctx: FaceCtx): Pose {
  const front = ctx.size.front;
  const side = sideOf(ctx);
  return {
    morph: 0, think: 0, bx: 0, by: 0, bs: 1, bsx: 1, bsy: 1, brot: 0,
    // A calm three-quarter rest (not Grok's corner), mirrored per agent: small
    // faces look at you, their pair set a little toward the agent's side, so
    // two eyes dead centre never read as a glyph.
    yaw: front ? 3 * side : 18 * side, pitch: front ? 4 : 13, froll: front ? 0 : -6 * side, split: ctx.split,
    eS: 1, eW: 1, eH: 1, tilt: 0, lid: ctx.temper.lid, smile: 0, ex: front ? SMALL_NUDGE * side : 0, ey: 0,
    ringP: 0, ringGap: RING_GAP, ringA: 1, ringO: 0, ballS: 0, ballPark: 0, badgeS: 0,
    // Long cuts always lean the agent's way, never stand as a pause glyph
    // (EYE_LEAN); a state whose eyes are not open bars lets it go (leanW 0).
    lookW: 1, blinkW: 1, eyeLean: side, leanW: 1,
    ringPhase: 0, ringSpeed: 0, blinkMul: 1, blinkC: 1, blinkDir: 0, spinYaw: 0, badgeKind: null, ringKind: "live", pulse: 0,
  };
}

/** The jittered slot T falls in: slot n runs from at(n) to at(n + 1). */
function slotAt(at: (n: number) => number, P: number, T: number) {
  let n = Math.floor(T / P);
  while (T < at(n)) n -= 1;
  while (T >= at(n + 1)) n += 1;
  return n;
}

/** How long a glance takes: a drift, not a saccade. */
const GLANCE_S = 0.7;

/** The glance slot T falls in: when it began, and where the eyes were and are going. */
function glanceSlot(ctx: FaceCtx, salt: number, T: number, every: [number, number], ampY: number, ampP: number, biasP = 0) {
  const P = (every[0] + every[1]) / 2;
  const at = (n: number) => n * P + (noise(ctx.seed, n, salt) - 0.5) * (every[1] - every[0]);
  const n = slotAt(at, P, T);
  const target = (k: number) => ({
    y: (noise(ctx.seed, k, salt + 1) * 2 - 1) * ampY,
    p: (noise(ctx.seed, k, salt + 2) * 2 - 1) * ampP + biasP,
  });
  return { start: at(n), next: at(n + 1), a: target(n - 1), b: target(n) };
}

/** A glance schedule, pure in T: slots of `every` seconds (jittered), each a new place to look, reached in a slow drift. */
function glance(ctx: FaceCtx, salt: number, T: number, every: [number, number], ampY: number, ampP: number, biasP = 0) {
  const g = glanceSlot(ctx, salt, T, every, ampY, ampP, biasP);
  const e = outCubic((T - g.start) / GLANCE_S);
  return { y: lerp(g.a.y, g.b.y, e), p: lerp(g.a.p, g.b.p, e) };
}

/** Face time at which a glance schedule next moves: now while a glance is under way, else the next slot. */
function glanceNext(ctx: FaceCtx, salt: number, T: number, every: [number, number]) {
  const g = glanceSlot(ctx, salt, T, every, 0, 0);
  return T - g.start < GLANCE_S ? T : g.next;
}

/** Speed eases exponentially toward the target; the phase is its closed-form integral. */
function ringSpin(ts: number, snap: Pose | null, target: number, tau: number) {
  const s0 = snap ? snap.ringSpeed : 0;
  const p0 = snap ? snap.ringPhase : 0;
  const e = Math.exp(-ts / tau);
  return { speed: target + (s0 - target) * e, phase: p0 + target * ts + (s0 - target) * tau * (1 - e) };
}
function settleRing(p: Pose, ts: number, snap: Pose | null) {
  const s = ringSpin(ts, snap, 0, 0.3);
  p.ringPhase = s.phase;
  p.ringSpeed = s.speed;
}
/** 0 → peak → 1: the one deliberate pop in the system, the needs-you ball arriving. */
function pop(x: number, peak: number) {
  const t = clamp01(x);
  return t < 0.42 ? peak * outCubic(t / 0.42) : peak - (peak - 1) * inOutSine((t - 0.42) / 0.58);
}
/** Hold-and-return: 0 → 1 (ease out) → hold → 0 (ease out), once per period. */
function gesture(ts: number, start: number, period: number, rise: number, hold: number, fall: number) {
  if (ts < start) return 0;
  const l = (ts - start) % period;
  if (l < rise) return outQuint(l / rise);
  if (l < rise + hold) return 1;
  if (l < rise + hold + fall) return 1 - outCubic((l - rise - hold) / fall);
  return 0;
}
/** Seconds into a state at which a gesture schedule next moves: `ts` while one is under way. */
function gestureNext(ts: number, start: number, period: number, dur: number) {
  if (ts < start) return start;
  const l = (ts - start) % period;
  return l < dur ? ts : ts + period - l;
}

/** The waiting look at its badge: every 4.2 s for the first four, then every 16 s, so a long wait is not a tic. */
const WAIT_GESTURE = [0.35, 0.85, 0.45] as const;
const waitGesture = (ts: number) => (ts < 18.4 ? gesture(ts, 1.6, 4.2, ...WAIT_GESTURE) : gesture(ts - 18.4, 2, 16, ...WAIT_GESTURE));
const waitGestureNext = (ts: number) => (ts < 18.4 ? gestureNext(ts, 1.6, 4.2, 1.65) : 18.4 + gestureNext(ts - 18.4, 2, 16, 1.65));

/** Done's slow drift once the beat is over: rarer than idle's. */
const DONE_EVERY: [number, number] = [7, 12];
/** Done's mirrored lean, degrees: negative drops each happy capsule's outer end (blocked's sad lean is the other way). */
const HAPPY_TILT = -12;

/** Idle's glance cadence, shaped by the stored mark. */
const idleEvery = (ctx: FaceCtx): [number, number] => [4 / ctx.temper.glance, 8 / ctx.temper.glance];

type Timing = [delay: number, duration: number, ease?: Ease];
interface StateDef {
  /**
   * `rebase`: the state is not new, the agent's look changed under it
   * (`rebaseSegment`): the entry-only beats (the acknowledgement blink, the
   * face spin, a fresh orbit's pop, the badge's pop) are skipped and what is
   * already on screen carries on from `snap`.
   */
  target(ts: number, snap: Pose | null, ctx: FaceCtx, T: number, rebase: boolean): Pose;
  timing?: Partial<Record<BlendedField, Timing>>;
  /**
   * The face time at which the state's own pose next changes: T while it is
   * moving, Infinity once it never will (blinks and the pointer aside). A
   * state without it moves continuously (the orbit, the dots, the voice).
   */
  quiet?(ts: number, ctx: FaceCtx, T: number, snap: Pose | null): number;
}

/** A badge leaving fades out as itself, on one curve, from every state that has none. */
const BADGE_OUT: Timing = [0, 0.3, outCubic];

/**
 * The orbit leaving, mirroring its entrance, and put away as done puts it
 * away: the open ring reels back into its ball at once (an ease-out: the
 * change is seen in the first frames, never a held beat), and the ball sinks
 * into nothing while the last of the ring reels in, opaque throughout, so it
 * never hangs beside the body as a lone, fading dot. The orbit is over once
 * nothing is left to see. Under half a second, never a cut, and no stub of
 * ring outlives its ball.
 */
const RING_OUT: Partial<Record<BlendedField, Timing>> = {
  ringP: [0, 0.32, outCubic],
  ballS: [0.17, 0.25, outCubic],
  ringO: [0.42, 0.001],
};

/**
 * The stalled orbit (blocked) leaving over `reel` seconds: the grey ring reels
 * into its red ball, and the ball shrinks once the last eighth of the ring is
 * left (from half the reel), so the two reach nothing together: the ball
 * never sits alone under the body like a stray dot, and what little ring is
 * left fades with its ball (drawOrbit). The opacity only goes once nothing is
 * left to see.
 */
const stallOut = (reel: number): Partial<Record<BlendedField, Timing>> => ({
  ringP: [0, reel, outCubic],
  ballS: [0.5 * reel, 0.5 * reel, outCubic],
  ringO: [reel, 0.08, outCubic],
});

/**
 * An orbit leaving, computed inside a target (for states whose own target
 * draws an orbit in some cases, so their timing table cannot carry the exit):
 * the same curves as RING_OUT, or stallOut for a stalled one.
 */
function reelOut(p: Pose, ts: number, snap: Pose) {
  p.ringKind = snap.ringKind;
  p.ringGap = snap.ringGap;
  p.ringA = snap.ringA;
  const ease = (t: Timing) => (t[2] ?? outQuint)((ts - t[0]) / t[1]);
  const T = snap.ringKind === "stalled" ? stallOut(RING_OUT.ringP![1]) : RING_OUT;
  p.ringP = lerp(snap.ringP, 0, ease(T.ringP!));
  p.ballS = lerp(snap.ballS, 0, ease(T.ballS!));
  p.ringO = lerp(snap.ringO, 0, ease(T.ringO!));
}

/**
 * Below 48 px, an orbit giving way to a badge (needs you, blocked): the rim
 * ball sinks first and fast (0.18 s), so it is gone before the notch opens
 * (0.2 s) and the eyes never have two things to keep clear of at once (a
 * 20 px face would lose both eyes between them). Otherwise as reelOut.
 */
function leaveForBadge(p: Pose, ts: number, snap: Pose, ctx: FaceCtx) {
  if (ctx.size.ring || snap.ballS <= 0.05) {
    reelOut(p, ts, snap);
    return;
  }
  p.ringKind = snap.ringKind;
  p.ringGap = snap.ringGap;
  p.ringA = snap.ringA;
  p.ringP = lerp(snap.ringP, 0, outCubic(ts / 0.08));
  p.ballS = lerp(snap.ballS, 0, outCubic(ts / 0.18));
  p.ringO = lerp(snap.ringO, 0, outCubic((ts - 0.15) / 0.05));
}

/** How far a working face (48 px and up) stays turned its own way while it looks down at the work (degrees). */
const WORK_YAW = 10;

/** The working face spin, in seconds into the state: once the ball is out, the face goes round with it. A change of state waits for it to end. */
const SPIN: [number, number] = [0.45, 1.45];
/** Whether a face spins as it kicks into gear: 48 px and up, and not out of thinking (already a turn). */
const spinsInto = (size: SizeClass, snap: Pose | null) => size.spin && !(snap && snap.morph > 0.5);
/**
 * A fresh orbit's ball pops out on the near half of its ring (ring phase),
 * which passes under every body, so it arrives in view and clear of the body,
 * never in mid-air or behind it. Each copy pops at a point of its own,
 * between the ring's right end and just past its front (5° to 125° round),
 * so faces that start working in the same frame (one poll of the roster can
 * carry several) set off from different places.
 */
const FRESH_PHASE = 65 - BALL_LEAD;
const freshPhase = (ctx: FaceCtx) => FRESH_PHASE + 120 * (noise(ctx.seed, 5, 67) - 0.5);
/** The stalled orbit's ball rests at the lowest point of the tilted ring (lower left, clear of every body). */
const STALL_PHASE = RING_LOWEST - BALL_LEAD;

/** A ball changing paint (working ↔ blocked): it dips over 0.12 s, holds at a third of its size until 0.16 s, and changes colour halfway through the hold. */
const REPAINT = { dip: 0.12, swap: 0.14, hold: 0.16 };

/**
 * A visible orbit changing kind (working ↔ blocked): its ball dips to a third
 * of its size in its old paint and grows back in the new one, so the colour
 * swaps while it is small, under the acknowledgement blink. A blend from the
 * presence blue to the blocked red would pass through magenta, a third hue
 * that is in neither (the ball's paint has no transition, agent-face.css; the
 * ring's grey ↔ blue blend has no third hue and keeps its transition).
 * Returns the ball's size, and holds `p.ringKind` at the old paint until the
 * bottom of the dip.
 */
function repaintBall(p: Pose, ts: number, snap: Pose) {
  if (ts < REPAINT.swap) p.ringKind = snap.ringKind;
  if (ts < REPAINT.dip) return lerp(snap.ballS, 0.3, outCubic(ts / REPAINT.dip));
  if (ts < REPAINT.hold) return 0.3;
  return lerp(0.3, 1, outCubic((ts - REPAINT.hold) / 0.3));
}

/** The stalled orbit's coast: the speed it had decays on this time constant (s). */
const STALL_COAST_TAU = 0.3;
/** Once the coast is down to this speed (°/s) the ball settles. */
const STALL_SETTLE_SPEED = 10;
/** The settle's peak speed (°/s), well under the orbit's own: a ball finding the bottom, never thrown there. */
const STALL_SLIDE_PEAK = 55;

/**
 * How an orbit runs down from `snap` (blocked): when its coast ends (t1, s
 * into the state), where and how fast it is then (pc, vc), the shorter way
 * from there to the bottom of the ring (delta, degrees), and how long the
 * settle takes (dur, s).
 */
function stallPlan(snap: Pose) {
  const p0 = snap.ringPhase;
  const v0 = snap.ringSpeed;
  const a = Math.abs(v0);
  const t1 = a > STALL_SETTLE_SPEED ? STALL_COAST_TAU * Math.log(a / STALL_SETTLE_SPEED) : 0;
  const e = Math.exp(-t1 / STALL_COAST_TAU);
  const pc = p0 + v0 * STALL_COAST_TAU * (1 - e);
  const vc = v0 * e;
  const delta = ((((STALL_PHASE - pc) % 360) + 540) % 360) - 180;
  // A Hermite settle peaks at 1.5 × its mean speed: sized so it stays under STALL_SLIDE_PEAK.
  const dur = Math.max(0.8, (1.5 * Math.abs(delta)) / STALL_SLIDE_PEAK);
  return { p0, v0, t1, pc, vc, delta, dur };
}

/** Whether a blocked face picks up a running orbit from `snap` (the one stallRing runs down). */
const runsDown = (snap: Pose | null): snap is Pose => !!snap && snap.ringO > 0.5 && snap.ballS > 0.05;

/** Seconds into blocked at which the ball has settled at the bottom of the ring (0 when nothing runs down). */
function stallEnd(snap: Pose | null, ctx: FaceCtx) {
  if (!ctx.size.ring || !runsDown(snap)) return 0;
  const S = stallPlan(snap);
  return S.t1 + S.dur;
}

/**
 * The orbit running down (blocked), in two parts. First it coasts on: the
 * speed it had decays exponentially, so the ball never speeds up and never
 * turns back while it rolls. Then, slow, it settles the shorter way to the
 * bottom of the ring, from the speed it has left to rest, never faster than
 * STALL_SLIDE_PEAK: a ball finding the bottom, rocking back at most once,
 * slowly, and never bouncing.
 */
function stallRing(p: Pose, ts: number, snap: Pose | null) {
  if (!runsDown(snap)) {
    p.ringPhase = STALL_PHASE;
    p.ringSpeed = 0;
    return;
  }
  const S = stallPlan(snap);
  if (ts < S.t1) {
    const e = Math.exp(-ts / STALL_COAST_TAU);
    p.ringPhase = S.p0 + S.v0 * STALL_COAST_TAU * (1 - e);
    p.ringSpeed = S.v0 * e;
    return;
  }
  // A cubic Hermite from (pc, vc) to (pc + delta, 0).
  const s = Math.min(1, (ts - S.t1) / S.dur);
  const m0 = S.vc * S.dur;
  p.ringPhase = S.pc + m0 * (s * s * s - 2 * s * s + s) + S.delta * (3 * s * s - 2 * s * s * s);
  p.ringSpeed = s >= 1 ? 0 : (m0 * (3 * s * s - 4 * s + 1) + S.delta * 6 * s * (1 - s)) / S.dur;
}

const STATES: Record<AgentState, StateDef> = {
  idle: {
    target(ts, snap, ctx, T) {
      const p = restPose(ctx);
      if (ctx.live) {
        const g = glance(ctx, 11, T, idleEvery(ctx), 6, 3.5, ctx.temper.glanceUp);
        p.yaw += g.y;
        p.pitch += g.p;
      }
      settleRing(p, ts, snap);
      return p;
    },
    timing: { ...RING_OUT, yaw: [0.1, 0.62, outCubic], pitch: [0.1, 0.62, outCubic], morph: [0, 0.42], think: [0, 0.3, outCubic], badgeS: BADGE_OUT },
    quiet: (ts, ctx, T) => (ts < 1.2 ? T : ctx.live ? glanceNext(ctx, 11, T, idleEvery(ctx)) : Infinity),
  },

  /* Large faces turn away, round the back, while the body winds into the
     middle of three flat round dots (it rounds as it shrinks, so every agent
     thinks with the same ellipsis): the turn starts at once and eases out,
     and the wind-down overlaps it, so the eyes are carried off, never
     flicked, and there is no blank beat between. Small faces close their eyes
     instead (a turn at 28 px is a jump). A wave runs across the dots on the
     chat's 1.4 s rhythm. */
  thinking: {
    target(ts, snap, ctx, _T, rebase) {
      const p = restPose(ctx);
      Object.assign(
        p,
        // Small, the eyes shut: no lean floor. Large, they stay open bars as
        // they go round the limb, and the floor fades with the turn itself.
        ctx.size.front
          ? { lid: 0, morph: 1, think: 1, lookW: 0, blinkW: 0, leanW: 0 }
          : { yaw: 132 * sideOf(ctx), pitch: 14, morph: 1, think: 1, lookW: 0, blinkW: 0 },
      );
      // Each copy's wave starts at a point of its own: faces that start
      // thinking in the same frame never pulse as one (unseen as it starts:
      // the side dots grow from nothing).
      p.pulse = rebase && snap ? snap.pulse + ts * waveRate(ctx) : ts * waveRate(ctx) + 1.4 * noise(ctx.seed, 3, 61);
      settleRing(p, ts, snap);
      return p;
    },
    // Out of working (the most frequent change in an agent loop) the orbit
    // reels into its ball while the head turns away, and the ball sinks as the
    // body winds down: one action, done before the body is half wound, never a
    // cut. Ease-outs, so the change shows in the first frames.
    timing: {
      yaw: [0, 0.6, outCubic],
      pitch: [0, 0.6, outCubic],
      lid: [0, 0.16, outCubic],
      morph: [0.2, 0.55, outCubic],
      think: [0.42, 0.5, outCubic],
      bs: [0.2, 0.55, outCubic],
      by: [0.2, 0.55, outCubic],
      brot: [0.2, 0.55, outCubic],
      ringP: [0, 0.36, outCubic],
      ballS: [0.24, 0.2, outCubic],
      ringO: [0.4, 0.05, outCubic],
      badgeS: BADGE_OUT,
      // An expression lets go before the eyes go round the limb: a happy or
      // worried capsule seen edge-on would end in points.
      smile: [0, 0.2, outCubic],
      eW: [0, 0.2, outCubic],
      eH: [0, 0.2, outCubic],
      tilt: [0, 0.2, outCubic],
      // Small, the lean lets go once the eyes have shut; large, out of done or blocked it comes back as the head turns away.
      leanW: [0.05, 0.35, inOutCubic],
    },
  },

  /* Acknowledge (a blink), then kick into gear as one action: the presence
     ball pops out in front at the right (0.25 s), throws Juno's open ring
     forward round the body in its own direction of travel (0.35 to 0.95 s),
     the face goes once round the back with it, the same way (0.45 to
     1.45 s; once, as the beat of starting, never again), and it settles
     looking down at the work. Then the orbit turns at a calm 96°/s (each
     face at its own pace, ±10%), the eyes follow its ball as it passes in
     front (from 48 px: in gear, not a decal turning round a still face), and
     they look up now and then. */
  working: {
    target(ts, snap, ctx, T, rebase) {
      const p = restPose(ctx);
      const sz = ctx.size;
      const spin = !rebase && spinsInto(sz, snap);
      const g = glance(ctx, 23, T, [3.5, 6.5], 7, 3);
      const look = rebase ? 1 : outQuint((ts - (spin ? SPIN[1] : 0.5)) / 0.5);
      // Fresh: no orbit already there (one still leaving, or stalled, is picked
      // up where it is; so is any orbit when the state is only rebased).
      const fresh = !snap || (!rebase && snap.ringO < 0.5);
      const s = fresh ? ringSpin(Math.max(0, ts - 0.25), null, orbitSpeed(ctx), spinUpTau(ctx)) : ringSpin(ts, snap, orbitSpeed(ctx), 0.9);
      p.ringPhase = s.phase + (fresh ? freshPhase(ctx) : 0);
      p.ringSpeed = s.speed;
      // Head down at the work, still turned the agent's own way (its far eye
      // narrower) and still rolled its own way, so the pair keeps its lean: a
      // working face whose two long cuts stood upright read as ⏸ inside its
      // spinning ring.
      const side = sideOf(ctx);
      if (sz.front) {
        p.yaw = lerp(0, 3 * side + g.y * 0.4, look);
        p.pitch = lerp(2, -6 + g.p * 0.5, look);
      } else {
        // Following the ball while it is in front (sin > 0 is the near half),
        // a smooth weight that is zero, and flat, as it goes behind.
        const phi = (p.ringPhase + BALL_LEAD) * D2R;
        const near = Math.sin(phi) > 0 ? Math.sin(phi) ** 2 : 0;
        p.yaw = lerp(0, WORK_YAW * side + g.y + 6 * Math.cos(phi) * near, look);
        p.pitch = lerp(1, -10 + g.p - 4 * near, look);
        p.froll = lerp(0, p.froll, look);
      }
      p.blinkMul = forcedBlink(ts, snap, rebase);
      p.ringKind = "live";
      if (fresh || !snap) {
        p.ballS = outQuint((ts - 0.25) / 0.3);
        p.ringP = outCubic((ts - 0.35) / 0.6);
      } else {
        p.ballS = snap.ringKind !== "live" ? repaintBall(p, ts, snap) : lerp(snap.ballS, 1, outCubic(ts / 0.35));
        p.ringP = lerp(snap.ringP, 1, outCubic(ts / 0.5));
      }
      p.ringO = 1;
      p.ringA = 1;
      p.ringGap = RING_GAP;
      // Against the clock, as the orbit's front runs: the face and its ring turn together.
      p.spinYaw = spin && ts >= SPIN[0] && ts < SPIN[1] ? -360 * inOutCubic((ts - SPIN[0]) / (SPIN[1] - SPIN[0])) : 0;
      return p;
    },
    timing: { yaw: [0, 0.3], pitch: [0, 0.3], ringP: [0, 0.001], ballS: [0, 0.001], ringO: [0, 0.2], morph: [0, 0.4], think: [0, 0.3], badgeS: BADGE_OUT },
  },

  /* It asks for you: leans in, faces you with larger eyes, the needs-you ball
     pops once into its notch, and now and then the eyes go to it and back —
     one calm "over here", every 4.2 s at first, then every 16 s. Small faces
     look half as far. Out of working, the orbit reels in as the ball pops:
     "stop, over here". */
  waiting: {
    target(ts, snap, ctx, _T, rebase) {
      const p = restPose(ctx);
      const g = waitGesture(ts);
      const front = ctx.size.front;
      Object.assign(p, {
        yaw: lerp(0, front ? -7 : -12, g),
        pitch: lerp(1, front ? 4 : 8, g),
        froll: 0,
        eS: 1.1,
        ex: 0.04,
        ey: 0.03,
        bs: 1.035,
        lookW: 0.5,
      });
      p.blinkMul = forcedBlink(ts, snap, rebase);
      if (rebase && snap && snap.badgeKind === "ball") {
        // Only rebased: the ball is already in its notch and stays.
        p.badgeKind = "ball";
        p.badgeS = lerp(snap.badgeS, 1, outCubic(ts / 0.3));
      } else if (snap && snap.badgeKind === "bar" && snap.badgeS > 0.5) {
        // From blocked: the bar shrinks nearly away, and the ball grows from that point.
        p.badgeKind = ts < 0.16 ? "bar" : "ball";
        p.badgeS = ts < 0.16 ? lerp(snap.badgeS, 0.15, outCubic(ts / 0.16)) : 0.15 + 0.85 * pop((ts - 0.16) / 0.6, 1.14);
      } else {
        p.badgeKind = "ball";
        p.badgeS = ts < 0.2 ? 0 : pop((ts - 0.2) / 0.65, 1.14);
      }
      // An orbit leaves as everywhere else; small, its rim ball is gone before the notch opens.
      if (snap && snap.ringO > 0.002) leaveForBadge(p, ts, snap, ctx);
      settleRing(p, ts, snap);
      return p;
    },
    timing: { ringP: [0, 0.001], ballS: [0, 0.001], ringO: [0, 0.001], badgeS: [0, 0.001], bs: [0, 0.6], yaw: [0, 0.4], pitch: [0, 0.4] },
    quiet: (ts, _ctx, T) => (ts < 0.9 ? T : T + waitGestureNext(ts) - ts),
  },

  /* It looks up at you: the head tilts toward you, the eyes open wider and
     rise, and their height follows the voice. Wider and higher than idle by
     a pixel or more even at 20 px, so the still reads too. */
  listening: {
    target(ts, snap, ctx, T, rebase) {
      const p = restPose(ctx);
      const g = ctx.live ? glance(ctx, 37, T, [2.2, 4.2], 4, 2) : { y: 0, p: 0 };
      Object.assign(p, {
        yaw: g.y * 0.6,
        pitch: 7 + g.p * 0.5,
        froll: 0,
        // Cocked the agent's own way, as its eyes lean at rest (a cock the
        // other way would stand its eyes up against their lean).
        brot: -12 * sideOf(ctx),
        eS: 1.18,
        ey: -0.05,
        eH: 1.02 + 0.2 * clamp01(ctx.level),
      });
      p.blinkMul = forcedBlink(ts, snap, rebase);
      settleRing(p, ts, snap);
      return p;
    },
    timing: { ...RING_OUT, brot: [0, 0.6], eH: [0, 0.12, outCubic], badgeS: BADGE_OUT },
  },

  /* It needs help: the head tilts and sinks and the eyes go worried (WORRY:
     shorter, leaned so each one's outer top droops). From
     48 px no sticker: the body carries it, with its orbit stalled (the open
     ring stands still in muted ink, its ball in the blocked red rolled to the
     bottom). Smaller, a still bar in the blocked ink sits in the notch. No
     pop, no loop: a block can last hours and must stay calm in a roster. */
  blocked: {
    target(ts, snap, ctx, T, rebase) {
      const p = restPose(ctx);
      const g = ctx.live ? glance(ctx, 41, T, [5, 9], 4, 2) : { y: 0, p: 0 };
      Object.assign(p, {
        yaw: (ctx.size.front ? -4 : -10) + g.y,
        pitch: (ctx.size.front ? 0 : -3) + g.p,
        froll: 0,
        brot: 7,
        by: 0.05,
        bs: 0.97,
        eH: worryHeight(ctx),
        eW: WORRY_W,
        tilt: WORRY.tilt,
        lid: 0.96,
        // The worry leans the two eyes apart: no floor (it lets go as the worry comes in).
        leanW: 0,
      });
      p.blinkMul = forcedBlink(ts, snap, rebase);
      if (ctx.size.ring) {
        p.ringKind = "stalled";
        p.ringA = 1;
        p.ringGap = RING_GAP;
        if (snap && snap.ringO > 0.5 && (snap.ballS > 0.05 || rebase)) {
          // An orbit already there (working, or one still leaving) is picked
          // up where it is, and runs down (stallRing); a running one's ball
          // changes paint at the bottom of a dip (repaintBall).
          p.ringO = lerp(snap.ringO, 1, outCubic(ts / 0.2));
          p.ballS = snap.ringKind !== "stalled" ? repaintBall(p, ts, snap) : lerp(snap.ballS, 1, outCubic(ts / 0.35));
          p.ringP = lerp(snap.ringP, 1, outCubic(ts / 0.5));
        } else {
          // A calm entrance, working's without the pop: the stalled ball
          // rises at the bottom of the ring, and the ring is drawn out of it.
          // It arrives, never appears in mid-air.
          p.ringO = 1;
          p.ballS = outCubic((ts - 0.15) / 0.35);
          p.ringP = outCubic((ts - 0.25) / 0.7);
        }
        stallRing(p, ts, snap);
        // A needs-you ball leaving (from waiting) fades out as itself.
        p.badgeKind = null;
        p.badgeS = snap ? snap.badgeS * (1 - outCubic(ts / 0.3)) : 0;
        return p;
      }
      // Below 48 px: no orbit. A rim ball leaving (from working) sinks before the bar's notch opens.
      if (snap && snap.ringO > 0.002) leaveForBadge(p, ts, snap, ctx);
      settleRing(p, ts, snap);
      if (rebase && snap && snap.badgeKind === "bar") {
        // Only rebased: the bar is already in its notch and stays.
        p.badgeKind = "bar";
        p.badgeS = lerp(snap.badgeS, 1, outCubic(ts / 0.3));
      } else if (snap && snap.badgeKind === "ball" && snap.badgeS > 0.5) {
        // From waiting: the ball shrinks nearly away, and the bar grows from that point.
        p.badgeKind = ts < 0.16 ? "ball" : "bar";
        p.badgeS = ts < 0.16 ? lerp(snap.badgeS, 0.15, outCubic(ts / 0.16)) : lerp(0.15, 1, outQuint((ts - 0.16) / 0.45));
      } else {
        p.badgeKind = "bar";
        p.badgeS = outQuint((ts - 0.25) / 0.5);
      }
      return p;
    },
    // A slow, heavy look away: no snap. The orbit's own motion is in the target.
    timing: { ringP: [0, 0.001], ballS: [0, 0.001], ringO: [0, 0.001], yaw: [0, 0.6, outCubic], pitch: [0, 0.6, outCubic], brot: [0, 0.6], by: [0, 0.6], bs: [0, 0.6], badgeS: [0, 0.001], eH: [0.05, 0.45, outCubic], eW: [0, 0.4], tilt: [0.1, 0.5, outCubic], leanW: [0, 0.45, inOutCubic] },
    // Moving until its look has settled and its ball has found the bottom of the ring.
    quiet: (ts, ctx, T, snap) => (ts < Math.max(2.6, stallEnd(snap, ctx)) ? T : ctx.live ? glanceNext(ctx, 41, T, [5, 9]) : Infinity),
  },

  /* From working: the gap closes, so the logo's open ring is whole for a
     moment; then the ring reels into its ball and the ball sinks into the
     rim. Opaque throughout: it is put away, never faded or thrown. The eyes
     squint happily, and stay content for as long as the agent is done, with
     a slow drift of the gaze after the beat (no blinks: the happy capsules hold). */
  done: {
    target(ts, snap, ctx, T, rebase) {
      const p = restPose(ctx);
      // Only rebased: the beat is long over, so the face stays as it had settled.
      const beat = rebase ? ts + 5.2 : ts;
      const fromWork = !!snap && snap.ringO > 0.5 && snap.ballS > 0.05 && snap.ringKind === "live";
      if (fromWork && snap && ctx.size.ring) {
        p.ringGap = snap.ringGap * (1 - outCubic(ts / 0.25));
        p.ringP = ts < 0.3 ? lerp(snap.ringP, 1, outQuint(ts / 0.25)) : 1 - inOutSine((ts - 0.3) / 0.4);
        p.ballS = lerp(snap.ballS, 0, outCubic((ts - 0.58) / 0.25));
        // Nothing is left to see by then; the orbit is simply over.
        p.ringO = ts < 0.9 ? 1 : 0;
      } else if (fromWork && snap) {
        // Small: the rim ball slows and sinks back into the body.
        p.ringO = 1;
        p.ballS = snap.ballS * (1 - outCubic(ts / 0.45));
      } else if (snap && snap.ringO > 0.002) {
        // Any other orbit (stalled, or already leaving) leaves as everywhere else.
        reelOut(p, ts, snap);
      }
      const s = ringSpin(ts, snap, 0, 0.32);
      p.ringPhase = s.phase;
      p.ringSpeed = s.speed;
      // The lower lid lifts: a squashed capsule, gently bowed, wider, its
      // outer end lower (mirrored), so the pair smiles without a ^ ^ caret
      // (Grok's happy is a capsule restyle). Held, softened a little after the beat.
      const happy = 1 - 0.18 * inOutSine((beat - 2.6) / 0.8);
      const sq = clamp(1.25 / ctx.aspect, 0.5, 1);
      p.smile = happy;
      p.eH = lerp(1, sq, happy);
      // Small, wider still and set further apart (drawFace keeps 1.25 px of
      // body between the pair, narrowing the capsules if it must), so at
      // 20 px the bow shows, the capsules stay wider than the open eyes on
      // the narrow seats too, and done never reads as two smaller dots.
      p.eW = lerp(1, ctx.size.front ? 1.5 : 1.3, happy);
      if (ctx.size.front) p.split = lerp(ctx.split, ctx.split * 1.25, happy);
      p.tilt = HAPPY_TILT * happy;
      p.lid = lerp(0.93, 1, happy) * ctx.temper.lid;
      p.yaw = lerp(p.yaw, ctx.size.front ? 0 : 4, happy);
      p.pitch = lerp(p.pitch, 6, happy);
      p.froll = lerp(p.froll, 0, happy);
      if (ctx.live) {
        // After the beat, a slow idle-style drift, eased in so it never jumps.
        const g = glance(ctx, 53, T, DONE_EVERY, 4, 2);
        const w = outCubic((beat - 4) / 1.2) * happy;
        p.yaw += g.y * w;
        p.pitch += g.p * w;
      }
      p.blinkW = 0;
      // The happy capsules are not bars: the lean floor lets go as they form.
      p.leanW = 0;
      return p;
    },
    timing: { ringGap: [0, 0.001], ringP: [0, 0.001], ballS: [0, 0.001], ringO: [0, 0.001], ringA: [0, 0.001], eH: [0.05, 0.3], eW: [0.05, 0.3], tilt: [0.05, 0.45, outCubic], smile: [0.05, 0.34], badgeS: BADGE_OUT, leanW: [0.05, 0.45, inOutCubic] },
    quiet: (ts, ctx, T) => (ts < 5.2 ? T : ctx.live ? glanceNext(ctx, 53, T, DONE_EVERY) : Infinity),
  },

  /* Paused: the eyes close to dashes, the head drops a little, and it holds
     still (agent-face.css paints it dormant, so paused never reads as done). */
  sleeping: {
    target(ts, snap, ctx) {
      const p = restPose(ctx);
      Object.assign(p, { yaw: 0, pitch: -9, froll: 0, eW: 1.32, lid: 0, by: 0.05, lookW: 0, blinkW: 0, leanW: 0 });
      settleRing(p, ts, snap);
      return p;
    },
    // The lean lets go only once the lids are half down (the cuts are no longer bars), and the dashes level slowly.
    timing: { ...RING_OUT, lid: [0.05, 0.7, outCubic], eW: [0.05, 0.7, outCubic], by: [0, 0.8], pitch: [0, 0.8], badgeS: BADGE_OUT, leanW: [0.12, 0.5, inOutCubic] },
    quiet: (ts, _ctx, T) => (ts < 1.2 ? T : Infinity),
  },
};

/**
 * A segment of a face's life: a state, when it began, and the pose it began
 * from. `from` is for a face that arrives already in its state (a page load):
 * the state runs as if it had been there all along, but the pose glides off
 * the still frame the server painted over `ARRIVE_S`, and the loops (the
 * orbit's ball, the dots' wave) start from where that frame left them.
 */
export interface Segment {
  state: AgentState;
  at: number;
  snap: Pose | null;
  from?: { pose: Pose; at: number };
  /** The state carries on under a changed look (`rebaseSegment`): no entry beats, every field eases over `REBASE`. */
  rebase?: boolean;
}

/**
 * How every field moves when an agent's look changes under a state it is
 * already in (rebaseSegment): an ease-in-out, so the first frame after the
 * change is the frame before it, and a head that now rests the other way
 * turns there calmly (36° in 0.6 s, at most 90°/s).
 */
const REBASE: Timing = [0, 0.6, inOutCubic];

/**
 * The segment a face carries on in when its agent's look changes while it is
 * on screen (a colour, shape or eyes pick in the hire flow, a look saved from
 * the studio). The identity is a hash of the look, so the new one may rest
 * the other way round and keep another pace: rather than swap those under a
 * running state (the head flips and the orbit's ball jumps in one frame), the
 * state is re-entered from where the face is, under the old identity, with
 * its entry beats skipped. A face turned away (thinking) and now resting the
 * other way is mirrored while its eyes are hidden, so they never sweep across.
 */
export function rebaseSegment(seg: Segment, T: number, from: FaceCtx, to: FaceCtx): Segment {
  const snap = snapshot(seg, T, from);
  if (from.side !== to.side && snap.morph > 0.5 && Math.abs(snap.yaw) > 100) snap.yaw = -snap.yaw;
  return { state: seg.state, at: T, snap, rebase: true };
}

const ARRIVE_S = 0.3;
/** How long a small face's parked rim ball takes to roll down into its swing once its orbit starts (s). */
const PARK_S = 1.2;
/** The longest a thinking face arriving on a page holds its painted dots before its wave starts. */
const WAVE_HOLD_S = 1.4;
/** The longest a working face arriving on a page holds its ball on the painted spot before it spins up. */
const ORBIT_HOLD_S = 2;
const DEFAULT_TIMING: Timing = [0, 0.45, outQuint];
/**
 * Fields that leave gentler than the default when a state's table says
 * nothing: an eye's lean (worry, happiness) unwinds, never flicks, and the
 * lean floor comes back over a third of a second (at most about 2° a frame),
 * before the eyes are bars again.
 */
const FIELD_TIMING: Partial<Record<BlendedField, Timing>> = { tilt: [0, 0.5, outCubic], leanW: [0, 0.3, outCubic] };
/** Out of the dots: the body re-inflates gently and the face comes back round after it. */
const FROM_DOTS: Partial<Record<BlendedField, Timing>> = {
  morph: [0, 0.5, outCubic],
  think: [0, 0.4, outCubic],
  yaw: [0.1, 0.65, outCubic],
  pitch: [0.1, 0.65, outCubic],
};
/**
 * …into done (from 48 px), the happy capsules form once the face is nearly
 * round (yaw within about 25°): it comes back and smiles, never smiles
 * edge-on, and its eyes keep their lean until the capsules have formed (they
 * come back round as a pair of open bars). Small faces never turned: their
 * eyes open straight into the capsules.
 */
const FROM_DOTS_HAPPY: Partial<Record<BlendedField, Timing>> = {
  smile: [0.4, 0.34],
  eW: [0.4, 0.3],
  eH: [0.4, 0.3],
  tilt: [0.4, 0.45, outCubic],
  leanW: [0.5, 0.45, inOutCubic],
};

/**
 * A happy pair turning worried (done → blocked) turns its lean over under
 * the acknowledgement blink: the tilt passes upright while the eyes are shut
 * (about 0.06 to 0.12 s in), never as two bars standing side by side.
 */
const TURN_OVER: Timing = [0.02, 0.4, outCubic];

/**
 * Waking from paused: the eyes open with the colour coming back (the dormant
 * paint takes 560 ms), slowly and then fully, never a jolt.
 */
const FROM_SLEEP: Partial<Record<BlendedField, Timing>> = {
  lid: [0.08, 0.6, inOutCubic],
  eW: [0.08, 0.6, inOutCubic],
  pitch: [0, 0.7, outCubic],
  by: [0, 0.7, outCubic],
};

/**
 * The fastest a face may come home round the back (°/s at the start of its
 * ease): a face caught mid-spin keeps the spin's own speed, never whips. A
 * state that needs you comes home at nearly the spin's peak (1080°/s), so
 * its eyes are back before its badge has popped. (580: a face rolled its own
 * way, as at work, starts the turn into thinking under 0.17 R a frame.)
 */
const TURN_SPEED = 580;
const TURN_SPEED_NEEDS_YOU = 1000;

/** The pose at face time T (seconds), before rest life. */
export function poseAt(seg: Segment, T: number, ctx: FaceCtx): Pose {
  const def = STATES[seg.state] ?? STATES.idle;
  const ts = T - seg.at;
  const snap = seg.snap;
  const rebase = !!seg.rebase && !!snap;
  const tgt = def.target(ts, snap, ctx, T, rebase);
  if (seg.from) return arrive(tgt, seg.from, T, ctx);
  if (!snap) return tgt;
  const out: Pose = { ...tgt };
  if (rebase) {
    const e = REBASE[2]!((ts - REBASE[0]) / REBASE[1]);
    for (const f of BLENDED) out[f] = lerp(snap[f], tgt[f], e);
    out.badgeKind = !tgt.badgeKind && snap.badgeKind ? snap.badgeKind : tgt.badgeKind;
    out.ringKind = tgt.ringO > 0.002 ? tgt.ringKind : snap.ringKind;
    return carryOn(out, snap, tgt, ts);
  }
  const fromDots = snap.morph > 0.5;
  // Waking from paused, into any state that opens the eyes (from 48 px, into
  // thinking too: they stay shut as the head turns away, never open upright
  // on the way round).
  const fromSleep = !fromDots && snap.lid < 0.1 && snap.blinkW < 0.05 && tgt.lid > 0.5;
  const turnsOver = snap.tilt < -1 && tgt.tilt > 1;
  // Into done, a blink carried on from the change has all but reopened (0.9
  // open, 0.745 of the way through blinkCurve) before the happy capsules
  // form: they form from the reopened eye, never squash it again as it opens.
  const carried = seg.state === "done" ? blinkPhase(snap, false) : null;
  const settle = carried === null ? 0 : Math.max(0, 0.745 - carried) * ACK_S;
  // A stalled orbit (blocked) leaving where the state's own table would
  // reel in a live one: its ball goes with the ring, over the same time.
  const stalledOut = snap.ringKind === "stalled" && snap.ringO > 0.002 && tgt.ringO <= 0.002 ? stallOut(def.timing?.ringP?.[1] ?? 0.45) : null;
  for (const f of BLENDED) {
    const timing =
      (fromDots ? (FROM_DOTS[f] ?? (seg.state === "done" && !ctx.size.front ? FROM_DOTS_HAPPY[f] : undefined)) : undefined) ??
      (fromSleep ? FROM_SLEEP[f] : undefined) ??
      (turnsOver && f === "tilt" ? TURN_OVER : undefined) ??
      stalledOut?.[f] ??
      def.timing?.[f] ??
      FIELD_TIMING[f] ??
      DEFAULT_TIMING;
    const d = timing[0] + (f === "smile" || f === "eH" || f === "eW" ? settle : 0);
    let dur = timing[1];
    let ez = timing[2];
    if (f === "yaw") {
      // A long way round (out of a face spin) eases out from the spin's speed.
      const ease = ez ?? outQuint;
      const k = ease === outQuint ? 5 : ease === outCubic ? 3 : 2;
      const far = Math.abs(tgt.yaw - snap.yaw);
      const speed = seg.state === "waiting" || seg.state === "blocked" ? TURN_SPEED_NEEDS_YOU : TURN_SPEED;
      if (far > 90 && (k * far) / dur > speed) {
        dur = (3 * far) / speed;
        ez = outCubic;
      }
    }
    out[f] = lerp(snap[f], tgt[f], (ez ?? outQuint)((ts - d) / dur));
  }
  // A badge that is leaving fades out as itself; so does an orbit.
  out.badgeKind = !tgt.badgeKind && snap.badgeKind ? snap.badgeKind : tgt.badgeKind;
  out.ringKind = tgt.ringO > 0.002 ? tgt.ringKind : snap.ringKind;
  // The dots' wave keeps running while they merge back into the body.
  if (snap.think > 0.01 && tgt.think < snap.think) out.pulse = snap.pulse + ts;
  return carryOn(out, snap, tgt, ts);
}

/**
 * A blink under way when the state changed runs on to its end in the new
 * state, whatever the state (blinkPhase): a change never cuts the eyes from
 * shut to open in one frame, and the state's own acknowledgement joins it
 * (forcedBlink) rather than closing them again. Into a state that shuts the
 * eyes itself (paused, a small face thinking), the blink never reopens: a
 * closing one goes on to shut and stays shut, one reopening stops where it
 * is, and the lid closes over it, so shut eyes never open to close again.
 */
function carryOn(out: Pose, snap: Pose, tgt: Pose, ts: number): Pose {
  const phase = blinkPhase(snap, false);
  if (phase === null) return out;
  const shuts = tgt.lid < 0.5 && tgt.lid < snap.lid - 0.05;
  const carried = !shuts ? blinkFrom(phase, ts) : phase >= 0.46 ? blinkCurve(phase) : blinkCurve(Math.min(phase + Math.max(0, ts) / ACK_S, 0.4));
  out.blinkMul = Math.min(out.blinkMul, carried);
  return out;
}

function arrive(tgt: Pose, from: { pose: Pose; at: number }, T: number, ctx: FaceCtx): Pose {
  const t = T - from.at;
  const out: Pose = { ...tgt };
  const e = outCubic(t / ARRIVE_S);
  if (e < 1) for (const f of BLENDED) out[f] = lerp(from.pose[f], tgt[f], e);
  // The orbit's ball holds its painted spot for a beat of this copy's own (up
  // to ORBIT_HOLD_S), then moves off it, spinning up to this face's own speed
  // at a rate of its own, so working faces mounted together never orbit as
  // one machine: every ball is painted at the same spot, and the paces alone
  // would take tens of seconds to part them. The wave holds the painted frame
  // (its middle dot raised) for a beat of its own too (up to one 1.4 s
  // period), then runs on at its rate, so thinking faces mounted together
  // never pulse as one, even at roster sizes where every wave keeps the
  // chat's exact rhythm.
  // (The hold is skewed short: a spin-up gains speed as it goes, so even
  // starts would bunch the balls that left last.)
  const hold = ORBIT_HOLD_S * noise(ctx.seed, 2, 67) ** 2;
  const s = ringSpin(Math.max(0, t - hold), from.pose, tgt.ringSpeed, arriveTau(ctx));
  out.ringPhase = s.phase;
  out.ringSpeed = s.speed;
  // A small face's rim ball, painted parked at the upper right, rolls down
  // into its swing as its orbit starts: it moves off the painted spot, never
  // jumps from it.
  out.ballPark = lerp(from.pose.ballPark, tgt.ballPark, inOutSine((t - hold) / PARK_S));
  out.pulse = from.pose.pulse + Math.max(0, t - WAVE_HOLD_S * noise(ctx.seed, 2, 61)) * waveRate(ctx);
  return out;
}

/**
 * The snapshot a new state blends from. A face caught mid-spin (the runtime
 * holds a change until the spin ends, so only a size change or reduced motion
 * catches one) keeps turning the same way to come home; one back from
 * thinking turns back the way it went. It records how shut the eyes are
 * (every blink under way: the scheduled one, a glance's, the state's own
 * acknowledgement, one carried from the change before) and which way they
 * are going, so the next state carries the blink on (blinkPhase).
 */
export function snapshot(seg: Segment, T: number, ctx: FaceCtx): Pose {
  const s = poseAt(seg, T, ctx);
  let yaw = s.yaw + s.spinYaw;
  if (s.spinYaw !== 0) {
    // The spin runs to −360°: fold into [−90°, 270°) so the rest of the turn goes on the same way.
    yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
    if (yaw < -90) yaw += 360;
  }
  const shut = (t: number, P: Pose) => P.blinkMul * (ctx.live ? restExtras(ctx, seg, t, P).blink : 1);
  const blinkC = shut(T, s);
  let blinkDir = 0;
  if (blinkC < 0.999) {
    const t1 = T + 1 / 480;
    blinkDir = shut(t1, poseAt(seg, t1, ctx)) > blinkC + 1e-6 ? 1 : -1;
  }
  return { ...s, yaw, spinYaw: 0, blinkC, blinkDir };
}

/**
 * Folds a blink the pure rig cannot see (the runtime's hover notice) into a
 * snapshot, when it is the more shut of the two, so it too is carried on.
 */
export function carryBlink(snap: Pose, c: number, dir: number): Pose {
  return c < snap.blinkC ? { ...snap, blinkC: c, blinkDir: dir } : snap;
}

/**
 * The face time at which a face's pose next changes (rest life included):
 * T while anything is moving, Infinity when nothing ever will.
 */
export function nextChange(seg: Segment, T: number, ctx: FaceCtx, P: Pose): number {
  if (seg.from && T - seg.from.at < ARRIVE_S) return T;
  const def = STATES[seg.state] ?? STATES.idle;
  if (!def.quiet) return T;
  let next = def.quiet(T - seg.at, ctx, T, seg.snap);
  if (ctx.live && P.blinkW > 0) next = Math.min(next, blinkNext(ctx, seg.state, T, seg.at + BLINK_QUIET_S));
  return next;
}

/**
 * The reduced-motion frame for a state: every one reads on its own. Thinking
 * is three dots with the middle raised, working the ring with its ball parked
 * (or, small, the ball at the lower right of the rim), waiting and blocked
 * their badge, done the happy capsules (no ring), sleeping the dashes.
 */
export function stillPose(state: AgentState, ctx: FaceCtx): Pose {
  const quiet: FaceCtx = { ...ctx, live: false };
  const def = STATES[state] ?? STATES.idle;
  const p = def.target(state === "done" ? 1.2 : 3.0, null, quiet, 0, false);
  p.blinkMul = 1;
  p.spinYaw = 0;
  p.ringSpeed = 0;
  const rest = restPose(quiet);
  switch (state) {
    case "idle":
      p.yaw = rest.yaw;
      p.pitch = rest.pitch;
      break;
    case "working":
      // The orbit's ball parked in front at the right, in the gap of its ring
      // (the brand's open ring with its ball terminal), whose far end sits
      // well clear of every body (no stub poking past a flank); small, the
      // rim ball parked at the upper right (RIM_PARK), where the logo's ball
      // terminal sits, never the lower right's online-status dot.
      p.ringPhase = 0;
      p.ringP = 1;
      p.ballS = 1;
      p.ballPark = ctx.size.ring ? 0 : 1;
      p.yaw = (ctx.size.front ? 3 : WORK_YAW) * sideOf(ctx);
      p.pitch = ctx.size.front ? -4 : -10;
      break;
    case "thinking":
      p.pulse = 0.65;
      break;
    case "waiting":
      p.badgeS = 1;
      p.yaw = 0;
      p.pitch = 1;
      break;
    case "listening":
      p.eH = 1.12;
      break;
    case "done":
      p.ringO = 0;
      p.ballS = 0;
      break;
    default:
      break;
  }
  return p;
}

/**
 * A still turned nearly to the viewer, for pickers that compare eye cuts
 * (`AgentFace pose="front"`): both eyes near the same size, so the cuts
 * compare, but still a touch turned and rolled, so the pair sits on a sphere
 * (the far eye a little narrower, the pair a little off centre) and leans
 * (EYE_LEAN), never two upright bars dead centre, the pause glyph. Every
 * swatch of a row is drawn the same way round (`\`, up and to the right, as
 * Grok's rest), whatever way the look it stands for would rest: a swatch
 * draws the cut, and a row leaning both ways would not compare.
 */
export function frontPose(p: Pose): Pose {
  return { ...p, yaw: 8, pitch: 5, froll: -4, brot: 0, eyeLean: 1 };
}

/* ------------------------------------------------------------------------ */
/* Rest life                                                                 */
/* ------------------------------------------------------------------------ */

/** The blink schedule: ~240 ms blinks at jittered intervals (slower when small, and while focused on work), one in seven doubled. */
function blinkSlots(ctx: FaceCtx, state: AgentState) {
  const range: [number, number] = ctx.size.blinkSlow ? [6, 12] : state === "working" ? [4.5, 9] : ctx.temper.blink;
  const P = (range[0] + range[1]) / 2;
  const salt = ctx.size.blinkSlow ? 71 : state === "working" ? 73 : 79;
  const at = (n: number) => n * P + (noise(ctx.seed, n, salt) - 0.5) * (range[1] - range[0]);
  const slot = (T: number) => {
    return slotAt(at, P, T);
  };
  const doubled = (n: number) => noise(ctx.seed, n, salt + 1) < 0.15;
  return { at, slot, doubled };
}

/** Scheduled blinks are muted this long after a change of state: the acknowledgement blink is the blink, never a twitch after it. */
const BLINK_QUIET_S = 1.2;

/** The scheduled blink at T; a blink whose slot began before `since` is skipped whole, never joined halfway. */
function blinkAt(ctx: FaceCtx, state: AgentState, T: number, since = -Infinity) {
  const { at, slot, doubled } = blinkSlots(ctx, state);
  const n = slot(T);
  if (at(n) < since) return 1;
  let v = blinkCurve((T - at(n)) / BLINK_S);
  if (doubled(n)) v = Math.min(v, blinkCurve((T - at(n) - 0.3) / BLINK_S));
  return v;
}

/** Face time of the next blink: T while one is under way. */
function blinkNext(ctx: FaceCtx, state: AgentState, T: number, since = -Infinity) {
  const { at, slot, doubled } = blinkSlots(ctx, state);
  const n = slot(T);
  const dur = doubled(n) ? 0.3 + BLINK_S : BLINK_S;
  if (T - at(n) < dur && at(n) >= since) return T;
  let k = n + 1;
  while (at(k) < since) k++;
  return at(k);
}

/**
 * Rest life without the pointer, pure: the scheduled blinks (muted just after
 * a change of state), and the blink that opens a long glance, as eyes do.
 * The runtime adds the pointer look and the hover notice on top.
 */
export function restExtras(ctx: FaceCtx, seg: Segment, T: number, P: Pose = poseAt(seg, T, ctx)): FaceExtras {
  if (!ctx.live) return NO_EXTRAS;
  const since = seg.at + BLINK_QUIET_S;
  let blink = lerp(1, blinkAt(ctx, seg.state, T, since), P.blinkW);
  if (seg.state === "idle" && P.blinkW > 0) {
    const g = glanceSlot(ctx, 11, T, idleEvery(ctx), 6, 3.5, ctx.temper.glanceUp);
    if (Math.abs(g.b.y - g.a.y) > 8 && g.start >= since) blink = Math.min(blink, lerp(1, blinkCurve((T - g.start) / BLINK_S), P.blinkW));
  }
  return blink === 1 ? NO_EXTRAS : { ...NO_EXTRAS, blink };
}

/* ------------------------------------------------------------------------ */
/* The runtime (client only)                                                 */
/* ------------------------------------------------------------------------ */

export interface FaceConfig {
  spec: FaceSpec;
  mark: AgentMark;
  /** The agent's identity (`faceIdentity`): which way it rests and its pace. */
  identity: number;
  live: boolean;
  /** Look at the pointer while it is near. */
  look: boolean;
  /**
   * A preview a person drives (the studio, the hire flow): every change goes
   * on screen at once, skipping the smoothing meant for agent loops (gateAt),
   * so a click is answered in the next frame.
   */
  direct?: boolean;
}

export interface FaceRigHandle {
  setState(state: AgentState): void;
  configure(config: FaceConfig): void;
  release(): void;
}

interface Runtime {
  el: SVGSVGElement;
  parts: Record<Part, Element | null>;
  ids: { mask: string; clip: string; body: string };
  config: FaceConfig;
  ctx: FaceCtx;
  seg: Segment;
  offset: number;
  last: FaceFrame;
  /** The write dead band, in R: a quarter of a device pixel. */
  quantum: number;
  visible: boolean;
  active: boolean;
  reduced: boolean;
  /** The pointer look: eyes (y, p) and the body's slower follower (by), toward the targets. */
  look: { y: number; p: number; by: number; ty: number; tp: number };
  noticedAt: number;
  trigger: Element | null;
  onEnter: (() => void) | null;
  /** The timer that wakes a resting face for its next blink or glance. */
  wakeTimer: number;
  /** State-change smoothing: when the current state went on screen, until when its face spin plays, the latest request, and its timer. */
  shownAt: number;
  spinUntil: number;
  wanted: AgentState;
  holdTimer: number;
  /** How many staggered changes this copy has asked for: the slot of its noise the next entry beat comes from. */
  changes: number;
}

/** A request to think is held this long, so a blip of thinking never plays. */
const THINK_HOLD_MS = 250;
/** …and this long out of working, so a short model turn between two tool calls stays working and the orbit keeps turning. */
const THINK_HOLD_FROM_WORK_MS = 2500;
/** A request to work out of thinking is held this long, so a tool blip inside a model turn never throws a ring. */
const WORK_HOLD_FROM_THINK_MS = 400;
/** A state stays on screen at least this long; later requests collapse to the latest. */
const MIN_SHOWN_MS = 700;
/** Between thinking and working, whose transitions take about a second each, a state stays at least this long, so each one plays to its end. */
const BUSY_SHOWN_MS = 1400;

/** Where a face's smoothing stands: the state on screen, when it went on, and until when its spin plays (all ms). */
export interface Gate {
  state: AgentState;
  shownAt: number;
  spinUntil: number;
}

/** When (ms) a request for `next`, made at `now`, may go on screen. Pure: the runtime's one rule, and the tests'. */
export function gateAt(g: Gate, next: AgentState, now: number): number {
  const busy = (s: AgentState) => s === "working" || s === "thinking";
  let at = g.shownAt + (busy(g.state) && busy(next) ? BUSY_SHOWN_MS : MIN_SHOWN_MS);
  if (next === "thinking") at = Math.max(at, now + (g.state === "working" ? THINK_HOLD_FROM_WORK_MS : THINK_HOLD_MS));
  if (next === "working" && g.state === "thinking") at = Math.max(at, now + WORK_HOLD_FROM_THINK_MS);
  // A state that needs you is never kept waiting behind the face spin: the
  // face comes home from wherever the spin has got to, the same way round,
  // at the spin's own speed (snapshot, poseAt).
  if (next === "waiting" || next === "blocked") return Math.max(at, now);
  // Otherwise the working face spin is never interrupted: a change waits for it to end.
  return Math.max(at, g.spinUntil);
}

/** When (ms) a request goes on screen: at once for a direct preview, else through the smoothing (gateAt). */
export function changeAt(g: Gate, next: AgentState, now: number, direct = false): number {
  return direct ? now : gateAt(g, next, now);
}

/**
 * The longest a change from an agent's loop is held back so that faces
 * handed it in one frame part (ms). The roster polls every 10 s, so the
 * agents that start within one poll window (routines set for the same time
 * do, every day) flip together, and every entry beat runs on a fixed clock:
 * without this, six faces would blink, pop their balls and spin as one.
 */
const ENTRY_SPREAD_MS = 450;
/** The least time between two faces' entries on one page (ms): no two face spins begin in the same few frames. */
const ENTRY_GAP_MS = 90;

/**
 * Whether a change from `from` to `next` is staggered: everything an agent's
 * loop sends, except a state that needs you (never kept waiting) and a voice
 * turn (listening answers the person's own voice, in real time).
 */
export function staggers(from: AgentState, next: AgentState, direct = false) {
  return !direct && next !== "waiting" && next !== "blocked" && next !== "listening" && from !== "listening";
}

/**
 * When (ms) a staggered change goes on screen: no earlier than `at` (the
 * smoothing's answer), after a beat of this copy's own (up to
 * ENTRY_SPREAD_MS, slot `n` of its noise), and ENTRY_GAP_MS clear of every
 * other face's entry in `taken`. Pure: the runtime's rule, and the tests'.
 */
export function staggeredAt(seed: number, n: number, now: number, at: number, taken: readonly number[]): number {
  let t = Math.max(at, now + ENTRY_SPREAD_MS * noise(seed, n, 89));
  for (const e of [...taken].sort((a, b) => a - b)) if (Math.abs(e - t) < ENTRY_GAP_MS) t = e + ENTRY_GAP_MS;
  return t;
}

/** Entries (ms) faces on this page have recently been given, so the next one keeps clear of them. */
const entries: number[] = [];

/** Seconds into a new state until which its face spin plays, 0 when it does not spin. */
export function spinHold(state: AgentState, size: SizeClass, snap: Pose | null): number {
  return state === "working" && spinsInto(size, snap) ? SPIN[1] : 0;
}

declare global {
  interface Window {
    /** Dev only: a clock to drive every face from (ms), for frame-exact captures. */
    __agentFaceNow?: () => number;
    /** Dev only: draw every face at the current clock now. */
    __agentFaceTick?: () => void;
    /** Dev only: how many frames the face clock has run, for cost checks. */
    __agentFaceTicks?: number;
  }
}

const faces = new Set<Runtime>();
let raf = 0;
let lastTick = 0;
let observer: IntersectionObserver | null = null;
let pointer: { x: number; y: number; at: number } | null = null;
let pointerDirty = false;
let unsubscribeMotion: (() => void) | null = null;
let listening = false;

const clockMs = () => (typeof window !== "undefined" && window.__agentFaceNow ? window.__agentFaceNow() : performance.now());

function faceTime(rt: Runtime, ms: number) {
  return (ms + rt.offset) / 1000;
}

/** Every attribute a frame can set; the rest (class, fill, data-part) belong to React. */
const MANAGED = ["d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "transform", "opacity", "stroke-width", "mask", "clip-path", "id", "data-kind", "data-tone", "data-off"];

/**
 * What the DOM carries now, as a frame: the baseline the first diff is taken
 * against. Never the frame React rendered: a face can be attached twice to one
 * element (Strict Mode, a remount), and the first rig may already have drawn.
 */
function readFrame(parts: Record<Part, Element | null>): FaceFrame {
  const out = {} as FaceFrame;
  for (const part of PARTS) {
    const attrs: Record<string, string> = {};
    const el = parts[part];
    if (el) {
      for (const key of MANAGED) {
        const value = el.getAttribute(key);
        if (value !== null) attrs[key] = value;
      }
    }
    out[part] = attrs;
  }
  return out;
}

const NUMBER = /-?\d*\.?\d+(?:e-?\d+)?/g;

/** Whether two attribute values differ by less than `q` in every number, with the same words between. */
function within(a: string, b: string, q: number) {
  if (a.replace(NUMBER, "#") !== b.replace(NUMBER, "#")) return false;
  const na = a.match(NUMBER);
  const nb = b.match(NUMBER);
  if (!na || !nb || na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) if (Math.abs(Number(na[i]) - Number(nb[i])) >= q) return false;
  return true;
}

/**
 * Writes a frame as attribute diffs against what the DOM holds, skipping any
 * change under a quarter of a device pixel (the tail of an ease-out, a
 * glance's last hundredths): the face looks the same and the page does no
 * style or layout work for it.
 */
function write(rt: Runtime, frame: FaceFrame) {
  const kept = {} as FaceFrame;
  for (const part of PARTS) {
    const el = rt.parts[part];
    const next = frame[part];
    const prev = rt.last[part] ?? {};
    const held: Record<string, string> = {};
    for (const key in next) {
      const a = prev[key];
      const b = next[key];
      if (a === b) {
        held[key] = b;
        continue;
      }
      if (a !== undefined && key !== "id" && within(a, b, key === "opacity" ? 0.004 : rt.quantum)) {
        held[key] = a;
        continue;
      }
      el?.setAttribute(key, b);
      held[key] = b;
    }
    for (const key in prev) {
      if (!(key in next)) el?.removeAttribute(key);
    }
    kept[part] = held;
  }
  rt.last = kept;
}

function extrasFor(rt: Runtime, P: Pose, T: number, dt: number): FaceExtras {
  const { ctx, config } = rt;
  const lk = rt.look;
  // The eyes follow the pointer quickly; the body leans after them, slower, so it trails.
  const a = 1 - Math.exp(-dt / 0.08);
  const ab = 1 - Math.exp(-dt / 0.16);
  lk.y += (lk.ty - lk.y) * a;
  lk.p += (lk.tp - lk.p) * a;
  lk.by += (lk.ty - lk.by) * ab;
  if (!ctx.live) return NO_EXTRAS;
  const lw = config.look ? P.lookW : 0;
  const big = !ctx.size.front;
  let blink = restExtras(ctx, rt.seg, T, P).blink;
  // The hover notice is a blink like any other: a state that holds its eyes
  // (done's happy capsules, blinkW 0) answers with the pointer look alone.
  if (rt.noticedAt > 0) blink = Math.min(blink, lerp(1, blinkCurve((T - rt.noticedAt) / BLINK_S), P.blinkW));
  return {
    yaw: lk.y * (big ? 16 : 10) * lw,
    pitch: -lk.p * (big ? 12 : 8) * lw,
    roll: 0,
    blink,
    lean: big ? lk.by * 0.05 * lw : 0,
    tilt: big ? lk.by * 3 * lw : 0,
  };
}

/**
 * A segment's snapshot with the hover notice folded in: a notice blink under
 * way when the state changes is carried on like any other (carryBlink), and
 * stops running on its own clock, so the two never close the eyes twice.
 */
function withNotice(rt: Runtime, seg: Segment, T: number): Segment {
  if (!seg.snap || !(rt.noticedAt > 0) || T - rt.noticedAt >= BLINK_S) return seg;
  const snap = seg.snap;
  const at = rt.noticedAt;
  rt.noticedAt = 0;
  const open = (t: number) => lerp(1, blinkCurve((t - at) / BLINK_S), snap.blinkW) * snap.blinkMul;
  const c = open(T);
  return { ...seg, snap: carryBlink(snap, c, open(T + 1 / 480) > c + 1e-6 ? 1 : -1) };
}

function clearWake(rt: Runtime) {
  if (rt.wakeTimer) window.clearTimeout(rt.wakeTimer);
  rt.wakeTimer = 0;
}

function render(rt: Runtime, ms: number, dt: number) {
  const T = faceTime(rt, ms);
  if (rt.seg.state === "listening") {
    const raw = getComputedStyle(rt.el).getPropertyValue("--level");
    rt.ctx.level = raw ? clamp01(Number.parseFloat(raw) || 0) : 0;
  }
  const P = rt.reduced ? stillPose(rt.seg.state, rt.ctx) : poseAt(rt.seg, T, rt.ctx);
  const X = rt.reduced ? NO_EXTRAS : extrasFor(rt, P, T, dt);
  write(rt, drawFace(rt.config.spec, P, X, rt.ids));
  clearWake(rt);
  if (rt.reduced) {
    rt.active = false;
    return;
  }
  // Rest is event driven: when nothing is moving, leave the clock until the
  // next blink or glance (or a pointer move, a hover, a state change).
  const lookSettled = Math.abs(rt.look.ty - rt.look.y) + Math.abs(rt.look.tp - rt.look.p) + Math.abs(rt.look.ty - rt.look.by) < 0.002;
  const noticing = rt.noticedAt > 0 && T - rt.noticedAt < BLINK_S;
  const next = lookSettled && !noticing ? nextChange(rt.seg, T, rt.ctx, P) : T;
  if (next - T < 1 / 90) {
    rt.active = true;
    return;
  }
  rt.active = false;
  if (Number.isFinite(next) && typeof window !== "undefined") {
    rt.wakeTimer = window.setTimeout(() => {
      rt.wakeTimer = 0;
      wake(rt);
    }, Math.max(0, (next - T) * 1000 - 8));
  }
}

function updateLookTargets() {
  pointerDirty = false;
  const now = clockMs();
  const fresh = pointer && now - pointer.at < 5000 ? pointer : null;
  const reads: Array<{ rt: Runtime; rect: DOMRect }> = [];
  for (const rt of faces) {
    if (rt.visible && rt.config.look && !rt.reduced) reads.push({ rt, rect: rt.el.getBoundingClientRect() });
  }
  for (const { rt, rect } of reads) {
    let ty = 0;
    let tp = 0;
    if (fresh) {
      const dx = fresh.x - (rect.left + rect.width / 2);
      const dy = fresh.y - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy);
      const reach = Math.max(260, rect.width * 5);
      if (dist < reach) {
        const t = 1 - dist / reach;
        const strength = 1 - (1 - t) * (1 - t);
        // Right on top of the face, it looks at you, not past you.
        const near = Math.min(1, dist / Math.max(24, rect.width * 0.6));
        ty = clamp((dist ? dx / dist : 0) * strength * near * 1.4, -1.4, 1.4);
        tp = clamp((dist ? dy / dist : 0) * strength * near * 1.4, -1.4, 1.4);
      }
    }
    if (ty !== rt.look.ty || tp !== rt.look.tp) {
      rt.look.ty = ty;
      rt.look.tp = tp;
      rt.active = true;
    }
  }
}

function tick() {
  raf = 0;
  if (process.env.NODE_ENV !== "production") window.__agentFaceTicks = (window.__agentFaceTicks ?? 0) + 1;
  const ms = clockMs();
  const dt = lastTick ? Math.min(0.05, (ms - lastTick) / 1000) : 0;
  lastTick = ms;
  if (pointerDirty) updateLookTargets();
  let any = false;
  for (const rt of faces) {
    if (!rt.visible || !rt.active) continue;
    render(rt, ms, dt);
    if (rt.active) any = true;
  }
  if (any) schedule();
  else lastTick = 0;
}

function schedule() {
  if (!raf && typeof window !== "undefined" && !window.__agentFaceNow) raf = window.requestAnimationFrame(tick);
}

function wake(rt: Runtime) {
  if (rt.reduced) return;
  rt.active = true;
  schedule();
}

function onPointerMove(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY, at: clockMs() };
  pointerDirty = true;
  schedule();
}
function onPointerLeave() {
  pointer = null;
  pointerDirty = true;
  schedule();
}

function ensureListening() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  if (!window.matchMedia?.("(pointer: coarse)").matches) {
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
  }
  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        for (const rt of faces) {
          if (rt.el !== record.target) continue;
          rt.visible = record.isIntersecting;
          if (rt.visible) wake(rt);
        }
      }
    });
  }
  unsubscribeMotion = subscribeReducedMotion(() => {
    for (const rt of faces) {
      rt.reduced = reducedMotionAt(rt.el);
      render(rt, clockMs(), 0);
      if (!rt.reduced) wake(rt);
    }
  });
  if (process.env.NODE_ENV !== "production") {
    window.__agentFaceTick = () => {
      const ms = clockMs();
      for (const rt of faces) render(rt, ms, 1 / 60);
    };
  }
}

function stopListening() {
  if (!listening || faces.size > 0) return;
  listening = false;
  window.removeEventListener("pointermove", onPointerMove);
  document.documentElement.removeEventListener("pointerleave", onPointerLeave);
  observer?.disconnect();
  observer = null;
  unsubscribeMotion?.();
  unsubscribeMotion = null;
  if (raf) window.cancelAnimationFrame(raf);
  raf = 0;
  lastTick = 0;
}

let seedCounter = 0;

/**
 * Puts a rendered face on the rig, showing `state`. The face arrives settled
 * in that state, as if it had been there all along, gliding off the still
 * frame the server painted (no first-frame jump); only later changes play
 * their transitions. Its first diff is taken against what the DOM carries.
 */
export function attachFaceRig(
  el: SVGSVGElement,
  config: FaceConfig,
  state: AgentState,
  ids: Runtime["ids"],
): FaceRigHandle {
  ensureListening();
  const parts = {} as Record<Part, Element | null>;
  for (const part of PARTS) parts[part] = el.querySelector(`[data-part="${part}"]`);
  const seed = (Math.random() * 4294967296) >>> 0 ^ (seedCounter++ * 0x9e3779b1);
  const offset = noise(seed, 0, 3) * 9000;
  // The ids the DOM really carries: after a hydration mismatch elsewhere in the
  // tree, React keeps the server's attributes, and useId may differ from them.
  const domIds = {
    mask: el.querySelector("mask")?.id || ids.mask,
    clip: el.querySelector("clipPath")?.id || ids.clip,
    body: parts.body?.id || ids.body,
  };
  const ctx = faceCtx(config.spec, config.mark, seed, config.live, config.identity);
  const T0 = (clockMs() + offset) / 1000;
  const rt: Runtime = {
    el,
    parts,
    ids: domIds,
    config,
    ctx,
    // Settled in its state, as if there all along (each face at its own point
    // in its loops), arriving from the still frame the server drew.
    seg: { state, at: T0 - 60 - noise(seed, 1, 5) * 9, snap: null, from: { pose: stillPose(state, ctx), at: T0 } },
    offset,
    last: readFrame(parts),
    quantum: quantumOf(config),
    visible: true,
    active: false,
    reduced: reducedMotionAt(el),
    look: { y: 0, p: 0, by: 0, ty: 0, tp: 0 },
    noticedAt: 0,
    trigger: el.closest("[data-face-trigger], a, button, [role='button'], [role='link']"),
    onEnter: null,
    wakeTimer: 0,
    shownAt: -Infinity,
    spinUntil: 0,
    wanted: state,
    holdTimer: 0,
    changes: 0,
  };
  faces.add(rt);
  observer?.observe(el);
  // The paint follows the state as drawn, not as requested (agent-face.css):
  // a held change never greys a face that is still working, or colours one
  // whose eyes are still closed.
  el.setAttribute("data-drawn", state);
  if (rt.trigger) {
    rt.onEnter = () => {
      if (rt.reduced || !rt.ctx.live) return;
      rt.noticedAt = faceTime(rt, clockMs());
      wake(rt);
    };
    rt.trigger.addEventListener("pointerenter", rt.onEnter);
  }
  render(rt, clockMs(), 0);
  if (!rt.reduced) wake(rt);

  const apply = (next: AgentState) => {
    rt.shownAt = clockMs();
    rt.spinUntil = 0;
    el.setAttribute("data-drawn", next);
    const T = faceTime(rt, rt.shownAt);
    if (rt.reduced) {
      rt.seg = { state: next, at: T - 60 - noise(rt.ctx.seed, 1, 5) * 9, snap: null };
      // Under reduced motion the stills cross-fade (agent-face.css) instead of cutting.
      el.removeAttribute("data-swap");
      void el.getBoundingClientRect();
      el.setAttribute("data-swap", "");
      render(rt, clockMs(), 0);
      return;
    }
    rt.seg = withNotice(rt, { state: next, at: T, snap: snapshot(rt.seg, T, rt.ctx) }, T);
    rt.spinUntil = rt.shownAt + spinHold(next, rt.config.spec.size, rt.seg.snap) * 1000;
    wake(rt);
  };

  return {
    setState(next) {
      rt.wanted = next;
      if (rt.holdTimer) window.clearTimeout(rt.holdTimer);
      rt.holdTimer = 0;
      if (next === rt.seg.state) return;
      const now = clockMs();
      let at = changeAt({ state: rt.seg.state, shownAt: rt.shownAt, spinUntil: rt.spinUntil }, next, now, rt.config.direct);
      if (staggers(rt.seg.state, next, rt.config.direct) && !rt.reduced) {
        // Faces handed one change in one frame (a poll of the roster) part:
        // each acknowledges after a beat of its own, clear of the others.
        while (entries.length && entries[0] < now - 2000) entries.shift();
        at = staggeredAt(rt.ctx.seed, ++rt.changes, now, at, entries);
        entries.push(at);
        entries.sort((a, b) => a - b);
      }
      if (at <= now) {
        apply(next);
        return;
      }
      rt.holdTimer = window.setTimeout(() => {
        rt.holdTimer = 0;
        if (rt.wanted !== rt.seg.state) apply(rt.wanted);
      }, at - now);
    },
    configure(next) {
      const T = faceTime(rt, clockMs());
      const sizeChanged = next.spec.size.key !== rt.config.spec.size.key;
      const old = rt.ctx;
      rt.config = next;
      rt.ctx = faceCtx(next.spec, next.mark, rt.ctx.seed, next.live, next.identity);
      rt.quantum = quantumOf(next);
      if (sizeChanged) {
        rt.seg = { state: rt.seg.state, at: T - 60 - noise(rt.ctx.seed, 1, 5) * 9, snap: null };
        rt.spinUntil = 0;
      } else if (!rt.reduced && (rt.ctx.side !== old.side || rt.ctx.pace !== old.pace)) {
        // A new look under a running state: carry on from where the face is,
        // never swap its rest side or pace in one frame (rebaseSegment).
        rt.seg = withNotice(rt, rebaseSegment(rt.seg, T, old, rt.ctx), T);
        rt.spinUntil = 0;
      }
      render(rt, clockMs(), 0);
      wake(rt);
    },
    release() {
      faces.delete(rt);
      observer?.unobserve(el);
      if (rt.trigger && rt.onEnter) rt.trigger.removeEventListener("pointerenter", rt.onEnter);
      clearWake(rt);
      if (rt.holdTimer) window.clearTimeout(rt.holdTimer);
      rt.holdTimer = 0;
      stopListening();
    },
  };
}

/** A quarter of a device pixel, in R. */
function quantumOf(config: FaceConfig) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  return 1 / (4 * pxPerR(config.spec.px, config.spec.size) * dpr);
}
