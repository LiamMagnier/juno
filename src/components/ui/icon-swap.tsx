import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Two glyphs in one box, cross-faded — the state swap from
 * docs/design/ICONS_AND_MOTION.md §2.2 (rule 7): copy → check, play → pause,
 * pin → unpin, show → hide.
 *
 * WHY NOT A CONDITIONAL. `{copied ? <Check/> : <Copy/>}` replaces one drawing
 * with another in a single frame, which reads as a flicker at the exact moment
 * the reader is looking at the control to see whether it worked. Here both
 * faces are always mounted in one grid cell and trade opacity plus a small
 * scale (0.8 → 1) on the fast rung, so the control reads as one object
 * changing its mind. The box is sized by the larger face, so nothing beside it
 * moves.
 *
 * Reduced motion: the resting scale reads `--motion-scale-from`, which the
 * reduced tier in globals.css pins to 1 — the swap keeps its fade and loses
 * the scale, exactly as every other entrance does.
 *
 * CSS only, no hooks, so it renders in a server component too. The glyphs keep
 * their own hover articulation (a copy sheet still lifts under the pointer);
 * this wrapper only decides which of the two is showing.
 *
 * @example
 *   <IconSwap swapped={copied} from={<Copy className="size-4" />} to={<Check className="size-4" />} />
 */
export function IconSwap({
  swapped,
  from,
  to,
  className,
}: {
  /** `false` shows `from`, `true` shows `to`. */
  swapped: boolean;
  from: React.ReactNode;
  to: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)}>
      <span className={cn(FACE, swapped ? HIDDEN : SHOWN)}>{from}</span>
      <span className={cn(FACE, swapped ? SHOWN : HIDDEN)}>{to}</span>
    </span>
  );
}

/* Both faces share one cell. The transition belongs to the face rather than to
   the glyph, so a glyph's own hover articulation (the individual `translate` /
   `rotate` / `scale` properties in globals.css) composes with it instead of
   being overwritten by it. */
const FACE =
  "col-start-1 row-start-1 inline-flex items-center justify-center " +
  "transition-[opacity,transform] duration-fast ease-out-soft";
const SHOWN = "opacity-100 [transform:none]";
const HIDDEN = "pointer-events-none opacity-0 [transform:scale(var(--motion-scale-from,0.8))]";
