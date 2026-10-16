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
 *
 * Every constant is read from the generated tokens (spec D18, §3.12), which
 * also write them to Swift as `JunoGesture`, so the iPhone's sheets and these
 * decide identically. The values are wave 1's, unchanged.
 */

import { GESTURE } from "@/lib/design/tokens.generated";

/** How far a pull past the rest position may travel at most, and how stiffly it resists (D18). */
export const RUBBER_BAND_LIMIT_PX = GESTURE.rubberBandLimitPx;
export const RUBBER_BAND_C = GESTURE.rubberBandC;

/** The release settle is clamped to this range (`--settle-min` / `--settle-max`). */
export const SETTLE_MIN_MS = GESTURE.settleMinMs;
export const SETTLE_MAX_MS = GESTURE.settleMaxMs;

/** Below this many pixels of travel, a touch has not said what it is yet. */
export const INTENT_SLOP_PX = GESTURE.slopPx;

/** A release faster than this (px/ms) toward the edge dismisses, however short the pull. */
export const DISMISS_VELOCITY = GESTURE.dismissVelocity;
/** A slow release dismisses once the panel has travelled this share of its size. */
export const DISMISS_FRACTION = GESTURE.dismissFraction;

/** An edge pull opens once the drawer is this far out, or on a flick. */
export const OPEN_FRACTION = GESTURE.openFraction;
export const OPEN_VELOCITY = GESTURE.openVelocity;

/** How wide a strip at the screen's edge starts the drawer (px). */
export const EDGE_ZONE_PX = GESTURE.edgeZonePx;

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
export function rubberBand(overshoot: number, limit: number = RUBBER_BAND_LIMIT_PX): number {
  const distance = Math.abs(overshoot);
  if (distance === 0) return 0;
  const eased = (1 - 1 / ((distance * RUBBER_BAND_C) / limit + 1)) * limit;
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
 * the base rung so a slow release never crawls.
 */
export function settleMs(remaining: number, velocity: number, { min = SETTLE_MIN_MS, max = SETTLE_MAX_MS }: { min?: number; max?: number } = {}): number {
  const speed = Math.abs(velocity);
  if (speed < 0.05) return max;
  return Math.round(Math.min(max, Math.max(min, Math.abs(remaining) / speed)));
}

/** A sheet drags from its 44px header, or from the first 44px of a body scrolled to the top (spec C8). */
export const SHEET_DRAG_ZONE_PX = 44;

/**
 * Whether a touch at `y` may start dragging a bottom sheet: anywhere in the
 * top `zone` px of the panel (its header), or in the top `zone` px of the
 * scrolling body it landed in, when that body is scrolled to its top.
 * Anywhere else the touch belongs to the content.
 */
export function inSheetDragZone(
  { y, panelTop, body }: { y: number; panelTop: number; body?: { top: number; scrollTop: number } | null },
  zone: number = SHEET_DRAG_ZONE_PX,
): boolean {
  if (y - panelTop <= zone) return true;
  if (!body) return false;
  return body.scrollTop <= 0 && y - body.top <= zone;
}

/** The medium detent shows this share of the viewport (spec §5.6, glance sheets). */
export const MEDIUM_DETENT_FRACTION = 0.5;

/** How far a large sheet is pushed down to sit at the medium detent, in px. */
export function mediumDetentOffset(panelHeight: number, viewportHeight: number): number {
  return Math.max(0, Math.round(panelHeight - viewportHeight * MEDIUM_DETENT_FRACTION));
}

export type SheetDetent = "medium" | "large";

/**
 * On release of a glance sheet: where does it go? `offset` is the travel
 * toward dismissal from the current detent (negative = pulled up), `velocity`
 * px/ms toward dismissal, `detentOffset` the medium detent's push-down,
 * `visible` the height currently on screen.
 */
export function releaseDetent({
  detent,
  offset,
  velocity,
  detentOffset,
  visible,
}: {
  detent: SheetDetent;
  offset: number;
  velocity: number;
  detentOffset: number;
  visible: number;
}): SheetDetent | "dismiss" {
  if (detent === "medium") {
    if (offset < 0 && (velocity <= -DISMISS_VELOCITY || -offset >= detentOffset * DISMISS_FRACTION)) return "large";
    return shouldDismiss({ offset, size: visible, velocity }) ? "dismiss" : "medium";
  }
  if (!shouldDismiss({ offset, size: visible, velocity })) return "large";
  // From large, a pull that does not clear the medium detent by a margin stops there.
  if (detentOffset > 0 && offset < detentOffset + (visible - detentOffset) * DISMISS_FRACTION && velocity < DISMISS_VELOCITY * 2) return "medium";
  return "dismiss";
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
