/*
 * The stream pacer: turns a reply that arrives in bursts (a model's chunks,
 * a proxy's buffering, a reconnect replaying a backlog) into text that
 * reaches the screen at a steady reading cadence.
 *
 * The shown text trails the received text by a small, deliberate buffer, and
 * a velocity follows the arrival rate: chunks that land 300 characters at a
 * time on an irregular clock come out as a few characters every frame. When
 * the shown text falls far behind it catches up quickly (the backlog drains
 * in well under a second), and a huge backlog (a replay, a tab that slept) is
 * cut to the last screenful at once. Releases snap forward to the end of the
 * current word, so a word never appears half-written.
 *
 * When the stream ends, whatever is still held back DRAINS (spec C2: "at up
 * to 4× the rate, capped at 250, never in one block"): `tailVelocity` fixes a
 * speed at the moment the stream ends and `pacerDrain` spends it frame by
 * frame. The caller used to flush to the full text the instant the stream
 * ended, so the last 100 to 300 characters of every reply landed as one slab.
 *
 * Pure: the component (stream-text.tsx) owns the clock and the frame loop.
 */

import { TIMING_TOKENS } from "@/lib/design/tokens.generated";

export type PacerState = {
  /** Characters shown, fractional (the velocity integrates here). */
  shown: number;
  /** Arrival rate estimate, characters per second. */
  rate: number;
  /** Received length at the last arrival, and when it arrived (ms). */
  lastLength: number;
  lastArrival: number;
};

export const PACER = {
  /** First guess at the arrival rate before any measurement (chars/s). */
  initialRate: 260,
  minRate: 40,
  maxRate: 4000,
  /** How far behind the received text the shown text sits by design (s of arrival). */
  bufferSeconds: 0.12,
  /** Time constant for draining a backlog above the buffer (s). */
  drainSeconds: 0.38,
  /** Arrival-rate smoothing time constant (ms). */
  rateTau: 900,
  /** A backlog larger than this jumps to within `jumpKeep` characters of the end. */
  jumpAbove: 2400,
  jumpKeep: 320,
  /** The longest snap to a word end, in characters. */
  wordSnap: 18,
} as const;

export function initPacer(length: number, now: number): PacerState {
  return { shown: length, rate: PACER.initialRate, lastLength: length, lastArrival: now };
}

/** Record that the received text is now `length` long. */
export function pacerArrive(s: PacerState, length: number, now: number): PacerState {
  if (length === s.lastLength) return s;
  if (length < s.lastLength) {
    // The text was replaced (an edit, a regenerate, a normalisation): start over from it.
    return { ...s, shown: Math.min(s.shown, length), lastLength: length, lastArrival: now };
  }
  const dt = Math.max(16, now - s.lastArrival);
  const instant = ((length - s.lastLength) / dt) * 1000;
  // A gap longer than a second says nothing about the rate within a burst: weigh it lightly.
  const alpha = 1 - Math.exp(-Math.min(dt, 1000) / PACER.rateTau);
  const rate = Math.min(PACER.maxRate, Math.max(PACER.minRate, s.rate + (instant - s.rate) * alpha));
  return { ...s, rate, lastLength: length, lastArrival: now };
}

/** Advance the shown length by one frame of `dtMs`. */
export function pacerStep(s: PacerState, length: number, dtMs: number): PacerState {
  const backlog = length - s.shown;
  if (backlog <= 0) return s.shown === length ? s : { ...s, shown: length };
  if (backlog > PACER.jumpAbove) return { ...s, shown: length - PACER.jumpKeep };
  const dt = Math.min(0.1, dtMs / 1000);
  const buffer = s.rate * PACER.bufferSeconds;
  // Follow the arrival rate, plus a proportional pull on whatever sits above the buffer.
  const velocity = Math.max(s.rate * 0.35, s.rate + (backlog - buffer) / PACER.drainSeconds);
  return { ...s, shown: Math.min(length, s.shown + velocity * dt) };
}

/**
 * The tail drain (spec C2), apart from `PACER` because `PACER` is the
 * cross-platform contract (contracts/chat/stream-pacer.v1.json) the native
 * pacer replays. `maxMs` is `--stream-tail-max`.
 */
export const TAIL = {
  /** The drain runs at least this many times the arrival rate. */
  rateFactor: 4,
  /** …and finishes within this, however much is left. */
  maxMs: TIMING_TOKENS.stream.tailMax,
} as const;

/** The speed (characters per second) a finished stream's held tail drains at. */
export function tailVelocity(s: PacerState, length: number): number {
  const backlog = Math.max(0, length - s.shown);
  return Math.max(s.rate * TAIL.rateFactor, backlog / (TAIL.maxMs / 1000));
}

/** Advance a finished stream's tail by one frame of `dtMs` at `velocity` (from `tailVelocity`). */
export function pacerDrain(s: PacerState, length: number, dtMs: number, velocity: number): PacerState {
  if (s.shown >= length) return s.shown === length ? s : { ...s, shown: length };
  // A tail too long to read anyway (a replay that ended) still jumps first.
  if (length - s.shown > PACER.jumpAbove) return { ...s, shown: length - PACER.jumpKeep };
  const dt = Math.min(0.1, Math.max(0, dtMs) / 1000);
  return { ...s, shown: Math.min(length, s.shown + velocity * dt) };
}

/**
 * The index to cut the text at for a fractional `shown`: forward to the end of
 * the word it lands in (when that end has arrived and is close), never inside
 * a surrogate pair.
 */
export function revealCut(text: string, shown: number): number {
  let cut = Math.min(text.length, Math.max(0, Math.floor(shown)));
  if (cut >= text.length || cut === 0) return cut;
  if (/\S/.test(text[cut - 1]) && /\S/.test(text[cut])) {
    const limit = Math.min(text.length, cut + PACER.wordSnap);
    let end = cut;
    while (end < limit && /\S/.test(text[end])) end++;
    if (end < text.length && end < limit) cut = end;
    else {
      // The word's end has not arrived yet: hold at its start rather than show half of it.
      let start = cut;
      while (start > 0 && cut - start < PACER.wordSnap && /\S/.test(text[start - 1])) start--;
      if (start > 0 && cut - start < PACER.wordSnap) cut = start;
    }
  }
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut += 1;
  return cut;
}
