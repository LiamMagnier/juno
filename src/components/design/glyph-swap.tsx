import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Two glyphs in one box, cross-fading — the state swap of
 * docs/design/ICONS_AND_MOTION.md §2.2.7, for the editor's two-state controls:
 * a layer's eye and padlock, a paint's eye, play ⇄ pause, the corner-radius
 * link, the Ask Juno arrow ⇄ spinner.
 *
 * Every one of those used to be a ternary that unmounted one glyph and mounted
 * the other in the same frame, which is the one state change a reader cannot
 * follow: the mark is simply different, with nothing to say it changed. Both
 * glyphs stay mounted in one grid cell here, so the box never changes size and
 * the swap runs the same way in both directions — the leaving glyph shrinks to
 * 0.8 and fades on the exit curve while the arriving one grows from 0.8 on the
 * spring, and that overlap is what reads as one control changing its mind.
 *
 * Only `opacity` and `transform` move. A glyph's own hover articulation
 * (`data-motion` in icons.tsx) runs on the individual `translate` / `rotate` /
 * `scale` properties, so it composes with this rather than being overwritten.
 * Under reduced motion the scale collapses and the fade keeps its timing.
 *
 * The layers are hidden from assistive tech: the control that holds the swap
 * names its state in its own label ("Hide" / "Show"), which is where a screen
 * reader looks for it.
 *
 * Same contract as `@/components/aicss/glyph-swap` (swapped / from / to), so the
 * two can become one import the day a shared primitive lands in `ui/`.
 */
export function GlyphSwap({
  swapped,
  from,
  to,
  className,
}: {
  /** Show `to` instead of `from`. */
  swapped: boolean;
  /** The resting glyph (Eye, Play, ArrowUp). */
  from: React.ReactNode;
  /** The glyph the state swaps to (EyeOff, Pause, the spinner). */
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
