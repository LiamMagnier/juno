import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { ALEVR_LOCKUP, ALEVR_LOCKUP_CLEAR_VIEWBOX, ALEVR_LOCKUP_VIEWBOX, LOCKUP_MASS_RIGHT } from "./alevr-lockup-geometry";
import { AlevrWordmark } from "./alevr-wordmark";
import { ALEVR_WORDMARK } from "./alevr-wordmark-geometry";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";
import { CONTINUUM_BOUNDS, CONTINUUM_MASTER_PATHS, CONTINUUM_OPTICAL, opticalSizeFor } from "./continuum-geometry";
import { ContinuumMark } from "./continuum-mark";

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

/** Whole-pixel heights at which an optical master's tight crop draws pixel for pixel. */
const OPTICAL_CROP_HEIGHTS = ([16, 20, 24, 32] as const).map((n) => CONTINUUM_OPTICAL[n].rows[1] - CONTINUUM_OPTICAL[n].rows[0]);

/** The mark height to draw for a nominal one: an optical crop height when one is within 20%, else whole px. */
function snapMarkHeight(h: number): number {
  const best = OPTICAL_CROP_HEIGHTS.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a));
  return Math.abs(best / h - 1) <= 0.2 ? best : Math.round(h);
}

/**
 * Continuum and the wordmark, spaced per alevr-lockup-geometry.ts.
 *
 * Large (the mark wider than 40 px): one SVG with the master, scalable.
 * Small (sidebar, headers, 20 to 28 px tall): the mark is a ContinuumMark at
 * a whole-pixel height with the optical master for its device pixels, so its
 * channels stay open, and the word is placed beside it at its own size. The
 * full-size master at 20 px tall would fuse its blades.
 */
export function AlevrLockup({ height = 32, tone = "ink", withClearSpace = false, title = "Alevr", decorative = false, className, style }: AlevrLockupProps) {
  const L = ALEVR_LOCKUP;
  const box = withClearSpace ? ALEVR_LOCKUP_CLEAR_VIEWBOX : ALEVR_LOCKUP_VIEWBOX;
  const [bx, by, bw, bh] = box.split(" ").map(Number);
  const u = height / bh; // px per lockup unit
  const width = Math.round(bw * u * 100) / 100;
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img" as const, "aria-label": title };

  if (opticalSizeFor(L.mark.width * u) === null) {
    return (
      <svg
        viewBox={box}
        width={width}
        height={height}
        className={cn("shrink-0", className)}
        style={{ color: BRAND_TONE_COLOR[tone], ...style }}
        fill="currentColor"
        {...(decorative ? { "aria-hidden": true, focusable: false } : { role: "img", "aria-label": title })}
      >
        {decorative ? null : <title>{title}</title>}
        <g transform={L.markTransform}>
          {CONTINUUM_MASTER_PATHS.map((p) => (
            <path key={p.id} data-blade={p.id} d={p.d} />
          ))}
        </g>
        <g transform={L.wordTransform}>
          {ALEVR_WORDMARK.glyphs.map((g, i) => (
            <path key={i} d={g.d} />
          ))}
        </g>
      </svg>
    );
  }

  // Composed: positions in px from the box's top-left.
  const markH = snapMarkHeight(L.mark.height * u);
  const markW = markH * (CONTINUUM_BOUNDS.width / CONTINUUM_BOUNDS.height);
  const markLeft = Math.round((L.mark.x - bx) * u);
  const capMid = (L.capMiddle - by) * u;
  const markTop = Math.round(capMid - markH / 2);
  const massRight = markLeft + ((LOCKUP_MASS_RIGHT - CONTINUUM_BOUNDS.x) / CONTINUUM_BOUNDS.width) * markW;
  const wordH = L.word.height * u;
  const wordLeft = massRight + L.gap * u;
  const wordTop = (L.word.y - by) * u;
  const total = Math.max(width, Math.round((wordLeft + L.word.width * u + (withClearSpace ? L.clearSpace * u : 0)) * 100) / 100);
  return (
    <span
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: total, height, color: BRAND_TONE_COLOR[tone], ...style }}
      {...a11y}
    >
      <ContinuumMark size={markH} tight tone="current" style={{ position: "absolute", left: markLeft, top: markTop }} />
      <AlevrWordmark height={wordH} tone="current" decorative style={{ position: "absolute", left: wordLeft, top: wordTop }} />
    </span>
  );
}
