"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AIcss "Image Generation" — the canvas.
 *
 * The one component in the set that arrived already speaking Juno: a field of
 * points with a soft mass moving through it. The dot matrix is this app's mark
 * (see `signature/dot-matrix.tsx`), so adopting this replaced three blurred
 * orbs, a soft-light sheen sweep and a breathing radial pulse — five stacked
 * gradient layers doing "something is being made" by brute force — with the
 * shape the brand already uses to say exactly that.
 *
 * Two masked ellipses are cut out of a denser point field; they walk the four
 * corners on a 4.2s overshoot curve while breathing on an unrelated 1.9s one, so
 * the motion never lands on a beat the eye can anticipate. Everything else about
 * the block — the frame, the footer, the progress bar — stays Juno's.
 *
 * `pitch` opens the lattice up for a larger canvas. AIcss's 11px is tuned
 * against the morph mask sizes, so it is the default and moving it is a
 * deliberate act.
 */
export function ImageGenerationCanvas({
  resolution,
  pitch,
  className,
}: {
  /** Shown as a badge, in the metadata voice, when the request fixed a size. */
  resolution?: string | null;
  pitch?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("aicss-ig", className)}
      style={pitch ? ({ ["--aicss-ig-pitch" as string]: `${pitch}px` } as React.CSSProperties) : undefined}
    >
      <span className="aicss-ig-dots" />
      <span className="aicss-ig-glow" />
      {resolution && <span className="aicss-ig-res">{resolution}</span>}
    </div>
  );
}
