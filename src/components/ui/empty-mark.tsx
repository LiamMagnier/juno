"use client";

import * as React from "react";
import { DotRings } from "@/components/home/dot-construction";
import type { ArcSpec, LineSpec, RingSpec } from "@/components/home/dot-scenes";
import { cn } from "@/lib/utils";

/**
 * The empty state's mark: the construction in miniature, drawn in the shared
 * dot matrix (dot-construction.tsx). Three orbits at the 1.5 ratio on the
 * number line, and the presence trajectory a quarter of the way round the
 * middle one, the one blue thing in the state. It stands where a glyph in a
 * tile used to: the brand's own drawing says "nothing here yet" without
 * borrowing an icon for the thing that is missing.
 *
 * It draws on once (ring by ring, the way the homepage's construction does)
 * and stops asking for frames; reduced motion draws the final frame. It is
 * decorative and hidden from assistive technology.
 */
const RINGS: RingSpec[] = [
  { rx: 0.44 / 1.5 / 1.5, ry: 0.42 / 1.5 / 1.5 },
  { rx: 0.44 / 1.5, ry: 0.42 / 1.5 },
  { rx: 0.44, ry: 0.42, faint: true },
];
const LINES: LineSpec[] = [{ x1: 0.02, y1: 0.5, x2: 0.98, y2: 0.5, strength: 0.14 }];
const ARCS: ArcSpec[] = [{ ring: 1, from: -75, to: 25 }];

export function EmptyMark({ size = "page", className }: { size?: "page" | "panel"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("empty-mark relative block shrink-0", size === "page" ? "h-[76px] w-[208px]" : "h-12 w-32", className)}
    >
      <DotRings rings={RINGS} lines={LINES} arcs={ARCS} start={180} delay={0.1} stagger={0.1} draw={1.2} className="empty-mark-dots" />
    </span>
  );
}
