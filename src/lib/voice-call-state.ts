import type { VoiceTransport } from "@/lib/voice-phase";

/**
 * ONE STATE AT A TIME: what a voice call is doing, as the screen says it.
 *
 * The hook reports two axes (the transport, and what is happening inside a
 * live call) and every part of the call used to read them its own way: the
 * word, the glow's tone, the live region and the controls each had a mapping,
 * and they disagreed at the edges (muted while the model spoke read
 * "Speaking"; a call that never started read "Call stopped"). This is the one
 * reading. The chip's word and mark, the composer's edge light and the screen
 * reader's announcements all come from `voiceCallView` and
 * `voiceCallAnnouncement`, so they cannot drift apart.
 *
 * Pure: no React, no DOM. tests/voice-call-state.test.ts reads every rule.
 */

export type VoiceCallState =
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "muted"
  | "reconnecting"
  | "ended"
  | "error";

export interface VoiceCallInput {
  transport: VoiceTransport;
  muted: boolean;
  userSpeaking: boolean;
  awaitingResponse: boolean;
  assistantSpeaking: boolean;
  /** The call came up at least once. An error after that stopped a call; before it, the call never started. */
  wasLive?: boolean;
}

/**
 * Whose level the chip's meter follows: your microphone, the model's output
 * as heard, a still row of dots (connecting, muted), or nothing at all.
 */
export type VoiceCallMeter = "you" | "alevr" | "rest" | "none";

/** What stands in the chip's graphic slot: the meter, the working mark, or a warning. */
export type VoiceCallMark = "meter" | "working" | "alert";

export interface VoiceCallView {
  state: VoiceCallState;
  /** The chip's word, sentence case. */
  word: string;
  meter: VoiceCallMeter;
  mark: VoiceCallMark;
  /** Whose light the composer's edge carries; null while no audio moves (C16: the light is on only while audio is live). */
  edge: "you" | "alevr" | null;
}

export const VOICE_CALL_WORD: Record<Exclude<VoiceCallState, "error">, string> = {
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  muted: "Muted",
  reconnecting: "Reconnecting…",
  ended: "Call ended",
};

/**
 * Total and ordered: the first rule that holds wins.
 *
 * `ended > error > reconnecting > connecting > muted > speaking > thinking > listening`
 *
 * MUTED OUTRANKS SPEAKING. Believing you are heard when you are not is the
 * one confusion a call must never produce, and the model talking is exactly
 * when people mute (to cough, to answer someone in the room). So the word is
 * "Muted"; the meter still follows the model's voice, because that audio is
 * still playing and the meter is a picture of sound, not a second word.
 *
 * Your own speech reads "Listening", as silence does: the hook flips between
 * the two with every syllable, and a word that changed at that rate would be
 * the busiest thing on the screen. The meter moving is what says it hears you.
 *
 * `idle` reads as connecting: the call's parts are drawn only once a call has
 * been asked for, and the frame before `start()` lands is a call on its way.
 */
export function voiceCallView(input: VoiceCallInput): VoiceCallView {
  const { transport, muted, userSpeaking, awaitingResponse, assistantSpeaking } = input;
  if (transport === "ended") return { state: "ended", word: VOICE_CALL_WORD.ended, meter: "none", mark: "meter", edge: null };
  if (transport === "error") {
    return { state: "error", word: input.wasLive ? "Call stopped" : "Couldn’t start", meter: "none", mark: "alert", edge: null };
  }
  if (transport === "reconnecting") {
    return { state: "reconnecting", word: VOICE_CALL_WORD.reconnecting, meter: "rest", mark: "meter", edge: null };
  }
  if (transport === "connecting" || transport === "idle") {
    return { state: "connecting", word: VOICE_CALL_WORD.connecting, meter: "rest", mark: "meter", edge: null };
  }
  if (muted) {
    return {
      state: "muted",
      word: VOICE_CALL_WORD.muted,
      meter: assistantSpeaking ? "alevr" : "rest",
      mark: "meter",
      edge: assistantSpeaking ? "alevr" : null,
    };
  }
  if (assistantSpeaking) return { state: "speaking", word: VOICE_CALL_WORD.speaking, meter: "alevr", mark: "meter", edge: "alevr" };
  if (awaitingResponse && !userSpeaking) {
    return { state: "thinking", word: VOICE_CALL_WORD.thinking, meter: "none", mark: "working", edge: null };
  }
  return { state: "listening", word: VOICE_CALL_WORD.listening, meter: "you", mark: "meter", edge: "you" };
}

const IN_CALL: ReadonlySet<VoiceCallState> = new Set(["listening", "thinking", "speaking"]);

/**
 * What a screen reader hears when the call's state changes, or null.
 *
 * Only the changes a person acts on: the call connecting, the microphone
 * going off and on, a reconnect, the end. Never the turns themselves:
 * "Alevr is speaking" on every answer was read over the model's own voice,
 * and "Thinking" every turn is noise to someone listening to the call. An
 * error is not here either: its sentence is a `role="alert"` line of its own.
 */
