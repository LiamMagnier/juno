"use client";

import * as React from "react";

import { useOffscreen, usePhaseLock } from "@/lib/run/loop-phase";
import { useLoopOwner } from "@/lib/run/store";
import { cn } from "@/lib/utils";

/*
 * The compositor-only shimmer on the live label (SPEC §7.9): the text in
 * muted ink, and over it a masked window holding the same text in full ink
 * that slides across on the page's one loop. Only `transform` moves, so it
 * never repaints the text. It runs only while the label is live, not calm,
 * and its glyph owns the loop; otherwise the window is hidden and the label
 * reads as plain muted text.
 */

export interface RunSweepProps {
  children: React.ReactNode;
  /** false: the label settled into the summary; the shimmer stops in place. */
  live: boolean;
  calm?: boolean;
  /** The loop id of the glyph beside it. */
  loopId: string;
  className?: string;
}

const PERIOD_MS = 2_400;

export function RunSweep({ children, live, calm = false, loopId, className }: RunSweepProps) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const owns = useLoopOwner(loopId);
  useOffscreen(ref);
  usePhaseLock(ref, PERIOD_MS);
  return (
    <span
      ref={ref}
      className={cn("run-sweep", className)}
      data-settled={live ? undefined : "true"}
      data-calm={calm ? "" : undefined}
      data-loop={owns && live ? undefined : "off"}
    >
      <span className="run-sweep__text">{children}</span>
      {live ? (
        <span className="run-sweep__window" aria-hidden="true">
          <span className="run-sweep__text run-sweep__text--hi">{children}</span>
        </span>
      ) : null}
    </span>
  );
}
