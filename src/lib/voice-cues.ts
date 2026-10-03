import type { VoiceTransport } from "@/lib/voice-phase";

/**
 * THE TWO SOUNDS OF A VOICE CALL.
 *
 * A call says it is ready to hear you with a soft rising pair of notes, and
 * says it is over with the same pair falling. Nothing else makes a sound:
 * earcons cost attention (every one is a meaning someone has to learn), so a
 * voice mode gets the two that answer the questions a person has with their
 * eyes off the screen — "can I talk yet?" and "did it hang up?".
 *
 * WHEN, which matters more than what. The ready cue plays when the relay says
 * the session is live (`session.ready`) and the microphone is already
 * streaming, never on the button press: a chime that fires before the call can
 * hear you is a promise the call then breaks (Claude Code's own split-view
 * toggle had exactly that bug, anthropics/claude-code#48450). The ended cue
 * plays once when a call that was live stops, whoever stopped it: the End
 * button, the relay closing, an error, the page unmounting. A call that never
 * came up stays silent at both ends, so a failed connect is never a chime
 * pair, and a provider switch or a reconnect (live → connecting → live) is the
 * same call and makes no sound.
 *
 * WHAT. Synthesised, so no asset ships and web and native play the same
 * numbers (the Swift twin is JunoVoiceCues.swift): a sine with a little
 * triangle for body, through a gentle low-pass so the triangle's upper
 * harmonics never turn it into a beep. A perfect fifth, A4 and E5: rising is
 * "opening", falling is "closing". The first note is the accented one and the
 * last rings longest, the rhythm earcon research finds reads as one gesture.
 * Peaks sit near -18 dBFS: under speech, which the providers master close to
 * full scale, so the cue never shouts over the voice it introduces.
 *
 * The samples are rendered here, in plain arithmetic, and the browser plays
 * the buffer. One renderer means the tests measure exactly what is heard.
 */

export type VoiceCueKind = "start" | "end";

export interface VoiceCueNote {
  /** Hz. */
  freq: number;
  /** Onset, seconds from the start of the cue. */
  at: number;
  /** Length, seconds, including the release. */
  dur: number;
  /** Peak amplitude, dBFS. */
  peakDb: number;
}

export interface VoiceCueSpec {
  notes: readonly VoiceCueNote[];
  /** Raised-cosine rise, seconds. Long enough to have no click, short enough to have an edge. */
  attack: number;
  /** Raised-cosine fade to silence at the end of each note, seconds. */
  release: number;
  /** How far each note has decayed by the start of its release, dB below its peak. */
  decayDb: number;
  /** Triangle blended under the sine, 0..1 of the sine's level. */
  triangleMix: number;
  /** One-pole low-pass corner, Hz: rounds off the triangle's harmonics. */
  lowpassHz: number;
}

const A4 = 440;
const E5 = 659.25;

export const VOICE_CUES: Record<VoiceCueKind, VoiceCueSpec> = {
  // Ready: up a fifth. 260 ms end to end.
  start: {
    notes: [
      { freq: A4, at: 0, dur: 0.12, peakDb: -18 },
      { freq: E5, at: 0.09, dur: 0.17, peakDb: -19.5 },
    ],
    attack: 0.008,
    release: 0.04,
    decayDb: 14,
    triangleMix: 0.22,
    lowpassHz: 2800,
  },
  // Ended: the mirror, a touch softer and slower, 280 ms. Closing should not
  // sound more urgent than opening did.
  end: {
    notes: [
      { freq: E5, at: 0, dur: 0.12, peakDb: -19.5 },
      { freq: A4, at: 0.1, dur: 0.18, peakDb: -21 },
    ],
    attack: 0.01,
    release: 0.05,
    decayDb: 14,
    triangleMix: 0.22,
    lowpassHz: 2600,
  },
};

/**
 * How long the uplink sends silence after the ready cue starts, beyond the
 * cue itself: output latency plus the room's tail. Echo cancellation should
 * already remove the cue from the microphone, but a chime the model hears as
 * speech starts a turn nobody said, so the call does not depend on it.
 */
export const CUE_MIC_GATE_PAD_S = 0.12;

export const dbToGain = (db: number) => 10 ** (db / 20);
export const gainToDb = (gain: number) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

/** End of the last note, seconds. */
export function cueDuration(spec: VoiceCueSpec): number {
  return Math.max(...spec.notes.map((n) => n.at + n.dur));
}

/**
 * One note's envelope at `t` seconds into it: a raised-cosine attack to the
 * peak, an exponential decay that has lost `decayDb` by the release, and a
 * raised-cosine release to exactly zero. Exported for the tests.
 */
export function noteEnvelope(spec: VoiceCueSpec, note: VoiceCueNote, t: number): number {
  if (t < 0 || t >= note.dur) return 0;
  const peak = dbToGain(note.peakDb);
  const { attack, release } = spec;
  if (t < attack) return peak * 0.5 * (1 - Math.cos((Math.PI * t) / attack));
  const releaseStart = note.dur - release;
  const decaySpan = Math.max(1e-6, releaseStart - attack);
  const decayed = peak * dbToGain((-spec.decayDb * Math.min(t - attack, decaySpan)) / decaySpan);
  if (t < releaseStart) return decayed;
  return decayed * 0.5 * (1 + Math.cos((Math.PI * (t - releaseStart)) / release));
}

