"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Continuous disclosure (spec C10, docs/design/ICONS_AND_MOTION.md §2.2 rule 6).
 *
 * A section that opens under its header should UNFOLD, not appear. The
 * conditional that decides whether it is open stays where it was at the call
 * site (`<Collapse open={expanded}>` in place of `{expanded && …}`); the
 * content rides `grid-template-rows` 0fr → 1fr:
 *
 *   open    rows over 220 on in-out, opacity over 120 on out-soft
 *   close   rows and opacity over 160 on the accelerate
 *
 * MOUNTED AND INERT. The content mounts the first time the section opens and
 * then stays mounted while closed, `inert` (out of the tab order and the
 * accessibility tree) and folded to 0fr, so a close plays the same fold in
 * reverse instead of emptying first, and a reopen keeps scroll positions and
 * state. A section that has never opened costs nothing.
 *
 * Grid rows rather than `height`: the track resolves to the content's own
 * height at 1fr, so there is no measuring and no layout thrash (D27 names
 * grid-template-rows as an animatable property).
 *
 * Padding and borders never go on the grid item: a 0fr track keeps the item's
 * padding and border as its floor. The clipped item stays bare (`min-h-0
 * overflow-hidden`) and `innerClassName` lands on a box inside it.
 *
 * Reduced motion (sheet.css `.ui-collapse`): the rows snap and the fade keeps
 * its timing (Tier B keeps opacity, drops travel).
 */
export function Collapse({
  open,
  children,
  className,
  innerClassName,
}: {
  open: boolean;
  children: React.ReactNode;
  /**
   * The grid container whose row unfolds — width, placement. Its own margin,
   * padding and border do NOT fold (they are there at 0fr); put spacing in
   * `innerClassName` instead.
   */
  className?: string;
  /** The content box inside the clip — padding and borders go HERE, so they fold too. */
  innerClassName?: string;
}) {
  const [mounted, setMounted] = React.useState(open);
  // Open on its first render (a page load): it is simply there, no unfold.
  const [appearOpen] = React.useState(open);
  if (open && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <div
      className={cn("ui-collapse grid", className)}
      data-state={open ? "open" : "closed"}
      data-appear={appearOpen ? "none" : undefined}
      inert={!open}
      aria-hidden={open ? undefined : true}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={innerClassName}>{children}</div>
      </div>
    </div>
  );
}

/**
 * The disclosure chevron: turns a quarter over 120 on out-soft (C10). Pass
 * the glyph as the child; the turn lives on this wrapper so the glyph's own
 * hover articulation still composes. Focus rings never animate.
 */
export function CollapseChevron({ open, children, className }: { open: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("ui-collapse-chevron inline-flex", className)} data-state={open ? "open" : "closed"} aria-hidden="true">
      {children}
    </span>
  );
}
