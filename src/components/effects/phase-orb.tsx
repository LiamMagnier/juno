"use client";

import * as React from "react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";

import { ThinkingDots } from "@/components/signature/thinking-dots";
import { useEffectTheme, useHeldFor } from "@/components/effects/use-effect-theme";
import { cn } from "@/lib/utils";

export type { OrbState };

/**
 * The live mark beside "Thinking", "Searching for ...", "Writing" in the
 * transcript (Libraries.dev Thinking orbs, premium brief).
 *
 * The orb's state names the real phase of the run, passed in by the caller
 * from the phase it already computes for its sentence: a scan meridian while
 * the run searches, an undulating sash while it writes, a slow ring while it
 * reasons, orbiting particles while a tool runs. The sentence says WHAT; the
 * orb says the same thing in motion, so the two can never disagree.
 *
 * UNDER TWO SECONDS IT IS THE JUNO MATRIX, NOT AN ORB. The placement rule is
 * "no orb for waits under 2 s": a 400 ms flash of a globe reads as a glitch,
 * and most short replies start writing inside that window. The brand's 3x3
 * matrix holds the slot until then, and the orb fades in only once the wait
 * is real. The slot is 20px either way, so nothing on the line moves.
 *
 * Decorative: the caller's sentence is the status text (and its own live
 * region), so the canvas is `aria-hidden`. Reduced motion: the package draws
 * one still frame. Ink follows the app theme, pinned, so an orb in a light
 * transcript under a dark OS draws dark dots.
 */
export function PhaseOrb({ state, className }: { state: OrbState; className?: string }) {
  const theme = useEffectTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const longWait = useHeldFor(mounted, 2000);

  return (
    <span aria-hidden="true" className={cn("relative grid size-5 shrink-0 place-items-center", className)}>
      {longWait && theme ? (
        <ThinkingOrb
          state={state}
          size={20}
          theme={theme}
          aria-hidden="true"
          className="duration-base motion-safe:animate-fade-in"
        />
      ) : (
        <ThinkingDots className="text-muted-foreground" />
      )}
    </span>
  );
}
