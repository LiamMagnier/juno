/*
 * The gallery's voices: deterministic synthetic speech, so every render of a
 * state is the same picture. A level is a pure function of scene time and a
 * talker, never Math.random, never a timer.
 *
 * Speech-shaped on purpose, because a sine flatters every design: syllables
 * at about 4.5 a second, each a soft bump of its own loudness, word gaps,
 * phrases of about 2.5 s and real silence between them, where the light must
 * go still. The scale is the realtime hook's (normalizedSpeechLoudness,
 * -52..-12 dB → 0..1): conversational speech sits around 0.55-0.8 with
 * syllable troughs near 0.35 and a quiet room under 0.1.
 */

export type Talker = "you" | "alevr";

const SEED: Record<Talker, number> = { you: 1, alevr: 2 };

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Raw loudness 0..1 of a talker who is speaking continuously, at `ms`. */
export function speechLevel(ms: number, who: Talker): number {
  const seed = SEED[who];
  const t = ms / 1000;
  const rate = who === "alevr" ? 4.8 : 4.3;
  const syl = t * rate + seed * 13.37;
  const i = Math.floor(syl);
  const f = syl - i;
  const bump = Math.pow(Math.sin(Math.PI * f), 1.3);
  const loud = 0.55 + 0.45 * hash(i + seed * 101);
  const word = Math.floor(syl / 3.3);
  const dip = hash(word * 7 + seed) < 0.18 ? 0.45 : 1;
  const grain = 0.03 * Math.sin(t * 37.1 + seed) + 0.02 * Math.sin(t * 61.7 + seed * 2);
  // Alevr's output is mastered and steadier; a room microphone swings more.
  const floor = who === "alevr" ? 0.42 : 0.34;
  const span = who === "alevr" ? 0.42 : 0.5;
  return Math.max(0, Math.min(1, floor + span * bump * loud * dip + grain));
}

/** Phrases: `onMs` of speech, then `offMs` of silence, repeating from `startMs`. */
export function phrased(ms: number, who: Talker, startMs = 0, onMs = 2500, offMs = 900): number {
  if (ms < startMs) return 0;
  const period = onMs + offMs;
  const ph = (ms - startMs) % period;
  const gate = smoothstep(0, 90, ph) * (1 - smoothstep(onMs - 160, onMs, ph));
  return gate * speechLevel(ms, who);
}

/** Speech between two scene times, with a soft onset and a soft end. */
export function spoken(ms: number, who: Talker, fromMs: number, toMs: number): number {
  if (ms < fromMs || ms > toMs) return 0;
  const gate = smoothstep(fromMs, fromMs + 90, ms) * (1 - smoothstep(toMs - 140, toMs, ms));
  return gate * speechLevel(ms, who);
}

/** A room with nobody speaking: under the gate. */
export function room(ms: number): number {
  return 0.06 + 0.03 * Math.sin(ms / 340) * Math.sin(ms / 97);
}
