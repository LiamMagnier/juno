/**
 * Juno icons: the drawing primitives and the data format (design round 3).
 *
 * Pure data and pure functions: no JSX, no React, no imports. Plain Node can
 * import this file with type stripping only, which is what lets the native
 * generator (`scripts/generate-native-icons.mjs`) read the same drawings the
 * web renders. So: no enums, no namespaces, no parameter properties.
 *
 * THE GRID. A 24-unit box. The live area is 3 to 21. Key horizontals and
 * verticals sit on a 1.5-unit lattice; the renderer (index.tsx, fitDrawing)
 * then fits every straight stem and every point to the device pixel grid per
 * rendered size and pixel ratio, the way a font's hinting does. Every primary
 * silhouette encloses about 215 square units: a 15 unit square, a 16.5 unit
 * circle, a 12 x 18 page, an 18 x 12 landscape frame.
 *
 * THE LINE. One optical stroke: 1.25 px at 16, 1.5 px from 18 (the renderer
 * sets the width in units from the rendered size). Round caps and joins.
 *
 * THE HOUSE TRAITS (what makes a glyph Juno's rather than Lucide's):
 *   1. The gap. Where two parts meet or overlap, the front one is cut clear
 *      by 1.5 units (search's handle, the crew, customize's fader caps, the
 *      corner plus, the PDF label, offline's slash).
 *   2. Continuous corners on every container (rr), never plain arcs.
 *   3. Bracketed joins: a tab, a tail or a shoulder meets its edge in a soft
 *      S, the way Newsreader's serifs meet their stems (the folder, the bell).
 *   4. "New" is the thing with the house plus cut into its bottom-right
 *      corner (new chat, add member, connect).
 *   5. Small cuts: below 18 px a drawing may drop detail (IconSmallCut).
 * Points (the dot of an i, the knob of a slider) are filled circles, lines are
 * strokes; nothing else is filled except the "on" drawings.
 *
 * THE FORMAT mirrors `JunoGlyphDrawing` in `src/components/ui/juno-glyph-paths.ts`
 * (tag, attrs, children, knockout), plus the motion fields the web reads and
 * the native pipeline ignores (`hover`, `draw`, `part`).
 */

export type IconTag = "path" | "circle" | "rect" | "g";

/**
 * One hover articulation, applied to a `g` (a part). Lengths are grid units,
 * angles degrees. `o` is the transform origin in grid units. `rest` and `op`
 * are opacities at rest and on hover (for parts that appear, like the mic's
 * level ticks). `anim` names a one-shot keyframe in icons.css that plays once
 * on hover instead of a held pose; `x/y/r/s` then describe the pose a still
 * frame shows.
 */
export type IconMove = {
  x?: number;
  y?: number;
  r?: number;
  s?: number;
  sx?: number;
  sy?: number;
  o?: [number, number];
  rest?: number;
  op?: number;
  anim?: "swing" | "levels" | "wave" | "blink" | "caret" | "draw" | "pop" | "nod" | "spin" | "hop";
  delay?: number;
};

export type IconElement = {
  tag: IconTag;
  attrs: Record<string, string | number>;
  /** A `g`'s elements, in paint order. */
  children?: IconElement[];
  /** On a `g`: how it moves when its control is hovered. */
  hover?: IconMove;
  /**
   * Cut this shape out of everything painted before it: `true` grows the cut
   * by the stroke and the house gap (1.5 units each side), so a shape in front
   * stands clear of the one behind; "tight" cuts the shape and its own stroke
   * only (the eyes of a filled crew member). The attrs carry the cut's fill
   * and width too, so the native outliner subtracts the same region.
   */
  knockout?: boolean | "tight";
  /** Normalise the path length so the web can draw it in (check marks). */
  draw?: boolean;
};

export type IconOn =
  | { kind: "fill" }
  /** The glyph turns `deg` about `o` (grid units; default the centre) and holds there: plus to close, a chevron opening, the bell ringing. */
  | { kind: "turn"; deg: number; o?: [number, number] }
  | { kind: "swap"; to: string }
  | { kind: "draw" };

/**
 * The small optical cut: what a drawing becomes below 18 px, where a detail
 * smaller than about two device pixels turns to mud (the deck's chart). Only the listed layers change; the silhouette, the line and
 * the motion stay. The native projection maps it to the symbol's small scale.
 */
export type IconSmallCut = { elements?: IconElement[]; fill?: IconElement[] };

export type IconGroup =
  | "Navigation"
  | "Composer"
  | "Message"
  | "States"
  | "Files"
  | "Apps"
  | "Agents and time"
  | "Work and evidence"
  | "Code"
  | "Library"
  | "Arrows"
  | "Theme"
  | "System";

export type IconDrawing = {
  viewBox: 24;
  /** The house line in grid units at 24 px. The renderer overrides it per size. */
  line: 1.5;
  elements: IconElement[];
  /** The "on" drawing (a pinned pin, a starred star), shown for state="active". */
  fill?: IconElement[];
  /** What state="active" does. */
  on?: IconOn;
  /** A whole-glyph hover articulation (the glyph is one part). */
  hover?: IconMove;
  /** On hover, cross-fade to another drawing (the folder opens). */
  hoverSwap?: string;
  /** Below 18 px, these layers replace the regular ones (see IconSmallCut). */
  small?: IconSmallCut;
  group: IconGroup;
  /** One line for the gallery: what moves and why. */
  motion?: string;
  /** Drawn from a live value (progress): a control, not a symbol; the native projection skips it. */
  live?: true;
};

/* —————————————————————————————— Numbers —————————————————————————————— */

export const n3 = (n: number): number => Math.round(n * 1000) / 1000;
const fmt = (n: number): string => String(n3(n));
const P = (x: number, y: number): string => `${fmt(x)} ${fmt(y)}`;

/** A point on a circle; degrees clockwise from three o'clock (SVG's y is down). */
export function pt(cx: number, cy: number, r: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [n3(cx + r * Math.cos(t)), n3(cy + r * Math.sin(t))];
}

/** Rotate a point about (cx, cy). */
export function rot(x: number, y: number, cx: number, cy: number, deg: number): [number, number] {
  const t = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return [n3(cx + dx * Math.cos(t) - dy * Math.sin(t)), n3(cy + dx * Math.sin(t) + dy * Math.cos(t))];
}

/* —————————————————————————————— Path builders —————————————————————————————— */

/** An open polyline. */
export function poly(...xy: number[]): string {
  let d = "";
  for (let i = 0; i < xy.length; i += 2) d += `${i === 0 ? "M" : "L"}${P(xy[i], xy[i + 1])}`;
  return d;
}

/** A closed polygon. */
export function polygon(...xy: number[]): string {
  return `${poly(...xy)}Z`;
}

/** A polyline rotated about a centre (for glyphs drawn upright, then turned). */
export function polyRot(cx: number, cy: number, deg: number, ...xy: number[]): string {
  const out: number[] = [];
  for (let i = 0; i < xy.length; i += 2) out.push(...rot(xy[i], xy[i + 1], cx, cy, deg));
  return poly(...out);
}

/**
 * A rectangle with continuous corners: each corner starts curving at 1.18 r
 * from the vertex and its control points sit at 0.32 r, so curvature ramps in
 * instead of jumping (the difference between a squircle and a rounded rect).
 */
export function rr(x: number, y: number, w: number, h: number, r: number): string {
  const e = Math.min(r * 1.18, w / 2, h / 2);
  const c = r * 0.32;
  const x1 = x + w;
  const y1 = y + h;
  return (
    `M${P(x + e, y)}H${fmt(x1 - e)}C${P(x1 - c, y)} ${P(x1, y + c)} ${P(x1, y + e)}` +
    `V${fmt(y1 - e)}C${P(x1, y1 - c)} ${P(x1 - c, y1)} ${P(x1 - e, y1)}` +
    `H${fmt(x + e)}C${P(x + c, y1)} ${P(x, y1 - c)} ${P(x, y1 - e)}` +
    `V${fmt(y + e)}C${P(x, y + c)} ${P(x + c, y)} ${P(x + e, y)}Z`
  );
}

/** An arc on a circle from a0 to a1 (degrees clockwise from three o'clock). */
export function arc(cx: number, cy: number, r: number, a0: number, a1: number, move = true): string {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  const sweep = a1 > a0 ? 1 : 0;
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `${move ? `M${P(x0, y0)}` : ""}A${fmt(r)} ${fmt(r)} 0 ${large} ${sweep} ${P(x1, y1)}`;
}

/**
 * Two arms of an arrowhead meeting at (x, y), pointing along `dir` degrees,
 * each `arm` units long at 45 degrees to the shaft.
 */
export function head(x: number, y: number, dir: number, arm: number): string {
  const [ax, ay] = pt(x, y, arm, dir + 180 - 45);
  const [bx, by] = pt(x, y, arm, dir + 180 + 45);
  return poly(ax, ay, x, y, bx, by);
}

/**
 * A pencil: a tip at (tx, ty), a body `len` long along `deg`, `w` wide, the
 * cone `cone` long. Returns the outline and the ferrule line.
 */
export function pencil(tx: number, ty: number, deg: number, len: number, w: number, cone: number): string {
  const [bx, by] = pt(tx, ty, cone, deg);
  const [ex, ey] = pt(tx, ty, len, deg);
  const [nx, ny] = pt(0, 0, w / 2, deg + 90);
  return polygon(tx, ty, bx + nx, by + ny, ex + nx, ey + ny, ex - nx, ey - ny, bx - nx, by - ny);
}

/**
 * A crew member, flattened to a line: the gumdrop the 3D crew is sculpted
 * from (the Pebble and Dome bodies in crew/shapes.ts). A broad base with
 * soft corners, sides that rise and narrow a little, a domed top. `soft` is
 * the base corner as a share of the half width.
 */
export function gumdrop(cx: number, top: number, bottom: number, w: number, soft = 0.62): string {
  const hw = w / 2;
  const h = bottom - top;
  const rb = Math.min(hw * soft, h * 0.34);
  const k = 0.56;
  const shoulder = bottom - rb;
  const lift = (shoulder - top) * 0.56;
  const crown = 0.72;
  const right =
    `C${P(cx + hw - rb + rb * k, bottom)} ${P(cx + hw, bottom - rb * k)} ${P(cx + hw, shoulder)}` +
    `C${P(cx + hw, shoulder - lift)} ${P(cx + hw * crown, top)} ${P(cx, top)}`;
  const left =
    `C${P(cx - hw * crown, top)} ${P(cx - hw, shoulder - lift)} ${P(cx - hw, shoulder)}` +
    `C${P(cx - hw, bottom - rb * k)} ${P(cx - hw + rb - rb * k, bottom)} ${P(cx - hw + rb, bottom)}`;
  return `M${P(cx - hw + rb, bottom)}H${fmt(cx + hw - rb)}${right}${left}Z`;
}

/** A star of `n` points, outer radius R, inner radius r, point up. */
export function star(cx: number, cy: number, R: number, r: number, n = 5): string {
  const xy: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -90 + (i * 180) / n;
    xy.push(...pt(cx, cy, i % 2 === 0 ? R : r, a));
  }
  return polygon(...xy);
}

/** A gear: n teeth, tip radius R, root radius r, tooth half-angles at tip and root. */
export function gear(cx: number, cy: number, R: number, r: number, n: number, tipHalf: number, rootHalf: number): string {
  let d = "";
  const step = 360 / n;
  for (let i = 0; i < n; i++) {
    const c = -90 + i * step;
    const [ax, ay] = pt(cx, cy, r, c - rootHalf);
    const [bx, by] = pt(cx, cy, R, c - tipHalf);
    const [ex, ey] = pt(cx, cy, R, c + tipHalf);
    const [fx, fy] = pt(cx, cy, r, c + rootHalf);
    const [gx, gy] = pt(cx, cy, r, c + step - rootHalf);
    d += `${i === 0 ? "M" : "L"}${P(ax, ay)}L${P(bx, by)}A${fmt(R)} ${fmt(R)} 0 0 1 ${P(ex, ey)}L${P(fx, fy)}A${fmt(r)} ${fmt(r)} 0 0 1 ${P(gx, gy)}`;
  }
  return `${d}Z`;
}

/** Intersections of two circles (the upper one first when they are side by side). */
function meet(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): [[number, number], [number, number]] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r0 * r0 - a * a));
  const mx = x0 + (a * dx) / d;
  const my = y0 + (a * dy) / d;
  return [
    [n3(mx + (h * dy) / d), n3(my - (h * dx) / d)],
    [n3(mx - (h * dy) / d), n3(my + (h * dx) / d)],
  ];
}

