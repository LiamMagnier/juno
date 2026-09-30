/**
 * Juno icons: the drawing primitives and the data format (design round 3).
 *
 * Pure data and pure functions: no JSX, no React, no imports. Plain Node can
 * import this file with type stripping only, which is what lets the native
 * generator (`scripts/generate-native-icons.mjs`) read the same drawings the
 * web renders. So: no enums, no namespaces, no parameter properties.
 *
 * THE GRID. A 24-unit box. The live area is 3 to 21. Key horizontals and
 * verticals sit on a 1.5-unit lattice, which lands on whole device pixels at
 * 16 and 24 px on a 2x screen (and on the 3-unit lattice at 20 px); the renderer
 * then offsets the glyph by half a device pixel so a 1.5 px stroke has crisp
 * edges. Every primary silhouette encloses about 215 square units: a 15 unit
 * square, a 16.5 unit circle, a 12 x 18 page, an 18 x 12 landscape frame.
 *
 * THE LINE. One stroke: 1.5 px on screen at every size (the renderer sets the
 * stroke width in units from the rendered size). Round caps and joins.
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
  anim?: "swing" | "levels" | "wave" | "blink" | "draw" | "pop" | "nod";
  delay?: number;
};

export type IconElement = {
  tag: IconTag;
  attrs: Record<string, string | number>;
  /** A `g`'s elements, in paint order. */
  children?: IconElement[];
  /** On a `g`: how it moves when its control is hovered. */
  hover?: IconMove;
  /** Cut this shape (grown by the stroke and a 1.5 unit gap) out of everything painted before it. */
  knockout?: boolean;
  /** Normalise the path length so the web can draw it in (check marks). */
  draw?: boolean;
};

export type IconOn =
  | { kind: "fill" }
  | { kind: "turn"; deg: number }
  | { kind: "swap"; to: string }
  | { kind: "draw" };

export type IconGroup =
  | "Navigation"
  | "Composer"
  | "Message"
  | "States"
  | "Files"
  | "Apps"
  | "Crew and time"
  | "Code"
  | "Library"
  | "Arrows"
  | "Theme";

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
  group: IconGroup;
  /** One line for the gallery: what moves and why. */
  motion?: string;
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
 * A crew pebble: the silhouette of a crew member's sculpted form. A soft
 * base, sides that rise and narrow into a domed top (the 3D crew's
 * three-quarter body, flattened to a line).
 */
