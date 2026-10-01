import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { ALEVR_LOCKUP, ALEVR_LOCKUP_CLEAR_VIEWBOX, ALEVR_LOCKUP_VIEWBOX } from "./alevr-lockup-geometry";
import { ALEVR_WORDMARK } from "./alevr-wordmark-geometry";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";
import { CONTINUUM_MASTER_PATHS } from "./continuum-geometry";

export type AlevrLockupProps = {
  /** Height of the lockup's tight box in CSS px. */
  height?: number;
  tone?: BrandTone;
  /** Include the clear space (one path width) inside the box. */
  withClearSpace?: boolean;
  /** Accessible name; defaults to "Alevr". Pass `decorative` inside a labelled link. */
  title?: string;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
};

/** Continuum and the wordmark as one drawing, spaced per alevr-lockup-geometry.ts. */
export function AlevrLockup({ height = 32, tone = "ink", withClearSpace = false, title = "Alevr", decorative = false, className, style }: AlevrLockupProps) {
  const viewBox = withClearSpace ? ALEVR_LOCKUP_CLEAR_VIEWBOX : ALEVR_LOCKUP_VIEWBOX;
  const [, , vw, vh] = viewBox.split(" ").map(Number);
  const width = Math.round(((height * vw) / vh) * 100) / 100;
  return (
    <svg
      viewBox={viewBox}
      width={width}
      height={height}
      className={cn("shrink-0", className)}
      style={{ color: BRAND_TONE_COLOR[tone], ...style }}
      fill="currentColor"
      {...(decorative ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": title })}
    >
      {decorative ? null : <title>{title}</title>}
      <g transform={ALEVR_LOCKUP.markTransform}>
        {CONTINUUM_MASTER_PATHS.map((p) => (
          <path key={p.id} data-blade={p.id} d={p.d} />
        ))}
      </g>
      <g transform={ALEVR_LOCKUP.wordTransform}>
        {ALEVR_WORDMARK.glyphs.map((g, i) => (
          <path key={i} d={g.d} />
        ))}
      </g>
    </svg>
  );
}
