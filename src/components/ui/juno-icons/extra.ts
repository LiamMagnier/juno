/**
 * Alevr icons: the production additions.
 *
 * The design lane draws the family in drawings.ts (a copy of the gallery's
 * src/app/dev/design/juno/icons/drawings.ts, ported as a whole). This file
 * holds the glyphs production needed that the gallery never drew: every mark
 * the web app used to borrow from Phosphor (the design editor's alignment,
 * media controls, the admin pages, a tool call's resting mark). They are drawn
 * here, in the same grammar, so a later port of drawings.ts overwrites nothing
 * and these stay one file to review.
 *
 * THE GRAMMAR (drawings.ts, top): the 24 unit construction grid, live area 3
 * to 21, key stems on the 1.5 unit lattice, one line (1.25 px at 16, 1.5 px
 * from 18), round caps and joins, continuous corners on every container (rr),
 * the 1.5 unit house gap where a part stands in front of another (ko), and
 * "New" as the house plus cut into the bottom-right corner. Every drawing is
 * projected to the family keyline (9/8) by `keyline`, exactly as drawings.ts
 * does, and fitted to the device pixel grid per size by the renderer.
 *
 * Primary silhouettes keep the family's mass: a 16.5 unit circle, a 15 unit
 * square, a 12 x 18 page, an 18 x 15 frame. Interior detail stays at least
 * 3 units (2 px at 16) from its container's line, and below 18 px a drawing
 * may drop detail (`small`).
 *
 * Pure data and pure functions, no JSX, so the native generator can read it
 * the way it reads drawings.ts.
 */

import {
  arc,
  c,
  dot,
  flipX,
  g,
  gumdrop,
  head,
  keyline,
  ko,
  koCircle,
  n3,
  p,
  poly,
  pencil,
  pt,
  rot,
  roundPoly,
  shift,
  rr,
  solid,
  turn,
  type IconDrawing,
  type IconElement,
} from "./drawings";

const I = (d: Omit<IconDrawing, "viewBox" | "line">): IconDrawing => keyline({ viewBox: 24, line: 1.5, ...d });

const f = (v: number): string => String(n3(v));
const P = (x: number, y: number): string => `${f(x)} ${f(y)}`;

/* —————————————————————————— Shared construction (drawings.ts' own, restated) —————————————————————————— */

/** The page every file mark is drawn on: 12 x 18 with a 4.5 unit fold. */
const PAGE = "M13.5 3H8.25A2.25 2.25 0 0 0 6 5.25V18.75A2.25 2.25 0 0 0 8.25 21H15.75A2.25 2.25 0 0 0 18 18.75V7.5Z";
const FOLD = "M13.5 3V6A1.5 1.5 0 0 0 15 7.5H18";
const page = (...inner: IconElement[]): IconElement[] => [p(PAGE), p(FOLD), ...inner];
/** The 18 x 15 frame (sidebar, image, terminal, browser). */
const FRAME = rr(3, 4.5, 18, 15, 3);
/** The chat bubble. */
const BUBBLE = "M6.75 4.5H17.25A3 3 0 0 1 20.25 7.5V13.5A3 3 0 0 1 17.25 16.5H11.25L7.5 19.875V16.5H6.75A3 3 0 0 1 3.75 13.5V7.5A3 3 0 0 1 6.75 4.5Z";
const CLOUD = "M7.125 18.75H17.25A3.75 3.75 0 0 0 17.9 11.31A5.625 5.625 0 0 0 7.05 10.6A4.125 4.125 0 0 0 7.125 18.75Z";
const SLASH = poly(4.5, 4.5, 19.5, 19.5);
const plusAt = (cx: number, cy: number, a = 3): string => `${poly(cx, cy - a, cx, cy + a)}${poly(cx - a, cy, cx + a, cy)}`;
/** A continuous corner (rr's construction), from the end of the incoming edge to the start of the outgoing one. */
function corner(vx: number, vy: number, inX: number, inY: number, outX: number, outY: number, r: number): string {
  const e = r * 1.18;
  const k = r * 0.32;
  return `C${P(vx + inX * k, vy + inY * k)} ${P(vx + outX * k, vy + outY * k)} ${P(vx + outX * e, vy + outY * e)}`;
}
const tabS = (x: number, yTab: number, yTop: number): string => {
  const s = (yTop - yTab) * 0.9;
  return `H${f(x)}C${P(x + s, yTab)} ${P(x + 1.25 * s - 0.6, yTop)} ${P(x + 2 * s, yTop)}`;
};
function folderBody(x0: number, x1: number, yTab: number, yTop: number, y1: number, tabEnd: number, r = 2.25): string {
  const e = r * 1.18;
  return (
    `M${P(x0, yTab + e)}${corner(x0, yTab, 0, 1, 1, 0, r)}${tabS(tabEnd, yTab, yTop)}H${f(x1 - e)}${corner(x1, yTop, -1, 0, 0, 1, r)}` +
    `V${f(y1 - e)}${corner(x1, y1, 0, -1, -1, 0, r)}H${f(x0 + e)}${corner(x0, y1, 1, 0, 0, -1, r)}Z`
  );
}
const FOLDER = folderBody(3.75, 20.25, 5.25, 7.5, 18.75, 8.25);
/** The monitor (computer's): an 18 x 12 screen on a stand. */
const SCREEN = rr(3, 4.5, 18, 12, 2.25);
const STAND = [poly(12, 16.5, 12, 19.5), poly(8.25, 19.5, 15.75, 19.5)];
/** The image frame's hills and sun. */
const HILLS = [poly(3, 15.75, 7.5, 11.25, 15.75, 19.5), poly(13.125, 16.875, 17.25, 12.75, 21, 16.5)];
const SHIELD = "M12 3.375L18.75 5.625V11.25C18.75 15.6 15.9 18.75 12 20.625C8.1 18.75 5.25 15.6 5.25 11.25V5.625Z";

