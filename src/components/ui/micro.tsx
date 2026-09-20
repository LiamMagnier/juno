"use client";

import * as React from "react";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "framer-motion";
import {
  BURST_ANGLES,
  BURST_MS,
  BURST_RADIUS,
  ROLL_MS,
  SQUASH_RATIO,
  STRETCH,
  STRETCH_MS,
  STRETCH_PEAK,
  SWELL,
  SWELL_DIP,
  swellTransition,
} from "@/lib/micro";
import { ease } from "@/lib/motion";
import { cn } from "@/lib/utils";

/* ────────────────────────────────────────────────────────────────────────────
 * The three micro-interactions this product actually needs, and nothing else.
 *
 * reactbits.dev/c/micro has thirty-three, and thirty of them are wrong for a
 * tool people keep open all day: a rating that peeks, a field that dodges the
 * cursor, a ticket that tears. Those are showcase pieces — they are ABOUT
 * themselves, and a control that is about itself is one the reader has to look
 * at rather than through. What survives the filter is the motion that answers
 * a question the interface was already leaving unanswered:
 *
 *   squash  — "did my toggle land, or is it mid-flight?"   (SquishSwitch, RubberSegment)
 *   swell   — "did that register?"                          (PulseHeart)
 *   roll    — "did that number change, or was it always 3?" (PulseHeart's counter)
 *
 * Each is ~30 lines here against 300–600 in the reference, because the
 * reference ships every knob as a prop and this ships one calibrated value
 * from `lib/micro.ts`. A design system's whole job is to have already made
 * these choices.
 */

// ---------------------------------------------------------------------------
// Squash
// ---------------------------------------------------------------------------

/**
 * A thumb that stretches while it travels and settles back.
 *
 * KEYED ON A NONCE, NOT ON STATE, and that is the load-bearing decision. A
 * squash is a response to a GESTURE, so it must fire when the person moves the
 * control and stay silent when the value changes underneath them — a settings
 * page hydrating, a parent re-syncing, a websocket landing. Passing a boolean
 * would squash every switch on the page at mount, which is how this effect
 * usually announces itself as decoration. Callers bump a counter from their
 * own interaction handler instead, so silence is the default.
 *
 * The deformation is symmetric (0 → 1 → 0) because it decorates travel rather
 * than direction: the thumb does not need to know which way it is going, only
 * that it is moving. That also means one hook serves a two-position switch, an
 * n-position segmented control and anything else on a track.
 *
 * @param nonce  Bump to run the squash. Never runs on the first render.
 * @param axis   The direction of travel; the other axis takes the squash.
 */
export function useTravelSquash(nonce: number, axis: "x" | "y" = "x") {
  const reduce = useReducedMotion() ?? false;
  const t = useMotionValue(0);
  const mounted = React.useRef(false);

  React.useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (reduce) return;
    const controls = animate(t, [0, 1, 0], {
      duration: STRETCH_MS / 1000,
      times: [0, STRETCH_PEAK, 1],
      // Out on the way up (the spring front-loads, so the stretch has to be
      // there before the thumb is), soft on the way back.
      ease: [ease.outStrong, ease.outSoft],
    });
    return () => controls.stop();
  }, [nonce, reduce, t]);

  const grow = useTransform(t, (v) => 1 + v * STRETCH);
  const shrink = useTransform(t, (v) => 1 - v * STRETCH * SQUASH_RATIO);
  return axis === "x" ? { scaleX: grow, scaleY: shrink } : { scaleX: shrink, scaleY: grow };
}

/** A counter to feed `useTravelSquash`, bumped from an interaction handler. */
export function useGestureNonce(): [number, () => void] {
  const [n, setN] = React.useState(0);
  return [n, React.useCallback(() => setN((v) => v + 1), [])];
}

// ---------------------------------------------------------------------------
// Swell + burst
// ---------------------------------------------------------------------------

/**
 * The glyph of a control that was just switched on: dip, overshoot, settle.
 *
 * Turning something OFF gets no swell — it is a retraction, and a retraction
 * that celebrates itself is the interface disagreeing with the user. Off
 * simply returns to 1 on the same curve.
 */
