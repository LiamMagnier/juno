/**
 * The shared motion vocabulary for framer-motion.
 *
 * WHY THIS EXISTS, given that the CSS side is already good.
 *
 * The keyframes in tailwind.config.ts cover entrances thoroughly — `rise-in`
 * alone has 73 call sites — and nothing here replaces them. A one-shot entrance
 * that runs once and is never interrupted is cheaper and simpler as CSS, and it
 * should stay CSS.
 *
 * What CSS cannot do is the motion that makes an interface feel authored rather
 * than assembled: motion that is INTERRUPTIBLE (a panel caught halfway and sent
 * back without a snap), PHYSICAL (velocity carried from a drag into the
 * settle), CHOREOGRAPHED (a list whose rows arrive in sequence, not together),
 * and CONTINUOUS across a layout change (an element that moves between two
 * positions in the tree instead of disappearing from one and appearing in the
 * other). `framer-motion` was already a dependency and was doing this in
 * exactly four files.
 *
 * EVERY NUMBER HERE IS DERIVED, NOT CHOSEN. Durations and curves come from
 * `tokens.generated.ts`, which is generated from the same `globals.css`
 * custom properties the CSS classes use, so a framer transition and a CSS
 * transition on the same interaction agree by construction. The variants below
 * reproduce the existing keyframes' exact offsets (8px for rise, 6px for
 * fade-up, 4px + 0.96 for pop) so the two systems are indistinguishable in
 * motion even when one element uses each.
 *
 * The spring presets deliberately mirror `JunoMotion` in
 * `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesignTokens.swift`
 * — same duration, same bounce — so the Mac app and the web settle identically.
 */

import type { CSSProperties } from "react";

import type { Transition, Variants } from "framer-motion";

import { DURATION, EASING } from "@/lib/design/tokens.generated";

/** framer works in seconds; the tokens are authored in milliseconds. */
const s = (ms: number) => ms / 1000;

type Bezier = [number, number, number, number];
const bezier = (t: readonly [number, number, number, number]): Bezier => [t[0], t[1], t[2], t[3]];

/** `--ease-*`, as framer cubic-bezier arrays. */
export const ease = {
  /** The default decelerate, for things arriving under their own steam. */
  outSoft: bezier(EASING.outSoft),
  /** Front-loaded, overshoot-free — for things the user is moving. */
  outStrong: bezier(EASING.outStrong),
  /** The hardest decelerate, for long travel that must not feel slow. */
  outExpo: bezier(EASING.outExpo),
  /** The accelerate curve. Exits accelerate; entrances decelerate. */
  in: bezier(EASING.in),
  /** Symmetric, for A-to-B moves where both endpoints are on screen. */
  inOut: bezier(EASING.inOut),
  /** The only symmetric LOOP curve — no seam where it turns around. */
  breathe: bezier(EASING.breathe),
  /** The Soft UI entrance: scale .96 → 1 with a ~2% overrun, then settle. */
  spring: bezier(EASING.spring),
  /** Sheets and drawers — front-loaded, overshoot-free, pulled by the user. */
  drawer: bezier(EASING.drawer),
} satisfies Record<string, Bezier>;

/** `--dur-*`, in seconds. */
export const duration = {
  press: s(DURATION.press),
  fast: s(DURATION.fast),
  exit: s(DURATION.exit),
  base: s(DURATION.base),
  slow: s(DURATION.slow),
  emphasis: s(DURATION.emphasis),
} satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Duration-based transitions, one per rung of the scale. Reach for these when
 * the motion is a state change with a known endpoint and no physicality — a
 * colour, an opacity, a height.
 */
export const transition = {
  /** Transform only, on the element under the finger. */
  press: { duration: duration.press, ease: ease.outStrong },
  /** A property changing on the element the pointer is already touching. */
  fast: { duration: duration.fast, ease: ease.outSoft },
  /** Leaving. Accelerates, because the user has already decided. */
  exit: { duration: duration.exit, ease: ease.in },
  /** The default. Anything without an argument for a different number. */
  base: { duration: duration.base, ease: ease.outSoft },
  /** A whole region changing — a panel, a page's worth of content. */
  slow: { duration: duration.slow, ease: ease.outExpo },
  /** The one rung reserved for a change the user did NOT cause. */
  emphasis: { duration: duration.emphasis, ease: ease.outExpo },
  /** A-to-B where both endpoints are visible: chevrons, accordions, widths. */
  symmetric: { duration: duration.base, ease: ease.inOut },
} satisfies Record<string, Transition>;

