import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { ALEVR_WORDMARK, ALEVR_WORDMARK_VIEWBOX } from "./alevr-wordmark-geometry";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";

export type AlevrWordmarkProps = {
  /** Height of the ink box (ascender to baseline overshoot) in CSS px. Minimum legible width is 72 px (height about 21). */
  height?: number;
  tone?: BrandTone;
  /** Accessible name; defaults to "Alevr". Pass `decorative` when a visible label already names it. */
  title?: string;
  decorative?: boolean;
  className?: string;
  style?: CSSProperties;
};

const ASPECT = ALEVR_WORDMARK.bounds.width / ALEVR_WORDMARK.bounds.height;

/** The Alevr wordmark: upright Newsreader SemiBold, outlined, with optical kerning. Never italic, never "AleVR". */
export function AlevrWordmark({ height = 24, tone = "ink", title = "Alevr", decorative = false, className, style }: AlevrWordmarkProps) {
  const width = Math.round(height * ASPECT * 100) / 100;
  return (
    <svg
      viewBox={ALEVR_WORDMARK_VIEWBOX}
      width={width}
      height={height}
      className={cn("shrink-0", className)}
      style={{ color: BRAND_TONE_COLOR[tone], ...style }}
      fill="currentColor"
      {...(decorative ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": title })}
    >
      {decorative ? null : <title>{title}</title>}
      {ALEVR_WORDMARK.glyphs.map((g, i) => (
        <path key={i} d={g.d} />
      ))}
    </svg>
  );
}
