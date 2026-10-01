/*
 * The audio the voice designs are drawn from. A deterministic synthetic
 * speech level, so every render of a state is the same picture: a level is a
 * pure function of time and a talker seed, never Math.random, never a timer.
 *
 * The shape is speech-like on purpose (a flat sine would make every design
 * look better than it will with a real voice): syllables at about 4.6 per
 * second, each a soft bump of its own loudness; words separated by short
 * dips; phrases of about 2.6 s with real silence between them, where the
 * signature must go still. The product replaces this with the analyser's
 * RMS of the microphone (you) or of the reply's audio (Juno), smoothed the
 * same way (`smoothed`: a 100 ms window, which is what an AnalyserNode with
 * smoothingTimeConstant 0.8 feels like at 60 fps).
 */

export type Talker = "you" | "juno" | "member";

const SEED: Record<Talker, number> = { you: 1, juno: 2, member: 3 };

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Raw level 0..1 for a talker at `ms`. */
export function speech(ms: number, who: Talker = "you"): number {
  const seed = SEED[who];
  const t = ms / 1000;
  const rate = who === "juno" ? 4.9 : 4.4;
  const syl = t * rate + seed * 13.37;
  const i = Math.floor(syl);
  const f = syl - i;
  const bump = Math.pow(Math.sin(Math.PI * f), 1.4);
  const loud = 0.42 + 0.58 * hash(i + seed * 101);
  // Every three or four syllables, a word boundary dips.
  const word = Math.floor(syl / 3.4);
  const dip = hash(word * 7 + seed) < 0.2 ? 0.3 : 1;
  // Phrases: about 2.6 s of speech, then silence.
  const period = who === "juno" ? 3.6 : 3.3;
  const ph = (t + seed * 0.7) % period;
  const gate = smoothstep(0, 0.14, ph) * (1 - smoothstep(period - 0.75, period - 0.5, ph));
  const grain = 0.05 * Math.sin(t * 37.1 + seed) + 0.03 * Math.sin(t * 61.7 + seed * 2);
  return Math.max(0, Math.min(1, gate * (bump * loud * dip * 0.9 + 0.1 + grain)));
}

/** The level as the analyser reports it: a 100 ms trailing average, still a pure function of time. */
export function smoothed(ms: number, who: Talker = "you"): number {
  let sum = 0;
  let w = 0;
  for (let k = 0; k < 7; k++) {
    const weight = 1 - k / 8;
    sum += speech(ms - k * 16, who) * weight;
    w += weight;
  }
  return sum / w;
}

/**
 * Times (ms) at which each talker is mid-phrase and fairly loud, for stills.
 * Chosen by sampling the signal (the loudest moments in the first 6 s); a still frozen
 * here shows the signature carrying a voice, not a pause.
 */
export const LOUD_AT: Record<Talker, number> = { you: 3920, juno: 4880, member: 4900 };