/**
 * A cloud on a flat base at y = `base`: a left lobe, a tall middle lobe and a
 * right lobe, joined where their circles meet.
 */
export function cloud(left: number, right: number, base: number, top: number): string {
  const w = right - left;
  const rl = w * 0.2;
  const rr_ = w * 0.23;
  const lx = left + rl;
  const rx = right - rr_;
  const ly = base - rl;
  const ry = base - rr_;
  const rm = (base - top) * 0.56;
  const mx = left + w * 0.47;
  const my = top + rm;
  const [, lm] = meet(lx, ly, rl, mx, my, rm).sort((p, q) => p[1] - q[1]);
  const [mr] = meet(mx, my, rm, rx, ry, rr_).sort((p, q) => p[1] - q[1]);
  const lm2 = lm[1] < ly ? lm : [lx, ly - rl];
  return (
    `M${P(lx, base)}H${fmt(rx)}A${fmt(rr_)} ${fmt(rr_)} 0 0 0 ${P(mr[0], mr[1])}` +
    `A${fmt(rm)} ${fmt(rm)} 0 0 0 ${P(lm2[0], lm2[1])}A${fmt(rl)} ${fmt(rl)} 0 0 0 ${P(lx, base)}Z`
  );
}

/** A crescent: the circle (cx, cy, r) minus the circle (bx, by, br). */
export function crescent(cx: number, cy: number, r: number, bx: number, by: number, br: number): string {
  const [a, b] = meet(cx, cy, r, bx, by, br);
  return `M${P(a[0], a[1])}A${fmt(r)} ${fmt(r)} 0 1 0 ${P(b[0], b[1])}A${fmt(br)} ${fmt(br)} 0 0 1 ${P(a[0], a[1])}Z`;
}

/* —————————————————————————————— Elements —————————————————————————————— */

export function p(d: string, extra?: Partial<IconElement>): IconElement {
  return { tag: "path", attrs: { d }, ...extra };
}

export function c(cx: number, cy: number, r: number, extra?: Partial<IconElement>): IconElement {
  return { tag: "circle", attrs: { cx: n3(cx), cy: n3(cy), r: n3(r) }, ...extra };
}

/** A point: a filled circle with no stroke (the same size at every weight). */
export function dot(cx: number, cy: number, r = 1.125): IconElement {
  return { tag: "circle", attrs: { cx: n3(cx), cy: n3(cy), r: n3(r), fill: "currentColor", stroke: "none" } };
}

/** A filled shape that keeps the outline's silhouette (fill plus the same stroke). */
export function solid(d: string): IconElement {
  return { tag: "path", attrs: { d, fill: "currentColor" } };
}

export function solidCircle(cx: number, cy: number, r: number): IconElement {
  return { tag: "circle", attrs: { cx: n3(cx), cy: n3(cy), r: n3(r), fill: "currentColor" } };
}

export function g(children: IconElement[], hover?: IconMove): IconElement {
  return { tag: "g", attrs: {}, children, hover };
}

/** The house gap: what stands in front is cut clear of what is behind by this much, each side. */
export const GAP = 1.5;
/** A gapped cut's width in grid units: the line plus the gap on both sides. */
const CUT = 1.5 + GAP * 2;

/** Cut `d` (its fill, grown by the stroke and the house gap) out of everything painted before it. */
export function ko(d: string): IconElement {
  return { tag: "path", attrs: { d, fill: "black", strokeWidth: CUT }, knockout: true };
}

export function koCircle(cx: number, cy: number, r: number): IconElement {
  return { tag: "circle", attrs: { cx: n3(cx), cy: n3(cy), r: n3(r), fill: "black", strokeWidth: CUT }, knockout: true };
}

/** Cut `d` and its own stroke (plus 0.75, so the hole stays open at 16 px), no gap: a hole in a filled drawing. */
export function koTight(d: string): IconElement {
  return { tag: "path", attrs: { d, fill: "black", strokeWidth: 2.25 }, knockout: "tight" };
}

/* —————————————————————————————— Transforms —————————————————————————————— */

/**
 * Apply a point transform to an absolute path (M L H V C Q A Z). H and V become
 * L; arcs keep their radii (every arc here is circular) and flip their sweep
 * when the transform mirrors.
 */
export function xform(d: string, f: (x: number, y: number) => [number, number], mirror = false): string {
  const tokens = d.match(/[MLHVCQAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let cmd = "";
  let out = "";
  const num = () => Number(tokens[i++]);
  const put = (x: number, y: number) => {
    const [a, b] = f(x, y);
    return P(a, b);
  };
  while (i < tokens.length) {
    const t = tokens[i];
    if (/[MLHVCQAZ]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z") {
        out += "Z";
        continue;
      }
    }
    if (cmd === "M" || cmd === "L") {
      cx = num();
      cy = num();
      out += `${cmd}${put(cx, cy)}`;
      if (cmd === "M") cmd = "L";
    } else if (cmd === "H") {
      cx = num();
      out += `L${put(cx, cy)}`;
    } else if (cmd === "V") {
      cy = num();
      out += `L${put(cx, cy)}`;
    } else if (cmd === "C") {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      cx = num();
      cy = num();
      out += `C${put(x1, y1)} ${put(x2, y2)} ${put(cx, cy)}`;
    } else if (cmd === "Q") {
      const x1 = num();
      const y1 = num();
      cx = num();
      cy = num();
      out += `Q${put(x1, y1)} ${put(cx, cy)}`;
    } else if (cmd === "A") {
      const rx = num();
      const ry = num();
      const rotation = num();
      const large = num();
      const sweep = num();
      cx = num();
      cy = num();
      out += `A${fmt(rx)} ${fmt(ry)} ${fmt(rotation)} ${large} ${mirror ? 1 - sweep : sweep} ${put(cx, cy)}`;
    } else {
      i++;
    }
  }
  return out;
}

export const turn = (d: string, deg: number, cx = 12, cy = 12): string => xform(d, (x, y) => rot(x, y, cx, cy, deg));
export const flipY = (d: string, axis = 12): string => xform(d, (x, y) => [x, n3(2 * axis - y)], true);
export const flipX = (d: string, axis = 12): string => xform(d, (x, y) => [n3(2 * axis - x), y], true);
export const shift = (d: string, dx: number, dy: number): string => xform(d, (x, y) => [n3(x + dx), n3(y + dy)]);

/** A closed polygon whose corners are rounded by `r` (a quadratic through each vertex). */
export function roundPoly(r: number, ...xy: number[]): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]);
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i - 1 + n) % n];
    const [vx, vy] = pts[i];
    const [nx, ny] = pts[(i + 1) % n];
    const l1 = Math.hypot(px - vx, py - vy);
    const l2 = Math.hypot(nx - vx, ny - vy);
    const k1 = Math.min(r, l1 / 2) / l1;
    const k2 = Math.min(r, l2 / 2) / l2;
    const ax = vx + (px - vx) * k1;
    const ay = vy + (py - vy) * k1;
    const bx = vx + (nx - vx) * k2;
    const by = vy + (ny - vy) * k2;
    d += `${i === 0 ? "M" : "L"}${P(ax, ay)}Q${P(vx, vy)} ${P(bx, by)}`;
  }
  return `${d}Z`;
}

/* —————————————————————————————— Shared shapes —————————————————————————————— */

/** The page every file-type mark is drawn on: 12 x 18 with a 4.5 unit fold. */
const PAGE = "M13.5 3H8.25A2.25 2.25 0 0 0 6 5.25V18.75A2.25 2.25 0 0 0 8.25 21H15.75A2.25 2.25 0 0 0 18 18.75V7.5Z";
const FOLD = "M13.5 3V6A1.5 1.5 0 0 0 15 7.5H18";
const page = (...inner: IconElement[]): IconElement[] => [p(PAGE), p(FOLD), ...inner];

/** The 18 x 15 frame (sidebar, image, terminal, browser). */
const FRAME = rr(3, 4.5, 18, 15, 3);

const CHEVRON = poly(9.375, 6.75, 14.625, 12, 9.375, 17.25);
const ARROW_SHAFT = poly(4.5, 12, 19.5, 12);
const ARROW_HEAD = head(19.5, 12, 0, 7.425);

const BUBBLE = "M6.75 4.5H17.25A3 3 0 0 1 20.25 7.5V13.5A3 3 0 0 1 17.25 16.5H11.25L7.5 19.875V16.5H6.75A3 3 0 0 1 3.75 13.5V7.5A3 3 0 0 1 6.75 4.5Z";
/**
 * The folder: continuous corners, and a tab whose shoulder is a soft S (a
 * bracketed join, the way Newsreader's serifs meet their stems) instead of a
 * straight diagonal.
 */
/** A continuous corner (rr's construction) from the end of one edge to the start of the next; `dx, dy` point from the corner along the incoming edge. */
function corner(vx: number, vy: number, inX: number, inY: number, outX: number, outY: number, r: number): string {
  const e = r * 1.18;
  const k = r * 0.32;
  return `C${P(vx + inX * k, vy + inY * k)} ${P(vx + outX * k, vy + outY * k)} ${P(vx + outX * e, vy + outY * e)}`;
}
/** The tab's soft S, from the tab's top edge at x down to the body's top edge. */
const tabS = (x: number, yTab: number, yTop: number): string => {
  const s = (yTop - yTab) * 0.9;
  return `H${fmt(x)}C${P(x + s, yTab)} ${P(x + 1.25 * s - 0.6, yTop)} ${P(x + 2 * s, yTop)}`;
};
function folderBody(x0: number, x1: number, yTab: number, yTop: number, y1: number, tabEnd: number, r = 2.25): string {
  const e = r * 1.18;
  return (
    `M${P(x0, yTab + e)}${corner(x0, yTab, 0, 1, 1, 0, r)}${tabS(tabEnd, yTab, yTop)}H${fmt(x1 - e)}${corner(x1, yTop, -1, 0, 0, 1, r)}` +
    `V${fmt(y1 - e)}${corner(x1, y1, 0, -1, -1, 0, r)}H${fmt(x0 + e)}${corner(x0, y1, 1, 0, 0, -1, r)}Z`
  );
}
const FOLDER = folderBody(3.75, 20.25, 5.25, 7.5, 18.75, 8.25);
/** The open folder's back: up the left, over the tab, along the top, down to where the front leaf covers it. */
const FOLDER_BACK = `M3.75 18.75V${fmt(5.25 + 2.655)}${corner(3.75, 5.25, 0, 1, 1, 0, 2.25)}${tabS(8.25, 5.25, 7.5)}H${fmt(18.75 - 2.655)}${corner(18.75, 7.5, -1, 0, 0, 1, 2.25)}V10.5`;
/** The bell's shoulders are round, its waist straight, and its lip flares a little: cast, not extruded. */
const BELL = "M4.875 16.5C6 15.6 6.75 14.4 6.75 12.75V10.5A5.25 5.25 0 0 1 17.25 10.5V12.75C17.25 14.4 18 15.6 19.125 16.5";
const MIC = "M9 6.75A3 3 0 0 1 15 6.75V11.25A3 3 0 0 1 9 11.25Z";
const EYE = "M3 12C5.2 7.9 8.4 5.625 12 5.625C15.6 5.625 18.8 7.9 21 12C18.8 16.1 15.6 18.375 12 18.375C8.4 18.375 5.2 16.1 3 12Z";
const PIN = "M9.75 3.75V9L6.375 13.5H17.625L14.25 9V3.75";
const THUMB = "M7.5 10.5L10.6 4.45A1.8 1.8 0 0 1 14 5.55L13.4 9H18.35A1.9 1.9 0 0 1 20.2 11.35L18.8 17.95A2 2 0 0 1 16.85 19.5H7.5Z";
/** The sleeve: one bar standing the house gap off the hand (a cuff that shares the hand's edge is everyone else's thumb). */
const SLEEVE = poly(4.5, 11.25, 4.5, 18.75);
/*
 * The crew: two members on one ground line, the nearer one shorter, wider and
 * smiling at you. D-029 retired the two-dot face and D-034 drew the crew with
 * graphic eyes; at icon size those are closed arcs (the content, eyes-shut
 * smile), set low and wide, the way the cuteness rules in D-033 place them.
 * Nothing in the glyph can read as a pair of staring dots.
 */
