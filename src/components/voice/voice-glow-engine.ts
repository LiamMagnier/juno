/**
 * THE VOICE LIGHT'S STATE MODEL. Pure: a frame is a function of the previous
 * state, the inputs and the time step, so the gallery can simulate any moment
 * exactly and the tests can drive it without a browser.
 *
 * What it answers, each frame, for the renderer:
 *
 * - YOUR light and ALEVR'S light, each with an amplitude (how bright) and a
 *   lift (how far it spreads along the edge and blooms out). Each follows its
 *   OWN audio — the microphone and the reply as heard — so talking over Alevr
 *   shows two voices, not one blended line. Brightness follows the syllable
 *   (45 ms attack, 150 ms release); the extent follows the phrase (80 / 300
 *   ms), so the light articulates without its shape twitching.
 * - A rest pose for whoever holds the floor: a faint, still light at the
 *   bottom of the composer. It does not breathe. Silence is perfectly still,
 *   and a still frame is never redrawn.
 * - MUTED: the edge goes graphite and holds.
 * - THINKING: the Continuum handoff carried by light. One beam leaves your end
 *   of the edge in ember and arrives at Alevr's in presence ink: six 70 ms
 *   steps of a 220 ms tone, 570 ms end to end, then it settles at Alevr's end.
 *   While the answer is still coming it passes again, never more often than
 *   every 1.6 s (MOTION_AND_THINKING.md).
 * - OFF (connecting, reconnecting, ended, error, a closing dictation): the
 *   light leaves on the exit rung and nothing is drawn.
 *
 * Reduced motion: every level is ignored and each state is a static pose,
 * reached by a 120 ms fade.
 */

export type GlowMode = "you" | "alevr" | "thinking" | "muted" | "off";

export interface GlowInput {
  mode: GlowMode;
  /** Your microphone, 0..1, already normalised to speech loudness. */
  you: number;
  /** Alevr's audible output, 0..1, the same scale. */
  alevr: number;
  reduced: boolean;
}

export interface GlowVoiceFrame {
  /** 0..1 brightness. */
  amp: number;
  /** 0..1 spread and bloom, from the voice's own envelope. */
  lift: number;
}

export interface GlowBeamFrame {
  amp: number;
  /** 0 = your end of the edge, 1 = Alevr's end. */
  pos: number;
  /** 0 = ember, 1 = presence: the tone handed over as it travels. */
  mix: number;
}

export interface GlowFrame {
  you: GlowVoiceFrame;
  alevr: GlowVoiceFrame;
  muted: number;
  beams: [GlowBeamFrame, GlowBeamFrame];
}

/** V3 timings (globals.css `--dur-*`) and the Continuum handoff, in seconds. */
export const GLOW_TIMING = {
  fast: 0.12,
  base: 0.22,
  slow: 0.36,
  exit: 0.16,
  handoffTone: 0.22,
  handoffStagger: 0.07,
  handoffSegments: 6,
  repass: 1.6,
} as const;

/** One handoff pass, end to end: the last segment starts 5 × 70 ms in and takes 220 ms. */
export const HANDOFF_PASS = (GLOW_TIMING.handoffSegments - 1) * GLOW_TIMING.handoffStagger + GLOW_TIMING.handoffTone;

/** The still light whoever holds the floor keeps while silent. */
export const REST_AMP = 0.3;
const MUTED_AMP = 0.55;
/** Where a beam settles once it has arrived. */
const BEAM_REST = 0.42;
/** Reduced motion: the speaking pose, held. */
const STATIC_AMP = 0.62;
const STATIC_LIFT = 0.28;

/* ———————————————————————————— curves ———————————————————————————— */

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 6; i++) {
      const x = sampleX(u) - t;
      const s = slopeX(u);
      if (Math.abs(x) < 1e-5 || Math.abs(s) < 1e-6) break;
      u -= x / s;
    }
    u = Math.min(1, Math.max(0, u));
    return sampleY(u);
  };
}

/** `--ease-out-soft` and `--ease-in-out`, the curves the shell already moves on. */
export const easeOutSoft = cubicBezier(0.33, 1, 0.68, 1);
export const easeInOut = cubicBezier(0.65, 0, 0.35, 1);

/* ———————————————————————————— input ———————————————————————————— */

/**
 * Speech loudness (normalizedSpeechLoudness: -52..-12 dB → 0..1) to light.
 * Below the floor is a room, not a voice: a fan or a far conversation must
 * not keep the edge twitching. A soft knee, so a word's onset rises instead
 * of switching on.
 */
