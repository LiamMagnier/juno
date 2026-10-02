import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { ORBIT_GLYPH, glyphSizeFor } from "./brand-glyphs";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";

export type BrandGlyphProps = {
  /** Rendered size in CSS px; 16, 20 and 24 use their own masters, other sizes scale the nearest. */
  size?: number;
  tone?: BrandTone;
  /** Accessible name. Omit inside a labelled control (it is then hidden from assistive technology). */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

/** Alevr Orbit's glyph: two separated open elliptical arcs. Static; never a spinner. */
export function OrbitGlyph({ size = 20, tone = "current", title, className, style }: BrandGlyphProps) {
  const g = ORBIT_GLYPH[glyphSizeFor(size)];
  return (
    <svg
      viewBox={`0 0 ${g.size} ${g.size}`}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      style={{ color: BRAND_TONE_COLOR[tone], ...style }}
      fill="none"
      stroke="currentColor"
      strokeWidth={g.stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      {g.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
