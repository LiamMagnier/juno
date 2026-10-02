import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { BRAND_TONE_COLOR, type BrandTone } from "./brand-tone";
import { continuumDrawingSet, type ContinuumDrawing, type ContinuumDrawingSet } from "./continuum-geometry";

export type ContinuumMarkProps = {
  /** Rendered height in CSS px (the square box, or the ink box when `tight`). */
  size?: number;
  tone?: BrandTone;
  /**
   * Accessible name. Omit when the mark is decorative or sits inside a labelled
   * control (the link or button carries the name), and it is hidden from
   * assistive technology.
   */
  title?: string;
  /** Crop to the ink (wider than tall) instead of a square box. */
  tight?: boolean;
  className?: string;
  style?: CSSProperties;
};

/** Width : height of a drawing's viewBox. */
export const drawingAspect = (d: ContinuumDrawing): number => {
  const [, , vw, vh] = d.viewBox.split(" ").map(Number);
  return vw / vh;
};

/**
 * Both device-pixel drawings of a set as nested SVGs filling their parent box,
 * one displayed at a time by brand.css. `render` draws one drawing's blades.
 * With a single drawing, it renders that drawing's blades directly (the parent
 * then carries the drawing's own viewBox: see `outerViewBox`).
 */
export function ContinuumDrawings({ set, render }: { set: ContinuumDrawingSet; render: (d: ContinuumDrawing, variant: "lo" | "hi") => ReactNode }) {
  if (!set.hiDpi) return <>{render(set.base, "lo")}</>;
  return (
    <>
      <svg className="alevr-dppx-lo" viewBox={set.base.viewBox} width="100%" height="100%" overflow="visible">
        {render(set.base, "lo")}
      </svg>
      <svg className="alevr-dppx-hi" viewBox={set.hiDpi.viewBox} width="100%" height="100%" overflow="visible">
        {render(set.hiDpi, "hi")}
      </svg>
    </>
  );
}

/** The viewBox of the outer <svg> around ContinuumDrawings for a box of width x height px. */
export const outerViewBox = (set: ContinuumDrawingSet, width: number, height: number): string => (set.hiDpi ? `0 0 ${width} ${height}` : set.base.viewBox);

/**
 * Continuum, Alevr's master mark: four blades around an open aperture, drawn
 * from continuum-geometry.ts. Each blade is its own path (`data-blade`) in the
 * fixed clockwise order the thinking handoff walks. Below 41 px it draws the
 * optical master that suits its size in device pixels.
 */
export function ContinuumMark({ size = 20, tone = "ink", title, tight = false, className, style }: ContinuumMarkProps) {
  const set = continuumDrawingSet(size, { tight });
  const width = tight ? Math.round(size * drawingAspect(set.base) * 100) / 100 : size;
  return (
    <svg
      viewBox={outerViewBox(set, width, size)}
      width={width}
      height={size}
      className={cn("shrink-0", className)}
      style={{ color: BRAND_TONE_COLOR[tone], ...style }}
      fill="currentColor"
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      <ContinuumDrawings set={set} render={(d) => d.paths.map((p) => <path key={p.id} data-blade={p.id} d={p.d} />)} />
    </svg>
  );
}
