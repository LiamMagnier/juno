"use client";

/**
 * The composer's one move from the /code landing to the session (G58).
 *
 * The landing and the session are two routes, so the composer box is two
 * mounts, and the session's docked composer used to appear at the bottom as
 * if the landing's had vanished. The landing records where its box stood as
 * the send navigates; the first docked composer the session paints (the
 * route's loading frame, the static first paint or the live one, whichever
 * mounts first) plays a measured translate from there to its own place: the
 * chat view's centre-to-dock handoff, on the same rungs (--dur-slow,
 * --ease-out-expo: long travel, no overshoot).
 *
 * Those frames replace one another while the move is still playing, and each
 * replacement is a new element. So the move is one clock, not one element:
 * the first mount starts it, and a frame that mounts mid-flight picks it up
 * where it is (a negative delay) instead of restarting it or snapping to the
 * dock. Once the time is spent, later mounts are simply where they belong.
 *
 * Travel, so reduced motion (the OS setting or the app's own Reduced) never
 * plays it: the box is simply where it belongs.
 */
import * as React from "react";
import { reducedMotionAt } from "@/lib/run/loop-phase";

/** Older than this, a recorded origin belongs to some other navigation. */
const TRAVEL_FRESH_MS = 6000;
/** The move's length when the token cannot be read (--dur-slow). */
const TRAVEL_FALLBACK_MS = 360;

interface Origin {
  top: number;
  /** When the landing recorded it. */
  at: number;
  /** When the first docked composer started the move, or null before. */
  startedAt: number | null;
}

let origin: Origin | null = null;

/** The landing's send: where its composer box stood. */
export function rememberComposerOrigin(box: Element | null | undefined, now: number = Date.now()): void {
  if (!box) return;
  origin = { top: box.getBoundingClientRect().top, at: now, startedAt: null };
}

/** Forgets the recorded move (tests, or a navigation that went elsewhere). */
export function forgetComposerOrigin(): void {
  origin = null;
}

/**
 * Where the move stands for a composer mounting now: the landing's top and how
 * far into the move this mount is (0 for the first). Null when there is no
 * fresh origin or the move has already finished.
 */
export function takeComposerOrigin(now: number = Date.now(), duration: number = TRAVEL_FALLBACK_MS): { top: number; elapsed: number } | null {
  if (!origin || now - origin.at > TRAVEL_FRESH_MS) {
    origin = null;
    return null;
  }
  if (origin.startedAt === null) origin.startedAt = now;
  const elapsed = now - origin.startedAt;
  if (elapsed >= duration) {
    origin = null;
    return null;
  }
  return { top: origin.top, elapsed };
}

/** The distance worth animating: under 12px a "move" would say nothing. */
export function travelDistance(from: number | null, to: number): number | null {
  if (from === null) return null;
  const dy = from - to;
  return Math.abs(dy) > 12 ? dy : null;
}

/**
 * Plays the arrival on the element `ref` points at, once, on mount, when the
 * landing left an origin. A layout effect, so the first painted frame already
 * shows the box at the landing's position rather than flashing it docked.
 */
export function useComposerArrival(ref: React.RefObject<HTMLElement | null>, enabled = true): void {
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const root = getComputedStyle(document.documentElement);
    const duration = parseFloat(root.getPropertyValue("--dur-slow")) || TRAVEL_FALLBACK_MS;
    // Reduced motion: nothing moves, and the origin is spent so no later frame plays it either.
    if (reducedMotionAt(el)) {
      forgetComposerOrigin();
      return;
    }
    const step = takeComposerOrigin(Date.now(), duration);
    if (!step) return;
    const dy = travelDistance(step.top, el.getBoundingClientRect().top);
    if (dy === null) return;
    // Not cancelled on cleanup: a frame that unmounts takes its animation with
    // it, and the next frame continues the same clock.
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
      duration,
      delay: -step.elapsed,
      easing: root.getPropertyValue("--ease-out-expo").trim() || "ease-out",
      fill: "backwards",
    });
    // Once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