const CREW_FRONT = gumdrop(9, 8.25, 20.25, 12.75);
const CREW_BACK = gumdrop(15.375, 5.25, 20.25, 11.25);
/** Closed eyes: two upper half circles, `apart` between their centres. */
const smile = (cx: number, y: number, apart: number, r = 1.125): string => `${arc(cx - apart / 2, y, r, 180, 360)}${arc(cx + apart / 2, y, r, 180, 360)}`;
const CREW_EYES = smile(9, 15, 5.25);
const MEMBER = gumdrop(10.5, 5.625, 20.25, 14.25);
const MEMBER_EYES = smile(10.5, 13.125, 6, 1.3);
/** One hop: up a unit and a half and down, once (hello). */
const hop = { anim: "hop" as const, y: -1.25 };
/** The house plus, for a corner: arms `a` either side of (cx, cy). */
const plusAt = (cx: number, cy: number, a = 3): string => `${poly(cx, cy - a, cx, cy + a)}${poly(cx - a, cy, cx + a, cy)}`;
const SLASH = poly(4.5, 4.5, 19.5, 19.5);
/** A cloud on a flat base: a right lobe, a tall middle lobe, a left lobe. */
const CLOUD = "M7.125 18.75H17.25A3.75 3.75 0 0 0 17.9 11.31A5.625 5.625 0 0 0 7.05 10.6A4.125 4.125 0 0 0 7.125 18.75Z";
const PLAY = roundPoly(1.6, 8.25, 5.25, 19.5, 12, 8.25, 18.75);
const HAND =
  "M8.25 20.25C6.9 19.4 6.2 18.4 5.5 17.1L3.9 14.25A1.5 1.5 0 0 1 6.3 12.6L6.75 13.35V8.25A1.875 1.875 0 0 1 10.5 8.25V12" +
  "V6A1.875 1.875 0 0 1 14.25 6V12V7.5A1.875 1.875 0 0 1 18 7.5V15C18 18 16.2 20.25 13.5 20.25Z";

/**
 * The library shelf: one volume standing on the shelf line (the shelf is its
 * bottom edge), and one leaning, resting on its own corner. No spine bands:
 * at 16 px a band made the pair read as "0lb". The two stand a house gap
 * apart at the top, so they never merge into one blob.
 */
const SHELF_Y = 19.5;
const LEAN = -12;
const UPRIGHT = `M${P(3.75, SHELF_Y)}V${fmt(4.5 + 1.77)}${corner(3.75, 4.5, 0, 1, 1, 0, 1.5)}H${fmt(9 - 1.77)}${corner(9, 4.5, -1, 0, 0, 1, 1.5)}V${fmt(SHELF_Y)}`;
const leanBook = (() => {
  const q = (x: number, y: number) => rot(x, y, 15, SHELF_Y, LEAN);
  const [ax, ay] = q(15, SHELF_Y);
  const [bx, by] = q(20.25, SHELF_Y);
  const [cx_, cy_] = q(20.25, SHELF_Y - 12);
  const [dx, dy] = q(15, SHELF_Y - 12);
  return roundPoly(1.5, ax, ay, bx, by, cx_, cy_, dx, dy);
})();

const PLUG = ["M7.5 9H16.5V12A4.5 4.5 0 0 1 7.5 12Z", poly(9.75, 9, 9.75, 4.5), poly(14.25, 9, 14.25, 4.5), poly(12, 16.5, 12, 20.25)];

/** Undo: the shaft leaves to the left from the hook's top and the hook turns back under it (a U-turn, the way the state goes). */
const UNDO = "M4.5 8.25H14.25A5.25 5.25 0 0 1 14.25 18.75H9.75";
const UNDO_HEAD = head(4.5, 8.25, 180, 4.773);
/** Return: down the right side, round the corner, out to the left. */
const ENTER = "M18.75 6V12A3 3 0 0 1 15.75 15H5.25";
const ENTER_HEAD = head(5.25, 15, 180, 4.773);
/** The clock's hands, shared by routine and history. */
const HANDS = poly(12, 8.25, 12, 12, 14.625, 13.5);
/** The bell's parts, so the muted bell is the bell. */
const BELL_PARTS = [BELL, poly(4.5, 16.5, 19.5, 16.5), poly(10.125, 19.5, 13.875, 19.5)];
/** The pin's parts, so the unpin is the pin. */
const PIN_PARTS = [poly(8.25, 3.75, 15.75, 3.75), PIN, poly(12, 13.5, 12, 20.25)];

/* —————————————————————————————— Alevr shapes (revision 1, the brand overlay) —————————————————————————————— */

/**
 * An arc of the ellipse (cx, cy) with semi-axes a and b whose major axis is
 * turned `phi` degrees (negative rises to the right), from parameter t0 to t1
 * (degrees; increasing runs clockwise on screen).
 */
export function ellArc(cx: number, cy: number, a: number, b: number, phi: number, t0: number, t1: number): string {
  const f = (phi * Math.PI) / 180;
  const at = (t: number): [number, number] => {
    const r = (t * Math.PI) / 180;
    const x = a * Math.cos(r);
    const y = b * Math.sin(r);
    return [n3(cx + x * Math.cos(f) - y * Math.sin(f)), n3(cy + x * Math.sin(f) + y * Math.cos(f))];
  };
  const [x0, y0] = at(t0);
  const [x1, y1] = at(t1);
  const large = Math.abs(t1 - t0) > 180 ? 1 : 0;
  const sweep = t1 > t0 ? 1 : 0;
  return `M${P(x0, y0)}A${fmt(a)} ${fmt(b)} ${fmt(phi)} ${large} ${sweep} ${P(x1, y1)}`;
}

/**
 * Orbit, Alevr's agent workspace: one ellipse in the board's construction
 * (b = 0.618 a), its major axis rising, drawn as two open arcs that never
 * meet. Each arc is the other turned half a turn (equilibrium), so the glyph
 * has no start and no end to chase: it can never read as a spinner.
 */
const ORBIT_A = 9.375;
const ORBIT_B = n3(ORBIT_A * 0.618);
const ORBIT_TILT = -24;
const orbitArcs = (gapA: number, gapB: number): string[] => [
  ellArc(12, 12, ORBIT_A, ORBIT_B, ORBIT_TILT, 180 + gapA, 360 - gapB),
  ellArc(12, 12, ORBIT_A, ORBIT_B, ORBIT_TILT, gapA, 180 - gapB),
];

/** Code: opposed square brackets with continuous corners; the cursor stands inset between them. */
const BRACKET = `M9.75 4.5H${fmt(4.5 + 2.655)}${corner(4.5, 4.5, 1, 0, 0, 1, 2.25)}V${fmt(19.5 - 2.655)}${corner(4.5, 19.5, 0, -1, 1, 0, 2.25)}H9.75`;
const CURSOR = poly(12, 8.25, 12, 15.75);

/** A simple person: head and shoulders, the house gap between them. */
const HEAD = [12, 8.25, 3.75] as const;
const SHOULDERS = "M4.875 20.25C4.875 17.1 8.1 15 12 15C15.9 15 19.125 17.1 19.125 20.25";

/** A rectangle turned `deg` about (ox, oy), its corners rounded by r (roundPoly: a turned rectangle has no straight stems to fit). */
const turnedRect = (x: number, y: number, w: number, h: number, r: number, deg: number, ox: number, oy: number): string => {
  const q = (px: number, py: number) => rot(px, py, ox, oy, deg);
  return roundPoly(r, ...q(x, y), ...q(x + w, y), ...q(x + w, y + h), ...q(x, y + h));
};

/**
 * Memory: recall cards, held fanned. The one in front is upright and carries
 * what is remembered; the one behind leans, its top and its side showing,
 * the way the library's second volume leans (things you keep lean). Copy is
 * two sheets offset, versions a cascade; neither leans.
 */
const MEM_FRONT = rr(3.75, 8.25, 11.25, 12.75, 2.25);
/** Leaning right, as the library's second volume does (copy's second sheet sits up and left, square). */
const MEM_BACK = flipX(turnedRect(5.25, 4.125, 11.25, 12.75, 2.1, -10, 10.875, 10.5));
/** The back card leans further from its foot (its lower right corner) on hover. */
const MEM_PIVOT: [number, number] = [17.25, 18];
const MEM_LINES = [poly(6.75, 12.75, 12, 12.75), poly(6.75, 16.5, 9.75, 16.5)];

/** Instructions: a ruled sheet (no fold: it is not a file) whose last line is set in. */
const SHEET_RULED = rr(5.25, 3, 13.5, 18, 2.25);

/** A small microphone for dictation, beside the insertion cursor. */
const MIC_SMALL = "M6.75 6A3 3 0 0 1 12.75 6V10.5A3 3 0 0 1 6.75 10.5Z";
/** The text cursor: a stem with two serifs (the I-beam), Newsreader's own construction at icon size. */
const ibeam = (x: number, y0: number, y1: number, w = 3): string =>
  `${poly(x, y0, x, y1)}${poly(x - w / 2, y0, x + w / 2, y0)}${poly(x - w / 2, y1, x + w / 2, y1)}`;

/** Plan: a checked step. */
const tick = (cy: number): string => poly(3.75, cy, 5.625, cy + 1.875, 9, cy - 1.5);

/** Receipt: a slip with continuous top corners and a torn (folded) foot. */
const SLIP = `M5.25 21V${fmt(3 + 2.655)}${corner(5.25, 3, 0, 1, 1, 0, 2.25)}H${fmt(18.75 - 2.655)}${corner(18.75, 3, -1, 0, 0, 1, 2.25)}V21L16.5 19.5L14.25 21L12 19.5L9.75 21L7.5 19.5Z`;

/** Sources: a pair of pages, a house gap apart at the spine. */
const LEAF = "M10.5 6.375C8.9 5.3 6.4 4.95 3.75 5.25V18.375C6.4 18.075 8.9 18.4 10.5 19.5Z";

/** Citation: one typographic quotation mark, a filled head with a rising tail (Newsreader's 66). */
const quote = (cx: number, cy: number): IconElement[] => [dot(cx, cy, 2.625), p(`M${P(cx - 2.625, cy)}C${P(cx - 2.625, cy - 3.6)} ${P(cx - 1.2, cy - 6.4)} ${P(cx + 1.5, cy - 8.1)}`)];

/** The eye as it sits inside a frame (preview). */
const ALMOND = "M6.75 12C8.25 9.75 10 8.625 12 8.625C14 8.625 15.75 9.75 17.25 12C15.75 14.25 14 15.375 12 15.375C10 15.375 8.25 14.25 6.75 12Z";

/** Bookmark: a ribbon with continuous top corners and a notched foot. */
const RIBBON = `M6.75 20.25V${fmt(3.75 + 2.655)}${corner(6.75, 3.75, 0, 1, 1, 0, 2.25)}H${fmt(17.25 - 2.655)}${corner(17.25, 3.75, -1, 0, 0, 1, 2.25)}V20.25L12 16.125Z`;

/** Apps: two framed tiles, connected by two quarter paths (Alevr's curved paths, not a flowchart elbow). */
const TILE_A = rr(3.75, 3.75, 7.5, 7.5, 2.25);
const TILE_B = rr(12.75, 12.75, 7.5, 7.5, 2.25);


/**
 * Folio (D-038, "What Alevr made"): one sheet folded once, standing open and
 * seen from a little above, so the fold runs to a point at its foot. Straight
 * leaves on one crease (sources is a pair of separate, curved pages).
 */
const FOLIO = roundPoly(1.2, 12, 6, 20.25, 3.75, 20.25, 18.75, 12, 21, 3.75, 18.75, 3.75, 3.75);
const FOLIO_CREASE = poly(12, 6, 12, 21);
/**
 * Deep Field (D-038, "Deep research"): one long look into a field. The
 * viewfinder's corners hold four points of falling size, set on a spiral so
 * they read as found, not scattered (no starfield: four points, one frame).
 */
const FIELD_CORNERS = [
  "M3.75 8.25V6.75A3 3 0 0 1 6.75 3.75H8.25",
  "M15.75 3.75H17.25A3 3 0 0 1 20.25 6.75V8.25",
  "M20.25 15.75V17.25A3 3 0 0 1 17.25 20.25H15.75",
  "M8.25 20.25H6.75A3 3 0 0 1 3.75 17.25V15.75",
];

/* —————————————————————————————— The set —————————————————————————————— */

const I = (d: Omit<IconDrawing, "viewBox" | "line">): IconDrawing => ({ viewBox: 24, line: 1.5, ...d });


