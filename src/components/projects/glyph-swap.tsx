import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Two glyphs in one cell, cross-fading between them — pin ⇄ pinned,
 * copy ⇄ copied, pause ⇄ play (ICONS_AND_MOTION.md §2.2, rule 7).
 *
 * A state swap used to be a conditional: one glyph unmounted and the other
 * mounted in the same frame, so the only evidence the press did anything was
 * a cut. Here both are always drawn in the same grid cell and trade opacity
 * with a small scale (0.8 → 1) on `duration-fast`, so the change reads as the
 * mark turning over rather than being replaced. Under reduced motion the scale
 * collapses and the fade keeps its timing.
 *
 * The fade and scale live on a wrapper span, never on the glyph: an `svg.icon`
 * with a hover articulation owns its own `transition` in globals.css, and a
 * utility on the same element would lose to it.
 *
 * Server-component safe. Lives with the projects surface because the pin
 * toggles there were its first callers; it has no projects-specific logic.
 */
export function GlyphSwap({
  active,
  on,
  off,
  className,
}: {
  /** Which glyph is showing: `on` while true, `off` while false. */
  active: boolean;
  /** The glyph for the ON state — the filled pin, the check, the play mark. */
  on: ReactNode;
  /** The glyph for the OFF / resting state. */
  off: ReactNode;
  className?: string;
}) {
  const layer =
    "col-start-1 row-start-1 flex items-center justify-center transition-[opacity,transform] duration-fast ease-out-soft";
  const hidden = "scale-[0.8] opacity-0 motion-reduce:scale-100";
  return (
    <span aria-hidden="true" className={cn("inline-grid shrink-0 place-items-center", className)}>
      <span className={cn(layer, active ? hidden : "opacity-100")}>{off}</span>
      <span className={cn(layer, active ? "opacity-100" : hidden)}>{on}</span>
    </span>
  );
}
