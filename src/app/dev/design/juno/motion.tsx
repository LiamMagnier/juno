"use client";

import * as React from "react";
import { useReducedMotion, type Transition } from "framer-motion";

/*
 * Juno's motion language in one place, on the INTERACTION_SPEC §1 ladder. The
 * CSS side (tokens.css) carries the same durations and curves as custom
 * properties; framer reads them here.
 *
 *   Causality and continuity only. Frequency decides motion: anything done a
 *   hundred times a day or started from the keyboard does not move (F0);
 *   tens a day is tonal (F1); occasional things get 220 to 360 ms (F2); only
 *   rare moments may reach 560 ms (F3). Springs use duration and bounce, the
 *   same parameterisation SwiftUI uses, so web and native share numbers.
 *   Nothing idles.
 *
 * Reduced motion is "fewer and gentler": travel, scale and height become a
 * short crossfade; nothing that carries meaning is removed.
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

/* Curves (§1.3) */
export const EASE_OUT: [number, number, number, number] = [0.33, 1, 0.68, 1]; // out-soft: the default
export const EASE_STRONG: [number, number, number, number] = [0.32, 0.72, 0, 1]; // out-strong / drawer
export const EASE_EXPO: [number, number, number, number] = [0.16, 1, 0.3, 1]; // out-expo: long travel, regions
export const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1]; // exits the person caused
export const EASE_IN_OUT: [number, number, number, number] = [0.65, 0, 0.35, 1]; // A to B, both ends visible
export const EASE_DRAWER = EASE_STRONG;

/* Durations (§1.1), seconds */
export const D = { press: 0.07, fast: 0.12, exit: 0.16, base: 0.22, slow: 0.36, emphasis: 0.56 } as const;

/* Springs (§1.4) */
export const SPRING = {
  /** Selection moves, a segmented thumb, a face pose change, a popover retargeting. */
  standard: { type: "spring", duration: 0.22, bounce: 0.05 },
  /** The task hand-off (T1) and a face turning toward you (P3). Nothing else. */
  emphasized: { type: "spring", duration: 0.36, bounce: 0.1 },
  /** Neighbours moving, panels docking, the composer moving from the home to the dock (C18). */
  layout: { type: "spring", duration: 0.36, bounce: 0 },
  /** Anything following a pointer or finger. */
  interactive: { type: "spring", duration: 0.32, bounce: 0.15 },
  /** Two sites only: an approved action's receipt settling, and long work finishing on screen. */
  reward: { type: "spring", duration: 0.36, bounce: 0.15 },
} satisfies Record<string, Transition>;

export const T = {
  /** Hover tone, glyph swaps, label cross-fades (F1). */
  fast: { duration: D.fast, ease: EASE_OUT } satisfies Transition,
  /** Anything leaving that the person caused: opacity-led, ease-in. */
  exit: { duration: D.exit, ease: EASE_IN } satisfies Transition,
  /** Menus and popovers from their trigger, disclosures, card arrival (F2). */
  base: { duration: D.base, ease: EASE_OUT } satisfies Transition,
  /** Disclosures whose both ends are visible (chevrons, Collapse). */
  disclose: { duration: D.base, ease: EASE_IN_OUT } satisfies Transition,
  /** A region changing: a sheet, a panel docking, the send anchor scroll. */
  slow: { duration: D.slow, ease: EASE_EXPO } satisfies Transition,
  /** Web sheets and docking panels. */
  sheet: { duration: D.slow, ease: EASE_DRAWER } satisfies Transition,
  /** Aliases kept for readability at call sites. */
  menuIn: { duration: D.base, ease: EASE_OUT } satisfies Transition,
  menuOut: { duration: D.exit, ease: EASE_IN } satisfies Transition,
  grow: { duration: D.base, ease: EASE_OUT } satisfies Transition,
  fade: { duration: D.base, ease: EASE_OUT } satisfies Transition,
  travel: SPRING.layout,
  presence: SPRING.standard,
  instant: { duration: 0 } satisfies Transition,
};

/** The reduced form of any transition: a short crossfade (§1.7). */
export const R = { duration: D.exit, ease: EASE_OUT } satisfies Transition;

export function useT() {
  const reduced = useReduced();
  return { reduced, t: (k: keyof typeof T): Transition => (reduced ? R : T[k]) };
}

/** Behaviour timers (§1.2): not motion. */
export const TIMING = {
  showDelay: 200,
  minVisible: 400,
  copiedHold: 1500,
  approvalArm: 500,
  phaseMinHold: 1000,
  elapsedAfter: 3000,
  undoWindow: 10_000,
} as const;
