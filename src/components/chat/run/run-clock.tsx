"use client";

import * as React from "react";

/*
 * The elapsed-time leaf (SPEC §7.5, §7.11): the only thing that re-renders
 * once a second, paused while offscreen. Narrow under a minute ("12s"),
 * digital from a minute ("1:04"). Chat counts from the run's start; a Research
 * row counts its DTO's `workingMs` forward from when it was fetched and holds
 * still at gates and while paused.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it.
 */

export interface RunClockProps {
  /** Worked time already counted, in ms, as of `since`. */
  elapsedMs: number;
  /** Epoch ms from which the clock keeps counting; null holds it at `elapsedMs`. */
  since: number | null;
  /** Hidden until the shown time reaches this: 3 s for chat (RUN_PACING.timerAfterMs), 0 for Research. */
  showAfterMs?: number;
  className?: string;
}

export function RunClock({ className }: RunClockProps) {
  return <span data-stub="run-clock" className={className} aria-hidden="true" />;
}
