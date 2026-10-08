"use client";

import * as React from "react";
import { GalaxyMark, type ThinkingPhase } from "@/components/brand/galaxy-mark";
import { TIMING } from "@/lib/interaction";
import { cn } from "@/lib/utils";

/*
 * THE LIVE LINE (INTERACTION_SPEC M1, MOTION_AND_THINKING.md).
 *
 * Every row in the transcript that says work is happening right now is drawn
 * by this component and nothing else: the reply waiting for its first word,
 * the run strip above an answer, a tool receipt that is running, the task
 * card's current step, a research run, an image being made, Python running.
 * One drawing means one behaviour, and one place where the rules hold:
 *
 *   - The galaxy mark (GalaxyMark, GALAXY_SPEC.md) leads the words: a small
 *     spiral of dots that turns, inner stars faster, for as long as the work
 *     is real, and slows to a stop when it is not. No orb, no shimmer, no
 *     spinner, no caret.
 *   - The words are the truthful phase ("Thinking", "Searching the web",
 *     "Reading Q3 Forecast.xlsx", "Waiting for your answer"), in the second
 *     ink. Never the presence blue: blue words read as a link.
 *   - A phase holds at least `phaseMinHold` (1 s) on screen, so a burst of
 *     steps never flickers; only the newest waiting phase is kept.
 *   - Real elapsed seconds join after `elapsedAfter` (3 s), in the third ink,
 *     tabular. A number changing once a second is information, not motion.
 *   - Nothing shows for the first `showDelay` (200 ms), so a quick answer
 *     never flashes a status. The box is kept, so nothing below it moves.
 *   - Waiting on the person is a static mark and the words in the attention
 *     ink; an error is a static mark and the words in the first ink.
 *
 * The live region is the words alone. The clock ticks beside it, hidden from
 * assistive technology, so a screen reader hears each phase once and never a
 * count of seconds.
 */

export type LiveLinePhase = Extract<ThinkingPhase, "thinking" | "working" | "waiting" | "error">;

/**
 * The text on screen, held at least `hold` ms per phase. A newer phase that
 * arrives sooner waits for the remainder; a burst keeps only the latest.
 */
export function useHeldPhase(text: string, hold: number = TIMING.phaseMinHold): string {
  const [shown, setShown] = React.useState(text);
  const since = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (since.current === null) since.current = performance.now();
  }, []);
  React.useEffect(() => {
    if (text === shown) return;
    const started = since.current ?? performance.now();
    const wait = Math.max(0, started + hold - performance.now());
    const timer = window.setTimeout(() => {
      since.current = performance.now();
      setShown(text);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [text, shown, hold]);
  return shown;
}

/**
 * Whole seconds since `since` (an ISO time or epoch ms) or since mount,
 * ticking once a second while `running`. Read in effects, never in render,
 * so a server-rendered line and the first client render agree (0).
 */
export function useLiveSeconds(running: boolean, since?: string | number | null): number {
  const [seconds, setSeconds] = React.useState(0);
  const sinceMs = typeof since === "string" ? Date.parse(since) : typeof since === "number" ? since : NaN;
  React.useEffect(() => {
    if (!running) return;
    const start = Number.isFinite(sinceMs) ? sinceMs : Date.now();
    const tick = () => setSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running, sinceMs]);
  return seconds;
}

/** "4s", "1m 12s". */
export function formatLiveSeconds(total: number): string {
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${total % 60}s`;
}

/** Whether the line has waited out `showDelay`. */
function useShown(delay: number): boolean {
  const [shown, setShown] = React.useState(delay <= 0);
  React.useEffect(() => {
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  return shown;
}

export interface LiveLineProps {
  /** The truthful phase, in words. */
  text: string;
  /** A count inside the phase ("41 of 128 tests"): it updates in place, with no fade and no new pass. */
  detail?: string | null;
  phase?: LiveLinePhase;
  /** Real elapsed seconds. Shown from 3 s. Omit for a line with no clock. */
  seconds?: number | null;
  /**
   * What leads the words instead of the mark: an agent's face, when an agent
   * (not Alevr) is the one doing the work (M1).
   */
  lead?: React.ReactNode;
  /** A real step changed without the words changing (a new tool call of the same kind). */
  eventKey?: string | number;
  /** Mark size: 20 beside reading text (the default), 16 inside a dense row. */
  size?: 16 | 20;
  /** Show at once instead of after `showDelay` (the row already waited, or it is a status that needs the person). */
  immediate?: boolean;
  /** Off for a line inside a region that already announces (a receipt row, a labelled card). */
  announce?: boolean;
  className?: string;
}

export function LiveLine({
  text,
  detail,
  phase = "thinking",
  seconds,
  lead,
  eventKey,
  size = 20,
  immediate,
  announce = true,
  className,
}: LiveLineProps) {
  const pending = phase === "thinking" || phase === "working";
  const held = useHeldPhase(text);
  // A status that needs the person is never delayed: it is the news.
  const shown = useShown(immediate || !pending ? 0 : TIMING.showDelay);
  const showClock = seconds != null && seconds * 1000 >= TIMING.elapsedAfter;
  return (
    <div
      className={cn(
        "live-line flex min-w-0 items-center gap-2 text-nav",
        size === 20 ? "min-h-6" : "min-h-5 gap-1.5",
        // The second ink (`foreground` at 75% is the V3 ink-2 on both grounds).
        "text-foreground/75 transition-opacity duration-fast ease-out-soft",
        shown ? "opacity-100" : "opacity-0",
        className,
      )}
      data-phase={phase}
    >
      {lead ? (
        <span className="inline-flex shrink-0" aria-hidden="true">
          {lead}
        </span>
      ) : (
        <span className={cn("inline-grid shrink-0 place-items-center", size === 20 ? "size-5" : "size-4")}>
          <GalaxyMark phase={phase} size={size} eventKey={eventKey === undefined ? held : `${held}\u0000${eventKey}`} />
        </span>
      )}
      {/* The region stays mounted and only its child is keyed: a region
          inserted at the same moment as its text is often not announced. */}
      <span className="min-w-0 truncate" {...(announce ? { role: "status", "aria-live": "polite" as const } : {})}>
        <span
          key={held}
          className={cn(
            "duration-fast motion-safe:animate-fade-in",
            phase === "waiting" && "font-medium text-[hsl(var(--attention))] dark:font-normal",
            phase === "error" && "text-foreground",
          )}
        >
          {held}
        </span>
        {detail ? <span className="tabular-nums">, {detail}</span> : null}
      </span>
      {showClock ? (
        <span aria-hidden="true" className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">
          <span className="mr-2 opacity-60">·</span>
          {formatLiveSeconds(seconds ?? 0)}
        </span>
      ) : null}
    </div>
  );
}