export function voiceCallAnnouncement(previous: VoiceCallState | null, next: VoiceCallState): string | null {
  if (previous === next) return null;
  switch (next) {
    case "connecting":
      return previous === null ? "Connecting the call." : null;
    case "reconnecting":
      return "Reconnecting.";
    case "muted":
      return "Microphone off.";
    case "ended":
      return "The call has ended.";
    case "error":
      return null;
    default:
      if (previous === "muted") return "Microphone on.";
      if (previous === "connecting" || previous === null) return next === "listening" ? "Connected. Listening." : "Connected.";
      if (previous === "reconnecting") return "Reconnected.";
      // listening ⇄ thinking ⇄ speaking: the call is doing its job.
      return null;
  }
}

/** An announcement waits this long for the state to settle, so a flip and its undo say nothing. */
export const ANNOUNCE_SETTLE_MS = 400;
/** And never lands within this long of the last one (INTERACTION_SPEC C16: "flips faster than every 2 s are not announced"). */
export const ANNOUNCE_MIN_GAP_MS = 2_000;

export interface AnnouncerTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const browserTimers: AnnouncerTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The call's live region, debounced.
 *
 * Each change is measured against what was last SAID, not against the last
 * state seen: mute and unmute inside the settle window say nothing (the
 * state is back where the listener last heard it), and a connect that runs
 * straight on into a turn still says "Connected." once. Nothing lands within
 * `ANNOUNCE_MIN_GAP_MS` of the last announcement; a later change replaces a
 * waiting one rather than queueing behind it.
 */
export class VoiceAnnouncer {
  private said: VoiceCallState | null = null;
  private lastAt: number | null = null;
  private pending: { text: string; state: VoiceCallState; handle: unknown } | null = null;

  constructor(
    private readonly speak: (text: string) => void,
    private readonly timers: AnnouncerTimers = browserTimers,
  ) {}

  observe(state: VoiceCallState): void {
    const text = voiceCallAnnouncement(this.said, state);
    if (this.pending) {
      this.timers.clearTimeout(this.pending.handle);
      this.pending = null;
    }
    if (!text) {
      // Nothing worth saying, but the turn states still move the baseline
      // forward: a later unmute is measured from where the call now is.
      if (this.said && IN_CALL.has(this.said) && IN_CALL.has(state)) this.said = state;
      return;
    }
    const now = this.timers.now();
    const wait = Math.max(ANNOUNCE_SETTLE_MS, this.lastAt === null ? 0 : this.lastAt + ANNOUNCE_MIN_GAP_MS - now);
    const handle = this.timers.setTimeout(() => {
      this.pending = null;
      this.said = state;
      this.lastAt = this.timers.now();
      this.speak(text);
    }, wait);
    this.pending = { text, state, handle };
  }

  dispose(): void {
    if (this.pending) this.timers.clearTimeout(this.pending.handle);
    this.pending = null;
  }
}

/**
 * Whether this browser can share a screen at all. iOS Safari and Android
 * Chrome have no `getDisplayMedia`, and the button used to be drawn there
 * anyway, failing silently on every press.
 */
export function canShareScreen(nav: { mediaDevices?: { getDisplayMedia?: unknown } } | undefined = typeof navigator === "undefined" ? undefined : navigator): boolean {
  return typeof nav?.mediaDevices?.getDisplayMedia === "function";
}

/* ———————————————————————— the meter and the edge, as numbers ———————————————————————— */

export const METER_BARS = 5;
/** A bar at rest is a dot, never nothing: the meter is visibly on and visibly quiet. */
export const METER_FLOOR = 0.2;
/** Which band each bar draws, left to right: the lows (most of a voice's energy) in the middle, so speech rises as a mound. */
const METER_ORDER = [3, 1, 0, 2, 4] as const;

/**
 * Five bar heights (0..1) from a speaker's envelope and the spectrum's shape.
 *
 * Loudness sets how tall the meter is; the bands only set its shape, each
 * bar relative to the loudest. Bands alone made the meter twitch with every
 * formant at a constant volume, and the envelope alone drew one number five
 * times.
 */
export function meterTargets(envelope: number, bands: ArrayLike<number>, out: Float32Array = new Float32Array(METER_BARS)): Float32Array {
  let peak = 0;
  for (let i = 0; i < bands.length; i++) peak = Math.max(peak, bands[i] ?? 0);
  const loud = Math.min(1, Math.pow(Math.max(0, envelope), 0.9) * 1.05);
  for (let i = 0; i < METER_BARS; i++) {
    const band = bands[METER_ORDER[i]] ?? 0;
    const shape = peak > 0.01 ? 0.3 + 0.7 * (band / peak) : 0.7;
    out[i] = METER_FLOOR + (1 - METER_FLOOR) * Math.min(1, loud * shape);
  }
  return out;
}

/**
 * Ease a level toward its target by elapsed time, quicker up than down: the
 * meter catches a syllable's onset and lets it go gently, so it never
 * jitters at the frame rate. Time-based, so 60 Hz and 120 Hz move alike.
 */
export function easeLevel(current: number, target: number, dtMs: number, attackMs = 60, releaseMs = 180): number {
  const tau = target > current ? attackMs : releaseMs;
  if (!(dtMs > 0)) return current;
  return current + (target - current) * (1 - Math.exp(-dtMs / tau));
}

/** Reduced motion steps the meter at most this often, with no easing (INTERACTION_SPEC C16). */
export const REDUCED_METER_HZ = 4;

/** Whether a reduced-motion meter takes its next step now. */
export function meterStepDue(nowMs: number, lastStepMs: number | null, hz = REDUCED_METER_HZ): boolean {
  return lastStepMs === null || nowMs - lastStepMs >= 1000 / hz;
}
