"use client";

import * as React from "react";
import { useReducedMotion, type Transition } from "framer-motion";

/*
 * Juno's motion language in one place. The CSS side (tokens.css) carries the
 * same durations and curves as custom properties; framer reads them here.
 *
 *   Causality and continuity only. Chrome answers in 120 to 240 ms on one
 *   ease-out curve; objects that travel (a mark into its token, the composer
 *   to the dock, the sentence into the first message) use a critically damped
 *   spring so an interruption keeps its velocity. Springs with bounce are for
 *   direct manipulation and presence only. Nothing idles.
 *
 * Reduced motion is "fewer and gentler": travel, scale and height become a
 * short crossfade; nothing is removed that carries meaning.
 */

const ForcedReduced = React.createContext(false);

export function MotionPref({ reduced, children }: { reduced: boolean; children: React.ReactNode }) {
  return <ForcedReduced.Provider value={reduced}>{children}</ForcedReduced.Provider>;
}

export function useReduced(): boolean {
  const os = useReducedMotion();
  const forced = React.useContext(ForcedReduced);
  return forced || !!os;
}

export const EASE_OUT: [number, number, number, number] = [0.2, 0, 0, 1];
export const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];
export const EASE_DRAWER: [number, number, number, number] = [0.32, 0.72, 0, 1];

export const T = {
  /** Tonal chrome changes (hover, selection). */
  fast: { duration: 0.12, ease: EASE_OUT } satisfies Transition,
  /** Menus, palettes, popovers: in from their trigger. */
  menuIn: { duration: 0.16, ease: EASE_OUT } satisfies Transition,
  /** Menus: out, quicker than in, opacity-led. */
  menuOut: { duration: 0.11, ease: EASE_IN } satisfies Transition,
  /** A panel growing out of its token; a disclosure opening. */
  grow: { duration: 0.22, ease: EASE_OUT } satisfies Transition,
  /** Content arriving in place. */
  fade: { duration: 0.2, ease: EASE_OUT } satisfies Transition,
  /** Something that travels between two places (shared elements). */
  travel: { type: "spring", stiffness: 420, damping: 42, mass: 1 } satisfies Transition,
  /** Direct manipulation and presence: a touch of life, never a wobble. */
  presence: { type: "spring", stiffness: 520, damping: 30, mass: 0.8 } satisfies Transition,
  /** Sheets and side panels. */
  sheet: { duration: 0.32, ease: EASE_DRAWER } satisfies Transition,
  instant: { duration: 0 } satisfies Transition,
};

/** The reduced form of any transition: a short crossfade. */
export const R = { duration: 0.14, ease: EASE_OUT } satisfies Transition;

export function useT() {
  const reduced = useReduced();
  return { reduced, t: (k: keyof typeof T): Transition => (reduced ? R : T[k]) };
}
