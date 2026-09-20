/**
 * The micro-interaction vocabulary: what a control does in the quarter-second
 * the user is touching it.
 *
 * WHY A THIRD MOTION FILE, after `tailwind.config.ts`'s keyframes and
 * `lib/motion.ts`'s framer presets. Those two answer "how does this ARRIVE"
 * and "how does this TRAVEL" — entrances, exits, layout changes, the motion of
 * regions. Neither has anything to say about the smallest scale, which is the
 * one a person is actually touching: a thumb that stretches because it is
 * moving fast, a glyph that overshoots because it was just switched on, a
 * number that rolls rather than cuts, a button that fills while it is held.
 * Those were being hand-written per call site or, far more often, not done at
 * all — the product travelled beautifully and felt inert under the finger.
 *
 * EVERY NUMBER IS DERIVED OR MEASURED, and the derivations are written down.
 * Durations come from `DURATION`, curves from `EASING`, so a squash and the
 * CSS transition underneath it agree by construction. The three magnitudes
 * that are NOT in the token file — how far a thumb stretches, how far a glyph
 * overshoots, how far a burst throws — are calibrated against
 * reactbits.dev/c/micro, which is the reference this pass was worked from:
 * RubberSegment dilates 0.19, SquishSwitch caps its stretch at 0.40 and
 * PulseHeart overshoots 1.7 on a cubic back. Those are the upper end of the
 * range because that library is a showcase; the values below sit at roughly
 * half, because this is a tool people use for hours and a control that
 * performs is a control that gets tiring. The RATIOS are kept — a squash is
 * always ~60% of its stretch, so the thumb conserves area and reads as
 * rubber rather than as a box being resized.
 *
 * NOTHING HERE RUNS UNDER `prefers-reduced-motion`. Every consumer takes the
 * reduced flag and collapses to the endpoint, because all of this is
 * decoration on a state change that has already happened — which is exactly
 * the class of motion that rule exists for.
 */

import { DURATION, EASING } from "@/lib/design/tokens.generated";

/**
 * How far a travelling thumb stretches along its axis, as a fraction.
 *
 * 0.10 against RubberSegment's 0.19. The reference's control is 44px tall with
 * a 4px inset; Juno's product switch is 28px tall with 2px, so the same
 * fraction is half the pixels of slack to absorb it and the thumb visibly
 * clips its own track. Ten percent of a 32px cell is 3.2px of stretch, which
 * is the smallest amount that still reads as deliberate at 60fps.
 */
export const STRETCH = 0.1;

/**
 * The cross-axis squash, as a fraction of the stretch.
 *
 * 0.6, which is what makes it rubber. A box that grows on one axis and holds
 * the other is being resized; one that gives back most of what it took is
 * conserving volume, and the eye reads the second as a material. Not 1.0 —
 * true area conservation over-squashes at these magnitudes and the thumb goes
 * visibly thin.
 */
export const SQUASH_RATIO = 0.6;

/**
 * When the stretch peaks, as a fraction of the travel.
 *
 * 0.35 — just past a third. A thumb moving between two adjacent cells is at
 * its fastest early (the spring front-loads), so peak deformation belongs
 * early too; peaking at the midpoint reads as the thumb inflating on arrival
 * rather than being dragged.
 */
export const STRETCH_PEAK = 0.35;

/** How long a stretch-and-settle takes. The travel it decorates is `base`. */
export const STRETCH_MS = DURATION.base;

/**
 * How far a glyph overshoots when it is switched ON.
 *
 * 1.18 against PulseHeart's 1.7. Seventy percent is a like button on a social
 * feed, where the whole point of the control is the reward; this is a feedback
 * thumb on a message in a work tool, and the same gesture happens beside a
 * paragraph the person is still reading. Eighteen percent is visible in
 * peripheral vision without pulling the eye off the text.
 *
 * `outBack` is the curve, and it is already in the token file — the overshoot
 * is in the easing, not in a keyframe, so the peak scale and the settle are
 * one animation rather than two chained ones.
 */
export const SWELL = 1.18;

/** The dip before the swell: the glyph compresses, then springs past 1. */
export const SWELL_DIP = 0.86;

export const swellTransition = {
  duration: DURATION.base / 1000,
  ease: EASING.outBack as unknown as [number, number, number, number],
} as const;

/**
 * The burst: how many particles leave the glyph, and how far.
 *
 * SIX, at 60° apart. Eight reads as a firework and four reads as a compass;
 * six is the smallest count that has no obvious axis, which is what keeps it
 * from looking aimed. `BURST_RADIUS` is in multiples of the glyph's own box,
 * so it scales with whatever it decorates instead of being a pixel count that
 * is right on one control and wrong on the next.
 */
export const BURST_COUNT = 6;
export const BURST_RADIUS = 0.9;
export const BURST_MS = DURATION.slow;

/** Particle angles, in degrees, offset so none sits on the vertical. */
export const BURST_ANGLES = Array.from({ length: BURST_COUNT }, (_, i) => (360 / BURST_COUNT) * i + 15);

/**
 * How long a destructive control must be held before it fires.
 *
 * 900ms. The reference's default is 2000, which is a demo value — long enough
 * that the progress fill is the point. Here the fill is the receipt, not the
 * show: 900ms is past every accidental press (a deliberate click is 80–150ms,
 * a slip on a trackpad rarely exceeds 300) while staying short enough that
 * someone deleting six things in a row is not being punished. Releasing early
 * unwinds in `exit`, which is the rule for anything the user has stopped
 * asking for.
 */
export const HOLD_MS = 900;
export const HOLD_RELEASE_MS = DURATION.exit;

/**
 * Below this, a press is a TAP and not an aborted hold.
 *
 * 180ms. A hold control still has to answer a plain click — someone who does
 * not know it is a hold will click it, and the honest response is to say so
 * ("Hold to delete") rather than to silently do nothing, which reads as a
 * broken button.
 */
export const TAP_MS = 180;

/** How long one digit takes to roll to the next. */
export const ROLL_MS = DURATION.base;