export const ICONS = {
  /* ——— Navigation ——— */
  chat: I({
    group: "Navigation",
    elements: [p(BUBBLE)],
    fill: [solid(BUBBLE)],
    on: { kind: "fill" },
    hover: { s: 1.07, o: [7.5, 19.875], anim: "pop" },
    motion: "The bubble speaks: a small pop from the tail.",
  }),
  orbit: I({
    group: "Navigation",
    elements: orbitArcs(18, 18).map((d) => p(d)),
    motion: "None, ever: Orbit's glyph is static (it must never read as a spinner or a loading orbit). Selection is tonal, on the row.",
  }),
  code: I({
    group: "Navigation",
    elements: [g([p(BRACKET)], { x: -1 }), g([p(flipX(BRACKET))], { x: 1 }), p(CURSOR)],
    motion: "Alevr Code: opposed brackets with the cursor inset between them. The brackets open a unit each way; the cursor holds still.",
  }),
  "new-chat": I({
    group: "Navigation",
    elements: [p(BUBBLE), ko(plusAt(18.75, 17.25, 2.625)), p(plusAt(18.75, 17.25, 2.625))],
    hover: { s: 1.07, o: [7.5, 19.875], anim: "pop" },
    motion: "A new chat is the chat bubble with the house plus cut into its corner. It speaks: a small pop from the tail.",
  }),
  search: I({
    group: "Navigation",
    elements: [c(10.125, 10.125, 6.375), p(poly(17.063, 17.063, 20.25, 20.25))],
    hover: { r: -14, o: [10.125, 10.125] },
    motion: "The handle stands a house gap off the lens (Juno's join). The lens tilts about its own centre, so only the handle swings.",
  }),
  folder: I({
    group: "Navigation",
    elements: [p(FOLDER)],
    fill: [solid(FOLDER)],
    on: { kind: "fill" },
    hoverSwap: "folder-open",
    motion: "The folder opens (a cross-fade to its open drawing).",
  }),
  "folder-open": I({
    group: "Navigation",
    elements: [p(FOLDER_BACK), g([p(roundPoly(1.2, 6.75, 10.5, 20.625, 10.5, 17.25, 18.75, 3.75, 18.75))], { y: -0.5 })],
    motion: "The front leaf lifts half a unit.",
  }),
  library: I({
    group: "Navigation",
    elements: [p(poly(3, SHELF_Y, 21, SHELF_Y)), p(UPRIGHT), g([p(leanBook)], { r: -LEAN, o: [15, SHELF_Y], y: -1 })],
    motion: "The leaning volume straightens and lifts, as a book comes off the shelf.",
  }),
  customize: I({
    group: "Navigation",
    elements: [
      p(poly(4.5, 7.5, 19.5, 7.5)),
      p(poly(4.5, 16.5, 19.5, 16.5)),
      { ...ko(rr(13.875, 4.875, 2.25, 5.25, 1.125)), hover: { x: -2.25 } },
      g([solid(rr(13.875, 4.875, 2.25, 5.25, 1.125))], { x: -2.25 }),
      { ...ko(rr(7.875, 13.875, 2.25, 5.25, 1.125)), hover: { x: 2.25 } },
      g([solid(rr(7.875, 13.875, 2.25, 5.25, 1.125))], { x: 2.25 }),
    ],
    motion: "Two faders, their caps cut clear of the track by the house gap. The caps slide toward each other.",
  }),
  crew: I({
    group: "Navigation",
    elements: [
      g([p(CREW_BACK)], { y: -0.75 }),
      { ...ko(CREW_FRONT), hover: hop },
      g([p(CREW_FRONT), p(CREW_EYES)], hop),
    ],
    fill: [g([solid(CREW_BACK)], { y: -0.75 }), { ...ko(CREW_FRONT), hover: hop }, g([solid(CREW_FRONT), koTight(CREW_EYES)], hop)],
    on: { kind: "fill" },
    motion: "The one behind stands up; the one in front, eyes closed in a smile, hops once: hello.",
  }),
  bell: I({
    group: "Navigation",
    elements: BELL_PARTS.map((d) => p(d)),
    fill: [solid(`${BELL}Z`), p(BELL_PARTS[1]), p(BELL_PARTS[2])],
    on: { kind: "turn", deg: 14, o: [12, 4.5] },
    hover: { r: 10, o: [12, 4.5], anim: "swing" },
    motion: "One swing from the hanger, damped, then still. Active (something new): it holds the swing, tilted as it rings, at its usual weight. Never a fill or a dot.",
  }),
  sidebar: I({
    group: "Navigation",
    elements: [p(FRAME), g([p(poly(9, 4.5, 9, 19.5))], { x: -1.5 })],
    motion: "The divider slides toward the edge the panel hides into.",
  }),
  "panel-right": I({
    group: "Navigation",
    elements: [p(FRAME), g([p(poly(15, 4.5, 15, 19.5))], { x: 1.5 })],
    motion: "The divider slides toward the right edge.",
  }),
  settings: I({
    group: "Navigation",
    elements: [p(gear(12, 12, 8.625, 6.6, 6, 11, 19)), c(12, 12, 2.625)],
    hover: { r: 30, o: [12, 12] },
    motion: "The gear turns half a tooth.",
  }),
  account: I({
    group: "Navigation",
    elements: [
      c(12, 12, 8.25),
      g([c(12, 9.375, 2.625)], { y: -0.75 }),
      p("M6.9 18.4C8 16.2 9.8 15 12 15C14.2 15 16 16.2 17.1 18.4"),
    ],
    motion: "The head lifts, a small nod up.",
  }),
  help: I({
    group: "Navigation",
    elements: [
      c(12, 12, 8.25),
      g([p("M9.375 9.75A2.625 2.625 0 1 1 13.31 12.02C12.55 12.46 12 13.05 12 14.06"), dot(12, 16.875)], { r: 12, o: [12, 13.5] }),
    ],
    motion: "The question mark tilts its head.",
  }),
  menu: I({
    group: "Navigation",
    elements: [p(poly(4.5, 8.25, 19.5, 8.25)), g([p(poly(4.5, 15.75, 12.75, 15.75))], { sx: 1.818, o: [4.5, 15.75] })],
    motion: "A long line over a short one (never an equals sign); the short one runs out to full length, as the panel it opens.",
  }),
  more: I({
    group: "Navigation",
    elements: [g([dot(6, 12, 1.5)], { x: -0.75 }), dot(12, 12, 1.5), g([dot(18, 12, 1.5)], { x: 0.75 })],
    motion: "The outer points step apart.",
  }),
  "more-vertical": I({
    group: "Navigation",
    elements: [g([dot(12, 6, 1.5)], { y: -0.75 }), dot(12, 12, 1.5), g([dot(12, 18, 1.5)], { y: 0.75 })],
    motion: "The outer points step apart.",
  }),

  /* ——— Composer ——— */
  plus: I({
    group: "Composer",
    elements: [p(poly(12, 5.25, 12, 18.75)), p(poly(5.25, 12, 18.75, 12))],
    on: { kind: "turn", deg: 45 },
    motion: "No hover pose (a quarter turn lands where it started and steals the real turn). Active: turns 45 degrees into a close.",
  }),
  attach: I({
    group: "Composer",
    elements: [p(turn("M10.5 9V15A1.5 1.5 0 0 0 13.5 15V6.75A3 3 0 0 0 7.5 6.75V15.75A4.5 4.5 0 0 0 16.5 15.75V8.25", 40))],
    hover: { r: -10, o: [12, 12] },
    motion: "The clip tilts as if sliding onto a page.",
  }),
  image: I({
    group: "Composer",
    elements: [
      p(FRAME),
      p(poly(3, 15.75, 7.5, 11.25, 15.75, 19.5)),
      p(poly(13.125, 16.875, 17.25, 12.75, 21, 16.5)),
      g([c(15.75, 8.625, 1.875)], { y: -1 }),
    ],
    motion: "The sun rises a unit.",
  }),
  screenshot: I({
    group: "Composer",
    elements: [
      g([p("M3 8.25V6A3 3 0 0 1 6 3H8.25")], { x: 0.75, y: 0.75 }),
      g([p("M15.75 3H18A3 3 0 0 1 21 6V8.25")], { x: -0.75, y: 0.75 }),
      g([p("M21 15.75V18A3 3 0 0 1 18 21H15.75")], { x: -0.75, y: -0.75 }),
      g([p("M8.25 21H6A3 3 0 0 1 3 18V15.75")], { x: 0.75, y: -0.75 }),
    ],
    motion: "The corners close in on the capture.",
  }),
  at: I({
    group: "Composer",
    elements: [c(12, 12, 3.75), p(`M15.75 8.25V13.125A2.25 2.25 0 0 0 20.25 13.125V12${arc(12, 12, 8.25, 0, -306, false)}`)],
    hover: { r: -18, o: [12, 12] },
    motion: "The tail winds back a little.",
  }),
  skill: I({
    group: "Apps",
    elements: page(g([p(poly(13.125, 10.875, 10.875, 17.625))], { r: 16, o: [12, 14.25] })),
    motion: "A folded sheet you can use again, with the slash that runs it. The slash leans in, like a key being struck.",
  }),
  mic: I({
    group: "Composer",
    elements: [
      p(MIC),
      p("M6 11.25A6 6 0 0 0 18 11.25"),
      p(poly(12, 17.25, 12, 20.25)),
      g([p(poly(3, 7.5, 3, 10.5))], { rest: 0, op: 1 }),
      g([p(poly(21, 7.5, 21, 10.5))], { rest: 0, op: 1, delay: 60 }),
    ],
    on: { kind: "swap", to: "voice" },
    motion: "Two level ticks appear beside it. Active: becomes the level meter.",
  }),
  voice: I({
    group: "Composer",
    elements: [
      g([p(poly(4.5, 9.75, 4.5, 14.25))], { sy: 0.6, o: [4.5, 12], anim: "levels", delay: 0 }),
      g([p(poly(8.25, 7.5, 8.25, 16.5))], { sy: 1.25, o: [8.25, 12], anim: "levels", delay: 30 }),
      g([p(poly(12, 4.5, 12, 19.5))], { sy: 0.7, o: [12, 12], anim: "levels", delay: 60 }),
      g([p(poly(15.75, 7.5, 15.75, 16.5))], { sy: 1.2, o: [15.75, 12], anim: "levels", delay: 90 }),
      g([p(poly(19.5, 9.75, 19.5, 14.25))], { sy: 0.7, o: [19.5, 12], anim: "levels", delay: 120 }),
    ],
    motion: "One pass of levels runs across the bars, then they rest. With `levels`, the bars follow the input.",
  }),
  send: I({
    group: "Composer",
    elements: [p(poly(12, 19.5, 12, 5.25)), p(head(12, 5.25, -90, 7.425))],
    hover: { y: -1.5 },
    on: { kind: "swap", to: "stop" },
    motion: "Lifts one and a half units. Active: becomes stop.",
  }),
  stop: I({
    group: "Composer",
    elements: [solid(rr(7.5, 7.5, 9, 9, 2.25))],
    hover: { s: 0.9, o: [12, 12] },
    motion: "Presses in slightly.",
  }),
  globe: I({
    group: "Composer",
    elements: [
      c(12, 12, 8.25),
      p(poly(3.75, 12, 20.25, 12)),
      g([p("M12 3.75C14.3 5.8 15.6 8.8 15.6 12C15.6 15.2 14.3 18.2 12 20.25C9.7 18.2 8.4 15.2 8.4 12C8.4 8.8 9.7 5.8 12 3.75Z")], { sx: 0.45, o: [12, 12] }),
    ],
    motion: "The meridian turns edge-on, as the globe rotates.",
  }),
  memory: I({
    group: "Composer",
    elements: [g([p(MEM_BACK)], { r: 6, o: MEM_PIVOT }), ko(MEM_FRONT), p(MEM_FRONT), ...MEM_LINES.map((d) => p(d))],
    fill: [g([p(MEM_BACK)], { r: 6, o: MEM_PIVOT }), ko(MEM_FRONT), solid(MEM_FRONT), ...MEM_LINES.map((d) => koTight(d))],
    on: { kind: "fill" },
    motion: "Layered recall cards, held fanned: what Alevr remembers (not a third save mark beside pin and star, not a brain). The card behind leans further back, as you look back through them. Active (memory on): the front card fills, its lines cut through.",
  }),
  research: I({
    group: "Composer",
    elements: [
      p(rr(3.75, 3, 11.25, 15, 2.25)),
      p(poly(7.5, 7.5, 11.25, 7.5)),
      { ...koCircle(15.375, 14.625, 4.125), hover: { x: -0.75, y: -0.75 } },
      g([c(15.375, 14.625, 4.125), p(poly(18.292, 17.542, 20.25, 19.5))], { x: -0.75, y: -0.75 }),
    ],
    motion: "A lens over a page, not the bare search lens: it reads its way up the page.",
  }),
  auto: I({
    group: "Composer",
    elements: [p(arc(12, 13.125, 8.25, 150, 390)), g([p(poly(12, 13.125, ...pt(12, 13.125, 5.625, -150)))], { r: 95, o: [12, 13.125] }), dot(12, 13.125, 1.5)],
    motion: "The needle sweeps across the dial: Juno picks the model.",
  }),

  /* ——— Message actions ——— */
  copy: I({
    group: "Message",
    elements: [
      g([p(rr(3, 3, 12, 12, 2.25))], { x: -0.75, y: -0.75 }),
      ko(rr(9, 9, 12, 12, 2.25)),
      p(rr(9, 9, 12, 12, 2.25)),
    ],
    on: { kind: "swap", to: "check" },
    motion: "Two sheets, the front one cut clear of the back by the house gap. The sheet behind steps out. Active: becomes a check that draws itself, once.",
  }),
  check: I({
    group: "Message",
    elements: [p(poly(5.25, 12.75, 9.75, 17.25, 18.75, 6.75), { draw: true })],
    on: { kind: "draw" },
    motion: "Active: the stroke draws itself in.",
  }),
  "thumbs-up": I({
    group: "Message",
    elements: [p(THUMB), p(SLEEVE)],
    fill: [solid(THUMB), p(SLEEVE)],
    on: { kind: "fill" },
    hover: { r: -8, o: [7.5, 19.5] },
    motion: "The thumb tips up. Active: filled.",
  }),
  "thumbs-down": I({
    group: "Message",
    elements: [p(flipY(THUMB)), p(flipY(SLEEVE))],
    fill: [solid(flipY(THUMB)), p(flipY(SLEEVE))],
    on: { kind: "fill" },
    hover: { r: 8, o: [7.5, 4.5] },
    motion: "The thumb tips down. Active: filled.",
  }),
  retry: I({
    group: "Message",
    elements: [p(arc(12, 12, 7.5, 130, -150)), p(head(...pt(12, 12, 7.5, -150), 120, 4.5))],
    hover: { r: -40, o: [12, 12] },
    motion: "Winds back forty degrees, the way it points, and holds; never a full turn (that is a spinner).",
  }),
  edit: I({
    group: "Message",
    elements: [p(pencil(4.5, 19.5, -45, 19.4, 4.2, 4.2)), p(poly(...pt(...pt(4.5, 19.5, 15.4, -45), 2.1, 45), ...pt(...pt(4.5, 19.5, 15.4, -45), 2.1, 225)))],
    hover: { r: -7, o: [4.5, 19.5] },
    motion: "The pencil rocks on its tip.",
  }),
  share: I({
    group: "Message",
    elements: [
      p("M9 9H7.5A2.25 2.25 0 0 0 5.25 11.25V18.75A2.25 2.25 0 0 0 7.5 21H16.5A2.25 2.25 0 0 0 18.75 18.75V11.25A2.25 2.25 0 0 0 16.5 9H15"),
      g([p(poly(12, 14.25, 12, 3)), p(head(12, 3, -90, 4.773))], { y: -1.25 }),
    ],
    motion: "The arrow rises out of the box.",
  }),
  "read-aloud": I({
    group: "Message",
    elements: [
      p(roundPoly(0.9, 3.75, 9, 7.5, 9, 11.25, 5.25, 11.25, 18.75, 7.5, 15, 3.75, 15)),
      g([p(arc(11.625, 12, 3.75, -48, 48))], { anim: "wave", delay: 0 }),
      g([p(arc(11.625, 12, 7.125, -48, 48))], { anim: "wave", delay: 80 }),
    ],
    motion: "The two waves sound once, near then far.",
  }),
  fork: I({
    group: "Message",
    elements: [
      p(poly(12, 20.25, 12, 14.25)),
      p("M12 14.25C12 10.5 6.375 10.5 6.375 5.25"),
      p(head(6.375, 4.5, -90, 3.182)),
      g([p("M12 14.25C12 10.5 17.625 10.5 17.625 5.25", { draw: true }), p(head(17.625, 4.5, -90, 3.182), { draw: true })], { anim: "draw" }),
    ],
    motion: "The new branch draws itself off the stem.",
  }),

  /* ——— States ——— */
  hand: I({
    group: "States",
    elements: [p(HAND)],
    fill: [solid(HAND), koTight(`${poly(10.5, 6.75, 10.5, 12)}${poly(14.25, 6.375, 14.25, 12)}`)],
    on: { kind: "fill" },
    hover: { r: -8, o: [11.25, 20.25], anim: "nod" },
    motion: "A small wave from the wrist, once.",
  }),
  alert: I({
    group: "States",
    elements: [c(12, 12, 8.25), p(poly(12, 7.5, 12, 12.75)), dot(12, 16.125)],
    motion: "None: a state is read, not played.",
  }),
  info: I({
    group: "States",
    elements: [c(12, 12, 8.25), dot(12, 7.875), p(poly(12, 11.25, 12, 16.5))],
    motion: "None.",
  }),
  success: I({
    group: "States",
    elements: [c(12, 12, 8.25), p(poly(8.25, 12.375, 10.875, 15, 15.75, 9.375), { draw: true })],
    on: { kind: "draw" },
    motion: "Active: the check draws itself in.",
  }),
  warning: I({
    group: "States",
    elements: [p(roundPoly(2, 12, 4.125, 20.625, 19.5, 3.375, 19.5)), p(poly(12, 10.125, 12, 14.25)), dot(12, 16.875)],
    motion: "None.",
  }),
  lock: I({
    group: "States",
    elements: [p(rr(5.25, 10.5, 13.5, 9.75, 2.25)), g([p("M8.25 10.5V7.5A3.75 3.75 0 0 1 15.75 7.5V10.5")], { y: -0.75 }), p(poly(12, 14.25, 12, 16.5))],
    motion: "The shackle rises a little.",
  }),
  unlock: I({
    group: "States",
    elements: [p(rr(5.25, 10.5, 13.5, 9.75, 2.25)), g([p(`M8.25 10.5V7.5${arc(12, 7.5, 3.75, 180, 330, false)}`)], { y: -0.75 }), p(poly(12, 14.25, 12, 16.5))],
    motion: "The shackle rises a little.",
  }),
  offline: I({
    group: "States",
    elements: [p(CLOUD), ko(SLASH), p(SLASH)],
    motion: "None.",
  }),
  progress: I({
    group: "States",
    live: true,
    elements: [c(12, 12, 7.5, { attrs: { cx: 12, cy: 12, r: 7.5, opacity: 0.3 } }), c(12, 12, 7.5, { attrs: { cx: 12, cy: 12, r: 7.5, pathLength: 1, strokeDasharray: "0.3 1", transform: "rotate(-90 12 12)" } })],
    motion: "None: `value` sets the arc. It never spins.",
  }),
  circle: I({
    group: "States",
    elements: [c(12, 12, 7.5)],
    motion: "None.",
  }),

  /* ——— Files ——— */
  document: I({
    group: "Files",
    elements: page(p(poly(9, 12, 15, 12)), p(poly(9, 15.75, 13.5, 15.75))),
    motion: "None: files are marks, not controls.",
  }),
  sheet: I({
    group: "Files",
    elements: [p(rr(3.75, 4.5, 16.5, 15, 3)), p(poly(3.75, 9.75, 20.25, 9.75)), p(poly(3.75, 14.25, 20.25, 14.25)), p(poly(9.75, 4.5, 9.75, 19.5))],
    motion: "None. A table, not a page: a page with lines in it read as a plus-minus sign at 16 px.",
  }),
  deck: I({
    group: "Files",
    elements: [p(rr(3, 4.5, 18, 11.25, 2.25)), p(poly(7.5, 12, 10.5, 9.375, 13.125, 11.25, 16.5, 8.25)), p(poly(9.375, 20.25, 10.875, 15.75)), p(poly(14.625, 20.25, 13.125, 15.75))],
    small: { elements: [p(rr(3, 4.5, 18, 11.25, 2.25)), p(poly(9.375, 20.25, 10.875, 15.75)), p(poly(14.625, 20.25, 13.125, 15.75))] },
    motion: "None. At 16 px the chart goes (the small cut): a screen on its stand.",
  }),
  pdf: I({
    group: "Files",
    elements: page(ko(rr(3.75, 12, 10.5, 5.25, 1.875)), p(rr(3.75, 12, 10.5, 5.25, 1.875)), p(poly(9, 8.25, 12, 8.25))),
    motion: "None. The label overhangs the page's edge, so a PDF never reads as a plain document at 16 px.",
  }),
  "file-image": I({
    group: "Files",
    elements: page(p(poly(9, 18, 11.625, 15.375, 14.25, 18)), c(14.25, 12, 1.125)),
    motion: "None.",
  }),
  "file-code": I({
    group: "Files",
    elements: page(p(poly(10.5, 11.625, 8.625, 13.875, 10.5, 16.125)), p(poly(13.5, 11.625, 15.375, 13.875, 13.5, 16.125))),
    motion: "None.",
  }),
  zip: I({
    group: "Files",
    elements: page(p(poly(11.25, 6, 12.75, 6)), p(poly(11.25, 9, 12.75, 9)), p(rr(10.5, 12, 3, 4.5, 1.2))),
    motion: "None.",
  }),
  link: I({
    group: "Files",
    elements: [
      g([p(turn("M9.75 16.5H7.5A4.5 4.5 0 0 1 7.5 7.5H9.75", -45))], { x: -0.53, y: 0.53 }),
      g([p(turn("M14.25 7.5H16.5A4.5 4.5 0 0 1 16.5 16.5H14.25", -45))], { x: 0.53, y: -0.53 }),
      p(turn(poly(9.375, 12, 14.625, 12), -45)),
    ],
    motion: "The two links draw apart along the chain.",
  }),
  design: I({
    group: "Files",
    elements: [g([p(roundPoly(1.5, 9, 4.5, 15, 4.5, 18, 11.25, 12, 20.25, 6, 11.25)), dot(12, 12, 1.3), p(poly(12, 14.625, 12, 17.25))], { y: 0.75 })],
    motion: "A pen nib (a design, not a copy of two shapes). It touches down.",
  }),

  /* ——— Apps ——— */
  app: I({
    group: "Apps",
    elements: PLUG.map((d) => p(d)),
    hover: { y: -1 },
    motion: "The plug pushes up into its socket.",
  }),
  connect: I({
    group: "Apps",
    elements: [g(PLUG.map((d) => p(shift(d, -2.25, -0.75))), { y: -1 }), ko(plusAt(18, 18)), p(plusAt(18, 18))],
    motion: "The plug pushes up into its socket; the corner plus says it is a new connection.",
  }),
  disconnect: I({
    group: "Apps",
    elements: [...PLUG.map((d) => p(d)), ko(SLASH), p(SLASH)],
    motion: "None: a state.",
  }),
  key: I({
    group: "Apps",
    elements: [c(8.25, 15.75, 3.75), p(poly(10.9, 13.1, 19.5, 4.5)), p(poly(16.5, 7.5, 18.75, 9.75)), p(poly(14.25, 9.75, 15.75, 11.25))],
    hover: { r: -14, o: [8.25, 15.75] },
    motion: "The key turns.",
  }),
  shield: I({
    group: "Apps",
    elements: [
      p("M12 3.375L18.75 5.625V11.25C18.75 15.6 15.9 18.75 12 20.625C8.1 18.75 5.25 15.6 5.25 11.25V5.625Z"),
      g([p(poly(9.375, 12, 11.25, 13.875, 14.625, 10.5), { draw: true })], { rest: 0, op: 1, anim: "draw" }),
    ],
    motion: "A check draws itself inside: protected.",
  }),

  /* ——— Crew and time ——— */
  "add-member": I({
    group: "Agents and time",
    elements: [g([p(MEMBER), p(MEMBER_EYES)], hop), ko(plusAt(18, 17.25)), p(plusAt(18, 17.25))],
    motion: "The new member hops once beside the corner plus.",
  }),
  routine: I({
    group: "Agents and time",
    elements: [
      g([p(arc(12, 12, 8.25, -60, 240)), p(head(...pt(12, 12, 8.25, 240), -30, 3.75))], { r: 45, o: [12, 12] }),
      p(HANDS),
    ],
    motion: "The loop comes round an eighth; the hands keep the time.",
  }),
  clock: I({
    group: "Agents and time",
    elements: [c(12, 12, 8.25), g([p(poly(12, 12, 12, 6.75))], { r: 90, o: [12, 12] }), p(poly(12, 12, 15, 13.875))],
    motion: "The long hand moves a quarter hour.",
  }),
  calendar: I({
    group: "Agents and time",
    elements: [p(rr(3.75, 5.25, 16.5, 15, 3)), p(poly(3.75, 10.5, 20.25, 10.5)), g([p(poly(8.25, 3, 8.25, 7.5)), p(poly(15.75, 3, 15.75, 7.5))], { y: -0.75 })],
    motion: "The rings lift, as a page turns.",
  }),
  pause: I({
    group: "Agents and time",
    elements: [p(poly(9, 6, 9, 18)), p(poly(15, 6, 15, 18))],
    on: { kind: "swap", to: "play" },
    motion: "Active: becomes play.",
  }),
  play: I({
    group: "Agents and time",
    elements: [p(PLAY)],
    hover: { x: 0.75 },
    on: { kind: "swap", to: "pause" },
    motion: "Nudges forward. Active: becomes pause.",
  }),

  /* ——— Code ——— */
  terminal: I({
    group: "Code",
    elements: [p(FRAME), g([p(poly(7.5, 9.375, 10.125, 12, 7.5, 14.625))], { x: 0.75 }), p(poly(12.75, 15, 16.5, 15))],
    motion: "The prompt steps forward.",
  }),
  diff: I({
    group: "Code",
    elements: [g([p(poly(12, 4.5, 12, 12)), p(poly(8.25, 8.25, 15.75, 8.25))], { y: -0.75 }), g([p(poly(8.25, 17.25, 15.75, 17.25))], { y: 0.75 })],
    motion: "The plus and the minus part, a unit and a half apart.",
  }),
  branch: I({
    group: "Code",
    elements: [
      c(7.5, 6, 2.25),
      c(7.5, 18, 2.25),
      p(poly(7.5, 8.25, 7.5, 15.75)),
      c(16.5, 6, 2.25),
      g([p("M7.5 15.75C7.5 11.25 16.5 12.75 16.5 8.25", { draw: true })], { anim: "draw" }),
    ],
    motion: "The branch draws itself off the trunk, out to its tip. (The ring is never dashed: a dash round a circle leaves a seam.)",
  }),
  "pull-request": I({
    group: "Code",
    elements: [
      c(6, 6, 2.25),
      c(6, 18, 2.25),
      p(poly(6, 8.25, 6, 15.75)),
      c(18, 18, 2.25),
      g([p("M18 15.75V9A3 3 0 0 0 15 6H11.25", { draw: true }), p(head(11.25, 6, 180, 4.243), { draw: true })], { anim: "draw" }),
    ],
    motion: "The request's path draws itself back to the trunk. The arrowhead is three units a side, so it still reads at 16 px.",
  }),
  run: I({
    group: "Code",
    elements: [c(12, 12, 8.25), g([p(roundPoly(1, 10.5, 8.625, 15.75, 12, 10.5, 15.375))], { x: 0.75 })],
    motion: "The triangle nudges forward.",
  }),
  test: I({
    group: "Code",
    elements: [
      p(poly(9.75, 3.75, 14.25, 3.75)),
      p("M10.5 3.75V9.375L5.7 17.4A1.95 1.95 0 0 0 7.37 20.25H16.63A1.95 1.95 0 0 0 18.3 17.4L13.5 9.375V3.75"),
      p(poly(7.136, 15, 16.864, 15)),
      g([dot(13.5, 12, 1.125)], { rest: 0, op: 1, y: -1 }),
    ],
    motion: "A bubble rises in the flask.",
  }),
  "file-tree": I({
    group: "Code",
    elements: [
      p(rr(3.75, 3.75, 6.75, 4.5, 1.5)),
      p(poly(6.75, 8.25, 6.75, 18.75, 13.5, 18.75)),
      p(poly(6.75, 12, 13.5, 12)),
      g([p(rr(13.5, 9.75, 6.75, 4.5, 1.5)), p(rr(13.5, 16.5, 6.75, 4.5, 1.5))], { x: 0.75 }),
    ],
    motion: "The children step out from the parent.",
  }),
  eye: I({
    group: "Code",
    elements: [p(EYE), g([c(12, 12, 3)], { x: 1 })],
    motion: "The pupil glances toward what it will show.",
  }),
  "eye-off": I({
    group: "Code",
    elements: [p(EYE), c(12, 12, 3), ko(SLASH), p(SLASH)],
    motion: "None.",
  }),
  computer: I({
    group: "Code",
    elements: [
      p(rr(3, 4.5, 18, 12, 2.25)),
      p(poly(12, 16.5, 12, 19.5)),
      p(poly(8.25, 19.5, 15.75, 19.5)),
      g([p(roundPoly(0.5, 10.5, 7.5, 15, 9.9, 12.6, 10.65, 11.7, 13.2))], { rest: 0, op: 1 }),
    ],
    motion: "A pointer appears on the screen: Juno can use it.",
  }),
  pointer: I({
    group: "Code",
    elements: [p(roundPoly(1, 5.25, 4.5, 19.125, 10.2, 12.9, 12.3, 10.2, 18.9))],
    hover: { x: -0.75, y: -0.75 },
    motion: "The pointer darts toward its target.",
  }),
  browser: I({
    group: "Code",
    elements: [p(FRAME), p(poly(3, 9, 21, 9)), g([p(poly(7.5, 13.5, 16.5, 13.5), { draw: true })], { anim: "draw", rest: 0, op: 1 })],
    motion: "A line of the page loads.",
  }),
  repo: I({
    group: "Code",
    elements: [p(rr(5.25, 3, 13.5, 18, 2.25)), p(poly(9, 3, 9, 21)), g([p(poly(12.75, 3.75, 12.75, 9, 14.25, 7.875, 15.75, 9, 15.75, 3.75))], { sy: 1.25, o: [14.25, 3] })],
    motion: "The bound book's ribbon lengthens, marking the place. (A spine and a ribbon: at 16 px it must not read as a phone.)",
  }),
  laptop: I({
    group: "Code",
    elements: [p(rr(4.5, 5.25, 15, 10.5, 2.25)), p(poly(3, 18.75, 21, 18.75))],
    motion: "None.",
  }),
  cloud: I({
    group: "Code",
    elements: [p(CLOUD)],
    hover: { x: 0.75 },
    motion: "The cloud drifts.",
  }),
  external: I({
    group: "Code",
    elements: [
      p("M10.5 5.25H7.5A2.25 2.25 0 0 0 5.25 7.5V16.5A2.25 2.25 0 0 0 7.5 18.75H16.5A2.25 2.25 0 0 0 18.75 16.5V13.5"),
      g([p(poly(11.25, 12.75, 19.5, 4.5)), p(poly(14.25, 4.5, 19.5, 4.5, 19.5, 9.75))], { x: 0.75, y: -0.75 }),
    ],
    motion: "The arrow leaves the box.",
  }),

  /* ——— Library ——— */
  grid: I({
    group: "Library",
    elements: [
      g([p(rr(4.5, 4.5, 6, 6, 1.5))], { x: -0.5, y: -0.5 }),
      g([p(rr(13.5, 4.5, 6, 6, 1.5))], { x: 0.5, y: -0.5 }),
      g([p(rr(4.5, 13.5, 6, 6, 1.5))], { x: -0.5, y: 0.5 }),
      g([p(rr(13.5, 13.5, 6, 6, 1.5))], { x: 0.5, y: 0.5 }),
    ],
    motion: "The four tiles part.",
  }),
  list: I({
    group: "Library",
    elements: [dot(5.25, 6.75), dot(5.25, 12), dot(5.25, 17.25), g([p(poly(9, 6.75, 19.5, 6.75)), p(poly(9, 12, 19.5, 12)), p(poly(9, 17.25, 19.5, 17.25))], { x: 0.75 })],
    motion: "The rows step in.",
  }),
  filter: I({
    group: "Library",
    elements: [p(poly(4.5, 7.5, 19.5, 7.5)), g([p(poly(7.5, 12, 16.5, 12))], { sx: 0.8, o: [12, 12] }), g([p(poly(10.5, 16.5, 13.5, 16.5))], { sx: 0.5, o: [12, 16.5] })],
    motion: "The lower lines narrow, the funnel tightens.",
  }),
  sort: I({
    group: "Library",
    elements: [
      g([p(poly(6.75, 4.5, 6.75, 19.5)), p(head(6.75, 19.5, 90, 4.243))], { y: 1 }),
      p(poly(11.25, 6.75, 20.25, 6.75)),
      p(poly(11.25, 12, 17.25, 12)),
      p(poly(11.25, 17.25, 14.25, 17.25)),
    ],
    motion: "A direction beside ordered lines (filter's lines are centred, a funnel). The arrow steps the way it sorts.",
  }),
  download: I({
    group: "Library",
    elements: [g([p(poly(12, 3.75, 12, 14.25)), p(head(12, 14.25, 90, 6.364))], { y: 1.25 }), p("M4.5 15.75V17.25A2.25 2.25 0 0 0 6.75 19.5H17.25A2.25 2.25 0 0 0 19.5 17.25V15.75")],
    motion: "The arrow drops into the tray.",
  }),
  upload: I({
    group: "Library",
    elements: [g([p(poly(12, 14.25, 12, 3.75)), p(head(12, 3.75, -90, 6.364))], { y: -1.25 }), p("M4.5 15.75V17.25A2.25 2.25 0 0 0 6.75 19.5H17.25A2.25 2.25 0 0 0 19.5 17.25V15.75")],
    motion: "The arrow rises out of the tray.",
  }),
  trash: I({
    group: "Library",
    elements: [
      g([p(poly(4.5, 6.75, 19.5, 6.75)), p("M9.75 6.75V5.25A1.5 1.5 0 0 1 11.25 3.75H12.75A1.5 1.5 0 0 1 14.25 5.25V6.75")], { r: -9, y: -0.5, o: [4.5, 6.75] }),
      p("M6.375 6.75L7.125 18.9A1.5 1.5 0 0 0 8.62 20.25H15.38A1.5 1.5 0 0 0 16.875 18.9L17.625 6.75"),
      p(poly(10.5, 10.5, 10.5, 16.5)),
      p(poly(13.5, 10.5, 13.5, 16.5)),
    ],
    motion: "The lid lifts from its hinge.",
  }),
  archive: I({
    group: "Library",
    elements: [g([p(rr(3.75, 4.5, 16.5, 4.5, 1.5))], { y: -1 }), p("M5.25 9V17.25A2.25 2.25 0 0 0 7.5 19.5H16.5A2.25 2.25 0 0 0 18.75 17.25V9"), p(poly(10.5, 12.75, 13.5, 12.75))],
    motion: "The lid lifts off the box.",
  }),
  pin: I({
    group: "Library",
    elements: PIN_PARTS.map((d) => p(d)),
    fill: [p(PIN_PARTS[0]), solid(`${PIN}Z`), p(PIN_PARTS[2])],
    on: { kind: "fill" },
    hover: { r: -14, o: [12, 20.25] },
    motion: "The pin tilts on its point. Active: filled, pinned.",
  }),
  star: I({
    group: "Library",
    elements: [p(star(12, 12.75, 8.625, 4.25))],
    fill: [solid(star(12, 12.75, 8.625, 4.25))],
    on: { kind: "fill" },
    hover: { r: -12, o: [12, 12.75] },
    motion: "The star tilts. Active: it fills.",
  }),

  /* ——— Arrows ——— */
  "arrow-right": I({ group: "Arrows", elements: [p(ARROW_SHAFT), p(ARROW_HEAD)], hover: { x: 1.5 }, motion: "Nudges the way it points." }),
  "arrow-left": I({ group: "Arrows", elements: [p(flipX(ARROW_SHAFT)), p(flipX(ARROW_HEAD))], hover: { x: -1.5 }, motion: "Nudges the way it points." }),
  "arrow-up": I({ group: "Arrows", elements: [p(turn(ARROW_SHAFT, -90)), p(turn(ARROW_HEAD, -90))], hover: { y: -1.5 }, motion: "Nudges the way it points." }),
  "arrow-down": I({ group: "Arrows", elements: [p(turn(ARROW_SHAFT, 90)), p(turn(ARROW_HEAD, 90))], hover: { y: 1.5 }, motion: "Nudges the way it points." }),
  "chevron-right": I({ group: "Arrows", elements: [p(CHEVRON)], hover: { x: 1.125 }, on: { kind: "turn", deg: 90 }, motion: "Nudges the way it points. Active: turns down (a disclosure opening)." }),
  "chevron-left": I({ group: "Arrows", elements: [p(flipX(CHEVRON))], hover: { x: -1.125 }, motion: "Nudges the way it points." }),
  "chevron-up": I({ group: "Arrows", elements: [p(turn(CHEVRON, -90))], hover: { y: -1.125 }, motion: "Nudges the way it points." }),
  "chevron-down": I({ group: "Arrows", elements: [p(turn(CHEVRON, 90))], hover: { y: 1.125 }, on: { kind: "turn", deg: 180 }, motion: "Nudges the way it points. Active: turns over (its menu is open)." }),
  "chevrons-up-down": I({
    group: "Arrows",
    elements: [g([p(poly(8.25, 9, 12, 5.25, 15.75, 9))], { y: -0.75 }), g([p(poly(8.25, 15, 12, 18.75, 15.75, 15))], { y: 0.75 })],
    motion: "The pair parts.",
  }),
  close: I({ group: "Arrows", elements: [p(poly(6.375, 6.375, 17.625, 17.625)), p(poly(17.625, 6.375, 6.375, 17.625))], motion: "None: a quarter turn lands where it started. The press says it." }),
  minus: I({ group: "Arrows", elements: [p(poly(5.25, 12, 18.75, 12))], motion: "None." }),
  expand: I({
    group: "Arrows",
    elements: [
      g([p(poly(13.5, 4.5, 19.5, 4.5, 19.5, 10.5)), p(poly(19.5, 4.5, 14.25, 9.75))], { x: 0.75, y: -0.75 }),
      g([p(poly(10.5, 19.5, 4.5, 19.5, 4.5, 13.5)), p(poly(4.5, 19.5, 9.75, 14.25))], { x: -0.75, y: 0.75 }),
    ],
    motion: "The corners push outward.",
  }),
  collapse: I({
    group: "Arrows",
    elements: [
      g([p(poly(14.25, 4.5, 14.25, 9.75, 19.5, 9.75)), p(poly(14.25, 9.75, 19.875, 4.125))], { x: -0.75, y: 0.75 }),
      g([p(poly(9.75, 19.5, 9.75, 14.25, 4.5, 14.25)), p(poly(9.75, 14.25, 4.125, 19.875))], { x: 0.75, y: -0.75 }),
    ],
    motion: "The corners draw inward.",
  }),

  /* ——— Theme ——— */
  sun: I({
    group: "Theme",
    elements: [
      c(12, 12, 3.75),
      g(
        [0, 45, 90, 135, 180, 225, 270, 315].map((a) => p(poly(...pt(12, 12, 6.75, a), ...pt(12, 12, 9, a)))),
        { r: 22.5, o: [12, 12] },
      ),
    ],
    on: { kind: "swap", to: "moon" },
    motion: "The rays turn half a step (a whole step would land where they started). Active: becomes the moon.",
  }),
  moon: I({
    group: "Theme",
    elements: [p(crescent(12, 12, 8.25, 16.875, 7.125, 6.75))],
    hover: { r: -15, o: [12, 12] },
    on: { kind: "swap", to: "sun" },
    motion: "The crescent rocks. Active: becomes the sun.",
  }),

  /* ——— Customize sections and account ——— */
  instructions: I({
    group: "Navigation",
    elements: [
      p(SHEET_RULED),
      p(poly(8.25, 8.25, 15.75, 8.25)),
      p(poly(8.25, 12, 15.75, 12)),
      g([p(poly(10.5, 15.75, 15.75, 15.75))], { x: 0.75 }),
    ],
    motion: "A ruled sheet (no fold: it is not a file) whose last line is set in, an instruction under an instruction. The set-in line steps further in.",
  }),
  "sign-out": I({
    group: "Navigation",
    elements: [p("M12.75 4.5H7.5A2.25 2.25 0 0 0 5.25 6.75V17.25A2.25 2.25 0 0 0 7.5 19.5H12.75"), g([p(poly(10.5, 12, 20.25, 12)), p(head(20.25, 12, 0, 5.303))], { x: 1 })],
    motion: "The arrow steps out of the door.",
  }),
  camera: I({
    group: "Composer",
    elements: [
      p("M3 9.75A2.25 2.25 0 0 1 5.25 7.5H7.5L9 5.25H15L16.5 7.5H18.75A2.25 2.25 0 0 1 21 9.75V17.25A2.25 2.25 0 0 1 18.75 19.5H5.25A2.25 2.25 0 0 1 3 17.25Z"),
      g([c(12, 13.125, 3.375)], { s: 0.85, o: [12, 13.125] }),
    ],
    motion: "The lens closes like a shutter.",
  }),
  mail: I({
    group: "Apps",
    elements: [p(rr(3, 5.25, 18, 13.5, 2.25)), p(poly(3.75, 6.75, 12, 12.75, 20.25, 6.75))],
    motion: "None.",
  }),
  "mic-off": I({
    group: "Composer",
    elements: [p(MIC), p("M6 11.25A6 6 0 0 0 18 11.25"), p(poly(12, 17.25, 12, 20.25)), ko(SLASH), p(SLASH)],
    motion: "None.",
  }),

  /* ——— The framed shell, the sidebar and its menus (D-033) ——— */
  keyboard: I({
    group: "Navigation",
    elements: [
      p(rr(3, 6, 18, 12, 2.25)),
      dot(7.5, 10.125),
      dot(10.5, 10.125),
      dot(13.5, 10.125),
      dot(16.5, 10.125),
      g([p(poly(8.25, 14.25, 15.75, 14.25))], { y: 0.75 }),
    ],
    motion: "The space bar goes down: a key pressed.",
  }),
  "bell-off": I({
    group: "Navigation",
    elements: [...BELL_PARTS.map((d) => p(d)), ko(SLASH), p(SLASH)],
    motion: "None: a state (this chat or member is muted).",
  }),
  history: I({
    group: "Agents and time",
    elements: [g([p(arc(12, 12, 8.25, 130, -150)), p(head(...pt(12, 12, 8.25, -150), 120, 4.5))], { r: -45, o: [12, 12] }), p(HANDS)],
    motion: "The arrow winds back an eighth: back in time (retry's arrow round routine's clock).",
  }),
  undo: I({
    group: "Arrows",
    elements: [p(UNDO), p(UNDO_HEAD)],
    hover: { r: -14, o: [14.25, 13.5] },
    motion: "The hook winds back, the way the change goes.",
  }),
  redo: I({
    group: "Arrows",
    elements: [p(flipX(UNDO)), p(flipX(UNDO_HEAD))],
    hover: { r: 14, o: [9.75, 13.5] },
    motion: "The hook winds forward.",
  }),
  enter: I({
    group: "Arrows",
    elements: [p(ENTER), p(ENTER_HEAD)],
    hover: { x: -1.125 },
    motion: "Nudges the way it points, as the key goes in.",
  }),
  "folder-plus": I({
    group: "Library",
    elements: [p(FOLDER), p(poly(12, 10.875, 12, 16.125)), p(poly(9.375, 13.5, 14.625, 13.5))],
    motion: "None: a menu verb (menus are quiet).",
  }),
  "folder-move": I({
    group: "Library",
    elements: [p(FOLDER), g([p(poly(8.25, 13.5, 15, 13.5)), p(head(15, 13.5, 0, 3.182))], { x: 1.125 })],
    motion: "The arrow moves in: this goes into a project.",
  }),
  unpin: I({
    group: "Library",
    elements: [...PIN_PARTS.map((d) => p(d)), ko(SLASH), p(SLASH)],
    motion: "None: the menu verb for a pinned row.",
  }),
  grip: I({
    group: "Library",
    elements: [dot(9.75, 6.75, 1.5), dot(14.25, 6.75, 1.5), dot(9.75, 12, 1.5), dot(14.25, 12, 1.5), dot(9.75, 17.25, 1.5), dot(14.25, 17.25, 1.5)],
    motion: "None: a handle; the pointer and the lift say it.",
  }),
  phone: I({
    group: "Code",
    elements: [p(rr(6.75, 3, 10.5, 18, 3)), p(poly(10.5, 18, 13.5, 18))],
    hover: { y: -0.75 },
    motion: "The phone lifts, as if picked up.",
  }),
  contrast: I({
    group: "Theme",
    elements: [c(12, 12, 8.25), solid("M12 3.75A8.25 8.25 0 0 1 12 20.25Z")],
    hover: { r: 180, o: [12, 12] },
    motion: "The halves trade places: light and dark follow the system.",
  }),

  /* ——— Alevr: the semantic inventory (NAMES_AND_ICONS.md), revision 1 ——— */
  profile: I({
    group: "Agents and time",
    elements: [g([c(...HEAD)], { y: -0.75 }), p(SHOULDERS)],
    motion: "The head lifts, a small nod up (account's motion, without the circle).",
  }),
  appearance: I({
    group: "Agents and time",
    elements: [g([p(rr(3.75, 3.75, 10.5, 10.5, 3))], { r: -12, o: [9, 9] }), koCircle(15, 15, 5.25), c(15, 15, 5.25)],
    motion: "An abstract swatch of shapes (an agent's body is chosen from shapes). The squircle turns behind the circle.",
  }),
  apps: I({
    group: "Apps",
    elements: [p(TILE_A), p(TILE_B), g([p(arc(11.25, 12.75, 5.25, -90, 0), { draw: true })], { anim: "draw" })],
    motion: "Two framed tiles joined by one quarter path (a curve, never a flowchart elbow). The path draws in: connected.",
  }),
  dictation: I({
    group: "Composer",
    elements: [
      p(MIC_SMALL),
      p("M4.5 10.5A5.25 5.25 0 0 0 15 10.5"),
      p(poly(9.75, 15.75, 9.75, 20.25)),
      g([p(ibeam(18.75, 6, 18, 2.25))], { anim: "caret" }),
    ],
    motion: "The microphone beside the text cursor (speech becomes text, not a conversation). The cursor blinks once.",
  }),
  slash: I({
    group: "Composer",
    elements: [p(rr(4.5, 4.5, 15, 15, 3.75)), g([p(poly(13.5, 8.25, 10.5, 15.75))], { r: 16, o: [12, 12] })],
    motion: "The slash key (the composer's command trigger). The slash leans in, like a key being struck.",
  }),
  rename: I({
    group: "Message",
    elements: [p(rr(3, 6.75, 18, 10.5, 2.25)), p(poly(6.75, 12, 9.75, 12)), ko(ibeam(14.25, 4.5, 19.5)), g([p(ibeam(14.25, 4.5, 19.5))], { anim: "caret" })],
    motion: "A field with the text cursor standing in it, cut clear by the house gap. The cursor blinks once.",
  }),
  refresh: I({
    group: "Message",
    elements: [
      g(
        [
          p(arc(12, 12, 7.5, -150, -20)),
          p(head(...pt(12, 12, 7.5, -20), 70, 4.5)),
          p(arc(12, 12, 7.5, 30, 160)),
          p(head(...pt(12, 12, 7.5, 160), 250, 4.5)),
        ],
        { r: 45, o: [12, 12] },
      ),
    ],
    motion: "Two paired arcs. They come round an eighth and hold; never a full turn (that is a spinner).",
  }),
  plan: I({
    group: "Work and evidence",
    elements: [
      p(tick(6.75)),
      p(poly(12, 6.75, 20.25, 6.75)),
      p(tick(12)),
      p(poly(12, 12, 20.25, 12)),
      dot(6.375, 17.25, 1.5),
      g([p(poly(12, 17.25, 17.25, 17.25), { draw: true })], { anim: "draw" }),
    ],
    motion: "Ordered steps: two done, one next. The next step's line writes itself in.",
  }),
  activity: I({
    group: "Work and evidence",
    elements: [
      p(poly(3.75, 20.25, 20.25, 20.25)),
      g([p(poly(6, 17.25, 6, 12))], { sy: 0.7, o: [6, 17.25], anim: "levels", delay: 0 }),
      g([p(poly(9.75, 17.25, 9.75, 6))], { sy: 0.8, o: [9.75, 17.25], anim: "levels", delay: 40 }),
      g([p(poly(14.25, 17.25, 14.25, 9.75))], { sy: 1.2, o: [14.25, 17.25], anim: "levels", delay: 80 }),
      g([p(poly(18, 17.25, 18, 4.5))], { sy: 0.75, o: [18, 17.25], anim: "levels", delay: 120 }),
    ],
    motion: "Event lines standing on one baseline (a voice meter has none): what happened, when. One pass across them on hover.",
  }),
  receipt: I({
    group: "Work and evidence",
    elements: [p(SLIP), p(poly(9, 8.25, 15, 8.25)), p(poly(9, 12, 13.5, 12))],
    hover: { y: -0.75 },
    motion: "A slip with a torn foot, its lines the evidence. It feeds up, as a receipt prints.",
  }),
  versions: I({
    group: "Work and evidence",
    elements: [
      g([p(rr(9.75, 3, 10.5, 12, 2.25))], { x: 0.75, y: -0.75 }),
      { ...ko(rr(6.75, 6, 10.5, 12, 2.25)), hover: { x: 0.375, y: -0.375 } },
      g([p(rr(6.75, 6, 10.5, 12, 2.25))], { x: 0.375, y: -0.375 }),
      ko(rr(3.75, 9, 10.5, 12, 2.25)),
      p(rr(3.75, 9, 10.5, 12, 2.25)),
    ],
    motion: "Three sheets in a cascade, each cut clear of the one in front by the house gap: the current one and the history behind it (copy is two sheets; memory stacks cards upward). They fan out.",
  }),
  "ask-first": I({
    group: "Work and evidence",
    elements: [
      p(arc(12, 12, 8.25, 150, 480)),
      g([p("M9.375 9.75A2.625 2.625 0 1 1 13.31 12.02C12.55 12.46 12 13.05 12 14.06"), dot(12, 16.875)], { r: 12, o: [12, 13.5] }),
    ],
    motion: "A question in an open contour (help's circle is closed): this waits for your answer. The question tilts.",
  }),
  blocked: I({
    group: "Work and evidence",
    elements: [c(12, 12, 8.25), p(poly(7.875, 12, 16.125, 12))],
    motion: "None: a barred entry is a decision, read, not played.",
  }),
  sources: I({
    group: "Work and evidence",
    elements: [p(LEAF), p(flipX(LEAF))],
    motion: "None. A pair of pages a house gap apart at the spine (a citation is the quote; sources are where it came from).",
  }),
  citation: I({
    group: "Work and evidence",
    elements: [...quote(7.875, 14.625), ...quote(16.125, 14.625)],
    motion: "None. Newsreader's opening quotation mark, at icon size: filled heads, rising tails.",
  }),
  commit: I({
    group: "Code",
    elements: [p(poly(3, 12, 7.125, 12)), p(poly(16.875, 12, 21, 12)), g([c(12, 12, 3.375)], { s: 1.15, o: [12, 12], anim: "pop" })],
    motion: "A node on its line, the line standing a house gap off it. The node settles once: saved.",
  }),
  review: I({
    group: "Code",
    elements: page(
      p(poly(9, 11.25, 15, 11.25)),
      p(poly(9, 15, 11.25, 15)),
      ko(poly(13.875, 18, 15.75, 19.875, 20.25, 15.375)),
      g([p(poly(13.875, 18, 15.75, 19.875, 20.25, 15.375), { draw: true })], { anim: "draw" }),
    ),
    motion: "An inspected sheet: the page with a check cut into its corner (the New convention's place). The check draws in.",
  }),
  preview: I({
    group: "Code",
    elements: [p(FRAME), p(ALMOND), g([dot(12, 12, 1.5)], { x: 0.75 })],
    motion: "A view frame with an eye in it (the bare eye is show and hide). The pupil glances toward what it will show.",
  }),
  "file-audio": I({
    group: "Files",
    elements: page(p(poly(9, 13.5, 9, 16.5)), p(poly(12, 11.25, 12, 18.75)), p(poly(15, 12.75, 15, 17.25))),
    motion: "None.",
  }),
  "file-video": I({
    group: "Files",
    elements: page(p(roundPoly(0.9, 9.75, 11.25, 15.375, 14.625, 9.75, 18))),
    motion: "None.",
  }),
  bookmark: I({
    group: "Library",
    elements: [p(RIBBON)],
    fill: [solid(RIBBON)],
    on: { kind: "fill" },
    motion: "None at rest. Active: filled, kept.",
  }),
  billing: I({
    group: "System",
    elements: [p(rr(3, 5.25, 18, 13.5, 2.25)), p(poly(3, 9.75, 21, 9.75)), p(poly(6.75, 14.25, 10.5, 14.25))],
    motion: "None: a settings noun.",
  }),
  accessibility: I({
    group: "System",
    elements: [
      c(12, 12, 8.25),
      dot(12, 7.5, 1.5),
      p("M7.5 10.125C9 10.6 10.5 10.875 12 10.875C13.5 10.875 15 10.6 16.5 10.125"),
      p(poly(12, 10.875, 12, 13.875)),
      p(poly(9.75, 17.25, 12, 13.875, 14.25, 17.25)),
    ],
    motion: "None: a settings noun.",
  }),

  folio: I({
    group: "Files",
    elements: [p(FOLIO), p(FOLIO_CREASE)],
    motion: "None. Folio (D-038, what Alevr made): a sheet folded once, standing open. Made things are kept, not played.",
  }),
  "deep-field": I({
    group: "Work and evidence",
    elements: [...FIELD_CORNERS.map((d) => p(d)), dot(10.125, 10.875, 1.875), dot(15, 9, 1.125), dot(14.25, 15, 1.5), dot(9, 15.75, 0.9)],
    motion: "Deep Field (D-038, deep research): the viewfinder holding four points of falling size. None: a long look is still.",
  }),
} satisfies Record<string, IconDrawing>;