export function gateLevel(raw: number): number {
  const FLOOR = 0.16;
  const CEIL = 0.84;
  const KNEE = 0.08;
  if (!(raw > FLOOR)) return 0;
  const x = raw - FLOOR;
  const span = CEIL - FLOOR;
  const y = x < KNEE ? (x * x) / (2 * KNEE) : x - KNEE / 2;
  return Math.min(1, y / (span - KNEE / 2));
}

/* ———————————————————————————— state ———————————————————————————— */

export interface GlowState {
  /** Brightness envelopes: they follow the syllables. */
  envYou: number;
  envAlevr: number;
  /** Extent envelopes: slower, they follow the phrase, so the light's shape stays calm. */
  liftYou: number;
  liftAlevr: number;
  /** Rest weights: who holds the floor, muted, thinking. */
  wYou: number;
  wAlevr: number;
  wMuted: number;
  wThink: number;
  /** The whole light's presence: 0 when off. */
  on: number;
  /** Seconds spent in the current thinking spell; -1 outside one. */
  thinkT: number;
}

export function createGlowState(): GlowState {
  return { envYou: 0, envAlevr: 0, liftYou: 0, liftAlevr: 0, wYou: 0, wAlevr: 0, wMuted: 0, wThink: 0, on: 0, thinkT: -1 };
}

/** Exponential approach that lands on the target within `dur` (≈95% at dur, snapped below eps). */
function approach(value: number, target: number, dt: number, dur: number): number {
  if (dur <= 0) return target;
  const next = target + (value - target) * Math.exp((-3 * dt) / dur);
  return Math.abs(next - target) < 1e-3 ? target : next;
}

/** An envelope: fast attack, slower release, snapped to exactly 0 in silence. */
function envelope(value: number, target: number, dt: number, attack = 0.045, release = 0.15): number {
  const tau = target > value ? attack : release;
  const next = target + (value - target) * Math.exp(-dt / tau);
  if (target === 0 && next < 0.004) return 0;
  return Math.abs(next - target) < 1e-4 ? target : next;
}

/** One step of the model. Mutates and returns `state`. `dt` in seconds (clamped). */
export function stepGlow(state: GlowState, input: GlowInput, dtIn: number): GlowState {
  const dt = Math.min(Math.max(dtIn, 0), 0.1);
  const { mode, reduced } = input;
  const fade = reduced ? GLOW_TIMING.fast : GLOW_TIMING.base;

  state.on = approach(state.on, mode === "off" ? 0 : 1, dt, mode === "off" ? GLOW_TIMING.exit : reduced ? GLOW_TIMING.fast : GLOW_TIMING.slow);
  state.wYou = approach(state.wYou, mode === "you" ? 1 : 0, dt, fade);
  state.wAlevr = approach(state.wAlevr, mode === "alevr" ? 1 : 0, dt, fade);
  state.wMuted = approach(state.wMuted, mode === "muted" ? 1 : 0, dt, fade);
  state.wThink = approach(state.wThink, mode === "thinking" ? 1 : 0, dt, fade);

  // Each voice follows its own audio. Your microphone is closed when muted;
  // nothing is heard when the call is off.
  const youTarget = reduced || mode === "muted" || mode === "off" ? 0 : gateLevel(input.you);
  const alevrTarget = reduced || mode === "off" ? 0 : gateLevel(input.alevr);
  state.envYou = envelope(state.envYou, youTarget, dt);
  state.envAlevr = envelope(state.envAlevr, alevrTarget, dt);
  state.liftYou = envelope(state.liftYou, youTarget, dt, 0.08, 0.3);
  state.liftAlevr = envelope(state.liftAlevr, alevrTarget, dt, 0.08, 0.3);

  if (mode === "thinking") state.thinkT = state.thinkT < 0 ? 0 : state.thinkT + dt;
  else if (state.wThink === 0) state.thinkT = -1;
  else if (state.thinkT >= 0) state.thinkT += dt; // let a pass finish under the fade
  return state;
}

function voiceFrame(rest: number, env: number, lift: number, on: number, reduced: boolean): GlowVoiceFrame {
  if (reduced) return { amp: on * rest * STATIC_AMP, lift: rest * STATIC_LIFT };
  const restAmp = REST_AMP * rest;
  const shaped = env > 0 ? Math.pow(env, 0.8) : 0;
  return { amp: on * (restAmp + (1 - restAmp) * shaped), lift };
}