/** A small chat bubble at (x, y), `w` x `h`, its tail at the bottom left (or right). */
function bubbleAt(x: number, y: number, w: number, h: number, r: number, tail: "left" | "right"): string {
  const x1 = x + w;
  const y1 = y + h;
  const e = r;
  if (tail === "left") {
    const tx = x + r + 1.5;
    return (
      `M${P(x + e, y)}H${f(x1 - e)}A${f(r)} ${f(r)} 0 0 1 ${P(x1, y + e)}V${f(y1 - e)}A${f(r)} ${f(r)} 0 0 1 ${P(x1 - e, y1)}` +
      `H${f(tx + 2.25)}L${P(tx - 0.75, y1 + 2.625)}V${f(y1)}H${f(x + e)}A${f(r)} ${f(r)} 0 0 1 ${P(x, y1 - e)}V${f(y + e)}A${f(r)} ${f(r)} 0 0 1 ${P(x + e, y)}Z`
    );
  }
  const tx = x1 - r - 1.5;
  return (
    `M${P(x + e, y)}H${f(x1 - e)}A${f(r)} ${f(r)} 0 0 1 ${P(x1, y + e)}V${f(y1 - e)}A${f(r)} ${f(r)} 0 0 1 ${P(x1 - e, y1)}` +
    `H${f(tx + 0.75)}V${f(y1 + 2.625)}L${P(tx - 2.25, y1)}H${f(x + e)}A${f(r)} ${f(r)} 0 0 1 ${P(x, y1 - e)}V${f(y + e)}A${f(r)} ${f(r)} 0 0 1 ${P(x + e, y)}Z`
  );
}

/* —————————————————————————— Constructed shapes —————————————————————————— */

/**
 * The wrench (a tool call's resting mark): an open-jaw spanner on the
 * diagonal. The head is a 4.875 unit ring whose jaw opens up and to the right,
 * the slot 3.75 units wide with a round floor at the ring's centre; the handle
 * runs 3 units wide down to the left and ends in a full round. One closed
 * outline, so the line weight is the family's and nothing crosses itself.
 */
const WRENCH = (() => {
  const cx = 15.375;
  const cy = 8.625;
  const R = 5.25;
  const axis = -45; // jaw direction (up right, SVG degrees)
  const half = 1.875; // half the slot's width
  const hw = 1.5; // half the handle's width
  const end: [number, number] = [5.625, 18.375]; // the handle's round end centre
  // Where the slot's sides meet the ring: the ring at angle axis +- asin(half / R).
  const da = (Math.asin(half / R) * 180) / Math.PI;
  const jawA = pt(cx, cy, R, axis + da);
  const jawB = pt(cx, cy, R, axis - da);
  // The slot's floor: a semicircle of radius `half` centred half a unit past the ring centre, toward the jaw.
  const [fx, fy] = pt(cx, cy, 0.375, axis);
  const floorA = pt(fx, fy, half, axis + 90);
  const floorB = pt(fx, fy, half, axis - 90);
  // Where the handle's sides meet the ring: the handle runs along axis + 180.
  const hda = (Math.asin(hw / R) * 180) / Math.PI;
  const neckA = pt(cx, cy, R, axis + 180 - hda);
  const neckB = pt(cx, cy, R, axis + 180 + hda);
  const tailA = pt(end[0], end[1], hw, axis + 90);
  const tailB = pt(end[0], end[1], hw, axis - 90);
  return (
    `M${P(...jawA)}L${P(...floorA)}A${f(half)} ${f(half)} 0 0 1 ${P(...floorB)}L${P(...jawB)}` +
    `A${f(R)} ${f(R)} 0 0 0 ${P(...neckA)}L${P(...tailB)}A${f(hw)} ${f(hw)} 0 0 1 ${P(...tailA)}L${P(...neckB)}` +
    `A${f(R)} ${f(R)} 0 0 0 ${P(...jawA)}Z`
  );
})();

/** A badge: a 12 lobed seal (the scallops soft, the line the family's), for "verified". */
const SEAL = (() => {
  const xy: number[] = [];
  const n = 12;
  for (let i = 0; i < n * 2; i++) xy.push(...pt(12, 12, i % 2 === 0 ? 8.625 : 7.125, -90 + (i * 180) / n));
  return roundPoly(1.35, ...xy);
})();

/** The eraser: a block on the diagonal, its working third cut off by one line, standing on a ground line. */
const ERASER_BLOCK = (() => {
  const q = (x: number, y: number) => rot(x, y, 12, 12, -45);
  return roundPoly(1.5, ...q(4.875, 8.625), ...q(19.125, 8.625), ...q(19.125, 15.375), ...q(4.875, 15.375));
})();
const ERASER_BAND = (() => {
  const a = rot(9.75, 8.625, 12, 12, -45);
  const b = rot(9.75, 15.375, 12, 12, -45);
  return poly(a[0], a[1], b[0], b[1]);
})();

