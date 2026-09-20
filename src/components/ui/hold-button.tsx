"use client";

import * as React from "react";
import { animate, motion, useMotionValue } from "framer-motion";
import { HOLD_MS, HOLD_RELEASE_MS, TAP_MS } from "@/lib/micro";
import { cn } from "@/lib/utils";

/**
 * Hold to confirm — a destructive action that costs a second of intent instead
 * of a modal.
 *
 * WHAT IT REPLACES, and when it does NOT. A confirmation dialog is the right
 * shape for a decision with CONSEQUENCES THE USER CANNOT SEE: deleting an
 * account, revoking every session, anything where the sentence in the dialog
 * is carrying information ("this also deletes 14 projects"). It is the wrong
 * shape for a decision the user can already see the whole of — deleting the
 * chat whose title is under their cursor — where the dialog adds a full
 * interrupt, a focus trap and a second click to protect against a slip that
 * 900ms of held pointer protects against just as well.
 *
 * So this is not a general replacement for `<Dialog>`; it is the control for
 * the case where the modal was only ever a speed bump. Where a dialog carries
 * a fact, the dialog stays.
 *
 * THE FILL IS A RECEIPT, NOT A SHOW. It travels under the label rather than
 * around it, so the word the person is reading never moves, and it unwinds on
 * `exit` when they let go — the accelerate curve, because a released hold is a
 * decision already made (motion.ts, `transition.exit`).
 *
 * A PLAIN CLICK IS ANSWERED. Someone who does not know this is a hold control
 * will click it, and a button that does nothing reads as broken. A press
 * shorter than `TAP_MS` calls `onTap`, whose default is to flash the hint text
 * — the control explains itself at exactly the moment the person needs it,
 * which is the alternative to a permanent "(hold)" suffix in the label.
 *
 * REDUCED MOTION DOES NOT TOUCH IT, which is the one exception in this pass.
 * Everything else here is decoration on a state change that already happened;
 * this bar is a determinate progress indicator, and the thing it indicates is
 * how long the person still has to hold. Freezing it would leave them holding
 * a button with no way to know when it fires — less motion, more anxiety. The
 * hold is a safety mechanism either way and is never shortened.
 */
export function HoldButton({
  onHold,
  onTap,
  label,
  holdingLabel,
  hint = "Keep holding",
  disabled,
  className,
  children,
}: {
  onHold: () => void;
  onTap?: () => void;
  /** Accessible name. The visible text is `children`. */
  label?: string;
  /** Swapped in while the press is live, if the verb changes ("Deleting…"). */
  holdingLabel?: React.ReactNode;
  /** Shown after a too-short press: what the control wants instead. */
  hint?: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const progress = useMotionValue(0);
  const [holding, setHolding] = React.useState(false);
  const [nudged, setNudged] = React.useState(false);
  const pressedAt = React.useRef(0);
  const done = React.useRef(false);
  const nudgeTimer = React.useRef<number | undefined>(undefined);

  React.useEffect(() => () => window.clearTimeout(nudgeTimer.current), []);

  const start = React.useCallback(() => {
    if (disabled || holding) return;
    done.current = false;
    pressedAt.current = Date.now();
    setHolding(true);
    setNudged(false);
    animate(progress, 1, {
      duration: HOLD_MS / 1000,
      // LINEAR, and this is the one place in the product where that is
      // correct: the bar is a clock. Any easing would make the remaining time
      // a lie in one direction or the other, and a person deciding whether to
      // let go is reading it as one.
      ease: "linear",
      onComplete: () => {
        if (done.current) return;
        done.current = true;
        setHolding(false);
        progress.set(0);
        onHold();
      },
    });
  }, [disabled, holding, onHold, progress]);

  const end = React.useCallback(() => {
    if (!holding || done.current) return;
    setHolding(false);
    const short = Date.now() - pressedAt.current < TAP_MS;
    animate(progress, 0, { duration: HOLD_RELEASE_MS / 1000, ease: "easeIn" });
    if (!short) return;
    if (onTap) {
      onTap();
      return;
    }
    setNudged(true);
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => setNudged(false), 1600);
  }, [holding, onTap, progress]);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      onPointerDown={(e) => {
        // Primary button only, and capture so a pointer that leaves the box
        // still delivers its `up` here — otherwise walking off the control
        // leaves the fill running with nothing to stop it.
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start();
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        // `repeat` fires while a key is held; the first one starts the clock
        // and the rest are the hold itself.
        if (e.repeat) return;
        e.preventDefault();
        start();
      }}
      onKeyUp={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        end();
      }}
      onBlur={end}
      className={cn(
        "pressable relative isolate flex h-9 w-full items-center justify-center gap-2 overflow-hidden rounded-control border border-destructive/30 bg-destructive/5 px-3 text-ui font-medium text-destructive transition-[background-color,border-color] duration-fast ease-out-soft hover:border-destructive/50 hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none",
        className
      )}
    >
      {/* The fill. `origin-left` + scaleX rather than a width, so it runs on
          the compositor and never reflows the label above it. */}
      <motion.span
        aria-hidden="true"
        className="absolute inset-0 -z-10 origin-left bg-destructive/20"
        style={{ scaleX: progress }}
      />
      <span className="relative truncate">
        {nudged ? hint : holding && holdingLabel ? holdingLabel : children}
      </span>
      {/* The clock, read aloud. A sighted user sees the bar; a screen-reader
          user gets the one fact the bar carries. `reduce` is irrelevant here —
          politeness, not motion. */}
      <span className="sr-only" aria-live="polite">
        {holding ? "Keep holding to confirm" : ""}
      </span>
    </button>
  );
}
