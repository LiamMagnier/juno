/**
 * The voice envelope bus: one smoothed 0..1 level per speaker, plus a few real
 * spectrum bands for the call meter.
 *
 * WHY A MODULE SINGLETON. The numbers move at frame rate. Pushing them through
 * React would re-render whatever is listening sixty times a second to move a
 * handful of bars. Publishers write here (the realtime call, read-aloud TTS);
 * consumers read here once per frame (the call meter, the aura through
 * `attachAuraLevel`). Same contract as `lib/aura.ts`, narrower job.
 *
 * WHY SPLIT ENVELOPES. One multiplexed level made Juno's speech borrow the
 * microphone's last shape: when the model started talking the glow faded off a
 * frozen mic frame instead of rising with the words coming out of the speaker.
 * User and assistant keep their own envelopes; the active floor is a choice,
 * not a leftover.
 */

export type VoiceSpeaker = "user" | "assistant";

/**
 * Whose envelope the multiplexed floor is carrying right now.
 *
 * `muted` is its own source rather than a zeroed `user`: a still grey band and
 * a silent room look the same at level 0, and only one of them means "you are
 * not being heard".
 */
export type VoiceLevelSource = "user" | "assistant" | "muted" | "idle";

/**
 * Who owns the bus this instant. A live call always wins: read-aloud during a
 * call would otherwise fight the call for the same refs every frame.
 */
export type VoiceEnvelopeOwner = "call" | "tts";

/** Speech energy lives in 85 Hz .. 4 kHz; the meter draws one bar per band. */
export const VOICE_BAND_COUNT = 5;

const levels: Record<VoiceSpeaker, { current: number }> = {
  user: { current: 0 },
  assistant: { current: 0 },
};

const bands = new Float32Array(VOICE_BAND_COUNT);
let source: VoiceLevelSource = "idle";
let owner: VoiceEnvelopeOwner | null = null;

function clamp01(value: number): number {
  return value > 1 ? 1 : value > 0 ? value : 0;
}

/** The live 0..1 envelope for one speaker. Write from the audio graph only. */
export function voiceLevelRef(speaker: VoiceSpeaker): { current: number } {
  return levels[speaker];
}

export function readVoiceLevel(speaker: VoiceSpeaker): number {
  return clamp01(levels[speaker].current);
}

export function setVoiceLevelSource(next: VoiceLevelSource): void {
  source = next;
}

export function readVoiceLevelSource(): VoiceLevelSource {
  return source;
}

/**
 * Claim the bus for one publisher. Last claim wins (a call that starts during
 * read-aloud takes the bus); the returned release only clears a claim still
 * held by this owner, so a superseded publisher cannot silence its successor.
 */
export function claimVoiceEnvelope(next: VoiceEnvelopeOwner): () => void {
  owner = next;
  return () => {
    if (owner === next) owner = null;
  };
}

export function readVoiceEnvelopeOwner(): VoiceEnvelopeOwner | null {
  return owner;
}

/** Publish the active source's spectrum, already folded to `VOICE_BAND_COUNT`. */
export function publishVoiceBands(next: ArrayLike<number>): void {
  const n = Math.min(VOICE_BAND_COUNT, next.length);
  for (let i = 0; i < n; i++) {
    bands[i] = clamp01(next[i]);
  }
  for (let i = n; i < VOICE_BAND_COUNT; i++) bands[i] = 0;
}

/** Copy the current bands into `out` (or a fresh buffer) and return it. */
export function readVoiceBands(out: Float32Array = new Float32Array(VOICE_BAND_COUNT)): Float32Array {
  const n = Math.min(VOICE_BAND_COUNT, out.length);
  for (let i = 0; i < n; i++) out[i] = bands[i];
  return out;
}

/**
 * Fold an FFT byte spectrum into `out`'s speech bands, log-spaced across
 * 85 Hz .. 4 kHz. Real bins per bar: five bars on one loudness number is a
 * needle drawn five times, not a spectrum.
 */
export function foldSpeechBands(
  freq: Uint8Array,
  sampleRate: number,
  fftSize: number,
  out: Float32Array
): void {
  const count = Math.min(out.length, VOICE_BAND_COUNT);
  if (count === 0 || freq.length === 0) return;
  const nyquist = sampleRate / 2;
  const hzPerBin = nyquist / freq.length;
  const loHz = 85;
  const hiHz = 4000;
  for (let band = 0; band < count; band++) {
    const t0 = band / count;
    const t1 = (band + 1) / count;
    const f0 = loHz * Math.pow(hiHz / loHz, t0);
    const f1 = loHz * Math.pow(hiHz / loHz, t1);
    const i0 = Math.max(1, Math.floor(f0 / hzPerBin));
    const i1 = Math.min(freq.length - 1, Math.max(i0, Math.ceil(f1 / hzPerBin)));
    let sum = 0;
    for (let i = i0; i <= i1; i++) sum += freq[i];
    out[band] = clamp01(sum / Math.max(1, i1 - i0 + 1) / 255);
  }
}

/** RMS of a time-domain byte buffer (0..1), for an analyser's envelope. */
export function timeDomainRms(time: Uint8Array): number {
  if (time.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / time.length);
}

export function resetVoiceLevel(): void {
  levels.user.current = 0;
  levels.assistant.current = 0;
  bands.fill(0);
  source = "idle";
}
