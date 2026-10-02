"use client";

import * as React from "react";

import { formatElapsed, useUiLocale } from "@/lib/i18n-format";
import { useOffscreen } from "@/lib/run/loop-phase";
import { cn } from "@/lib/utils";

/*
 * The elapsed-time leaf (SPEC §7.5, §7.11): the only thing that re-renders
 * once a second, paused while offscreen. Narrow under a minute ("12s"),
 * digital from a minute ("1:04"). Chat counts from the run's start; a Research
 * row counts its DTO's `workingMs` forward from when it was fetched and holds
 * still at gates and while paused.
 *
 * It holds rather than guesses: `since: null` is a clock that is not running
 * (a gate, a pause, the answer has begun), and a `since` in the future — a
 * client clock behind the server's — counts as zero, never as negative time.
 * The figure is `aria-hidden`: a number announced every second would bury the
 * line's accessible name, which already says what the run is doing.
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

/**
 * What the clock reads at `now`: the time already worked, plus the running
 * stretch when there is one. Never negative, never NaN.
 */
export function clockElapsedMs(elapsedMs: number, since: number | null, now: number): number {
  const base = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (since === null || !Number.isFinite(since) || !Number.isFinite(now)) return base;
  return base + Math.max(0, now - since);
}

export function RunClock({ elapsedMs, since, showAfterMs = 0, className }: RunClockProps) {
  const locale = useUiLocale();
  const ref = React.useRef<HTMLSpanElement | null>(null);
  // `null` until the first tick, which happens in an effect: a clock read during
  // render would make the server's HTML and the first client pass disagree.
  const [now, setNow] = React.useState<number | null>(null);
  const [offscreen, setOffscreen] = React.useState(false);
  useOffscreen(ref, setOffscreen);

  React.useEffect(() => {
    if (since === null) {
      setNow(null);
      return;
    }
    if (offscreen) return;
    const tick = () => setNow(Date.now());
    tick();
    // Aligned to the clock's own whole seconds, so "4s" never shows for 1.9 s.
    const start = clockElapsedMs(elapsedMs, since, Date.now());
    let interval: ReturnType<typeof setInterval> | null = null;
    const align = setTimeout(() => {
      tick();
      interval = setInterval(tick, 1_000);
    }, 1_000 - (start % 1_000));
    return () => {
      clearTimeout(align);
      if (interval !== null) clearInterval(interval);
    };
  }, [elapsedMs, since, offscreen]);

  const ms = clockElapsedMs(elapsedMs, since, now ?? since ?? 0);
  const shown = ms >= showAfterMs;
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-no-auto-translate
      // Hidden, not unmounted: the slot keeps its 5ch so a label change never moves the clock.
      className={cn("run-clock shrink-0 text-caption text-muted-foreground", !shown && "invisible", className)}
    >
      {formatElapsed(ms, locale)}
    </span>
  );
}