/** A triangle wave with the sine's phase: 0 at 0, +1 at a quarter cycle. */
function triangle(phase: number): number {
  const x = phase / (2 * Math.PI) + 0.25;
  return 4 * Math.abs(x - Math.floor(x + 0.5)) - 1;
}

/** The cue as mono samples at `sampleRate`. Pure, deterministic. */
export function renderVoiceCue(kind: VoiceCueKind, sampleRate: number): Float32Array<ArrayBuffer> {
  const spec = VOICE_CUES[kind];
  const length = Math.ceil(cueDuration(spec) * sampleRate);
  const out = new Float32Array(length);
  const mixNorm = 1 / (1 + spec.triangleMix);
  for (const note of spec.notes) {
    const from = Math.round(note.at * sampleRate);
    const to = Math.min(length, from + Math.ceil(note.dur * sampleRate));
    const w = 2 * Math.PI * note.freq;
    for (let i = from; i < to; i++) {
      const t = (i - from) / sampleRate;
      const phase = w * t;
      const wave = (Math.sin(phase) + spec.triangleMix * triangle(phase)) * mixNorm;
      out[i] += wave * noteEnvelope(spec, note, t);
    }
  }
  // One-pole low-pass, run forward. Its gain at the fundamentals is within a
  // few tenths of a dB of unity, so the peaks above still hold.
  const a = Math.exp((-2 * Math.PI * spec.lowpassHz) / sampleRate);
  let y = 0;
  for (let i = 0; i < length; i++) {
    y = (1 - a) * out[i] + a * y;
    out[i] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// When to play: one bracket per call.

export interface VoiceCueScheduler {
  /** Feed every transport the call passes through; plays at most one cue per call. */
  observe(transport: VoiceTransport): VoiceCueKind | null;
  /** True between the ready cue's moment and the ended cue's. */
  readonly open: boolean;
}

/**
 * The bracket. `observe` is idempotent, so the hook may report the same
 * transport from several places (the relay frame that caused it, the effect
 * that sees it, the End button) and still play each cue once.
 *
 * `enabled` is read at the moment of each cue, so the Voice sounds switch
 * takes effect immediately, including mid-call. The bracket advances either
 * way: turning sounds back on mid-call does not replay a ready cue.
 */
export function createVoiceCueScheduler(opts: {
  play: (kind: VoiceCueKind) => void;
  enabled: () => boolean;
}): VoiceCueScheduler {
  let open = false;
  const fire = (kind: VoiceCueKind) => {
    if (opts.enabled()) opts.play(kind);
    return kind;
  };
  return {
    observe(transport) {
      if (transport === "live") {
        if (open) return null;
        open = true;
        return fire("start");
      }
      if (transport === "idle" || transport === "ended" || transport === "error") {
        if (!open) return null;
        open = false;
        return fire("end");
      }
      // connecting / reconnecting: the same call, still in progress.
      return null;
    },
    get open() {
      return open;
    },
  };
}

// ---------------------------------------------------------------------------
// Measuring a cue: used by the tests and by /dev/voice-sounds, which renders
// the cue through an OfflineAudioContext and reports these numbers.

/** Autocorrelation pitch over `[from, to)` seconds, searched in 150-2000 Hz. */
export function estimatePitch(samples: Float32Array, sampleRate: number, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from * sampleRate));
  const b = Math.min(samples.length, Math.floor(to * sampleRate));
  const minLag = Math.floor(sampleRate / 2000);
  const maxLag = Math.ceil(sampleRate / 150);
  let bestLag = 0;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let norm = 0;
    for (let i = a; i + lag < b; i++) {
      sum += samples[i] * samples[i + lag];
      norm += samples[i + lag] * samples[i + lag];
    }
    const r = norm > 0 ? sum / Math.sqrt(norm) : 0;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  if (!bestLag) return 0;
  // Parabolic interpolation around the peak for sub-sample precision.
  const r = (lag: number) => {
    let s = 0;
    for (let i = a; i + lag < b; i++) s += samples[i] * samples[i + lag];
    return s;
  };
  const y0 = r(bestLag - 1);
  const y1 = r(bestLag);
  const y2 = r(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  return sampleRate / (bestLag + shift);
}

export interface CueAnalysis {
  /** Seconds from the first to the last sample above -60 dBFS. */
  duration: number;
  peakDbfs: number;
  rmsDbfs: number;
  /** Pitch just after the onset. */
  firstPitchHz: number;
  /** Pitch in the cue's last ringing stretch. */
  lastPitchHz: number;
  /** First and last samples, so a click at either edge shows. */
  edge: { first: number; last: number };
}

export function analyseCue(samples: Float32Array, sampleRate: number): CueAnalysis {
  const floor = dbToGain(-60);
  let first = -1;
  let last = -1;
  let peak = 0;
  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    energy += samples[i] * samples[i];
    if (v > floor) {
      if (first < 0) first = i;
      last = i;
    }
  }
  const onset = Math.max(0, first) / sampleRate;
  const end = Math.max(0, last) / sampleRate;
  return {
    duration: end - onset,
    peakDbfs: gainToDb(peak),
    rmsDbfs: gainToDb(Math.sqrt(energy / Math.max(1, last - first + 1))),
    firstPitchHz: estimatePitch(samples, sampleRate, onset + 0.012, onset + 0.07),
    lastPitchHz: estimatePitch(samples, sampleRate, end - 0.11, end - 0.05),
    edge: { first: samples[0] ?? 0, last: samples[samples.length - 1] ?? 0 },
  };
}
