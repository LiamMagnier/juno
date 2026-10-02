import { cn } from "@/lib/utils";
import { CODE_GLYPH, glyphSizeFor } from "./brand-glyphs";
import { BRAND_TONE_COLOR } from "./brand-tone";
import type { BrandGlyphProps } from "./orbit-glyph";

/** Alevr Code's glyph: opposed square brackets with an inset cursor. */
export function CodeGlyph({ size = 20, tone = "current", title, className, style }: BrandGlyphProps) {
  const g = CODE_GLYPH[glyphSizeFor(size)];
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