/** Other names the screens use for the same drawing. */
export const ICON_ALIASES = {
  compose: "new-chat",
  projects: "folder",
  "sidebar-toggle": "sidebar",
  "panel-left": "sidebar",
  waveform: "voice",
  "needs-you": "hand",
  attention: "hand",
  error: "alert",
  doc: "document",
  file: "document",
  slides: "deck",
  plug: "app",
  "person-add": "add-member",
  "globe-preview": "browser",
  web: "globe",
  "check-circle": "success",
  "branch-chat": "fork",
  settings2: "settings",
  move: "folder-move",
  "move-to": "folder-move",
  "new-project": "folder-plus",
  delete: "trash",
  restore: "undo",
  recent: "history",
  duplicate: "copy",
  export: "download",
  "theme-system": "contrast",
  system: "contrast",
  mobile: "phone",
  drag: "grip",
  mute: "bell-off",
  return: "enter",
  shortcuts: "keyboard",
  publish: "globe",
  desktop: "computer",
  studio: "computer",
  /* Alevr's semantic inventory (NAMES_AND_ICONS.md): the labels the brand names, resolved to one drawing each. */
  agents: "crew",
  "create-agent": "add-member",
  person: "profile",
  skills: "skill",
  routines: "routine",
  mention: "at",
  add: "plus",
  copied: "check",
  approve: "check",
  allow: "success",
  permission: "lock",
  ask: "ask-first",
  block: "blocked",
  notifications: "bell",
  theme: "contrast",
  loading: "progress",
  open: "external",
  back: "arrow-left",
  forward: "arrow-right",
  previous: "chevron-left",
  next: "chevron-right",
  cancel: "close",
  volume: "read-aloud",
  "mic-mute": "mic-off",
  files: "folder",
  audio: "file-audio",
  video: "file-video",
  card: "billing",
  language: "globe",
  folios: "folio",
  "deep-research": "deep-field",
} satisfies Record<string, string>;