export function pebble(cx: number, top: number, bottom: number, w: number): string {
  const hw = w / 2;
  const h = bottom - top;
  const wide = bottom - h * 0.4;
  return (
    `M${P(cx, bottom)}C${P(cx + hw * 0.66, bottom)} ${P(cx + hw, bottom - h * 0.14)} ${P(cx + hw, wide)}` +
    `C${P(cx + hw, top + h * 0.22)} ${P(cx + hw * 0.6, top)} ${P(cx, top)}` +
    `C${P(cx - hw * 0.6, top)} ${P(cx - hw, top + h * 0.22)} ${P(cx - hw, wide)}` +
    `C${P(cx - hw, bottom - h * 0.14)} ${P(cx - hw * 0.66, bottom)} ${P(cx, bottom)}Z`
  );
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

/** Cut `d` (grown by the stroke and the house gap) out of everything painted before it. */
export function ko(d: string): IconElement {
  return { tag: "path", attrs: { d }, knockout: true };
}

export function koCircle(cx: number, cy: number, r: number): IconElement {
  return { tag: "circle", attrs: { cx: n3(cx), cy: n3(cy), r: n3(r) }, knockout: true };
}

/* —————————————————————————————— Transforms —————————————————————————————— */

/**
 * Apply a point transform to an absolute path (M L H V C A Z). H and V become
 * L; arcs keep their radii (every arc here is circular) and flip their sweep
 * when the transform mirrors.
 */
export function xform(d: string, f: (x: number, y: number) => [number, number], mirror = false): string {
  const tokens = d.match(/[MLHVCAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
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
    if (/[MLHVCAZ]/.test(t)) {
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
const FOLDER = "M3.75 7.5A2.25 2.25 0 0 1 6 5.25H9.19L11.44 7.5H18A2.25 2.25 0 0 1 20.25 9.75V16.5A2.25 2.25 0 0 1 18 18.75H6A2.25 2.25 0 0 1 3.75 16.5Z";
const BELL = "M6.375 16.5V10.5A5.625 5.625 0 0 1 17.625 10.5V16.5";
const MIC = "M9 6.75A3 3 0 0 1 15 6.75V11.25A3 3 0 0 1 9 11.25Z";
const EYE = "M3 12C5.2 7.9 8.4 5.625 12 5.625C15.6 5.625 18.8 7.9 21 12C18.8 16.1 15.6 18.375 12 18.375C8.4 18.375 5.2 16.1 3 12Z";
const BOOKMARK = "M6.75 5.25A1.5 1.5 0 0 1 8.25 3.75H15.75A1.5 1.5 0 0 1 17.25 5.25V20.25L12 16.5L6.75 20.25Z";
const PIN = "M9.375 3.75V9L6.375 13.5H17.625L14.625 9V3.75";
const THUMB = "M7.5 10.5L10.6 4.45A1.8 1.8 0 0 1 14 5.55L13.4 9H18.35A1.9 1.9 0 0 1 20.2 11.35L18.8 17.95A2 2 0 0 1 16.85 19.5H7.5Z";
const CUFF = "M7.5 10.5H5.25A1.5 1.5 0 0 0 3.75 12V18A1.5 1.5 0 0 0 5.25 19.5H7.5";
const CREW_FRONT = pebble(8.25, 8.625, 20.25, 9);
const CREW_BACK = pebble(14.625, 3.75, 20.25, 10.5);
const SLASH = poly(4.5, 4.5, 19.5, 19.5);
/** A cloud on a flat base: a right lobe, a tall middle lobe, a left lobe. */
const CLOUD = "M7.125 18.75H17.25A3.75 3.75 0 0 0 17.9 11.31A5.625 5.625 0 0 0 7.05 10.6A4.125 4.125 0 0 0 7.125 18.75Z";
const PLAY = roundPoly(1.6, 8.25, 5.25, 19.5, 12, 8.25, 18.75);
const HAND =
  "M8.25 20.25C6.9 19.4 6.2 18.4 5.5 17.1L3.9 14.25A1.5 1.5 0 0 1 6.3 12.6L6.75 13.35V8.25A1.875 1.875 0 0 1 10.5 8.25V12" +
  "V6A1.875 1.875 0 0 1 14.25 6V12V7.5A1.875 1.875 0 0 1 18 7.5V15C18 18 16.2 20.25 13.5 20.25Z";

/** The leaning volume on the library shelf: 6 x 12, standing on its bottom-left corner, leaning 14.5 degrees onto the upright. */
const LEAN = -14.5;
const leanPt = (x: number, y: number) => rot(x, y, 13.5, 19.5, LEAN);
const leanBook = (() => {
  const [ax, ay] = leanPt(13.5, 19.5);
  const [bx, by] = leanPt(19.5, 19.5);
  const [cx_, cy_] = leanPt(19.5, 7.5);
  const [dx, dy] = leanPt(13.5, 7.5);
  return roundPoly(1.5, ax, ay, bx, by, cx_, cy_, dx, dy);
})();
const leanBand = (() => {
  const [ax, ay] = leanPt(13.5, 11.25);
  const [bx, by] = leanPt(19.5, 11.25);
  return poly(ax, ay, bx, by);
})();

const PLUG = ["M7.5 9H16.5V12A4.5 4.5 0 0 1 7.5 12Z", poly(9.75, 9, 9.75, 4.5), poly(14.25, 9, 14.25, 4.5), poly(12, 16.5, 12, 20.25)];

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
  code: I({
    group: "Navigation",
    elements: [
      g([p(poly(8.25, 7.5, 3.75, 12, 8.25, 16.5))], { x: -1 }),
      g([p(poly(15.75, 7.5, 20.25, 12, 15.75, 16.5))], { x: 1 }),
      p(poly(13.5, 5.25, 10.5, 18.75)),
    ],
    motion: "The brackets open a unit each way.",
  }),
  "new-chat": I({
    group: "Navigation",
    elements: [
      p("M11.25 4.5H7.5A3 3 0 0 0 4.5 7.5V16.5A3 3 0 0 0 7.5 19.5H16.5A3 3 0 0 0 19.5 16.5V12.75"),
      g([p(pencil(10.125, 13.875, -45, 12.2, 3.6, 3))], { x: 0.75, y: -0.75 }),
    ],
    motion: "The pencil lifts off the page, ready to write.",
  }),
  search: I({
    group: "Navigation",
    elements: [c(10.5, 10.5, 6.375), p(poly(15.2, 15.2, 19.5, 19.5))],
    hover: { r: -14, o: [10.5, 10.5] },
    motion: "The lens tilts about its own centre, so only the handle swings.",
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
    elements: [
      p("M3.75 18.75V7.5A2.25 2.25 0 0 1 6 5.25H9.19L11.44 7.5H16.5A2.25 2.25 0 0 1 18.75 9.75V10.5"),
      g([p(roundPoly(1.2, 6.75, 10.5, 20.625, 10.5, 17.25, 18.75, 3.75, 18.75))], { y: -0.5 }),
    ],
    motion: "The front leaf lifts half a unit.",
  }),
  library: I({
    group: "Navigation",
    elements: [
      p(rr(4.5, 4.5, 6, 15, 1.5)),
      p(poly(4.5, 9, 10.5, 9)),
      g([p(leanBook), p(leanBand)], { r: -LEAN, o: [13.5, 19.5], y: -1 }),
    ],
    motion: "The leaning volume straightens and lifts, as a book comes off the shelf.",
  }),
  customize: I({
    group: "Navigation",
    elements: [
      p(poly(4.5, 7.5, 19.5, 7.5)),
      p(poly(4.5, 16.5, 19.5, 16.5)),
      g([solidCircle(15, 7.5, 2.25)], { x: -2.25 }),
      g([solidCircle(9, 16.5, 2.25)], { x: 2.25 }),
    ],
    motion: "The two knobs slide toward each other along their tracks.",
  }),
  crew: I({
    group: "Navigation",
    elements: [
      g([p(CREW_BACK)], { y: -0.75 }),
      { ...ko(CREW_FRONT), hover: { x: -0.5 } },
      g([p(CREW_FRONT)], { x: -0.5 }),
    ],
    fill: [g([solid(CREW_BACK)], { y: -0.75 }), { ...ko(CREW_FRONT), hover: { x: -0.5 } }, g([solid(CREW_FRONT)], { x: -0.5 })],
    on: { kind: "fill" },
    motion: "The taller member rises; the one in front steps aside to make room.",
  }),
  bell: I({
    group: "Navigation",
    elements: [p(BELL), p(poly(4.5, 16.5, 19.5, 16.5)), p(poly(10.125, 19.5, 13.875, 19.5))],
    fill: [solid(`${BELL}Z`), p(poly(4.5, 16.5, 19.5, 16.5)), p(poly(10.125, 19.5, 13.875, 19.5))],
    on: { kind: "fill" },
    hover: { r: 10, o: [12, 4.5], anim: "swing" },
    motion: "One swing from the hanger, damped, then still.",
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
    elements: [g([p(poly(4.5, 9, 19.5, 9))], { y: -0.75 }), g([p(poly(4.5, 15, 19.5, 15))], { y: 0.75 })],
    motion: "The two lines part.",
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
    hover: { r: 90, o: [12, 12] },
    on: { kind: "turn", deg: 45 },
    motion: "Turns a quarter (it lands where it started). Active: turns 45 degrees into a close.",
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
    elements: [c(12, 12, 3.375), p(`M15.375 8.625V13.125A2.25 2.25 0 0 0 19.875 13.125V12${arc(12, 12, 7.875, 0, -306, false)}`)],
    hover: { r: -18, o: [12, 12] },
    motion: "The tail winds back a little.",
  }),
  skill: I({
    group: "Composer",
    elements: [p(rr(4.5, 4.5, 15, 15, 3.75)), g([p(poly(13.5, 8.25, 10.5, 15.75))], { r: 16, o: [12, 12] })],
    motion: "The slash leans in, like a key being struck.",
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
      g([p(poly(8.25, 7.5, 8.25, 16.5))], { sy: 1.25, o: [8.25, 12], anim: "levels", delay: 40 }),
      g([p(poly(12, 4.5, 12, 19.5))], { sy: 0.7, o: [12, 12], anim: "levels", delay: 80 }),
      g([p(poly(15.75, 7.5, 15.75, 16.5))], { sy: 1.2, o: [15.75, 12], anim: "levels", delay: 120 }),
      g([p(poly(19.5, 9.75, 19.5, 14.25))], { sy: 0.7, o: [19.5, 12], anim: "levels", delay: 160 }),
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
    elements: [p(BOOKMARK)],
    fill: [solid(BOOKMARK)],
    on: { kind: "fill" },
    hover: { y: 0.75 },
    motion: "The ribbon settles a little lower. Active: filled, memory on.",
  }),
  research: I({
    group: "Composer",
    elements: [c(10.5, 10.5, 6.375), p(poly(15.2, 15.2, 19.5, 19.5)), g([p(poly(7.875, 9, 13.125, 9)), p(poly(7.875, 12, 11.625, 12))], { x: 0.75 })],
    hover: { r: -8, o: [10.5, 10.5] },
    motion: "The lens reads: its lines move under it as it tilts.",
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
      g([p("M15 9V5.25A2.25 2.25 0 0 0 12.75 3H5.25A2.25 2.25 0 0 0 3 5.25V12.75A2.25 2.25 0 0 0 5.25 15H9")], { x: -0.75, y: -0.75 }),
      p(rr(9, 9, 12, 12, 2.25)),
    ],
    on: { kind: "swap", to: "check" },
    motion: "The sheet behind steps out. Active: becomes a check that draws itself.",
  }),
  check: I({
    group: "Message",
    elements: [p(poly(5.25, 12.75, 9.75, 17.25, 18.75, 6.75), { draw: true })],
    on: { kind: "draw" },
    motion: "Active: the stroke draws itself in.",
  }),
  "thumbs-up": I({
    group: "Message",
    elements: [p(THUMB), p(CUFF)],
    fill: [solid(THUMB), solid(`${CUFF}Z`)],
    on: { kind: "fill" },
    hover: { r: -8, o: [7.5, 19.5] },
    motion: "The thumb tips up. Active: filled.",
  }),
  "thumbs-down": I({
    group: "Message",
    elements: [p(flipY(THUMB)), p(flipY(CUFF))],
    fill: [solid(flipY(THUMB)), solid(`${flipY(CUFF)}Z`)],
    on: { kind: "fill" },
    hover: { r: 8, o: [7.5, 4.5] },
    motion: "The thumb tips down. Active: filled.",
  }),
  retry: I({
    group: "Message",
    elements: [p(arc(12, 12, 7.5, 130, -150)), p(head(...pt(12, 12, 7.5, -150), 120, 4.5))],
    hover: { r: -60, o: [12, 12] },
    motion: "Turns back a sixth, the way it points.",
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
      p(roundPoly(0.9, 3.75, 9.375, 7.125, 9.375, 11.25, 5.625, 11.25, 18.375, 7.125, 14.625, 3.75, 14.625)),
      g([p(arc(11.625, 12, 3.75, -48, 48))], { anim: "wave", delay: 0 }),
      g([p(arc(11.625, 12, 7.125, -48, 48))], { anim: "wave", delay: 90 }),
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
    fill: [solid(HAND)],
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
    elements: [p(roundPoly(2, 12, 3.75, 20.625, 19.125, 3.375, 19.125)), p(poly(12, 9.75, 12, 13.875)), dot(12, 16.5)],
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
    elements: page(p(poly(9, 12, 15, 12)), p(poly(9, 15.75, 15, 15.75)), p(poly(12, 10.5, 12, 17.25))),
    motion: "None.",
  }),
  deck: I({
    group: "Files",
    elements: [p(rr(3, 4.5, 18, 11.25, 2.25)), p(poly(7.5, 12, 10.5, 9.375, 13.125, 11.25, 16.5, 8.25)), p(poly(9.375, 20.25, 10.875, 15.75)), p(poly(14.625, 20.25, 13.125, 15.75))],
    motion: "None.",
  }),
  pdf: I({
    group: "Files",
    elements: page(p(poly(9, 12, 15, 12)), p(rr(9, 15, 6, 3, 1.5))),
    motion: "None.",
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
    elements: [g([c(15, 9, 5.25)], { x: 0.75, y: -0.75 }), ko(rr(4.5, 9.75, 9.75, 9.75, 2.25)), p(rr(4.5, 9.75, 9.75, 9.75, 2.25))],
    motion: "The circle slides out from behind the square: two layers parting.",
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
    elements: [
      ...PLUG.map((d) => p(shift(d, -1.5, 0))),
      ko(`${poly(18, 14.25, 18, 20.25)}${poly(15, 17.25, 21, 17.25)}`),
      g([p(poly(18, 14.25, 18, 20.25)), p(poly(15, 17.25, 21, 17.25))], { r: 90, o: [18, 17.25] }),
    ],
    motion: "The plus turns a quarter: add a connection.",
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
    group: "Crew and time",
    elements: [p(pebble(10.125, 5.25, 19.875, 12.75)), ko(`${poly(17.25, 13.5, 17.25, 19.5)}${poly(14.25, 16.5, 20.25, 16.5)}`), g([p(poly(17.25, 13.5, 17.25, 19.5)), p(poly(14.25, 16.5, 20.25, 16.5))], { r: 90, o: [17.25, 16.5] })],
    motion: "The plus turns a quarter.",
  }),
  routine: I({
    group: "Crew and time",
    elements: [
      g([p(arc(12, 12, 8.25, -60, 240)), p(head(...pt(12, 12, 8.25, 240), -30, 3.75))], { r: 45, o: [12, 12] }),
      p(poly(12, 8.25, 12, 12, 14.625, 13.5)),
    ],
    motion: "The loop comes round an eighth; the hands keep the time.",
  }),
  clock: I({
    group: "Crew and time",
    elements: [c(12, 12, 8.25), g([p(poly(12, 12, 12, 6.75))], { r: 90, o: [12, 12] }), p(poly(12, 12, 15, 13.875))],
    motion: "The long hand moves a quarter hour.",
  }),
  calendar: I({
    group: "Crew and time",
    elements: [p(rr(3.75, 5.25, 16.5, 15, 3)), p(poly(3.75, 10.5, 20.25, 10.5)), g([p(poly(8.25, 3, 8.25, 7.5)), p(poly(15.75, 3, 15.75, 7.5))], { y: -0.75 })],
    motion: "The rings lift, as a page turns.",
  }),
  pause: I({
    group: "Crew and time",
    elements: [p(poly(9, 6, 9, 18)), p(poly(15, 6, 15, 18))],
    on: { kind: "swap", to: "play" },
    motion: "Active: becomes play.",
  }),
  play: I({
    group: "Crew and time",
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
    elements: [g([p(poly(12, 4.5, 12, 12)), p(poly(8.25, 8.25, 15.75, 8.25))], { r: 90, o: [12, 8.25] }), p(poly(8.25, 17.25, 15.75, 17.25))],
    motion: "The plus turns a quarter.",
  }),
  branch: I({
    group: "Code",
    elements: [
      c(7.5, 6, 2.25),
      c(7.5, 18, 2.25),
      p(poly(7.5, 8.25, 7.5, 15.75)),
      g([c(16.5, 6, 2.25, { draw: true }), p("M16.5 8.25C16.5 12.75 7.5 11.25 7.5 15.75", { draw: true })], { anim: "draw" }),
    ],
    motion: "The branch draws itself off the trunk.",
  }),
  "pull-request": I({
    group: "Code",
    elements: [
      c(6, 6, 2.25),
      c(6, 18, 2.25),
      p(poly(6, 8.25, 6, 15.75)),
      c(18, 18, 2.25),
      g([p("M18 15.75V9A3 3 0 0 0 15 6H11.25", { draw: true }), p(head(11.25, 6, 180, 3.182), { draw: true })], { anim: "draw" }),
    ],
    motion: "The request's path draws itself back to the trunk.",
  }),
  run: I({
    group: "Code",
    elements: [c(12, 12, 8.25), g([p(roundPoly(1, 10.125, 8.625, 15.375, 12, 10.125, 15.375))], { x: 0.75 })],
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
      p(poly(7.125, 8.25, 7.125, 18.75, 13.5, 18.75)),
      p(poly(7.125, 12, 13.5, 12)),
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
    elements: [p("M6 18.75V5.25A2.25 2.25 0 0 1 8.25 3H18V21H15.75M11.25 21H8.25A2.25 2.25 0 0 1 6 18.75A2.25 2.25 0 0 1 8.25 16.5H18"), g([p("M11.25 16.5V22.125L13.5 20.625L15.75 22.125V16.5")], { y: 0.75 })],
    motion: "The ribbon slips down a little.",
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
    elements: [g([p(poly(8.25, 18.75, 8.25, 5.25)), p(head(8.25, 5.25, -90, 4.243))], { y: -1 }), g([p(poly(15.75, 5.25, 15.75, 18.75)), p(head(15.75, 18.75, 90, 4.243))], { y: 1 })],
    motion: "The arrows pass each other.",
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
    elements: [p(poly(8.25, 3.75, 15.75, 3.75)), p(PIN), p(poly(12, 13.5, 12, 20.25))],
    fill: [p(poly(8.25, 3.75, 15.75, 3.75)), solid(`${PIN}Z`), p(poly(12, 13.5, 12, 20.25))],
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
  close: I({ group: "Arrows", elements: [p(poly(6.375, 6.375, 17.625, 17.625)), p(poly(17.625, 6.375, 6.375, 17.625))], hover: { r: 90, o: [12, 12] }, motion: "Turns a quarter." }),
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
        { r: 45, o: [12, 12] },
      ),
    ],
    on: { kind: "swap", to: "moon" },
    motion: "The rays turn an eighth. Active: becomes the moon.",
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
    elements: [p(poly(4.5, 6.75, 19.5, 6.75)), p(poly(4.5, 12, 19.5, 12)), g([p(poly(4.5, 17.25, 13.5, 17.25))], { sx: 1.3, o: [4.5, 17.25] })],
    motion: "The last line writes itself a little further.",
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
} satisfies Record<string, IconDrawing>;

/** Other names the screens use for the same drawing. */
export const ICON_ALIASES = {
  compose: "new-chat",
  projects: "folder",
  "sidebar-toggle": "sidebar",
  "panel-left": "sidebar",
  waveform: "voice",
  slash: "skill",
  "needs-you": "hand",
  attention: "hand",
  error: "alert",
  doc: "document",
  file: "document",
  slides: "deck",
  plug: "app",
  "person-add": "add-member",
  preview: "eye",
  "globe-preview": "browser",
  web: "globe",
  "check-circle": "success",
  "branch-chat": "fork",
  settings2: "settings",
} satisfies Record<string, string>;

export function resolveIcon(name: string): IconDrawing | undefined {
  const icons: Record<string, IconDrawing> = ICONS;
  const aliases: Record<string, string> = ICON_ALIASES;
  return icons[name] ?? icons[aliases[name] ?? ""];
}