/** A diamond about (cx, cy) with half diagonal `h`, its corners softened. */
const diamond = (cx: number, cy: number, h: number, r = 0.9): string => roundPoly(r, cx, cy - h, cx + h, cy, cx, cy + h, cx - h, cy);

/** One agent, alone: the crew's gumdrop with matte oval eyes (drawings.ts, `crew`), centred. */
const AGENT = gumdrop(12, 4.875, 20.25, 15, 0.5);
const AGENT_EYES = `${poly(9.375, 12.75, 9.375, 15)}${poly(14.625, 12.75, 14.625, 15)}`;

/** The selection outline: corners and the middle of each side, never a dash pattern (a dash round a corner leaves a seam). */
const SELECT_CORNERS = [
  "M3.75 7.5V6A2.25 2.25 0 0 1 6 3.75H7.5",
  "M16.5 3.75H18A2.25 2.25 0 0 1 20.25 6V7.5",
  "M20.25 16.5V18A2.25 2.25 0 0 1 18 20.25H16.5",
  "M7.5 20.25H6A2.25 2.25 0 0 1 3.75 18V16.5",
];
const SELECT_SIDES = [poly(10.5, 3.75, 13.5, 3.75), poly(20.25, 10.5, 20.25, 13.5), poly(10.5, 20.25, 13.5, 20.25), poly(3.75, 10.5, 3.75, 13.5)];

/** A cylinder (database): the top ellipse, the sides, one band, the foot. */
const DB_TOP = "M4.5 6.75A7.5 3 0 1 0 19.5 6.75A7.5 3 0 1 0 4.5 6.75Z";

/** Alignment bars: an edge rule and two blocks, the second shorter. */
const ALIGN_LEFT: IconElement[] = [p(poly(4.5, 3.75, 4.5, 20.25)), p(rr(7.5, 6, 12, 4.5, 1.5)), p(rr(7.5, 13.5, 7.5, 4.5, 1.5))];
/** Centred on the vertical axis: the axis shows only between and beyond the blocks. */
const ALIGN_CENTER: IconElement[] = [
  p(poly(12, 3.75, 12, 6)),
  p(poly(12, 10.5, 12, 13.5)),
  p(poly(12, 18, 12, 20.25)),
  p(rr(6, 6, 12, 4.5, 1.5)),
  p(rr(8.25, 13.5, 7.5, 4.5, 1.5)),
];
const turnEls = (els: IconElement[], deg: number): IconElement[] => els.map((el) => (el.tag === "path" ? p(turn(String(el.attrs.d), deg)) : el));
const flipEls = (els: IconElement[]): IconElement[] => els.map((el) => (el.tag === "path" ? p(flipX(String(el.attrs.d))) : el));

/* —————————————————————————— The additions —————————————————————————— */

