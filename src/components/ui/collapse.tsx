"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";

import { duration, ease, transition } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Continuous disclosure — docs/design/ICONS_AND_MOTION.md §2.2, rule 6.
 *
 * A section that opens under its header should UNFOLD, not appear. The
 * conditional that decides whether it is open stays exactly where it was at
 * the call site (`<Collapse open={expanded}>` in place of `{expanded && …}`);
 * what changes is that the content now rides a `grid-template-rows` 0fr → 1fr
 * on the symmetric curve with a short fade, and folds back the same way before
 * it unmounts. Nothing is mounted while closed, so a collapsed row costs what
 * it cost before.
 *
 * Grid rows rather than `height`: the row track resolves to the content's own
 * height at 1fr, so there is no measuring, no `height: auto` special case and
 * no layout thrash — the one legitimate way to animate "as tall as it needs
 * to be" (the contract's rule 8 names it).
 *
 * Padding and borders never go on the grid item itself: a 0fr track still
 * keeps the item's padding and border as its floor, so a padded item would
 * open from, and fold back to, that many pixels and then snap to nothing when
 * it unmounts. The clipped item stays bare (`min-h-0 overflow-hidden`) and
 * `innerClassName` lands on a box inside it, which the clip hides entirely.
 *
 * Reduced motion: the rows snap and the fade keeps its timing (Tier B).
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
  const reduce = useReducedMotion() ?? false;
  const rows: Transition = reduce ? { duration: 0 } : transition.symmetric;
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="collapse"
          className={cn("grid", className)}
          initial={{ gridTemplateRows: "0fr", opacity: 0 }}
          animate={{
            gridTemplateRows: "1fr",
            opacity: 1,
            transition: { gridTemplateRows: rows, opacity: transition.base },
          }}
          exit={{
            gridTemplateRows: "0fr",
            opacity: 0,
            // The fold and the fade leave together; the fade on the accelerate,
            // because the reader has already decided.
            transition: { gridTemplateRows: rows, opacity: { duration: duration.exit, ease: ease.in } },
          }}
        >
          <div className="min-h-0 overflow-hidden">
            <div className={innerClassName}>{children}</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
