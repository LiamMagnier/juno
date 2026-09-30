"use client";

import * as React from "react";
import { useReducedMotion, type Transition } from "framer-motion";

/*
 * One switch for reduced motion: the OS setting, or `rm=1` on the URL (so the
 * reduced form of every moment can be recorded side by side). Every framer
 * transition in Canvas reads its timing from here, so reduced motion turns a
 * glide into a crossfade or an instant change in one place.
 */

const ForcedReduced = React.createContext(false);

export function MotionPrefProvider({ reduced, children }: { reduced: boolean; children: React.ReactNode }) {
  return <ForcedReduced.Provider value={reduced}>{children}</ForcedReduced.Provider>;
}

export function useReduced(): boolean {
  const os = useReducedMotion();
  const forced = React.useContext(ForcedReduced);
  return forced || !!os;
}

/* The language: chrome is fast and tonal; objects that move travel on one curve. */
export const EASE_OUT: [number, number, number, number] = [0.2, 0, 0, 1];
export const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1];

export const T = {
  /** Menus, palettes, popovers: in. */
  menuIn: { duration: 0.14, ease: EASE_OUT } satisfies Transition,
  /** Menus: out (quicker than in). */
  menuOut: { duration: 0.1, ease: EASE_IN } satisfies Transition,
  /** A panel growing from its token. */
  panelIn: { duration: 0.2, ease: EASE_OUT } satisfies Transition,
  /** An object travelling (a mark into its chip, the composer to the dock). */
  travel: { duration: 0.32, ease: EASE_OUT } satisfies Transition,
  /** Quiet fades for content arriving. */
  fade: { duration: 0.22, ease: EASE_OUT } satisfies Transition,
  instant: { duration: 0 } satisfies Transition,
};
