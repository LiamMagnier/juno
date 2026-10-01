import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";
import { continuumDrawing } from "./continuum-geometry";

export type ContinuumMarkProps = {
  /** Rendered size in CSS px (the square box). 16, 20, 24 and 32 use their optical masters. */
  size?: number;
  tone?: BrandTone;
  /**
   * Accessible name. Omit when the mark is decorative or sits inside a labelled
   * control (the link or button carries the name), and it is hidden from
   * assistive technology.
   */
  title?: string;
  /** Draw the master in its own bounds (wider than tall) instead of a square box. */
  tight?: boolean;
  className?: string;
  style?: CSSProperties;
};

/**
 * Continuum, Alevr's master mark: four blades around an open aperture, drawn
 * from continuum-geometry.ts. Each blade is its own path (`data-blade`) in the
 * fixed clockwise order the thinking handoff walks.
 */
export function ContinuumMark({ size = 20, tone = "ink", title, tight = false, className, style }: ContinuumMarkProps) {
  const drawing = continuumDrawing(size, { tight });
  const [, , vw, vh] = drawing.viewBox.split(" ").map(Number);
  const width = tight ? Math.round(((size * vw) / vh) * 100) / 100 : size;
  return (
    <svg
      viewBox={drawing.viewBox}
      width={width}
      height={size}
      className={cn("shrink-0", className)}
      style={{ color: BRAND_TONE_COLOR[tone], ...style }}
      fill="currentColor"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      {drawing.paths.map((p) => (
        <path key={p.id} data-blade={p.id} d={p.d} />
      ))}
    </svg>
  );
}
