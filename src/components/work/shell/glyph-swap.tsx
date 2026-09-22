import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * Two or more glyphs sharing one slot, cross-fading when the state changes.
 *
 * Pause to play, a glyph to its spinner while the press is in flight, a pin to
 * its unpin: a control whose mark changes under the reader's finger used to
 * swap one `<svg>` for another in a single frame, which reads as a flicker on
 * the one element the reader is looking at. Here every glyph the slot can show
 * is mounted in the same grid cell; the outgoing one shrinks and fades while
 * the incoming one grows into place, on `duration-fast` (ICONS_AND_MOTION.md
 * §2.2, rule 7). Under reduced motion the scale collapses and the fade keeps
 * its timing.
 *
 * The slot is `aria-hidden`: the control around it owns the accessible name,
 * and three glyphs announcing themselves would be three names for one button.
 *
 * Server-component safe — no state, no hooks.
 */
export function GlyphSwap<K extends string>({
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
        const Glyph = glyphs[key];
        const on = key === show;
        return (
          <Glyph
            key={key}
            motion={key === spinning ? "none" : undefined}
            className={cn(
              "[grid-area:1/1] transition-[opacity,transform] duration-fast ease-out-soft",
              on ? "scale-100 opacity-100" : "scale-75 opacity-0 motion-reduce:scale-100",
              on && key === spinning && "animate-spin",
              className
            )}
          />
        );
      })}
    </span>
  );
}
