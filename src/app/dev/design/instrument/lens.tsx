"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * THE LENS: Instrument's signature, and Juno's own "face".
 *
 * A dark window cut into the body with one lit needle in it. The window is
 * always ink (in light theme it is the darkest thing on the page, in dark it
 * reads as a hole in the graphite), so the signal can always be light. The
 * needle rests at 45°, upper right, where the old mark kept its ball.
 *
 * States (the needle is the only moving part; transform only):
 *   rest       still, at 45°
 *   thinking   weighing: swings wide and narrows in, a 3.2s phrase, repeated
 *              only while Juno is actually thinking
 *   working    ticking: a crisp 30° step every 600ms with a 3° overshoot, the
 *              way a stepper hand moves; one turn is 7.2s
 *   listening  / speaking   follows the voice level (`level`, 0..1)
 *   settle     a one-shot return to rest with one overshoot, when work ends
 * Reduced motion: each state holds one distinct pose (thinking points to 10
 * o'clock, working to 3 o'clock) and the words beside it say the state.
 */

export type LensState = "rest" | "thinking" | "working" | "listening" | "speaking" | "settle";

export function Lens({
  state = "rest",
  size = 20,
  level = 0,
  label,
  className,
}: {
  state?: LensState;
  size?: number;
  /** Voice level 0..1 for listening / speaking. */
  level?: number;
  /** Accessible name; omit when the words beside the lens say the state. */
  label?: string;
  className?: string;
}) {
  const detailed = size >= 28;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={cn("in-lens", className)}
      style={{ width: size, height: size, "--level": level } as React.CSSProperties}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
        <circle className="in-lens__body" cx={12} cy={12} r={12} />
        <circle className="in-lens__ring" cx={12} cy={12} r={11.5} fill="none" strokeWidth={1} />
        {detailed ? (
          <g className="in-lens__ticks">
            {Array.from({ length: 12 }, (_, i) => {
              const a = (i * 30 * Math.PI) / 180;
              const r1 = i % 3 === 0 ? 8.6 : 9.3;
              const q = (n: number) => Math.round(n * 1000) / 1000;
              return (
                <line
                  key={i}
                  x1={q(12 + Math.sin(a) * r1)}
                  y1={q(12 - Math.cos(a) * r1)}
                  x2={q(12 + Math.sin(a) * 10.2)}
                  y2={q(12 - Math.cos(a) * 10.2)}
                  strokeWidth={0.7}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        ) : null}
        <g className="in-lens__needle">
          <line className="in-lens__tail" x1={12} y1={12} x2={12} y2={15} strokeWidth={detailed ? 1.5 : 1.9} strokeLinecap="round" />
          <line x1={12} y1={12} x2={12} y2={detailed ? 3.6 : 4.2} strokeWidth={detailed ? 1.5 : 1.9} strokeLinecap="round" />
          <circle cx={12} cy={12} r={detailed ? 1.6 : 1.35} />
        </g>
      </svg>
    </span>
  );
}

/**
 * The key: the lens and the send button are ONE object. Empty, it is the lens
 * (talk to Juno). With a draft it ARMS: the needle swings to twelve and becomes
 * the arrow, the pivot drops away, and the window lights (signal in dark; in
 * light the arrow is the light). 260ms, one small overshoot on the swing.
 * Reduced motion: an instant swap.
 */
export function Key({ armed, size = 32 }: { armed: boolean; size?: number }) {
  return (
    <span className="in-keylens" data-armed={armed ? "" : undefined} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} focusable="false">
        <circle className="in-keylens__body" cx={12} cy={12} r={12} />
        <circle className="in-keylens__ring" cx={12} cy={12} r={11.5} fill="none" strokeWidth={1} />
        <g className="in-keylens__needle">
          <line className="in-keylens__tail" x1={12} y1={12} x2={12} y2={14.6} strokeWidth={1.9} strokeLinecap="round" />
          <line className="in-keylens__hand" x1={12} y1={12} x2={12} y2={4.4} strokeWidth={1.9} strokeLinecap="round" />
          <circle className="in-keylens__hub" cx={12} cy={12} r={1.4} />
          <path className="in-keylens__head" d="M7.9 8.5 L12 4.4 L16.1 8.5" fill="none" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
        </g>
      </svg>
    </span>
  );
}

/** Juno at work, inline: the lens, then the words that say what it is doing. */
export function PresenceLine({
  state = "thinking",
  children,
  className,
}: {
  state?: LensState;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("in-presence-line", className)} role="status">
      <Lens state={state} size={16} />
      <span>{children}</span>
    </p>
  );
}

/** The wordmark: the lens and the name, set in the interface face. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <Lens size={20} />
      <span translate="no" className="in-wordmark">
        Juno
      </span>
    </span>
  );
}