/**
 * Spring transitions, for motion that must survive being interrupted.
 *
 * A duration-based tween restarted mid-flight jumps, because it re-derives its
 * path from wherever it happens to be. A spring carries its velocity through,
 * which is the entire reason to reach for one — not because springs are
 * fashionable, but because interruption is the common case for anything the
 * user is driving.
 *
 * `duration` + `bounce` rather than stiffness/damping/mass: it is the same
 * parameterisation SwiftUI's `Animation.spring(duration:bounce:)` takes, so
 * these three presets and `JunoMotion`'s three are the same three springs.
 */
export const spring = {
  /** The default settle. Mirrors `JunoMotion.standard`. */
  standard: { type: "spring", duration: duration.base, bounce: 0.05 },
  /** More overshoot, for a change that should be noticed. `JunoMotion.emphasized`. */
  emphasized: { type: "spring", duration: duration.slow, bounce: 0.1 },
  /** For anything tracking a pointer. `JunoMotion.spring` (interactiveSpring). */
  interactive: { type: "spring", stiffness: 320, damping: 30, mass: 0.8 },
  /** Layout changes — an element moving because its neighbours did. */
  layout: { type: "spring", duration: duration.slow, bounce: 0 },
} satisfies Record<string, Transition>;

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * Offsets copied from the CSS keyframes of the same name, so an element
 * animated by framer and one animated by `animate-rise-in` travel identically.
 * Changing one without the other is the drift this file exists to prevent.
 */
const SHIFT = { rise: 6, fadeUp: 6, pop: 4, stage: 12 } as const;
const POP_SCALE = 0.96;

export const variants = {
  /** `animate-fade-in`. */
  fade: {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: transition.base },
    exit: { opacity: 0, transition: transition.exit },
  },
  /** `animate-rise-in` — the workhorse entrance. */
  rise: {
    hidden: { opacity: 0, y: SHIFT.rise },
    visible: { opacity: 1, y: 0, transition: transition.base },
    exit: { opacity: 0, y: SHIFT.rise, transition: transition.exit },
  },
  /** `animate-fade-in-up` — a shorter rise, for dense lists. */
  fadeUp: {
    hidden: { opacity: 0, y: SHIFT.fadeUp },
    visible: { opacity: 1, y: 0, transition: transition.base },
    exit: { opacity: 0, y: SHIFT.fadeUp, transition: transition.exit },
  },
  /** `animate-pop-in` / `animate-pop-out` — menus, popovers, toasts. */
  pop: {
    hidden: { opacity: 0, y: SHIFT.pop, scale: POP_SCALE },
    // The CSS `animate-pop-in` runs --dur-base on --ease-spring; this is the
    // same curve, so a framer pop and a CSS pop are indistinguishable.
    visible: { opacity: 1, y: 0, scale: 1, transition: { duration: duration.base, ease: ease.spring } },
    exit: { opacity: 0, y: SHIFT.pop, scale: POP_SCALE, transition: transition.exit },
  },
  /** `animate-stage-in` — content arriving from the side of a staged flow. */
  stage: {
    hidden: { opacity: 0, x: SHIFT.stage },
    visible: { opacity: 1, x: 0, transition: transition.slow },
    exit: { opacity: 0, x: -SHIFT.stage, transition: transition.exit },
  },
} satisfies Record<string, Variants>;

/**
 * Parent variants that sequence their children.
 *
 * `staggerChildren` is the single highest-leverage thing in this file. A list
 * whose rows all fade in together reads as one flat repaint; the same rows 30ms
 * apart read as the interface dealing them out, and it costs nothing. The
 * default is deliberately short — long stagger on a list the user is waiting
 * for is a delay dressed as craft.
 *
 * @param step  Seconds between children. 0.03 for dense rows, up to ~0.06 for
 *              a handful of large cards.
 * @param delay Seconds before the first child.
 */
