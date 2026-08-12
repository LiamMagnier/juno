/**
 * The motion system.
 *
 * Two ideas hold this together.
 *
 * **Reduced motion is a second design, not a kill switch.** Deleting every
 * animation leaves a UI that teleports: panels appear without the eye being led
 * to them, and the user loses the causal link between the control they pressed
 * and the thing that changed. So the reduced profile keeps opacity and keeps
 * timing — it removes travel, overshoot and scale, the components that actually
 * provoke vestibular symptoms — and it shortens durations, because a fade with
 * no movement reads as slow at the same length that felt right with movement.
 *
 * **The preference comes from macOS, not from the web.** `prefers-reduced-motion`
 * is one of the two signals that matter and there is no media query at all for
 * "Reduce Transparency", so main reads both from `nativeTheme`/`systemPreferences`
 * and pushes them down `app:appearance-changed`, stamping `data-reduce-motion`
 * and `data-reduce-transparency` on <html>. React state is the source of truth
 * for components; `readReducedMotionFromDocument` exists for the first frame,
 * before the initial `app:appearance` round trip has resolved.
 *
 * This module is deliberately dependency-free apart from Framer Motion's types:
 * anything that imports application state here would make the motion system
 * un-testable and would create a cycle with `state/`.
 */

import type { Transition, Variants } from 'framer-motion';

/** A cubic-bezier control quartet, in Framer's argument order. */
export type Easing = [number, number, number, number];

/**
 * The curve set, mirrored from the web app's tokens so a control that exists in
 * both products decelerates identically in both.
 */
export const EASE = {
  /** Entrances, and anything arriving from outside the viewport. */
  outSoft: [0.33, 1, 0.68, 1] as Easing,
  /** Entrances with apparent mass — panels, sheets, the palette. */
  outStrong: [0.32, 0.72, 0, 1] as Easing,
  /** Exits. Leaving should be quicker than arriving, and accelerate away. */
  in: [0.4, 0, 1, 1] as Easing,
  /** A-to-B moves where both endpoints are visible: widths, rotations, thumbs. */
  inOut: [0.65, 0, 0.35, 1] as Easing,
} as const;

/** Seconds, because Framer takes seconds and unit mistakes here are silent. */
export const DURATION = {
  press: 0.07,
  fast: 0.12,
  exit: 0.16,
  base: 0.22,
  slow: 0.36,
} as const;

export interface MotionProfile {
  /** True when macOS "Reduce Motion" is on. */
  readonly reduced: boolean;
  /** Whether shared-element (`layoutId`) animations should run at all. */
  readonly layout: boolean;
  readonly transition: {
    readonly fast: Transition;
    readonly base: Transition;
    readonly exit: Transition;
    readonly panel: Transition;
  };
  /** Modal backdrop. Leads on open, trails on close. */
  readonly scrim: Variants;
  /** The command palette panel and other centred overlays. */
  readonly overlay: Variants;
  /** Menus and popovers, which emerge from their trigger. */
  readonly popover: Variants;
  /** Inspector / side panels entering from an edge. */
  readonly sidePanel: Variants;
  /** Rows in a list that appears as a unit. */
  readonly listItem: Variants;
  /** The one that is identical in both profiles. */
  readonly fade: Variants;
}

/**
 * Build the variant set for a given preference.
 *
 * Pure and cheap; memoise it per preference rather than per render.
 */
export function createMotionProfile(reduced: boolean): MotionProfile {
  const enter: Transition = reduced
    ? { duration: DURATION.fast, ease: EASE.outSoft }
    : { duration: DURATION.base, ease: EASE.outSoft };
  const leave: Transition = reduced
    ? { duration: DURATION.press, ease: EASE.in }
    : { duration: DURATION.exit, ease: EASE.in };
  const panel: Transition = reduced
    ? { duration: DURATION.fast, ease: EASE.outSoft }
    : { duration: DURATION.base, ease: EASE.outStrong };

  /* Travel and overshoot are the two things the reduced profile gives up. Every
     distance below is multiplied by these, so there is exactly one place where
     "reduced" changes meaning. */
  const shift = reduced ? 0 : 1;
  const scaleFrom = reduced ? 1 : 0.97;

  return {
    reduced,
    layout: !reduced,
    transition: { fast: { duration: DURATION.fast, ease: EASE.outSoft }, base: enter, exit: leave, panel },

    scrim: {
      hidden: { opacity: 0, transition: { duration: DURATION.base, ease: EASE.in } },
      visible: { opacity: 1, transition: { duration: DURATION.fast, ease: EASE.outSoft } },
    },

    overlay: {
      hidden: { opacity: 0, y: -8 * shift, scale: scaleFrom, transition: leave },
      visible: { opacity: 1, y: 0, scale: 1, transition: panel },
    },

    popover: {
      hidden: { opacity: 0, y: 4 * shift, scale: reduced ? 1 : 0.96, transition: leave },
      visible: { opacity: 1, y: 0, scale: 1, transition: enter },
    },

    sidePanel: {
      hidden: { opacity: 0, x: 12 * shift, transition: leave },
      visible: { opacity: 1, x: 0, transition: panel },
    },

    listItem: {
      /* No stagger under reduced motion: a cascade is travel in time rather
         than in space, and it produces the same "the page is still moving"
         feeling the preference is asking us to stop. */
      hidden: { opacity: 0, y: 4 * shift },
      visible: (index: number) => ({
        opacity: 1,
        y: 0,
        transition: { ...enter, delay: reduced ? 0 : Math.min(index, 8) * 0.018 },
      }),
    },

    fade: {
      hidden: { opacity: 0, transition: leave },
      visible: { opacity: 1, transition: enter },
    },
  };
}

/** The profile used before the first `app:appearance` response arrives. */
export const DEFAULT_MOTION_PROFILE: MotionProfile = createMotionProfile(false);

export const REDUCE_MOTION_ATTRIBUTE = 'data-reduce-motion';
export const REDUCE_TRANSPARENCY_ATTRIBUTE = 'data-reduce-transparency';

/**
 * First-frame fallback: the attribute main stamps on <html>, then the web
 * media query, then "no preference".
 *
 * The media query is second rather than first because on macOS it reflects the
 * same system setting but is not updated for every mechanism that can set it
 * (and is absent entirely in a non-browser test environment).
 */
export function readReducedMotionFromDocument(): boolean {
  if (typeof document === 'undefined') return false;
  const stamped = document.documentElement.getAttribute(REDUCE_MOTION_ATTRIBUTE);
  if (stamped !== null) return stamped === 'true';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}