export function Swell({
  on,
  children,
  className,
}: {
  on: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion() ?? false;
  return (
    <motion.span
      aria-hidden="true"
      className={cn("relative inline-flex", className)}
      animate={reduce || !on ? { scale: 1 } : { scale: [SWELL_DIP, SWELL, 1] }}
      transition={swellTransition}
    >
      {children}
    </motion.span>
  );
}

/**
 * Six particles leaving a glyph, once, when it turns on.
 *
 * `position: absolute` over the glyph's own box with `pointer-events-none`, so
 * it can be dropped into any control without changing its geometry or its hit
 * area. The radius is a multiple of the box (see BURST_RADIUS), which is what
 * lets the same component decorate a 16px thumb and a 24px heart.
 *
 * Rendered only while it runs. A permanently mounted ring of six spans with
 * opacity 0 is six nodes per control per row of a list, and a burst is by
 * definition rare.
 */
export function Burst({ on, className }: { on: boolean; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const [runId, setRunId] = React.useState(0);
  const [live, setLive] = React.useState(false);
  const wasOn = React.useRef(on);

  React.useEffect(() => {
    const turnedOn = on && !wasOn.current;
    wasOn.current = on;
    if (!turnedOn || reduce) return;
    setRunId((v) => v + 1);
    setLive(true);
    const timer = window.setTimeout(() => setLive(false), BURST_MS);
    return () => window.clearTimeout(timer);
  }, [on, reduce]);

  if (!live) return null;
  return (
    <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0", className)}>
      {BURST_ANGLES.map((deg) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <motion.span
            key={`${runId}-${deg}`}
            className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
            initial={{ opacity: 0.9, scale: 0.4, x: 0, y: 0 }}
            animate={{
              opacity: 0,
              scale: 0.2,
              // `em`-free on purpose: the parent box is square and inset-0, so
              // a percentage of its own width is the multiple of the glyph box
              // BURST_RADIUS names.
              x: `${Math.cos(rad) * BURST_RADIUS * 100}%`,
              y: `${Math.sin(rad) * BURST_RADIUS * 100}%`,
            }}
            transition={{ duration: BURST_MS / 1000, ease: ease.outExpo }}
          />
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Roll
// ---------------------------------------------------------------------------

/**
 * A number that rolls to its new value instead of cutting to it.
 *
 * WHY IT MATTERS in a product where numbers change without being touched: a
 * count that cuts is indistinguishable from a count that was always that, so a
 * message arriving, a document being written or a quota being spent all land
 * silently. The roll is the only thing on screen that says "this just became
 * different", and it costs one transform.
 *
 * Per DIGIT, not per number, so 99 → 100 rolls the two it shares and slides the
 * new column in rather than re-dealing the whole figure. Digits roll UP when
 * the value grew and DOWN when it shrank, which is the difference between "one
 * more" and "one fewer" without a label.
 *
 * `tabular-nums` is not optional: proportional digits change width as they
 * roll, so the row reflows under the animation it is trying to show.
 */
export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const prev = React.useRef(value);
  const up = value >= prev.current;
  React.useEffect(() => {
    prev.current = value;
  }, [value]);

  const digits = String(value).split("");
  if (reduce) return <span className={cn("tabular-nums", className)}>{value}</span>;

  return (
    <span className={cn("inline-flex tabular-nums", className)}>
      <span className="sr-only">{value}</span>
      {digits.map((d, i) => (
        <span
          aria-hidden="true"
          // Keyed by COLUMN, counted from the right, so the ones column stays
          // the ones column when the number gains a digit. Keyed from the left
          // it would re-mount every digit on 9 → 10 and roll all of them.
          key={`${digits.length - i}`}
          className="relative inline-block h-[1em] overflow-hidden"
          style={{ width: "0.62em" }}
        >
          <motion.span
            key={d}
            className="absolute inset-0 flex items-center justify-center"
            initial={{ y: up ? "100%" : "-100%" }}
            animate={{ y: "0%" }}
            transition={{ duration: ROLL_MS / 1000, ease: ease.outExpo }}
          >
            {d}
          </motion.span>
        </span>
      ))}
    </span>
  );
}