export const EXTRA_ICONS = {
  /* ——— Arrows ——— */
  "arrow-up-right": I({
    group: "Arrows",
    elements: [p(poly(6.375, 17.625, 17.25, 6.75)), p(poly(9.75, 6.75, 17.25, 6.75, 17.25, 14.25))],
    hover: { x: 0.75, y: -0.75 },
    motion: "Nudges the way it points (out of the product).",
  }),
  "arrow-up-line": I({
    group: "Arrows",
    elements: [p(poly(5.25, 4.5, 18.75, 4.5)), g([p(poly(12, 20.25, 12, 9)), p(head(12, 9, -90, 6.364))], { y: -1 })],
    motion: "To the front (a layer's order): the arrow rises to its rule.",
  }),
  "arrow-down-line": I({
    group: "Arrows",
    elements: [p(poly(5.25, 19.5, 18.75, 19.5)), g([p(poly(12, 3.75, 12, 15)), p(head(12, 15, 90, 6.364))], { y: 1 })],
    motion: "To the back: the arrow drops to its rule.",
  }),
  "corner-down-right": I({
    group: "Arrows",
    elements: [p("M5.25 4.5V12A3 3 0 0 0 8.25 15H18.75"), p(head(18.75, 15, 0, 4.773))],
    hover: { x: 1.125 },
    motion: "A reply under a line (return's mirror). Nudges the way it points.",
  }),
  repeat: I({
    group: "Arrows",
    elements: [
      p("M4.5 11.25V9.75A3 3 0 0 1 7.5 6.75H18.75"),
      p(head(18.75, 6.75, 0, 4.243)),
      p("M19.5 12.75V14.25A3 3 0 0 1 16.5 17.25H5.25"),
      p(head(5.25, 17.25, 180, 4.243)),
    ],
    motion: "None: a loop's setting, read, not played.",
  }),
  unfold: I({
    group: "Arrows",
    elements: [p(poly(4.5, 12, 19.5, 12)), g([p(poly(8.625, 7.875, 12, 4.5, 15.375, 7.875))], { y: -0.75 }), g([p(poly(8.625, 16.125, 12, 19.5, 15.375, 16.125))], { y: 0.75 })],
    motion: "Two chevrons leave the rule: the block opens along its axis.",
  }),
  fold: I({
    group: "Arrows",
    elements: [p(poly(4.5, 12, 19.5, 12)), g([p(poly(8.625, 4.5, 12, 7.875, 15.375, 4.5))], { y: 0.75 }), g([p(poly(8.625, 19.5, 12, 16.125, 15.375, 19.5))], { y: -0.75 })],
    motion: "Two chevrons close on the rule.",
  }),

  /* ——— Files and storage ——— */
  unarchive: I({
    group: "Library",
    elements: [
      p(rr(3.75, 4.5, 16.5, 4.5, 1.5)),
      p("M5.25 9V17.25A2.25 2.25 0 0 0 7.5 19.5H16.5A2.25 2.25 0 0 0 18.75 17.25V9"),
      g([p(poly(12, 16.875, 12, 12)), p(head(12, 12, -90, 3.182))], { y: -0.75 }),
    ],
    motion: "Archive's box with the arrow coming back out of it. The arrow rises.",
  }),
  "cloud-upload": I({
    group: "Library",
    elements: [p(CLOUD), ko(poly(12, 21, 12, 12.375)), g([p(poly(12, 21, 12, 12.375)), p(head(12, 12.375, -90, 3.712))], { y: -0.75 })],
    motion: "The arrow rises into the cloud, cut clear of its base by the house gap.",
  }),
  "file-upload": I({
    group: "Files",
    elements: page(g([p(poly(12, 17.625, 12, 11.25)), p(head(12, 11.25, -90, 3.182))], { y: -0.75 })),
    motion: "The arrow rises up the page.",
  }),
  "file-plus": I({
    group: "Files",
    elements: page(p(plusAt(12, 14.25, 2.625))),
    motion: "None: a new file.",
  }),
  save: I({
    group: "Library",
    elements: [
      p("M3.75 6A2.25 2.25 0 0 1 6 3.75H15.75L20.25 8.25V18A2.25 2.25 0 0 1 18 20.25H6A2.25 2.25 0 0 1 3.75 18Z"),
      p(poly(8.25, 3.75, 8.25, 7.5, 14.25, 7.5, 14.25, 3.75)),
      p("M7.5 20.25V15A1.5 1.5 0 0 1 9 13.5H15A1.5 1.5 0 0 1 16.5 15V20.25"),
    ],
    motion: "None: a verb whose result is the answer.",
  }),
  printer: I({
    group: "Library",
    elements: [
      p(poly(6.75, 8.25, 6.75, 3.75, 17.25, 3.75, 17.25, 8.25)),
      p("M6.75 16.5H5.25A2.25 2.25 0 0 1 3 14.25V10.5A2.25 2.25 0 0 1 5.25 8.25H18.75A2.25 2.25 0 0 1 21 10.5V14.25A2.25 2.25 0 0 1 18.75 16.5H17.25"),
      p(rr(6.75, 12.75, 10.5, 7.5, 1.5)),
    ],
    motion: "None.",
  }),
  inbox: I({
    group: "Library",
    elements: [p(rr(3.75, 3.75, 16.5, 16.5, 3)), p(poly(3.75, 13.5, 8.25, 13.5, 9.75, 15.75, 14.25, 15.75, 15.75, 13.5, 20.25, 13.5))],
    motion: "None.",
  }),
  layers: I({
    group: "Library",
    elements: [
      p(roundPoly(1.2, 12, 3.75, 20.25, 8.25, 12, 12.75, 3.75, 8.25)),
      p(poly(3.75, 12.375, 12, 16.875, 20.25, 12.375)),
      p(poly(3.75, 16.125, 12, 20.625, 20.25, 16.125)),
    ],
    small: { elements: [p(roundPoly(1.2, 12, 4.5, 20.25, 9, 12, 13.5, 3.75, 9)), p(poly(3.75, 15, 12, 19.5, 20.25, 15))] },
    motion: "None. Below 18 px one layer goes (the small cut): three lines 3 px apart turn to a grey block.",
  }),
  "folder-code": I({
    group: "Library",
    elements: [p(FOLDER), p(poly(10.125, 10.875, 8.25, 13.125, 10.125, 15.375)), p(poly(13.875, 10.875, 15.75, 13.125, 13.875, 15.375))],
    motion: "None.",
  }),
  "folder-lock": I({
    group: "Library",
    elements: [
      p(FOLDER),
      ko(rr(13.5, 15, 7.5, 6, 1.5)),
      p(rr(13.5, 15, 7.5, 6, 1.5)),
      p("M15 15V13.875A2.25 2.25 0 0 1 19.5 13.875V15"),
    ],
    motion: "None: a private folder, the lock cut into its corner where New puts the plus.",
  }),

  /* ——— Media ——— */
  "pause-circle": I({
    group: "Agents and time",
    elements: [c(12, 12, 8.25), p(poly(9.75, 8.625, 9.75, 15.375)), p(poly(14.25, 8.625, 14.25, 15.375))],
    motion: "None: a state.",
  }),
  "stop-circle": I({
    group: "Agents and time",
    elements: [c(12, 12, 8.25), solid(rr(9.375, 9.375, 5.25, 5.25, 1.125))],
    motion: "None: a state.",
  }),
  "skip-back": I({
    group: "Agents and time",
    optical: 1.06,
    elements: [p(poly(6, 6, 6, 18)), p(roundPoly(1.4, 18, 6, 9.375, 12, 18, 18))],
    hover: { x: -0.75 },
    motion: "Back to the start: nudges back.",
  }),
  "end-call": I({
    group: "Composer",
    elements: [
      p(
        "M3.75 14.25V12.75C3.75 10.4 7.5 8.625 12 8.625C16.5 8.625 20.25 10.4 20.25 12.75V14.25A1.5 1.5 0 0 1 18.75 15.75H16.5A1.5 1.5 0 0 1 15 14.25V12.95C13.1 12.4 10.9 12.4 9 12.95V14.25A1.5 1.5 0 0 1 7.5 15.75H5.25A1.5 1.5 0 0 1 3.75 14.25Z",
      ),
    ],
    motion: "None: the receiver laid flat, the call ends.",
  }),
  broadcast: I({
    group: "Agents and time",
    elements: [
      dot(12, 12, 1.5),
      p(arc(12, 12, 4.5, -45, 45)),
      p(arc(12, 12, 4.5, 135, 225)),
      p(arc(12, 12, 8.25, -40, 40)),
      p(arc(12, 12, 8.25, 140, 220)),
    ],
    motion: "None: a trigger that listens.",
  }),
  video: I({
    group: "Composer",
    elements: [p(rr(3, 6.75, 12.75, 10.5, 2.25)), p(roundPoly(1, 15.75, 10.5, 21, 7.5, 21, 16.5, 15.75, 13.5))],
    motion: "None.",
  }),
  film: I({
    group: "Files",
    elements: [
      p(FRAME),
      p(poly(7.5, 4.5, 7.5, 19.5)),
      p(poly(16.5, 4.5, 16.5, 19.5)),
      p(poly(3, 12, 7.5, 12)),
      p(poly(16.5, 12, 21, 12)),
    ],
    motion: "None. A frame and its two sprocket columns.",
  }),
  music: I({
    group: "Files",
    elements: [c(7.125, 17.25, 2.625), c(16.875, 15.75, 2.625), p(poly(9.75, 17.25, 9.75, 5.625, 19.5, 3.75, 19.5, 15.75))],
    motion: "None.",
  }),
  "image-plus": I({
    group: "Composer",
    elements: [
      p("M21 12V7.5A3 3 0 0 0 18 4.5H6A3 3 0 0 0 3 7.5V16.5A3 3 0 0 0 6 19.5H12"),
      p(poly(3, 15.75, 7.5, 11.25, 11.625, 15.375)),
      c(15.75, 8.625, 1.875),
      p(plusAt(18, 17.25, 3)),
    ],
    motion: "None: the image frame opened at its corner for the house plus.",
  }),
  "image-off": I({
    group: "Composer",
    elements: [p(FRAME), ...HILLS.map((d) => p(d)), ko(SLASH), p(SLASH)],
    motion: "None: a state (the image could not be shown).",
  }),
  "screen-share": I({
    group: "Code",
    elements: [p(SCREEN), ...STAND.map((d) => p(d)), g([p(poly(12, 13.125, 12, 7.875)), p(head(12, 7.875, -90, 3.182))], { y: -0.75 })],
    motion: "The arrow rises on the screen: this screen goes to the call.",
  }),
  "screen-off": I({
    group: "Code",
    elements: [p(SCREEN), ...STAND.map((d) => p(d)), p(poly(9.75, 8.25, 14.25, 12.75)), p(poly(14.25, 8.25, 9.75, 12.75))],
    motion: "None: stop sharing.",
  }),

  /* ——— Conversation ——— */
  "chat-question": I({
    group: "Message",
    elements: [p(BUBBLE), p("M10.125 8.625A1.875 1.875 0 1 1 12.9 10.27C12.4 10.56 12 10.96 12 11.625"), dot(12, 13.875, 0.9)],
    small: { elements: [p(BUBBLE), dot(12, 10.5, 1.125)] },
    motion: "None. Below 18 px the question becomes one point in the bubble (a question mark at 3 px is a smudge).",
  }),
  chats: I({
    group: "Message",
    elements: [p(bubbleAt(3, 3.75, 12, 9, 2.25, "left")), ko(bubbleAt(9, 9.75, 12, 8.25, 2.25, "right")), p(bubbleAt(9, 9.75, 12, 8.25, 2.25, "right"))],
    motion: "None. Two bubbles, the reply in front, cut clear by the house gap.",
  }),
  thought: I({
    group: "Message",
    elements: [p(rr(4.5, 3.75, 15.75, 11.25, 4.5)), c(7.5, 18, 1.5), dot(4.875, 20.625, 0.9)],
    motion: "None: the resting mark of a model's reasoning row (the live one is the Continuum mark beside its phase words).",
  }),

  /* ——— Editing and design ——— */
  eraser: I({
    group: "Message",
    elements: [p(ERASER_BLOCK), p(ERASER_BAND), p(poly(11.25, 20.25, 20.25, 20.25))],
    motion: "None.",
  }),
  "link-off": I({
    group: "Files",
    optical: 1.06,
    elements: [
      p(shift(turn("M9.75 16.5H7.5A4.5 4.5 0 0 1 7.5 7.5H9.75", -45), -1.125, 1.125)),
      p(shift(turn("M14.25 7.5H16.5A4.5 4.5 0 0 1 16.5 16.5H14.25", -45), 1.125, -1.125)),
      p(poly(10.125, 10.125, 13.875, 13.875)),
    ],
    motion: "None: the link's two halves drawn apart, the break marked across the gap where the bar was.",
  }),
  crop: I({
    group: "Composer",
    elements: [p(poly(6.75, 3, 6.75, 17.25, 21, 17.25)), p(poly(3, 6.75, 17.25, 6.75, 17.25, 21))],
    motion: "None.",
  }),
  "list-plus": I({
    group: "Library",
    elements: [p(poly(4.5, 6.75, 19.5, 6.75)), p(poly(4.5, 12, 12.75, 12)), p(poly(4.5, 17.25, 10.5, 17.25)), p(plusAt(17.25, 15.375, 2.625))],
    motion: "None: a menu verb.",
  }),
  "list-minus": I({
    group: "Library",
    elements: [p(poly(4.5, 6.75, 19.5, 6.75)), p(poly(4.5, 12, 12.75, 12)), p(poly(4.5, 17.25, 10.5, 17.25)), p(poly(14.625, 15.375, 19.875, 15.375))],
    motion: "None: a menu verb.",
  }),
  square: I({
    group: "Files",
    elements: [p(rr(4.5, 4.5, 15, 15, 3))],
    fill: [solid(rr(4.5, 4.5, 15, 15, 3))],
    on: { kind: "fill" },
    motion: "None: a shape.",
  }),
  frame: I({
    group: "Files",
    elements: [p(poly(8.25, 3.75, 8.25, 20.25)), p(poly(15.75, 3.75, 15.75, 20.25)), p(poly(3.75, 8.25, 20.25, 8.25)), p(poly(3.75, 15.75, 20.25, 15.75))],
    motion: "None: the design editor's frame tool.",
  }),
  component: I({
    group: "Files",
    elements: [p(diamond(12, 6.375, 3)), p(diamond(17.625, 12, 3)), p(diamond(12, 17.625, 3)), p(diamond(6.375, 12, 3))],
    motion: "None.",
  }),
  group: I({
    group: "Files",
    elements: [
      p(rr(5.25, 5.25, 13.5, 13.5, 1.5)),
      ko(rr(3.375, 3.375, 3.75, 3.75, 0.75)),
      ko(rr(16.875, 3.375, 3.75, 3.75, 0.75)),
      ko(rr(16.875, 16.875, 3.75, 3.75, 0.75)),
      ko(rr(3.375, 16.875, 3.75, 3.75, 0.75)),
      p(rr(3.375, 3.375, 3.75, 3.75, 0.75)),
      p(rr(16.875, 3.375, 3.75, 3.75, 0.75)),
      p(rr(16.875, 16.875, 3.75, 3.75, 0.75)),
      p(rr(3.375, 16.875, 3.75, 3.75, 0.75)),
    ],
    small: { elements: [p(rr(5.25, 5.25, 13.5, 13.5, 1.5)), dot(5.25, 5.25, 1.5), dot(18.75, 5.25, 1.5), dot(18.75, 18.75, 1.5), dot(5.25, 18.75, 1.5)] },
    motion: "None: a bounding box and its handles.",
  }),
  selection: I({
    group: "Files",
    elements: [...SELECT_CORNERS.map((d) => p(d)), ...SELECT_SIDES.map((d) => p(d))],
    motion: "None.",
  }),
  "select-area": I({
    group: "Files",
    elements: [
      ...SELECT_CORNERS.slice(0, 2).map((d) => p(d)),
      p(SELECT_CORNERS[3]),
      ...[SELECT_SIDES[0], SELECT_SIDES[3]].map((d) => p(d)),
      p(poly(20.25, 10.5, 20.25, 11.25)),
      p(poly(10.5, 20.25, 11.25, 20.25)),
      ko(roundPoly(0.75, 13.5, 13.5, 21.375, 16.5, 17.85, 17.85, 16.5, 21.375)),
      p(roundPoly(0.75, 13.5, 13.5, 21.375, 16.5, 17.85, 17.85, 16.5, 21.375)),
    ],
    motion: "None: point at a region (the selection, with the pointer standing in its corner).",
  }),
  crosshair: I({
    group: "Code",
    elements: [c(12, 12, 6.75), p(poly(12, 3, 12, 8.25)), p(poly(12, 15.75, 12, 21)), p(poly(3, 12, 8.25, 12)), p(poly(15.75, 12, 21, 12))],
    motion: "None.",
  }),
  type: I({
    group: "Files",
    elements: [p(poly(5.25, 6.75, 5.25, 4.5, 18.75, 4.5, 18.75, 6.75)), p(poly(12, 4.5, 12, 19.5)), p(poly(9, 19.5, 15, 19.5))],
    motion: "None: the text tool, a T with Newsreader's serifs.",
  }),
  layout: I({
    group: "Library",
    elements: [p(rr(3.75, 3.75, 16.5, 16.5, 3)), p(poly(3.75, 9.75, 20.25, 9.75)), p(poly(10.5, 9.75, 10.5, 20.25))],
    motion: "None.",
  }),
  columns: I({
    group: "Library",
    elements: [p(rr(3.75, 3.75, 16.5, 16.5, 3)), p(poly(12, 3.75, 12, 20.25))],
    motion: "None.",
  }),
  line: I({
    group: "Files",
    elements: [p(poly(5.25, 18.75, 18.75, 5.25))],
    motion: "None: the design editor's line tool.",
  }),
  bolt: I({
    group: "Files",
    elements: [p(roundPoly(1, 13.5, 3, 5.25, 13.5, 11.25, 13.5, 10.5, 21, 18.75, 10.5, 12.75, 10.5))],
    motion: "None: an interaction (a prototype's trigger).",
  }),

  /* ——— Places, devices and things ——— */
  map: I({
    group: "Library",
    elements: [p(roundPoly(1.2, 3.75, 6, 9, 3.75, 15, 6, 20.25, 3.75, 20.25, 18, 15, 20.25, 9, 18, 3.75, 20.25)), p(poly(9, 3.75, 9, 18)), p(poly(15, 6, 15, 20.25))],
    motion: "None.",
  }),
  database: I({
    group: "Code",
    elements: [p(DB_TOP), p(poly(4.5, 6.75, 4.5, 17.25)), p(poly(19.5, 6.75, 19.5, 17.25)), p("M4.5 12A7.5 3 0 0 0 19.5 12"), p("M4.5 17.25A7.5 3 0 0 0 19.5 17.25")],
    motion: "None.",
  }),
  cube: I({
    group: "Code",
    elements: [p(roundPoly(1.2, 12, 3.375, 19.5, 7.5, 19.5, 16.5, 12, 20.625, 4.5, 16.5, 4.5, 7.5)), p(poly(4.5, 7.5, 12, 11.625, 19.5, 7.5)), p(poly(12, 11.625, 12, 20.625))],
    motion: "None: a model.",
  }),
  tablet: I({
    group: "Code",
    elements: [p(rr(4.5, 3, 15, 18, 2.25)), p(poly(10.5, 18, 13.5, 18))],
    motion: "None.",
  }),
  braces: I({
    group: "Code",
    elements: [
      p("M8.625 4.5C7.2 4.5 6.375 5.25 6.375 6.75V9.375C6.375 10.95 5.6 11.85 4.5 12C5.6 12.15 6.375 13.05 6.375 14.625V17.25C6.375 18.75 7.2 19.5 8.625 19.5"),
      p(flipX("M8.625 4.5C7.2 4.5 6.375 5.25 6.375 6.75V9.375C6.375 10.95 5.6 11.85 4.5 12C5.6 12.15 6.375 13.05 6.375 14.625V17.25C6.375 18.75 7.2 19.5 8.625 19.5")),
    ],
    motion: "None: structured data.",
  }),
  wrench: I({
    group: "Code",
    elements: [p(WRENCH)],
    motion: "None: a tool call's resting mark (what kind of work the row holds).",
  }),
  workflow: I({
    group: "Code",
    elements: [p(rr(3.75, 3.75, 6.75, 6.75, 1.5)), p(rr(13.5, 13.5, 6.75, 6.75, 1.5)), p("M7.125 10.5V14.625A2.25 2.25 0 0 0 9.375 16.875H13.5")],
    motion: "None: steps carried out.",
  }),
  agent: I({
    group: "Agents and time",
    elements: [p(AGENT), p(AGENT_EYES)],
    motion: "None: one agent (a subagent in a run); the crew draws two.",
  }),
  people: I({
    group: "Agents and time",
    elements: [
      c(9.375, 8.625, 3.375),
      p("M3.375 19.5C3.375 16.6 6 14.625 9.375 14.625C12.75 14.625 15.375 16.6 15.375 19.5"),
      p("M15.375 5.4A3.375 3.375 0 0 1 15.375 11.85"),
      p("M17.625 14.85C19.4 15.45 20.625 17.1 20.625 19.5"),
    ],
    motion: "None: people (accounts, members). An agent is drawn as one.",
  }),
  megaphone: I({
    group: "Apps",
    elements: [p("M4.5 9.75V14.25A1.5 1.5 0 0 0 6 15.75H8.25L17.25 19.875V4.125L8.25 8.25H6A1.5 1.5 0 0 0 4.5 9.75Z"), p(poly(8.25, 15.75, 9.375, 20.25)), p(poly(20.25, 10.5, 20.25, 13.5))],
    motion: "None.",
  }),
  learn: I({
    group: "Apps",
    elements: [
      p(roundPoly(0.8, 12, 4.5, 21, 9, 12, 13.5, 3, 9)),
      p("M6.75 11.625V15.75C6.75 17.25 9 18.75 12 18.75C15 18.75 17.25 17.25 17.25 15.75V11.625"),
      p(poly(21, 9, 21, 14.25)),
    ],
    motion: "None.",
  }),
  target: I({
    group: "Apps",
    elements: [c(12, 12, 8.25), c(12, 12, 4.5), dot(12, 12, 1.5)],
    motion: "None.",
  }),
  coins: I({
    group: "Apps",
    elements: [c(9, 9, 5.25), koCircle(15, 15, 5.25), c(15, 15, 5.25)],
    motion: "None: what a run cost.",
  }),
  sigma: I({
    group: "Apps",
    elements: [p(poly(17.25, 5.25, 6.75, 5.25, 12.375, 12, 6.75, 18.75, 17.25, 18.75))],
    motion: "None: a total.",
  }),
  timer: I({
    group: "Agents and time",
    elements: [c(12, 13.5, 7.125), p(poly(9.75, 3, 14.25, 3)), p(poly(12, 13.5, 12, 9.375)), p(poly(18.375, 6.375, 19.5, 5.25))],
    motion: "None.",
  }),
  calculator: I({
    group: "Apps",
    elements: [
      p(rr(5.25, 3, 13.5, 18, 2.25)),
      p(poly(8.625, 7.5, 15.375, 7.5)),
      dot(9, 12, 1),
      dot(12, 12, 1),
      dot(15, 12, 1),
      dot(9, 15.75, 1),
      dot(12, 15.75, 1),
      dot(15, 15.75, 1),
    ],
    motion: "None.",
  }),
  fingerprint: I({
    group: "Apps",
    elements: [
      p(arc(12, 12.75, 8.25, 200, 340)),
      p("M6.75 19.125V13.5A5.25 5.25 0 0 1 17.25 13.5V15"),
      p("M9.75 19.875V13.5A2.25 2.25 0 0 1 14.25 13.5V16.5C14.25 18 14.7 19.2 15.375 20.25"),
    ],
    motion: "None.",
  }),
  "profile-edit": I({
    group: "Agents and time",
    elements: [
      c(10.125, 8.25, 3.75),
      p("M3.375 20.25C3.375 17.1 6.4 15 10.125 15C11.1 15 12 15.13 12.84 15.38"),
      ko(pencil(13.5, 20.625, -45, 9.5, 3.375, 2.625)),
      p(pencil(13.5, 20.625, -45, 9.5, 3.375, 2.625)),
    ],
    motion: "None: you, adjusted (personalization). The person with the house pencil standing in the corner.",
  }),

  /* ——— Status ——— */
  loader: I({
    group: "States",
    elements: [p(arc(12, 12, 7.5, -90, 180))],
    motion: "None of its own: a call site that is waiting turns it (animate-spin), and only while it waits.",
  }),
  "circle-dashed": I({
    group: "States",
    elements: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => p(arc(12, 12, 7.5, -90 + i * 45 + 9, -90 + i * 45 + 36))),
    motion: "None: not started (eight even segments, never a dash pattern).",
  }),
  "error-circle": I({
    group: "States",
    elements: [c(12, 12, 8.25), p(poly(9.375, 9.375, 14.625, 14.625)), p(poly(14.625, 9.375, 9.375, 14.625))],
    motion: "None: a state.",
  }),
  verified: I({
    group: "States",
    elements: [p(SEAL), p(poly(8.625, 12.375, 10.875, 14.625, 15.375, 9.75))],
    motion: "None.",
  }),
  ban: I({
    group: "States",
    elements: [c(12, 12, 8.25), p(poly(6.17, 6.17, 17.83, 17.83))],
    motion: "None: not allowed.",
  }),
  "shield-alert": I({
    group: "Apps",
    elements: [p(SHIELD), p(poly(12, 8.25, 12, 12.375)), dot(12, 15.375)],
    motion: "None: a state.",
  }),
  "shield-off": I({
    group: "Apps",
    elements: [p(SHIELD), ko(SLASH), p(SLASH)],
    motion: "None: a state.",
  }),
  upgrade: I({
    group: "System",
    elements: [c(12, 12, 8.25), g([p(poly(12, 16.125, 12, 8.25)), p(head(12, 8.25, -90, 3.712))], { y: -0.75 })],
    motion: "A plan above this one. The arrow rises.",
  }),

  /* ——— Design editor alignment ——— */
  "align-left": I({ group: "Files", elements: ALIGN_LEFT, motion: "None." }),
  "align-right": I({ group: "Files", elements: flipEls(ALIGN_LEFT), motion: "None." }),
  "align-center": I({ group: "Files", elements: ALIGN_CENTER, motion: "None." }),
  "align-top": I({ group: "Files", elements: turnEls(flipEls(ALIGN_LEFT), -90), motion: "None." }),
  "align-bottom": I({ group: "Files", elements: turnEls(ALIGN_LEFT, -90), motion: "None." }),
  "align-middle": I({ group: "Files", elements: turnEls(ALIGN_CENTER, 90), motion: "None." }),
  "distribute-horizontal": I({
    group: "Files",
    elements: [p(poly(3.75, 4.5, 3.75, 19.5)), p(poly(20.25, 4.5, 20.25, 19.5)), p(rr(9, 7.5, 6, 9, 1.5))],
    motion: "None.",
  }),
  "distribute-vertical": I({
    group: "Files",
    elements: [p(poly(4.5, 3.75, 19.5, 3.75)), p(poly(4.5, 20.25, 19.5, 20.25)), p(rr(7.5, 9, 9, 6, 1.5))],
    motion: "None.",
  }),

} satisfies Record<string, IconDrawing>;

/** Production names for these and the family's drawings. */
export const EXTRA_ALIASES = {
  "phone-off": "end-call",
  hangup: "end-call",
  "monitor-up": "screen-share",
  "monitor-x": "screen-off",
  spinner: "loader",
  "x-circle": "error-circle",
  "badge-check": "verified",
  prohibit: "ban",
  shapes: "appearance",
  "search-empty": "search",
  "text-search": "research",
  "file-search": "research",
  subagent: "agent",
  bot: "agent",
  users: "people",
  members: "people",
  reasoning: "thought",
  interaction: "bolt",
} satisfies Record<string, string>;