/**
 * The beams of a thinking spell at `t` seconds in: the pass under way, and
 * the previous one resting at Alevr's end, fading as the next one leaves.
 */
export function handoffBeams(t: number): [GlowBeamFrame, GlowBeamFrame] {
  const cycle = Math.floor(t / GLOW_TIMING.repass);
  const u = t - cycle * GLOW_TIMING.repass;
  const travel = Math.min(1, u / HANDOFF_PASS);
  const pos = easeInOut(travel);
  // The tone hands over as the ThinkingMark's paths do: one stagger after the
  // light sets off, ember passes to presence in one 220 ms tone step, so the
  // beam leaves your end warm and travels the rest of the way in Alevr's ink.
  // Short on purpose: wherever ember and presence overlap they mix to mauve.
  const mix = easeOutSoft(Math.min(1, Math.max(0, (u - GLOW_TIMING.handoffStagger) / GLOW_TIMING.handoffTone)));
  let amp: number;
  if (u < GLOW_TIMING.handoffTone) amp = easeOutSoft(u / GLOW_TIMING.handoffTone);
  else if (u < HANDOFF_PASS) amp = 1;
  else amp = 1 - (1 - BEAM_REST) * easeOutSoft(Math.min(1, (u - HANDOFF_PASS) / GLOW_TIMING.slow));
  const current: GlowBeamFrame = { amp, pos, mix };
  const previous: GlowBeamFrame =
    cycle > 0
      ? { amp: BEAM_REST * (1 - easeOutSoft(Math.min(1, u / GLOW_TIMING.handoffTone))), pos: 1, mix: 1 }
      : { amp: 0, pos: 1, mix: 1 };
  return [current, previous];
}

/** The frame the renderer draws for `state`. */
export function glowFrame(state: GlowState, reduced: boolean): GlowFrame {
  const on = state.on;
  const you = voiceFrame(state.wYou, state.envYou, state.liftYou, on, reduced);
  const alevr = voiceFrame(state.wAlevr, state.envAlevr, state.liftAlevr, on, reduced);
  let beams: [GlowBeamFrame, GlowBeamFrame];
  if (state.wThink === 0) {
    beams = [
      { amp: 0, pos: 0, mix: 0 },
      { amp: 0, pos: 1, mix: 1 },
    ];
  } else if (reduced) {
    // Static: your ember at your end, Alevr's presence at its end, both held.
    const a = on * state.wThink * BEAM_REST;
    beams = [
      { amp: a, pos: 0, mix: 0 },
      { amp: a, pos: 1, mix: 1 },
    ];
  } else {
    const [current, previous] = handoffBeams(Math.max(0, state.thinkT));
    const k = on * state.wThink;
    beams = [
      { ...current, amp: current.amp * k },
      { ...previous, amp: previous.amp * k },
    ];
  }
  return { you, alevr, muted: on * state.wMuted * MUTED_AMP, beams };
}

/** Flattened, for comparing frames and uploading uniforms. */
export function frameVector(f: GlowFrame): number[] {
  return [
    f.you.amp,
    f.you.lift,
    f.alevr.amp,
    f.alevr.lift,
    f.muted,
    f.beams[0].amp,
    f.beams[0].pos,
    f.beams[0].mix,
    f.beams[1].amp,
    f.beams[1].pos,
    f.beams[1].mix,
  ];
}

/** True when two frames would draw the same picture: the loop skips the draw. */
export function sameFrame(a: number[] | null, b: number[], eps = 1e-3): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

/** True when nothing is lit: the canvas can be cleared and left alone. */
export function isDark(v: number[]): boolean {
  return v[0] < 1e-3 && v[2] < 1e-3 && v[4] < 1e-3 && v[5] < 1e-3 && v[8] < 1e-3;
}

/**
 * Run the model from silence to `untilMs` at 60 Hz, reading levels at each
 * simulated instant. The gallery's frozen stills: the same URL is the same
 * picture, every time.
 */
export function simulateGlow(
  untilMs: number,
  at: (ms: number) => GlowInput,
  state: GlowState = createGlowState()
): GlowState {
  const step = 1000 / 60;
  for (let t = step; t <= untilMs + 1e-6; t += step) stepGlow(state, at(t), step / 1000);
  return state;
}