export function resolveIcon(name: string): IconDrawing | undefined {
  const icons: Record<string, IconDrawing> = ICONS;
  const aliases: Record<string, string> = ICON_ALIASES;
  return icons[name] ?? icons[aliases[name] ?? ""];
}

/** Below this rendered size a drawing's small cut, when it has one, replaces its regular layers. */
export const SMALL_CUT_BELOW = 18;
const smallCache = new WeakMap<IconDrawing, IconDrawing>();

/** The drawing for a rendered size: the small cut merged in below 18 px (one object per drawing, so fits cache). */
export function resolveIconAt(name: string, size: number): IconDrawing | undefined {
  const d = resolveIcon(name);
  if (!d?.small || size >= SMALL_CUT_BELOW) return d;
  let out = smallCache.get(d);
  if (!out) {
    out = { ...d, elements: d.small.elements ?? d.elements, fill: d.small.fill ?? d.fill };
    smallCache.set(d, out);
  }
  return out;
}

/* —————————————————————————————— Native projection —————————————————————————————— */

/**
 * A drawing as the native pipeline reads one: `JunoGlyphDrawing`'s shape
 * (`src/components/ui/juno-glyph-paths.ts`), so `scripts/generate-native-icons.mjs`
 * can outline it with `scripts/outline-glyph-strokes.swift` unchanged.
 */
