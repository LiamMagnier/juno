import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Two (or three) glyphs sharing one cell, cross-fading when the state changes.
 *
 * ICONS_AND_MOTION.md §2.2.7: a state swap — show to hide, play to stop, a
 * glyph to a spinner — is not one drawing replacing another in a frame. Every
 * glyph is mounted, stacked in the same grid area, and the one that matches
 * `state` is the only one at full opacity; the rest sit at 0.8 scale and zero
 * opacity. The swap runs on `duration-fast`, because the reader has just
 * pressed the control and is looking at it.
 *
 * Under reduced motion the scale collapses and the fade keeps its timing, the
 * tier globals.css applies everywhere else.
 *
 * Server-safe: no hooks, no context. Lives beside the auth forms because the
 * password toggle is where it started; settings and admin import it from
 * here rather than hand-rolling a second copy.
 */
export function GlyphSwap<K extends string>({
  state,
  glyphs,
  className,
}: {
  /** Which glyph is showing. */
  state: K;
  /** Every glyph the control can show, keyed by state. Order is paint order. */
  glyphs: Record<K, React.ReactNode>;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn("inline-grid shrink-0 place-items-center", className)}>
      {(Object.keys(glyphs) as K[]).map((key) => {
        const on = key === state;
        return (
          <span
            key={key}
            className={cn(
              "col-start-1 row-start-1 flex transition-[opacity,transform] duration-fast ease-out-soft motion-reduce:transition-opacity",
              on ? "scale-100 opacity-100" : "pointer-events-none scale-[0.8] opacity-0 motion-reduce:scale-100"
            )}
          >
            {glyphs[key]}
          </span>
        );
      })}
    </span>
  );
}
