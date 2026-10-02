/**
 * Alevr's two product glyphs, Orbit and Code, as pure data with optical
 * masters at 16, 20 and 24 px.
 *
 * Pure data and pure functions, no imports, so the export script and the
 * native projection read the same drawings the web renders.
 *
 * Both follow the V3 icon grammar (src/components/ui/juno-icons/drawings.ts):
 * one stroke, 1.25 px at 16 and 1.5 px from 18, round caps and joins, a 24 unit
 * grid with the live area 3 to 21, the 1.5 unit house gap where parts meet, and
 * continuous corners (curvature starts 1.18 r from the vertex, controls at 0.32 r).
 * Each size is drawn for its own pixel grid rather than scaled: straight
 * stems are placed so one edge of the stroke lands on a whole pixel.
 *
 * ORBIT: two separated open elliptical arcs of one ellipse. a : b is the golden
 * ratio (b = a / phi, so e = 0.786), the major axis is tilted 24 degrees up to
 * the right, and the two gaps sit at the two ends of the major axis (180
 * degrees apart in the ellipse's parameter), so the arcs are in point symmetry,
 * the same pairing the Continuum's blades have. Each gap is a clear 2 units
 * between round caps. The proportions match the V3 icon set's Orbit drawing
 * (rf/design-v3h), so the product icon and the brand glyph are one drawing.
 * Static: it is a place, not a spinner.
 *
 * CODE: opposed square brackets with an inset cursor. The cursor is about half
 * the brackets' height and sits on the axis between them. The axis is half a
 * pixel left of the box centre at every size, so the cursor's stroke covers
 * whole pixels instead of smearing across two; the brackets mirror about it.
 */

export type GlyphSize = 16 | 20 | 24;
export type BrandGlyph = { readonly size: GlyphSize; readonly stroke: number; readonly paths: readonly string[] };

const PHI = (1 + Math.sqrt(5)) / 2;
const n3 = (n: number): number => Math.round(n * 1000) / 1000;
const f = (n: number): string => String(n3(n));

/** Ellipse geometry shared by every size, in 24-unit grid terms. */
export const ORBIT_CONSTRUCTION = {
  /** Semi-major axis (grid units); matches the V3 icon set's Orbit drawing (rf/design-v3h). */
  a: 9.375,
  /** b = a / phi. */
  ratio: 1 / PHI,
  /** Tilt of the major axis, degrees (negative = up to the right in SVG's y-down space). */
  tilt: -24,
  /** Where the first gap is centred, in the ellipse's parameter (degrees): the major-axis vertex; the second is 180 degrees on. */
  gapAt: 0,
  /** The clear gap between the round caps (grid units): the 1.5 unit house gap, opened to 2 so it survives 16 px. */
  gap: 2,
} as const;

/**
 * Optical balance with Code at small sizes: an open, tilted ellipse reads
 * shorter and lighter than a bracket pair, so below 24 px Orbit is drawn a
 * little larger until it stands as tall as Code (12 px of ink at 16) beside
 * its label. The 24 master is the V3 drawing unchanged.
 */
const ORBIT_A: Record<GlyphSize, number> = { 16: 10.125, 20: 9.6, 24: ORBIT_CONSTRUCTION.a };

function orbitPaths(size: GlyphSize, stroke: number): string[] {
  const k = size / 24;
  const { ratio, tilt, gapAt, gap } = ORBIT_CONSTRUCTION;
  const a = ORBIT_A[size] * k;
  const b = a * ratio;
  const c = size / 2;
  const th = (tilt * Math.PI) / 180;
  const at = (tDeg: number): [number, number] => {
    const t = (tDeg * Math.PI) / 180;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    return [c + x * Math.cos(th) - y * Math.sin(th), c + x * Math.sin(th) + y * Math.cos(th)];
  };
  // The gap is the clear distance between the two round caps, measured straight
  // across (the chord between the arc ends, less one stroke), so it reads the
  // same however tightly the ellipse turns at that point.
  // At 16 px the clear gap is held at 1.5 px: a scaled 1.33 px gap fills in under antialiasing.
  const chord = (size === 16 ? 1.5 : gap * k) + stroke;
  const half = (g: number): number => {
    let lo = 0;
    let hi = 60;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      const p = at(g - mid);
      const q = at(g + mid);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < chord) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const span = (g: number): number => half(g);
  const out: string[] = [];
  for (const g of [gapAt, gapAt + 180]) {
    const start = g + span(g);
    const nextGap = g + 180;
    const end = nextGap - span(nextGap);
    const [x0, y0] = at(start);
    const [x1, y1] = at(end);
    // Each arc is a little under half the ellipse: large-arc 0, sweep 1 (increasing parameter is clockwise on screen).
    out.push(`M${f(x0)} ${f(y0)}A${f(a)} ${f(b)} ${f(tilt)} 0 1 ${f(x1)} ${f(y1)}`);
  }
  return out;
}

