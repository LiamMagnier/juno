/*
 * THE SHEET GESTURE, AS ARITHMETIC (G54).
 *
 * Phones close a sheet by throwing it back where it came from, and open the
 * navigation drawer by pulling it in from the screen's edge. Both follow the
 * finger 1:1, and both decide on release from two things: how far the panel
 * travelled and how fast it was going. A flick dismisses from a short pull;
 * a slow drag has to pass a fraction of the panel. This file is that
 * decision, with no DOM, so it is checked in tests and shared by every sheet
 * (ui/sheet-gesture.ts drives the DOM with it).
 *
 * The numbers are the ones the Code v2 bottom sheet shipped with (0.6 px/ms,
 * 30% of its height), kept close to what iOS sheets feel like: a quick
 * downward flick of a couple of centimetres closes; a lazy one that stops
 * halfway springs back.
 */

import { TIMING_TOKENS } from "@/lib/design/tokens.generated";

/** Below this many pixels of travel, a touch has not said what it is yet. */
export const INTENT_SLOP_PX = 8;

/** A release faster than this (px/ms) toward the edge dismisses, however short the pull. */
export const DISMISS_VELOCITY = 0.5;
/** A slow release dismisses once the panel has travelled this share of its size. */
export const DISMISS_FRACTION = 0.3;

/** An edge pull opens once the drawer is this far out, or on a flick. */
export const OPEN_FRACTION = 0.4;
export const OPEN_VELOCITY = 0.3;

/** How wide a strip at the screen's edge starts the drawer (px). */
export const EDGE_ZONE_PX = 24;

/** Velocity is measured over the last stretch of the gesture only, not its whole life. */
const VELOCITY_WINDOW_MS = 100;

export type GestureIntent = "drag" | "ignore" | null;

/**
 * What a touch that has moved (dx, dy) from where it started is doing.
 * `along` is the axis the panel moves on; `sign` the direction that moves it
 * toward dismissal (+1 down or right, -1 up or left). Null until the touch
 * has travelled past the slop. A drag must be mostly along the axis: a touch
 * that sets off sideways is a scroll, a swipe on a carousel, anything but
 * this.
 */
export function gestureIntent(dx: number, dy: number, along: "x" | "y", sign: 1 | -1): GestureIntent {
  const main = along === "x" ? dx : dy;
  const cross = along === "x" ? dy : dx;
  if (Math.abs(main) < INTENT_SLOP_PX && Math.abs(cross) < INTENT_SLOP_PX) return null;
  if (Math.abs(main) <= Math.abs(cross) * 1.2) return "ignore";
  return main * sign > 0 ? "drag" : "ignore";
}

/**
 * Travel the wrong way (pulling a bottom sheet UP) gives a little and then
 * resists, the way a scroll view's edge does, instead of stopping dead.
 * Returns the displayed offset for a finger `overshoot` px past the rest
 * position; it never exceeds `limit`.
 */
export function rubberBand(overshoot: number, limit = 64): number {
  const distance = Math.abs(overshoot);
  if (distance === 0) return 0;
  const eased = (1 - 1 / ((distance * 0.55) / limit + 1)) * limit;
  return Math.sign(overshoot) * eased;
}

/** The panel's displayed offset for a finger at `travel` px along the dismiss direction. */
export function dragOffset(travel: number): number {
  return travel >= 0 ? travel : rubberBand(travel);
}

export interface VelocitySample {
  /** Position along the gesture's axis, in px. */
  at: number;
  /** performance.now() of the sample. */
  t: number;
}

/** Keeps the last stretch of samples, so a gesture that paused and then flicked reads as a flick. */
export function pushSample(samples: VelocitySample[], sample: VelocitySample): VelocitySample[] {
  const next = [...samples, sample];
  while (next.length > 2 && sample.t - next[0].t > VELOCITY_WINDOW_MS) next.shift();
  return next;
}

/** Velocity in px/ms over the kept samples; 0 when there is nothing to measure. */
export function velocityOf(samples: readonly VelocitySample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return (last.at - first.at) / dt;
}

/**
 * On release: does the sheet go? `offset` is how far it travelled toward
 * dismissal (px, may be negative), `size` its extent on that axis, `velocity`
 * px/ms toward dismissal. A flick back toward rest always keeps it, however
 * far it had been pulled.
 */
export function shouldDismiss({ offset, size, velocity }: { offset: number; size: number; velocity: number }): boolean {
  if (offset <= 0) return false;
  if (velocity < -0.15) return false;
  if (velocity >= DISMISS_VELOCITY) return true;
  return offset >= Math.max(1, size) * DISMISS_FRACTION;
}

/**
 * On release of an edge pull: does the drawer open? `progress` 0..1 is how
 * far out it is, `velocity` px/ms in the opening direction.
 */
export function shouldOpen({ progress, velocity }: { progress: number; velocity: number }): boolean {
  if (velocity <= -OPEN_VELOCITY) return false;
  if (velocity >= OPEN_VELOCITY) return true;
  return progress >= OPEN_FRACTION;
}

/**
 * How long the panel takes to finish the move the finger started: the
 * remaining distance at the release speed, held between a quick settle and
 * the base rung so a slow release never crawls. The default clamp is
 * `--settle-min` / `--settle-max` (spec D18), read from the token table.
 */
export function settleMs(
  remaining: number,
  velocity: number,
  { min = TIMING_TOKENS.settle.min, max = TIMING_TOKENS.settle.max }: { min?: number; max?: number } = {},
): number {
  const speed = Math.abs(velocity);
  if (speed < 0.05) return max;
  return Math.round(Math.min(max, Math.max(min, Math.abs(remaining) / speed)));
}

/** Below this many pixels, the visual viewport's shortfall is a toolbar settling, not a keyboard. */
export const KEYBOARD_MIN_PX = 80;

/**
 * How far the on-screen keyboard reaches up into the layout viewport, in px:
 * what a bottom sheet must rise by to keep its fields above the keys. A
 * phone's keyboard shrinks the VISUAL viewport only, while `position: fixed;
 * bottom: 0` stays pinned to the layout viewport underneath it, so a sheet's
 * lower half (often its one field and its button) sat behind the keys. 0 when
 * there is no keyboard, or when a pinch zoom is what shrank the view.
 */
export function keyboardInset({
  layoutHeight,
  viewportHeight,
  viewportTop,
  scale = 1,
}: {
  layoutHeight: number;
  viewportHeight: number;
  viewportTop: number;
  scale?: number;
}): number {
  if (scale > 1.01) return 0;
  const inset = Math.round(layoutHeight - viewportHeight - viewportTop);
  return inset >= KEYBOARD_MIN_PX ? inset : 0;
}

/** The touch began in the strip along the screen's `edge`, where a pull opens the drawer. */
export function startsAtEdge(x: number, viewportWidth: number, edge: "left" | "right", zone = EDGE_ZONE_PX): boolean {
  return edge === "left" ? x <= zone : x >= viewportWidth - zone;
}
