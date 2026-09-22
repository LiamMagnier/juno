import type * as React from "react";

import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Two glyphs in one box, cross-faded — the state swap from
 * docs/design/ICONS_AND_MOTION.md §2.2 (rule 7): copy → check, play → pause,
 * pin → unpin, show → hide.
 *
 * THE ONE SWAP. This file is the only cross-fade-between-glyphs primitive in
 * the product. Five near-copies used to live beside the surfaces that first
 * needed them (aicss, design, projects, the work shell, here) and had already
 * drifted on curve, depth and accessibility; every caller now imports from
 * here. Reach for `IconSwap` for two glyphs, `IconSwapSet` for a slot that can
 * hold three or more (or hands over to a spinner), and `variants.swap` in
 * `@/lib/motion` when the faces mount and unmount under framer's
 * `AnimatePresence` instead.
 *
 * WHY NOT A CONDITIONAL. `{copied ? <Check/> : <Copy/>}` replaces one drawing
 * with another in a single frame, which reads as a flicker at the exact moment
 * the reader is looking at the control to see whether it worked. Here both
 * faces are always mounted in one grid cell and trade opacity plus a small
 * scale (0.8 → 1) on the fast rung, so the control reads as one object
 * changing its mind. The box is sized by the larger face, so nothing beside it
 * moves.
 *
 * The fade and scale live on a wrapper per face, never on the glyph: an
 * `svg.icon` with a hover articulation owns its own `transition` list in
 * globals.css, and the individual `translate` / `rotate` / `scale` properties
 * it animates compose with the face's `transform` instead of being overwritten
 * by it. A copy sheet still lifts under the pointer; this wrapper only decides
 * which of the two is showing.
 *
 * ACCESSIBILITY. The box is `aria-hidden`: the control around it owns the
 * accessible name and says the state in it ("Copy" / "Copied"), which is where
 * a screen reader looks. Two faces announcing themselves would be two names
 * for one button.
 *
 * Reduced motion: the hidden face's scale reads `--motion-scale-from`, which
 * the reduced tier in globals.css pins to 1 — the swap keeps its fade and
 * loses the scale, exactly as every other entrance does.
 *
 * CSS only, no hooks, so it renders in a server component too.
 *
 * @example
 *   <IconSwap swapped={copied} from={<Copy className="size-4" />} to={<Check className="size-4" />} />
 */
export function IconSwap({
  swapped,
  from,
  to,
  curve = "soft",
  className,
}: {
  /** `false` shows `from`, `true` shows `to`. */
  swapped: boolean;
  /** The resting glyph (Copy, Play, Eye). */
  from: React.ReactNode;
  /** The glyph the state swaps to (Check, Pause, EyeOff, the spinner). */
  to: React.ReactNode;
  /**
   * `soft` (default): both faces move on --ease-out-soft.
   * `spring`: the arriving face settles on --ease-spring while the leaving one
   * accelerates away on --ease-in — the entrance/exit pair, so the old mark is
   * still going as the new one lands. The transcript's and the design
   * editor's controls use it.
   */
  curve?: IconSwapCurve;
  className?: string;
}) {
  const ease = CURVE[curve];
  return (
    <span aria-hidden="true" className={cn("relative inline-grid shrink-0 place-items-center", className)}>
      <span className={cn(FACE, swapped ? [HIDDEN, ease.leave] : [SHOWN, ease.arrive])}>{from}</span>
      <span className={cn(FACE, swapped ? [SHOWN, ease.arrive] : [HIDDEN, ease.leave])}>{to}</span>
    </span>
  );
}

export type IconSwapCurve = "soft" | "spring";

/* Both faces share one cell. The timing function a transition runs on is the
   one on the state it is heading INTO, so the arriving face carries the
   arrival curve and the leaving face the exit curve. */
const FACE =
  "col-start-1 row-start-1 inline-flex items-center justify-center " +
  "transition-[opacity,transform] duration-fast";
const SHOWN = "opacity-100 [transform:none]";
const HIDDEN = "pointer-events-none opacity-0 [transform:scale(var(--motion-scale-from,0.8))]";
const CURVE: Record<IconSwapCurve, { arrive: string; leave: string }> = {
  soft: { arrive: "ease-out-soft", leave: "ease-out-soft" },
  spring: { arrive: "ease-spring", leave: "ease-in" },
};

/**
 * One slot, three or more glyphs — the same swap for a control whose mark has
 * more than two states: pause ⇄ play ⇄ the spinner while the press is in
 * flight, a glyph to its spinner and back.
 *
 * Every glyph the slot can show is mounted in the one cell, keyed by the state
 * that shows it, and the outgoing one shrinks and fades while the incoming one
 * grows into place. Its hidden depth is 0.75 rather than `IconSwap`'s 0.8: the
 * slot was drawn that way where it started (the work shell's run controls),
 * and consolidating it here kept it exactly as it was.
 *
 * `spinning` names the key whose glyph turns while it is shown. It keeps its
 * animation while it fades out, paused where it stands — dropping the class
 * would snap the notch back to 0deg mid-fade, and a hidden spinner does not
 * turn. The spinner carries no hover articulation (`motion="none"`).
 *
 * Takes components rather than elements so every layer gets the same size and
 * ink from one `className`. `aria-hidden` for the same reason as `IconSwap`.
 * Server-component safe — no state, no hooks.
 *
 * @example
 *   <IconSwapSet glyphs={{ idle: Play, busy: Loader2 }} show={busy ? "busy" : "idle"} spinning="busy" className="size-3.5" />
 */
export function IconSwapSet<K extends string>({
  glyphs,
  show,
  spinning,
  className,
}: {
  /** Every glyph the slot can hold, keyed by the state that shows it. */
  glyphs: Record<K, IconComponent>;
  /** The state showing now, or null for an empty slot. */
  show: K | null;
  /** The key whose glyph turns while it is shown — the spinner. It stops when hidden. */
  spinning?: K;
  /** Size and ink for every layer, e.g. `"size-3.5"`. */
  className?: string;
}) {
  const keys = Object.keys(glyphs) as K[];
  return (
    <span className="inline-grid shrink-0 place-items-center" aria-hidden="true">
      {keys.map((key) => {
        // Widened to the plain component type: JSX cannot resolve props on the
        // generic indexed access `Record<K, IconComponent>[K]`.
        const Glyph: IconComponent = glyphs[key];
        const on = key === show;
        return (
          <span
            key={key}
            className={cn(
              "flex items-center justify-center [grid-area:1/1]",
              "transition-[opacity,transform] duration-fast ease-out-soft",
              on ? "scale-100 opacity-100" : "scale-75 opacity-0 motion-reduce:scale-100"
            )}
          >
            <Glyph
              motion={key === spinning ? "none" : undefined}
              className={cn(
                key === spinning && "animate-spin",
                key === spinning && !on && "[animation-play-state:paused]",
                className
              )}
            />
          </span>
        );
      })}
    </span>
  );
}