export type NativeDrawing = { viewBox: 24; line: 1.5; elements: IconElement[] };

const MOTION_ONLY = new Set(["pathLength", "strokeDasharray", "className", "opacity", "transform"]);

function stillElements(els: IconElement[]): IconElement[] {
  const out: IconElement[] = [];
  for (const el of els) {
    if (el.tag === "g") {
      // A part that is only there on hover (the mic's level ticks) is not in the symbol.
      if (el.hover?.rest === 0) continue;
      out.push(...stillElements(el.children ?? []));
      continue;
    }
    const attrs: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(el.attrs)) if (!MOTION_ONLY.has(k)) attrs[k] = v;
    out.push(el.knockout ? { tag: el.tag, attrs, knockout: true } : { tag: el.tag, attrs });
  }
  return out;
}

/**
 * One cut of an icon as a static symbol: the rest pose with every part in
 * place, groups flattened (a symbol has no moving parts), hover-only parts
 * and motion-only attributes dropped. `fill` is the on drawing. A knockout
 * keeps its fill and its cut width in `attrs` (4.5 units for the gap, 2.25
 * for a tight hole), which is what the outliner subtracts. Undefined for a
 * live control (progress) or a cut the icon does not have. `scale: "small"`
 * reads the small optical cut (the SF Symbol's small scale), which equals the
 * regular drawing for every icon without one.
 */
