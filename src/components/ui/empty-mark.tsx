import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The empty state's mark (spec §6.13, §3.11): the dot construction in
 * miniature, NEUTRAL — no presence lamp, because presence means "Alevr is
 * live here" and an empty list is not live.
 *
 * 1px dots on the 4px dot-matrix pitch. The field inside the circle is drawn
 * at the matrix ink (foreground at 0.16 in light, 0.20 in dark, sheet.css
 * `.empty-mark`); three orbits at the 1.5 ratio are picked out at the muted
 * ink, so the construction reads at 48px (a page) and at 32px (a panel).
 *
 * A static SVG drawn in currentColor: no canvas, no frames, nothing to stop
 * under reduced motion, and it follows high contrast and forced colours like
 * any glyph. Decorative, hidden from assistive technology.
 */

export const EMPTY_MARK_SIZE = { page: 48, panel: 32 } as const;
const PITCH = 4;
const RING_RADII = [0.44 / 1.5 / 1.5, 0.44 / 1.5, 0.44] as const;

export interface EmptyMarkDot {
  x: number;
  y: number;
  ring: boolean;
}

/** The mark's dots for a box of `size` px: the matrix inside the circle, and which of them sit on an orbit. */
export function emptyMarkDots(size: number): EmptyMarkDot[] {
  const dots: EmptyMarkDot[] = [];
  const c = size / 2;
  const tolerance = PITCH * 0.55;
  for (let y = PITCH / 2; y < size; y += PITCH) {
    for (let x = PITCH / 2; x < size; x += PITCH) {
      const d = Math.hypot(x - c, y - c);
      if (d > size * 0.46) continue;
      const ring = RING_RADII.some((r) => Math.abs(d - r * size) <= tolerance);
      dots.push({ x, y, ring });
    }
  }
  return dots;
}

export function EmptyMark({ size = "page", className }: { size?: "page" | "panel"; className?: string }) {
  const px = EMPTY_MARK_SIZE[size];
  const dots = React.useMemo(() => emptyMarkDots(px), [px]);
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      className={cn("empty-mark block shrink-0", className)}
      data-size={size}
    >
      <g className="empty-mark__field" fill="currentColor">
        {dots
          .filter((d) => !d.ring)
          .map((d) => (
            <rect key={`${d.x}-${d.y}`} x={d.x - 0.5} y={d.y - 0.5} width={1} height={1} />
          ))}
      </g>
      <g className="empty-mark__orbits" fill="currentColor">
        {dots
          .filter((d) => d.ring)
          .map((d) => (
            <rect key={`${d.x}-${d.y}`} x={d.x - 0.75} y={d.y - 0.75} width={1.5} height={1.5} />
          ))}
      </g>
    </svg>
  );
}
