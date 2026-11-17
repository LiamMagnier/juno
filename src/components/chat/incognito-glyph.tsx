import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The incognito mark: a fedora over a pair of shades, drawn in house for the
 * one mode that hides who is asking. It replaces Lucide's "hat-glasses",
 * whose round lenses sat on the viewBox's bottom edge and, at 18px, read as
 * reading glasses under a bowl.
 *
 * DRAWN ON THE HOUSE GRID (DIRECTION.md §3): 24 units, round caps and joins,
 * mass inside the 18-unit live area (the brim spans 3 to 21, the crown's
 * shoulders top out near 4.8 and the lenses end at 19, so the figure's optical
 * centre lands on y = 12). At interface sizes the line is the family's one
 * 1.5px non-scaling stroke (`icon ag` + `width`, signature.css §12); larger
 * marks take a line that grows with them, as the set's empty-state glyphs do.
 *
 * WHY SHADES, NOT SPECTACLES. The lenses are flat across the top and joined by
 * one bar, the cut of a pair of sunglasses. Two open rings under a hat is the
 * symbol browsers use, but at this size the rings are the loudest thing in it
 * and they say "reading". A straight brow line says "covered".
 *
 * FILL MEANS ON (§3). `on` floods the crown and the lenses with the ink: the
 * hat is on and the shades are dark. Off, the same drawing is outline only, so
 * the two states differ in mass, not in shape, and a glance tells them apart.
 *
 * MOTION is incognito.css's, keyed on `data-gesture`: the caller sets it when
 * the state CHANGES ("on" settles the hat onto the head and the shades onto
 * the face, "off" tips the brim), never on mount (`incognitoGestureFor`). The
 * sheet is loaded by the toggle, the one place the mark moves; this module
 * stays free of it, so a still mark (the public home, the phone band) draws
 * right with no stylesheet at all and the drawing can be tested in node.
 * Server-component safe: no hooks, no context, static markup.
 */

/** The crown, closed along the brim so the "on" cut can fill it. */
export const CROWN =
  "M6.5 11 7.75 6.25C8 5.3 8.9 4.85 9.8 5.15l1.4.45c.5.16 1.1.16 1.6 0l1.4-.45c.9-.3 1.8.15 2.05 1.1L17.5 11Z";
/** The crown's visible edge: the same line, open at the bottom where the brim draws it. */
export const CROWN_EDGE =
  "M6.5 11 7.75 6.25C8 5.3 8.9 4.85 9.8 5.15l1.4.45c.5.16 1.1.16 1.6 0l1.4-.45c.9-.3 1.8.15 2.05 1.1L17.5 11";
export const BRIM = "M3 11h18";
/** Two bowls hung from one brow bar: flat across the top, round below. */
export const LENSES = "M4.75 15v1.25a2.75 2.75 0 0 0 5.5 0V15M13.75 15v1.25a2.75 2.75 0 0 0 5.5 0V15";
export const LENS_FILL = "M4.75 15h5.5v1.25a2.75 2.75 0 0 1-5.5 0ZM13.75 15h5.5v1.25a2.75 2.75 0 0 1-5.5 0Z";
export const BROW = "M4.75 15h14.5";

/** The line in viewBox units for a rendered size: the house 1.5px up to 24, then growing with the box. */
export function incognitoLine(px: number): number {
  const target = px <= 24 ? 1.5 : px * 0.068;
  return Math.round(((target * 24) / px) * 1000) / 1000;
}

export type IncognitoGesture = "on" | "off";

/**
 * Which gesture the mark should play for `active`: the one for the state it
 * changed TO, and nothing until it has changed. Arrival on a page is not a
 * change, so a mark never performs on mount; a press plays once, and
 * pressing back plays the other.
 */
export function incognitoGestureFor(previous: boolean, active: boolean, current: IncognitoGesture | null): IncognitoGesture | null {
  if (previous === active) return current;
  return active ? "on" : "off";
}

export function IncognitoGlyph({
  on = false,
  size = 18,
  gesture,
  className,
}: {
  /** The "on" cut: crown and lenses filled. */
  on?: boolean;
  /** Rendered size in px. 12 to 24 draw the family's non-scaling 1.5px line. */
  size?: number;
  /** The one gesture to play, set by the caller on a state change (incognito.css). */
  gesture?: IncognitoGesture | null;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={incognitoLine(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-glyph="Incognito"
      data-on={on ? "" : undefined}
      data-gesture={gesture ?? undefined}
      // `overflow-visible`: the hat travels up to 3 units above its rest
      // while it settles, past the viewBox's top edge.
      className={cn("icon ag incognito-mark shrink-0 overflow-visible", className)}
    >
      {/* The fills' opacity is a presentation attribute, so the cut is right
          without the stylesheet; incognito.css only adds the fade between. */}
      <g className="im-glasses">
        <path className="im-fill" d={LENS_FILL} fill="currentColor" stroke="none" opacity={on ? 1 : 0} />
        <path d={BROW} />
        <path d={LENSES} />
      </g>
      <g className="im-hat">
        <path className="im-fill" d={CROWN} fill="currentColor" stroke="none" opacity={on ? 1 : 0} />
        <path d={CROWN_EDGE} />
        <path d={BRIM} />
      </g>
    </svg>
  );
}
