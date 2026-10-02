"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A status label: the words of a phase, set still.
 *
 * This was AIcss's shimmering label, a valley of alpha swept through the word.
 * Alevr retired every shimmer (INTERACTION_SPEC M1, MOTION_AND_THINKING.md):
 * a live row is the Continuum mark beside truthful words (live-line.tsx), and
 * the words themselves never move. The component is kept so its callers keep
 * their box, tone and `settled` contract; both states are now the same still
 * text, in the tone the label asked for.
 */
export function ThinkingState({
  children = "Thinking",
  settled,
  tone = "muted",
  className,
  ...rest
}: React.ComponentPropsWithoutRef<"span"> & {
  /** Kept for callers: the label no longer moves in either state. */
  settled?: boolean;
  /** Which token the text rests at. `strong` for a label that leads a block. */
  tone?: "muted" | "strong";
}) {
  return (
    <span
      {...rest}
      data-settled={settled ? "true" : "false"}
      className={cn("aicss-thinking", tone === "strong" ? "text-foreground" : "text-muted-foreground", className)}
    >
      {children}
    </span>
  );
}
