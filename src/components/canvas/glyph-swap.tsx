import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Two glyphs in one cell, cross-fading when a state flips — copy → check,
 * device → cloud, the overflow mark → a spinner while its menu works.
 *
 * docs/design/ICONS_AND_MOTION.md §2.2 rule 7: a state swap must not be one
 * glyph replacing another in a frame. Both are mounted and share one grid
 * cell, so the box never changes size and the outgoing mark can still be seen
 * leaving while the incoming one settles in — opacity plus a small scale
 * (0.8 → 1) on `duration-fast`, which is over before the eye is back from the
 * button it pressed. Under reduced motion the scale collapses and the fade
 * keeps its timing, as every other swap in the product does.
 *
 * The transition sits on the wrapper spans, never on the svgs: an articulated
 * glyph's own `transition` belongs to `svg.icon[data-motion]` (its hover
 * gesture), and it outranks any utility written on the svg, so a cross-fade
 * declared there would simply never run.
 *
 * Presentational and hook-free, so it is safe in a server component. The
 * glyphs are `aria-hidden` by default (icons.tsx), so the cell adds nothing to
 * the accessible name; the control around it says which state it is in.
 */
export function GlyphSwap({
  active,
  off,
  on,
  className,
}: {
  /** Which glyph is showing: `on` when true, `off` when false. */
  active: boolean;
  off: ReactNode;
  on: ReactNode;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("inline-grid shrink-0 place-items-center", className)}>
      <span className={cn(LAYER, active && HIDDEN)}>{off}</span>
      <span className={cn(LAYER, !active && HIDDEN)}>{on}</span>
    </span>
  );
}

const LAYER =
  "inline-flex [grid-area:1/1] transition-[opacity,transform] duration-fast ease-out-soft";
const HIDDEN = "scale-[0.8] opacity-0 motion-reduce:scale-100";
