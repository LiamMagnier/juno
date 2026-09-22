import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Two glyphs in one box, cross-fading: the state swap from
 * docs/design/ICONS_AND_MOTION.md §2.2.7 (copy → check, play → pause).
 *
 * Both glyphs stay mounted in one grid cell, so the box never changes size and
 * the swap runs the same way in both directions. The leaving glyph shrinks to
 * 0.8 and fades on the exit curve; the arriving one grows from 0.8 on the
 * spring curve and settles. That small overlap is the whole effect — the old
 * mark is still leaving while the new one lands, so the eye reads one control
 * changing its mind rather than one icon being replaced by another in a frame.
 *
 * Only `opacity` and `transform` move. A glyph's own hover articulation
 * (`data-motion` in icons.tsx) runs on the individual `translate` / `rotate` /
 * `scale` properties, so it composes with this instead of being overwritten.
 * Under reduced motion the scale collapses and the fade keeps its timing.
 *
 * The wrappers are hidden from assistive tech: the control that holds the swap
 * names its state in its own label ("Copy" / "Copied"), which is where a screen
 * reader looks for it.
 */
export function GlyphSwap({
  swapped,
  from,
  to,
  className,
}: {
  /** Show `to` instead of `from`. */
  swapped: boolean;
  /** The resting glyph (Copy, Play). */
  from: React.ReactNode;
  /** The glyph the state swaps to (Check, Pause). */
  to: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-grid shrink-0 place-items-center", className)}>
      <span aria-hidden="true" className={cn(LAYER, swapped ? HIDDEN : SHOWN)}>
        {from}
      </span>
      <span aria-hidden="true" className={cn(LAYER, swapped ? SHOWN : HIDDEN)}>
        {to}
      </span>
    </span>
  );
}

const LAYER =
  "col-start-1 row-start-1 inline-flex items-center justify-center " +
  "transition-[opacity,transform] duration-fast motion-reduce:transform-none";
const SHOWN = "scale-100 opacity-100 ease-spring";
const HIDDEN = "pointer-events-none scale-[0.8] opacity-0 ease-in";
