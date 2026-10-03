"use client";

import * as React from "react";
import { motion, useReducedMotion, useSpring, useTransform, type MotionValue } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * The incognito mark: a hat over round glasses (Lucide "hat-glasses", ISC),
 * the symbol browsers use for private windows, drawn in the house line. It
 * replaces the cartoon ghost face the owner said looked wrong.
 *
 * Drawn in three parts so it can look at the pointer (`useIncognitoLook`):
 * the hat, the glasses (two lenses and the bridge), and two pupils that only
 * exist while the pointer is near. At rest it is the plain mark — no eyes —
 * and the pupils grow in as the pointer approaches, so the drawing stays the
 * symbol everywhere it is still (the incognito header, the native set) and
 * comes alive only when someone reaches for it.
 */
export function IncognitoGlyph({
  className,
  strokeWidth = 1.6,
  look,
}: {
  className?: string;
  strokeWidth?: number;
  /** Pointer-follow springs from `useIncognitoLook`; omit for the still mark. */
  look?: IncognitoLook;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // `overflow-visible`: the glasses travel up to 0.6 units, and the
      // lenses already touch the viewBox's bottom edge.
      className={cn("shrink-0 overflow-visible", className)}
    >
      {look ? <LookingGlyph look={look} /> : <StillGlyph />}
    </svg>
  );
}

const HAT = (
  <>
    <path d="m19 11-2.11-6.657a2 2 0 0 0-2.752-1.148l-1.276.61A2 2 0 0 1 12 4H8.5a2 2 0 0 0-1.925 1.456L5 11" />
    <path d="M2 11h20" />
  </>
);
const GLASSES = (
  <>
    <path d="M14 18a2 2 0 0 0-4 0" />
    <circle cx="17" cy="18" r="3" />
    <circle cx="7" cy="18" r="3" />
  </>
);

function StillGlyph() {
  return (
    <>
      {GLASSES}
      {HAT}
    </>
  );
}

/*
 * Travel, in viewBox units (24 across; 20px on screen, so one unit is ~0.8px).
 * Three depths, so the head turns rather than slides: the hat barely moves,
 * the glasses a little more, and the pupils most — inside the lens, never
 * touching its rim (lens r 3 less half the stroke is 2.25 inside; a 1.3 pupil
 * at 0.85 reaches 2.15).
 */
const HAT_TRAVEL = 0.3;
const GLASSES_TRAVEL = 0.6;
const PUPIL_TRAVEL = 0.85;

function LookingGlyph({ look }: { look: IncognitoLook }) {
  const hatX = useTransform(look.x, (v) => v * HAT_TRAVEL);
  const hatY = useTransform(look.y, (v) => v * HAT_TRAVEL * 0.5);
  const glassesX = useTransform(look.x, (v) => v * GLASSES_TRAVEL);
  const glassesY = useTransform(look.y, (v) => v * GLASSES_TRAVEL * 0.6);
  const pupilX = useTransform(look.x, (v) => v * PUPIL_TRAVEL);
  const pupilY = useTransform(look.y, (v) => v * PUPIL_TRAVEL);
  const pupilScale = useTransform(look.near, [0, 1], [0.2, 1]);
  return (
    <>
      <motion.g style={{ x: glassesX, y: glassesY }}>
        {GLASSES}
        <motion.g style={{ x: pupilX, y: pupilY, opacity: look.near }}>
          <motion.circle
            cx="7"
            cy="18"
            r="1.3"
            fill="currentColor"
            stroke="none"
            style={{ scale: pupilScale, transformBox: "fill-box", transformOrigin: "center" }}
          />
          <motion.circle
            cx="17"
            cy="18"
            r="1.3"
            fill="currentColor"
            stroke="none"
            style={{ scale: pupilScale, transformBox: "fill-box", transformOrigin: "center" }}
          />
        </motion.g>
      </motion.g>
      <motion.g style={{ x: hatX, y: hatY }}>{HAT}</motion.g>
    </>
  );
}

export type IncognitoLook = {
  /** Where the mark looks, −1…1 on each axis (0 = straight ahead). */
  x: MotionValue<number>;
  y: MotionValue<number>;
  /** 0 far away … 1 within reach: the pupils' presence. */
  near: MotionValue<number>;
};

/** How far the mark notices the pointer, in CSS px from its centre. */
const LOOK_RADIUS = 120;
/** Inside this distance the gaze is already at full turn, so it stays steady over the button. */
const FULL_TURN_AT = 36;
/*
 * Soft and slightly lagging: eyes that follow rather than snap. Critically
 * damped enough not to wobble at the end of a turn — the mark is in the
 * header chrome, and a bouncing eye would read as a notification.
 */
const LOOK_SPRING = { stiffness: 260, damping: 26, mass: 0.6 };
const NEAR_SPRING = { stiffness: 220, damping: 30 };

/**
 * Pointer-follow for the incognito mark. Watches the pointer anywhere on the
 * page (one passive listener, read once a frame), and while it is within
 * LOOK_RADIUS of `anchor`'s centre turns the glasses toward it; outside, they
 * settle back to straight ahead and the pupils fade out.
 *
 * Off — the mark stays still — for reduced motion, for a coarse pointer (there
 * is no hover to follow on a touch screen), and while `enabled` is false.
 */
export function useIncognitoLook(anchor: React.RefObject<HTMLElement | null>, enabled = true): IncognitoLook {
  const reduceMotion = useReducedMotion() ?? false;
  const x = useSpring(0, LOOK_SPRING);
  const y = useSpring(0, LOOK_SPRING);
  const near = useSpring(0, NEAR_SPRING);

  React.useEffect(() => {
    const rest = () => {
      x.set(0);
      y.set(0);
      near.set(0);
    };
    if (!enabled || reduceMotion) {
      rest();
      return;
    }
    if (typeof window === "undefined" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    let frame = 0;
    let px = 0;
    let py = 0;
    const update = () => {
      frame = 0;
      const el = anchor.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2);
      const dy = py - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      if (dist > LOOK_RADIUS || r.width === 0) {
        rest();
        return;
      }
      // Direction at a strength that ramps up over the first FULL_TURN_AT px,
      // so a pointer resting on the button does not make the eyes dart.
      const turn = Math.min(dist / FULL_TURN_AT, 1);
      x.set(dist === 0 ? 0 : (dx / dist) * turn);
      y.set(dist === 0 ? 0 : (dy / dist) * turn);
      // Full presence for the inner two thirds, fading over the outer third.
      near.set(Math.min(1, (LOOK_RADIUS - dist) / (LOOK_RADIUS / 3)));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      px = e.clientX;
      py = e.clientY;
      if (!frame) frame = requestAnimationFrame(update);
    };
    const onLeave = () => rest();
    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    window.addEventListener("blur", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("blur", onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchor, enabled, reduceMotion, x, y, near]);

  return { x, y, near };
}