/** A square bracket opening toward the centre, with continuous corners of radius r. */
function bracket(stemX: number, top: number, bottom: number, armX: number, r: number): string {
  const dir = armX > stemX ? 1 : -1;
  const e = r * 1.18;
  const c = r * 0.32;
  return (
    `M${f(armX)} ${f(top)}H${f(stemX + dir * e)}C${f(stemX + dir * c)} ${f(top)} ${f(stemX)} ${f(top + c)} ${f(stemX)} ${f(top + e)}` +
    `V${f(bottom - e)}C${f(stemX)} ${f(bottom - c)} ${f(stemX + dir * c)} ${f(bottom)} ${f(stemX + dir * e)} ${f(bottom)}H${f(armX)}`
  );
}

/** Per-size bracket placements (px): stem centrelines put one stroke edge on a whole pixel. */
// The 24-unit drawing follows the V3 icon set's Code (stem 4.5, corner 2.25, cursor 8.25 to
// 15.75); each size moves stems and arms to its own pixel grid, and the arms stop short enough
// to keep the V3 drawing's clear gap (3 units at 24) across the half-pixel axis shift.
const CODE_GRID: Record<GlyphSize, { stroke: number; stem: number; top: number; bottom: number; arm: number; r: number; cursor: [number, number] }> = {
  16: { stroke: 1.25, stem: 2.625, top: 2.625, bottom: 13.375, arm: 6, r: 1.5, cursor: [5.5, 10.5] },
  20: { stroke: 1.5, stem: 3.75, top: 3.75, bottom: 16.25, arm: 7.5, r: 1.75, cursor: [7, 13] },
  24: { stroke: 1.5, stem: 4.75, top: 4.75, bottom: 19.25, arm: 9.25, r: 2.25, cursor: [8.25, 15.75] },
};

function codePaths(size: GlyphSize): string[] {
  const g = CODE_GRID[size];
  const mid = size / 2 - 0.5;
  const left = bracket(g.stem, g.top, g.bottom, g.arm, g.r);
  const right = bracket(2 * mid - g.stem, g.top, g.bottom, 2 * mid - g.arm, g.r);
  const cursor = `M${f(mid)} ${f(g.cursor[0])}V${f(g.cursor[1])}`;
  return [left, right, cursor];
}

const STROKE: Record<GlyphSize, number> = { 16: 1.25, 20: 1.5, 24: 1.5 };

export const ORBIT_GLYPH: Readonly<Record<GlyphSize, BrandGlyph>> = {
  16: { size: 16, stroke: STROKE[16], paths: orbitPaths(16, STROKE[16]) },
  20: { size: 20, stroke: STROKE[20], paths: orbitPaths(20, STROKE[20]) },
  24: { size: 24, stroke: STROKE[24], paths: orbitPaths(24, STROKE[24]) },
};

export const CODE_GLYPH: Readonly<Record<GlyphSize, BrandGlyph>> = {
  16: { size: 16, stroke: CODE_GRID[16].stroke, paths: codePaths(16) },
  20: { size: 20, stroke: CODE_GRID[20].stroke, paths: codePaths(20) },
  24: { size: 24, stroke: CODE_GRID[24].stroke, paths: codePaths(24) },
};

/** The master that suits a rendered size: 16 below 18 px, 20 below 22 px, else 24 (scaled). */
export function glyphSizeFor(size: number): GlyphSize {
  if (size < 18) return 16;
  if (size < 22) return 20;
  return 24;
}