export function nativeDrawing(name: string, cut: "regular" | "fill" = "regular", scale: "regular" | "small" = "regular"): NativeDrawing | undefined {
  const d = scale === "small" ? resolveIconAt(name, 16) : resolveIcon(name);
  if (!d || d.live) return undefined;
  const els = cut === "fill" ? d.fill : d.elements;
  if (!els) return undefined;
  return { viewBox: 24, line: 1.5, elements: stillElements(els) };
}

/**
 * The native symbol prefix. Alevr's family is new geometry, so it gets its own
 * namespace instead of reusing `juno.*`, which the generator already ships for
 * the older marks in juno-glyph-paths.ts (juno.chat, juno.code, juno.library
 * would otherwise collide). Existing `juno.*` symbols keep their names.
 */
export const NATIVE_PREFIX = "alevr";

/** Every symbol the native apps would ship: `alevr.<name>`, and `alevr.<name>.fill` where there is an on drawing (small cuts ride inside the same symbol as its small scale). */
export function nativeSymbolNames(): string[] {
  const out: string[] = [];
  for (const [name, d] of Object.entries(ICONS) as [string, IconDrawing][]) {
    if (d.live) continue;
    out.push(`${NATIVE_PREFIX}.${name}`);
    if (d.fill) out.push(`${NATIVE_PREFIX}.${name}.fill`);
  }
  return out;
}

/** One native symbol: its cuts as static drawings (`small` only where the icon has its own small cut). */
export type NativeSymbol = {
  symbol: string;
  name: string;
  regular: NativeDrawing;
  fill?: NativeDrawing;
  small?: NativeDrawing;
  smallFill?: NativeDrawing;
};

/**
 * The whole table the native generator needs, in one call: every static icon
 * with its regular cut, its fill cut where it has an on drawing, and its small
 * optical cut where it has one. Aliases are listed separately (`ICON_ALIASES`):
 * a native call site resolves a label to the same symbol the web draws.
 *
 *   import { nativeIconTable, ICON_ALIASES } from "../src/app/dev/design/juno/icons/drawings.ts";
 *   for (const s of nativeIconTable()) outline(s.symbol, s.regular, s.small); // and s.fill
 */
export function nativeIconTable(): NativeSymbol[] {
  const out: NativeSymbol[] = [];
  for (const [name, d] of Object.entries(ICONS) as [string, IconDrawing][]) {
    if (d.live) continue;
    const regular = nativeDrawing(name, "regular");
    if (!regular) continue;
    const row: NativeSymbol = { symbol: `${NATIVE_PREFIX}.${name}`, name, regular };
    const fill = nativeDrawing(name, "fill");
    if (fill) row.fill = fill;
    if (d.small?.elements) row.small = nativeDrawing(name, "regular", "small");
    if (d.small?.fill && fill) row.smallFill = nativeDrawing(name, "fill", "small");
    out.push(row);
  }
  return out;
}