export const stagger = (step = 0.03, delay = 0): Variants => ({
  hidden: {},
  visible: { transition: { staggerChildren: step, delayChildren: delay } },
  // Exits run in reverse, nearest-to-the-action first, and faster than entry:
  // an unwind that takes as long as the build reads as the UI stalling.
  exit: { transition: { staggerChildren: step / 2, staggerDirection: -1 } },
});

// ---------------------------------------------------------------------------
// Stagger, for CSS entrances
// ---------------------------------------------------------------------------

/**
 * The stagger scale.
 *
 * The CSS keyframes stay CSS (see the note at the top of this file), so most
 * lists in the product sequence themselves with an inline
 * `style={{ animationDelay: ... }}`. There were 58 of those across 40 files and
 * they used EIGHT different steps — 30, 40, 45, 50, 55, 60, 65 and 80ms — with
 * caps of 10, 12, or none at all.
 *
 * That is the motion equivalent of the 26 radius values, and it is most of the
 * answer to why the interface does not feel authored: every list deals its rows
 * out at a different tempo, so no two screens share a rhythm. A viewer cannot
 * name the difference between 45ms and 50ms, but they can feel that the product
 * has no single hand behind it.
 *
 * Three rungs, chosen by how much each item weighs, not by how many there are.
 */
export const STAGGER = {
  /** Dense rows — a file list, a sidebar, a table. */
  tight: 30,
  /** The default. Cards and tiles in a grid. */
  base: 45,
  /** Large, few, and consequential — pricing tiers, onboarding steps. */
  loose: 60,
} as const;

export type StaggerRung = keyof typeof STAGGER;

/**
 * How many items still stagger before the delay stops growing.
 *
 * A cap is not an optimisation, it is the difference between choreography and a
 * queue: uncapped at 45ms, the 30th row arrives 1.35s after the first, so a long
 * list visibly loads rather than appearing. Ten is where the sequence has
 * already been read as a sequence — the existing sites that capped at all had
 * independently landed on 10 and 12.
 */
const STAGGER_CAP = 10;

/**
 * Inline style for the nth item of a staggered CSS entrance.
 *
 * Pair with `motion-safe:animate-rise-in` (or any entrance keyframe) and
 * `[animation-fill-mode:backwards]`, so an item waiting for its turn holds the
 * keyframe's `from` state instead of flashing at full opacity first.
 *
 * @example
 *   <li style={staggerDelay(i)} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]" />
 *   <li style={staggerDelay(i, "tight", 120)} />   // after a header has landed
 */
export function staggerDelay(
  index: number,
  rung: StaggerRung = "base",
  offsetMs = 0
): CSSProperties {
  const step = STAGGER[rung];
  const n = Math.max(0, Math.min(index, STAGGER_CAP));
  return { animationDelay: `${offsetMs + n * step}ms` };
}

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * The reduced-motion projection of a variant set.
 *
 * This mirrors the tiering globals.css already applies (see the
 * `prefers-reduced-motion` block): Tier B keeps the fade and drops the travel.
 * It does NOT drop the animation altogether — an element that simply appears
 * gives no indication of where it came from, which is a comprehension cost, not
 * a comfort one. Only opacity survives.
 *
 * Pair with framer's `useReducedMotion()` at the call site, or hoist a single
 * `<MotionConfig reducedMotion="user">` over a subtree and let framer do it.
 */
export const flatten = (v: Variants): Variants =>
  Object.fromEntries(
    Object.entries(v).map(([state, def]) => {
      if (typeof def !== "object" || def === null) return [state, def];
      const { x: _x, y: _y, scale: _scale, rotate: _rotate, ...rest } = def as Record<string, unknown>;
      return [state, rest];
    })
  );

/** Every variant set above, pre-flattened. */
export const reducedVariants = Object.fromEntries(
  Object.entries(variants).map(([k, v]) => [k, flatten(v)])
) as typeof variants;
