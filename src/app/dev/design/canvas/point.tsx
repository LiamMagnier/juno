import * as React from "react";

/*
 * The signature: "the point". Canvas's ground is a field of faint points; the
 * mark is nine of them with one point inked, which is Juno's attention.
 *
 *   rest      the ink point sits in the centre (the logo, a finished line)
 *   thinking  the ink point walks the ring of the grid, one point at a time
 *   working   the ink point reads the grid row by row, like a line of text
 *
 * Geometry on a 16-unit box: points at 3.5 / 8 / 12.5, faint points r 1.1 at
 * 30% ink, the ink point r 1.9. The walk is CSS (canvas.css) on transform
 * only; under reduced motion the ink point stays in the centre and the words
 * beside the glyph carry the state.
 */

export type PointState = "rest" | "thinking" | "working";

const GRID = [3.5, 8, 12.5];

export function Point({
  state = "rest",
  size = 16,
  label,
  className,
}: {
  state?: PointState;
  size?: number;
  /** Accessible name; omit when the words beside the glyph already say it. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      focusable="false"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={className ? `cv-point ${className}` : "cv-point"}
    >
      {GRID.map((y) =>
        GRID.map((x) => <circle key={`${x}-${y}`} className="cv-point__grid" cx={x} cy={y} r={1.15} />),
      )}
      <circle className="cv-point__ink" cx={8} cy={8} r={2.2} />
    </svg>
  );
}
