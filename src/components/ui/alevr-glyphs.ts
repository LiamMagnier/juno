/**
 * Alevr Line: the house icon drawings (owner, 6 Nov 2026: "rework the icons,
 * draw them the best way possible with motion design").
 *
 * Pure data, no React, so a server component (and a test) can read it.
 *
 * THE GRID. A 24 unit box, live area 3 to 21. Containers are 15 to 17 units
 * with a 3 unit corner (the same continuous softness as the menus and the
 * composer), circles are 17 units, so a square, a circle and a page carry the
 * same weight next to each other in a menu column.
 *
 * THE LINE. One stroke, round caps and joins. Its width is set per rendered
 * size by the renderer (icons.tsx), so a 16 px glyph and a 20 px glyph both
 * paint a crisp line of about 1.4 and 1.5 device-independent pixels instead of
 * one scaled number. Points (the dot of an i, the grip) are filled circles.
 *
 * MOTION. Each drawing names one gesture (`m`) and wraps the part that moves
 * in `<g class="gm">` (a second part in `gm2`). The gesture plays while the
 * control around the glyph is under a fine pointer, eases out in about 200 ms
 * and reverses from wherever it is when the pointer leaves (transitions, not
 * keyframes, except for the one-shot gestures). The CSS lives in
 * signature.css §6 and is off under reduced motion.
 */

export type GlyphMotion =
  | "r" | "l" | "u" | "d" | "ne"
  | "rot" | "turn" | "spin" | "ccw" | "cw"
  | "lid" | "lift" | "shift" | "tilt" | "swing" | "wiggle"
  | "pop" | "draw" | "blink" | "wave" | "squeeze" | "grow" | "shrink";

export type Glyph = {
  /** Inner SVG markup on the 24 unit grid. */
  b: string;
  /** The hover gesture. */
  m?: GlyphMotion;
  /** The "on" drawing (a pinned pin, a filled star). */
  on?: string;
};

// --- primitives ------------------------------------------------------------

const P = (...d: string[]) => d.map((x) => `<path d="${x}"/>`).join("");
const R = (x: number, y: number, w: number, h: number, r = 3) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/>`;
const C = (cx: number, cy: number, r: number) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
/** A point: filled, no line. */
const D = (cx: number, cy: number, r = 1.1) => `<circle class="gd" cx="${cx}" cy="${cy}" r="${r}"/>`;
/** A filled shape for an "on" drawing. */
const F = (d: string) => `<path class="gf" d="${d}"/>`;
/** The moving part. */
const M = (...parts: string[]) => `<g class="gm">${parts.join("")}</g>`;
const M2 = (...parts: string[]) => `<g class="gm2">${parts.join("")}</g>`;
/** A path that can draw itself in (check marks). */
const DRAW = (d: string) => `<path class="gdraw" pathLength="1" d="${d}"/>`;
const flipY = (inner: string) => `<g transform="matrix(1 0 0 -1 0 24)">${inner}</g>`;

const dashed = (inner: string) => `<g class="gdash">${inner}</g>`;
const wave = (...bars: string[]) => bars.map((d, i) => `<g class="gw" style="--i:${i}"><path d="${d}"/></g>`).join("");

/** Struck through: the slash cuts a clean gap through what it crosses (the house gap), then draws on top. */
const SLASHED = (inner: string) =>
  `<defs><mask id="ag-slash" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/><path d="M3.5 3.5l17 17" stroke="#000" stroke-width="4.5" stroke-linecap="round"/></mask></defs><g mask="url(#ag-slash)">${inner}</g><path d="M3.5 3.5l17 17"/>`;

/** A gear: n teeth, tip radius R, root radius r, tooth half-angle at the tip and the flank width, in degrees. */
function gear(n: number, Rt: number, r: number, tip: number, flank: number): string {
  const pt = (rad: number, deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(12 + rad * Math.cos(a)).toFixed(2)} ${(12 + rad * Math.sin(a)).toFixed(2)}`;
  };
  const step = 360 / n;
  let d = "";
  for (let k = 0; k < n; k++) {
    const t = k * step;
    const a0 = t - tip - flank;
    d += k === 0 ? `M${pt(r, a0)}` : ` A${r} ${r} 0 0 1 ${pt(r, a0)}`;
    d += ` L${pt(Rt, t - tip)} A${Rt} ${Rt} 0 0 1 ${pt(Rt, t + tip)} L${pt(r, t + tip + flank)}`;
  }
  d += ` A${r} ${r} 0 0 1 ${pt(r, -tip - flank)}Z`;
  return d;
}

// --- shared silhouettes ------------------------------------------------------

const BUBBLE = "M12 20a8 8 0 1 0-7-4.1L4 20l4.1-1A8 8 0 0 0 12 20Z";
const PAGE = "M13.5 3.5H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V9Z";
const PAGE_FOLD = "M13.5 3.5V7a2 2 0 0 0 2 2H19";
const FOLDER = "M3.5 7.5a3 3 0 0 1 3-3h2.9a2 2 0 0 1 1.4.6l1.4 1.3a2 2 0 0 0 1.4.6h4.9a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3h-12a3 3 0 0 1-3-3Z";
const MONITOR = R(3, 4, 18, 12.5, 3) + P("M12 16.5V20", "M8 20h8");
const CLOUD = "M7.5 19h9.25a4.25 4.25 0 0 0 .55-8.46A5.75 5.75 0 0 0 6.2 9.6 4.75 4.75 0 0 0 7.5 19Z";
const SHIELD = "M12 3.5l7 2.6v5.2c0 4.5-2.9 7.7-7 9.2-4.1-1.5-7-4.7-7-9.2V6.1Z";
const RING = C(12, 12, 8.5);
const PENCIL = "M4.5 19.5l.9-4L15.6 5.3a2.1 2.1 0 0 1 3 0l.1.1a2.1 2.1 0 0 1 0 3L8.5 18.6Z";
const LOOP_CCW = "M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9";
const PLAY = "M8 5.4v13.2a1 1 0 0 0 1.5.86l10.4-6.6a1 1 0 0 0 0-1.7L9.5 4.54A1 1 0 0 0 8 5.4Z";
const STAR = "M12 3.8l2.45 5 5.5.8-3.98 3.88.94 5.48L12 16.36l-4.91 2.6.94-5.48L4.05 9.6l5.5-.8Z";
const PIN = "M9.5 3.5h5M10.25 3.5v5.25L7.25 12.5v2h9.5v-2l-3-3.75V3.5";
const THUMB = "M7.5 10.5L11 3.6a2.1 2.1 0 0 1 2.1 2.5l-.6 3.4h5.1a2.2 2.2 0 0 1 2.1 2.8l-1.6 5.9a2.2 2.2 0 0 1-2.1 1.6H7.5Z";
const THUMB_CUFF = R(3.5, 10.5, 4, 9.5, 1.5);
const BOT = R(4.5, 8, 15, 11.5, 4) + P("M12 8V5") + D(12, 4.25, 1.25) + P("M2.75 12.5v3", "M21.25 12.5v3");

// --- the drawings, by concept --------------------------------------------

export const GLYPHS: Record<string, Glyph> = {
  // places
  chat: { b: P(BUBBLE), m: "tilt" },
  chats: { b: P("M8.5 8V6.5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3V11a3 3 0 0 1-3 3h-.5", "M3.5 11a3 3 0 0 1 3-3h6.5a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H9.5l-3.5 2.5V18A3 3 0 0 1 3.5 15Z"), m: "tilt" },
  "chat-question": { b: P(BUBBLE, "M9.75 9.75a2.25 2.25 0 1 1 3.1 2.08c-.5.22-.85.64-.85 1.17v.25") + D(12, 15.6, 0.95), m: "tilt" },
  "new-chat": { b: P("M11 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4") + M(P("M17.9 3.6a2 2 0 0 1 2.5 2.5l-.1.2-7.6 7.6-3.2.8.8-3.2 7.6-7.6Z")), m: "wiggle" },
  code: { b: M(P("M8.5 7l-5 5 5 5")) + M2(P("M15.5 7l5 5-5 5")), m: "shift" },
  design: { b: P("M5.5 14L12 3.5 18.5 14 12 20.5Z", "M12 3.5v7.25") + C(12, 12.5, 1.6), m: "wiggle" },
  library: {
    // Two upright books with air between them and a third leaning on the
    // pair; the old pair shared one edge, which drew a doubled stroke.
    b: R(3.25, 4.5, 4, 15, 1.4) + R(9, 4.5, 4, 15, 1.4) + P("M15.1 5.6l2.4-.65a1.2 1.2 0 0 1 1.47.85l3 11.9a1.2 1.2 0 0 1-.86 1.46l-2.4.65a1.2 1.2 0 0 1-1.47-.85l-3-11.9a1.2 1.2 0 0 1 .86-1.46Z"),
    on: F("M4.65 4.5h1.2c.77 0 1.4.63 1.4 1.4v12.2c0 .77-.63 1.4-1.4 1.4h-1.2c-.77 0-1.4-.63-1.4-1.4V5.9c0-.77.63-1.4 1.4-1.4Z") + F("M10.4 4.5h1.2c.77 0 1.4.63 1.4 1.4v12.2c0 .77-.63 1.4-1.4 1.4h-1.2c-.77 0-1.4-.63-1.4-1.4V5.9c0-.77.63-1.4 1.4-1.4Z") + F("M15.1 5.6l2.4-.65a1.2 1.2 0 0 1 1.47.85l3 11.9a1.2 1.2 0 0 1-.86 1.46l-2.4.65a1.2 1.2 0 0 1-1.47-.85l-3-11.9a1.2 1.2 0 0 1 .86-1.46Z"),
    m: "lift",
  },
  crew: { b: C(8, 9, 3) + C(16, 9, 3) + P("M2.75 19.5a5.25 5.25 0 0 1 10.5 0", "M13.4 15a5.25 5.25 0 0 1 7.85 4.5"), m: "lift" },
  orbit: { b: C(12, 12, 5) + `<g transform="rotate(-22 12 12)">` + P("M2 12.75a10 3.4 0 0 0 20 0", "M2 12.75c0-1 1.05-1.9 2.9-2.6", "M22 12.75c0-1-1.05-1.9-2.9-2.6") + `</g>`, m: "turn" },
  agent: { b: BOT + `<g class="gm">${D(9, 13.75, 1.25)}${D(15, 13.75, 1.25)}</g>`, m: "blink" },

  // call
  mic: { b: M(R(9, 3, 6, 11.5, 3)) + P("M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21"), m: "lift" },
  "mic-off": { b: SLASHED(R(9, 3, 6, 11.5, 3) + P("M5.5 11a6.5 6.5 0 0 0 13 0", "M12 17.5V21")) },
  customize: { b: P("M4 7h8", "M17.5 7H20", "M4 17h2.5", "M12 17h8") + M(C(14.75, 7, 2.25)) + M2(C(9.25, 17, 2.25)), m: "shift" },
  stop: { b: R(6, 6, 12, 12, 3), on: `<rect class="gf" x="6" y="6" width="12" height="12" rx="3"/>` },
  "end-call": { b: M(P("M3.4 13.6c4.7-4.3 12.5-4.3 17.2 0l-.5 2.3a1.2 1.2 0 0 1-1.5.9l-2.7-.8a1.2 1.2 0 0 1-.85-1.1v-1.6a9.5 9.5 0 0 0-6.1 0v1.6a1.2 1.2 0 0 1-.85 1.1l-2.7.8a1.2 1.2 0 0 1-1.5-.9Z")), m: "d" },

  // direction
  "chevron-down": { b: M(P("M7 10l5 5 5-5")), m: "d" },
  "chevron-up": { b: M(P("M7 14l5-5 5 5")), m: "u" },
  "chevron-left": { b: M(P("M14 7l-5 5 5 5")), m: "l" },
  "chevron-right": { b: M(P("M10 7l5 5-5 5")), m: "r" },
  "chevrons-up-down": { b: M(P("M8 9.5l4-4 4 4")) + M2(P("M8 14.5l4 4 4-4")), m: "squeeze" },
  "arrow-left": { b: M(P("M19 12H5", "M11 6l-6 6 6 6")), m: "l" },
  "arrow-right": { b: M(P("M5 12h14", "M13 6l6 6-6 6")), m: "r" },
  "arrow-up": { b: M(P("M12 19V5", "M6 11l6-6 6 6")), m: "u" },
  "arrow-down": { b: M(P("M12 5v14", "M6 13l6 6 6-6")), m: "d" },
  "arrow-up-right": { b: M(P("M7 17L17 7", "M8.5 7H17v8.5")), m: "ne" },
  "arrow-up-line": { b: P("M5 4h14") + M(P("M12 20V9", "M7 13l5-5 5 5")), m: "u" },
  "arrow-down-line": { b: P("M5 20h14") + M(P("M12 4v11", "M7 11l5 5 5-5")), m: "d" },
  "corner-down-right": { b: P("M5 5v6a3 3 0 0 0 3 3h11") + M(P("M15 10l4 4-4 4")), m: "r" },
  enter: { b: P("M19 5v6a3 3 0 0 1-3 3H5") + M(P("M9 10l-4 4 4 4")), m: "l" },
  at: { b: C(12, 12, 3.5) + P("M15.5 12v1.25a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.4 6.8"), m: "turn" },
  external: { b: P("M10.5 4.5H7.5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-3") + M(P("M14.5 4.5h5v5", "M19.5 4.5l-8 8")), m: "ne" },
  "sign-out": { b: P("M10 4.5H7.5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3H10") + M(P("M15.5 8l4 4-4 4", "M19.5 12h-10")), m: "r" },
  undo: { b: M(P("M9 14L4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11")), m: "l" },
  redo: { b: M(P("M15 14l5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13")), m: "r" },
  refresh: { b: M(P("M4.5 12a7.5 7.5 0 0 1 12.8-5.3L19.5 9", "M19.5 4.5V9H15", "M19.5 12a7.5 7.5 0 0 1-12.8 5.3L4.5 15", "M4.5 19.5V15H9")), m: "spin" },
  retry: { b: M(P(LOOP_CCW, "M4.5 4.5V9H9")), m: "ccw" },
  repeat: { b: P("M4 11V9.5a3 3 0 0 1 3-3h12.5", "M20 13v1.5a3 3 0 0 1-3 3H4.5") + M(P("M16.5 3.5l3 3-3 3")) + M2(P("M7.5 20.5l-3-3 3-3")), m: "shift" },
  history: { b: P(LOOP_CCW, "M4.5 4.5V9H9") + M(P("M12 8v4l2.75 1.75")), m: "turn" },
  expand: { b: M(P("M14 4.5h5.5V10", "M19.5 4.5l-5.5 5.5")) + M2(P("M10 19.5H4.5V14", "M4.5 19.5l5.5-5.5")), m: "grow" },
  collapse: { b: M(P("M19.5 4.5L14 10", "M14 5.5V10h4.5")) + M2(P("M4.5 19.5L10 14", "M10 18.5V14H5.5")), m: "shrink" },
  unfold: { b: P("M4.5 12h15") + M(P("M12 9V3.5", "M9 6.5l3-3 3 3")) + M2(P("M12 15v5.5", "M9 17.5l3 3 3-3")), m: "grow" },
  fold: { b: P("M4.5 12h15") + M(P("M12 3.5V9", "M9 6l3 3 3-3")) + M2(P("M12 20.5V15", "M9 18l3-3 3 3")), m: "shrink" },
  menu: { b: P("M4 6.5h16", "M4 12h16", "M4 17.5h16") },
  more: { b: `<g class="gw" style="--i:0">${D(5.5, 12, 1.4)}</g><g class="gw" style="--i:1">${D(12, 12, 1.4)}</g><g class="gw" style="--i:2">${D(18.5, 12, 1.4)}</g>`, m: "wave" },
  grip: { b: D(9, 6, 1.25) + D(15, 6, 1.25) + D(9, 12, 1.25) + D(15, 12, 1.25) + D(9, 18, 1.25) + D(15, 18, 1.25) },
  sidebar: { b: R(3.5, 4.5, 17, 15, 3.5) + M(P("M9.5 4.5v15")), m: "l" },
  "panel-right": { b: R(3.5, 4.5, 17, 15, 3.5) + M(P("M14.5 4.5v15")), m: "r" },

  // actions
  plus: { b: M(P("M12 5v14", "M5 12h14")), m: "rot" },
  minus: { b: P("M5 12h14") },
  close: { b: M(P("M6.5 6.5l11 11", "M17.5 6.5l-11 11")), m: "rot" },
  check: { b: DRAW("M5 12.5l4.5 4.5L19 7.5"), m: "draw" },
  copy: { b: P("M15.5 8.5V6.5a3 3 0 0 0-3-3h-6a3 3 0 0 0-3 3v6a3 3 0 0 0 3 3h2") + M(R(8.5, 8.5, 12, 12, 3)), m: "shift" },
  trash: { b: M(P("M4 6.5h16", "M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5")) + P("M6 6.5l.85 11.7A2.5 2.5 0 0 0 9.35 20.5h5.3a2.5 2.5 0 0 0 2.5-2.3L18 6.5", "M10 10.5v6", "M14 10.5v6"), m: "lid" },
  archive: { b: M(R(3.5, 4, 17, 4.5, 1.75)) + P("M5 8.5v8.5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8.5", "M10 12.5h4"), m: "lid" },
  unarchive: { b: R(3.5, 4, 17, 4.5, 1.75) + P("M5 8.5v8.5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8.5") + M(P("M12 17.5v-5", "M9.75 14.5L12 12.25l2.25 2.25")), m: "u" },
  download: { b: M(P("M12 4v11", "M7 10.5l5 5 5-5")) + P("M5 20h14"), m: "d" },
  upload: { b: M(P("M12 15.5V4", "M7 9l5-5 5 5")) + P("M5 20h14"), m: "u" },
  "cloud-upload": { b: P(CLOUD) + M(P("M12 16.5v-5", "M9.75 13.75L12 11.5l2.25 2.25")), m: "u" },
  "file-upload": { b: P(PAGE, PAGE_FOLD) + M(P("M12 17.5v-6", "M9.5 14L12 11.5l2.5 2.5")), m: "u" },
  save: { b: P("M4 7a3 3 0 0 1 3-3h9.5L20 7.5V17a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Z", "M8 4v3.5h6.5V4", "M8 20v-5h8v5"), m: "pop" },
  send: { b: M(P("M20.5 3.5l-10 10", "M20.5 3.5L14 20.5l-3.5-7-7-3.5Z")), m: "ne" },
  share: { b: P("M8.5 9.5H7.5a3 3 0 0 0-3 3V17a3 3 0 0 0 3 3h9a3 3 0 0 0 3-3v-4.5a3 3 0 0 0-3-3h-1") + M(P("M12 14V3.5", "M8.5 7L12 3.5 15.5 7")), m: "u" },
  printer: { b: P("M7 9V4.5h10V9", "M7 16.5H6a2.5 2.5 0 0 1-2.5-2.5v-2.5A2.5 2.5 0 0 1 6 9h12a2.5 2.5 0 0 1 2.5 2.5V14a2.5 2.5 0 0 1-2.5 2.5h-1") + M(R(7, 13.5, 10, 6.5, 1)), m: "d" },
  search: { b: M(C(10.75, 10.75, 6.75) + P("M15.75 15.75L20 20")), m: "tilt" },
  research: { b: P("M4 5.5h16", "M4 10.5h5", "M4 15.5h5") + M(C(15, 14, 3.75) + P("M17.75 16.75L20.25 19.25")), m: "tilt" },
  edit: { b: M(P(PENCIL, "M14 7l3 3")), m: "wiggle" },
  attach: { b: M(P("M19.5 11.5l-7.6 7.6a5 5 0 0 1-7.1-7.1l8.1-8.1a3.35 3.35 0 0 1 4.75 4.75l-7.95 7.95a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3")), m: "tilt" },

  // files and folders
  document: { b: P(PAGE, PAGE_FOLD, "M9 13h6", "M9 16.5h4") },
  "file-code": { b: P(PAGE, PAGE_FOLD, "M10.5 12.25l-2 2 2 2", "M13.5 12.25l2 2-2 2") },
  "file-plus": { b: P(PAGE, PAGE_FOLD) + M(P("M12 11.5v6", "M9 14.5h6")), m: "rot" },
  zip: { b: P("M12 3l8 4.5v9L12 21l-8-4.5v-9Z", "M4 7.5l8 4.5 8-4.5", "M12 12v9", "M8 5.25l8 4.5"), m: "pop" },
  folder: { b: P(FOLDER), m: "pop" },
  "folder-open": { b: P("M3.5 17V7.5a3 3 0 0 1 3-3h2.9a2 2 0 0 1 1.4.6l1.4 1.3a2 2 0 0 0 1.4.6H17a3 3 0 0 1 3 3v.5", "M5.35 19.5h11.9a2 2 0 0 0 1.9-1.4l1.55-5a1.8 1.8 0 0 0-1.7-2.35H7.9a2 2 0 0 0-1.9 1.4L3.5 19.5") },
  "folder-code": { b: P(FOLDER, "M10.25 11.25L8.5 13l1.75 1.75", "M13.75 11.25L15.5 13l-1.75 1.75") },
  "folder-lock": { b: P(FOLDER) + R(9.75, 12, 4.5, 3.5, 0.9) + P("M10.75 12v-.75a1.25 1.25 0 0 1 2.5 0V12") },
  "folder-move": { b: P(FOLDER) + M(P("M8 13h7", "M12.5 10.5L15 13l-2.5 2.5")), m: "r" },
  grid: { b: R(4, 4, 6.5, 6.5, 2) + R(13.5, 4, 6.5, 6.5, 2) + R(4, 13.5, 6.5, 6.5, 2) + M(R(13.5, 13.5, 6.5, 6.5, 2)), m: "pop" },
  list: { b: P("M9 6.5h11", "M9 12h11", "M9 17.5h11") + D(5, 6.5) + D(5, 12) + D(5, 17.5) },
  "list-plus": { b: P("M4 6.5h16", "M4 12h9", "M4 17.5h7") + M(P("M18 14.5v6", "M15 17.5h6")), m: "rot" },
  "list-minus": { b: P("M4 6.5h16", "M4 12h9", "M4 17.5h7", "M15 17.5h6") },
  plan: { b: P("M12 6.5h8", "M12 12.5h8", "M12 18.5h8") + DRAW("M4 6.5l1.5 1.5 3-3") + P("M4 12.5l1.5 1.5 3-3") + D(6, 18.5), m: "draw" },

  // media
  image: { b: R(3.5, 4.5, 17, 15, 3) + M(C(9, 10, 1.75)) + P("M20.5 15l-4.2-4.2a1.5 1.5 0 0 0-2.1 0L5 19.5"), m: "u" },
  "image-plus": { b: P("M20.5 11V7.5a3 3 0 0 0-3-3h-11a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3H12", "M3.5 16l4-4a1.5 1.5 0 0 1 2.1 0L13 15.5") + C(9, 9.5, 1.5) + M(P("M18 14v6", "M15 17h6")), m: "rot" },
  "image-off": { b: SLASHED(R(3.5, 4.5, 17, 15, 3) + C(9, 10, 1.75) + P("M20.5 15l-4.2-4.2a1.5 1.5 0 0 0-2.1 0L5 19.5")) },
  camera: { b: P("M4 9a2.5 2.5 0 0 1 2.5-2.5h1.4a1.5 1.5 0 0 0 1.25-.67l.8-1.16A1.5 1.5 0 0 1 11.2 4h1.6a1.5 1.5 0 0 1 1.25.67l.8 1.16a1.5 1.5 0 0 0 1.25.67h1.4A2.5 2.5 0 0 1 20 9v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17Z") + M(C(12, 12.75, 3.5)), m: "pop" },
  film: { b: R(4, 3.5, 16, 17, 3) + P("M8 3.5v17", "M16 3.5v17", "M4 12h16", "M4 7.75h4", "M16 7.75h4", "M4 16.25h4", "M16 16.25h4") },
  video: { b: R(3, 6, 13, 12, 3) + M(P("M16 10.5l4.2-2.6a.5.5 0 0 1 .8.4v7.4a.5.5 0 0 1-.8.4L16 13.5")), m: "r" },
  music: { b: M(P("M9 18V6l11-2v12") + C(6.5, 18, 2.5) + C(17.5, 16, 2.5)), m: "tilt" },
  voice: { b: wave("M4 10v4", "M8 6.5v11", "M12 3.5v17", "M16 7.5v9", "M20 10v4"), m: "wave" },
  "read-aloud": { b: P("M4 9.5v5a1 1 0 0 0 1 1h2.5l4.2 3.4a.5.5 0 0 0 .8-.4V5.5a.5.5 0 0 0-.8-.4L7.5 8.5H5a1 1 0 0 0-1 1Z") + `<g class="gw" style="--i:0"><path d="M16 9a4.25 4.25 0 0 1 0 6"/></g><g class="gw" style="--i:1"><path d="M18.75 6.25a8.25 8.25 0 0 1 0 11.5"/></g>`, m: "wave" },
  play: { b: M(P(PLAY)), on: F(PLAY), m: "r" },
  pause: { b: R(6.5, 5, 3.5, 14, 1.25) + R(14, 5, 3.5, 14, 1.25), on: `<rect class="gf" x="6.5" y="5" width="3.5" height="14" rx="1.25"/><rect class="gf" x="14" y="5" width="3.5" height="14" rx="1.25"/>` },
  "pause-circle": { b: RING + P("M10 9v6", "M14 9v6") },
  run: { b: RING + M(P("M10 8.9v6.2a.6.6 0 0 0 .92.5l4.9-3.1a.6.6 0 0 0 0-1l-4.9-3.1a.6.6 0 0 0-.92.5Z")), m: "r" },
  "stop-circle": { b: RING + R(9, 9, 6, 6, 1.25) },
  "skip-back": { b: M(P("M18.5 5.6v12.8a.8.8 0 0 1-1.25.66L8.6 12.66a.8.8 0 0 1 0-1.32l8.65-6.4a.8.8 0 0 1 1.25.66Z")) + P("M5.5 5v14"), m: "l" },

  // devices
  phone: { b: R(6.5, 3, 11, 18, 3) + P("M10.5 18h3") },
  tablet: { b: R(4.5, 3, 15, 18, 3) + P("M10.5 18h3") },
  laptop: { b: R(4.5, 4.5, 15, 10.5, 2) + P("M2.5 19h19") },
  computer: { b: MONITOR },
  "screen-share": { b: MONITOR + M(P("M12 13V8", "M9.5 10.5L12 8l2.5 2.5")), m: "u" },
  "screen-off": { b: SLASHED(MONITOR) },
  screenshot: { b: M(P("M4 8.5V7a3 3 0 0 1 3-3h1.5", "M15.5 4H17a3 3 0 0 1 3 3v1.5", "M20 15.5V17a3 3 0 0 1-3 3h-1.5", "M8.5 20H7a3 3 0 0 1-3-3v-1.5")) + C(12, 12, 2.5), m: "squeeze" },
  keyboard: { b: R(2.5, 6, 19, 12, 3) + P("M7.5 14.5h9") + D(7, 10, 1) + D(10.33, 10, 1) + D(13.66, 10, 1) + D(17, 10, 1) },
  offline: { b: SLASHED(D(12, 19, 1.25) + P("M8.75 15.5a4.6 4.6 0 0 1 6.5 0", "M5.25 12a9.6 9.6 0 0 1 13.5 0", "M2 8.5a14.5 14.5 0 0 1 20 0")) },

  // selection and canvas
  selection: { b: dashed(R(4, 4, 16, 16, 3)) },
  "select-area": { b: dashed(P("M12 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h3", "M20 10V7a3 3 0 0 0-3-3h-1")) + M(P("M13 13l7.5 2.6-3.3 1.3-1.3 3.3Z")), m: "ne" },
  crop: { b: P("M7 3v12a2 2 0 0 0 2 2h12", "M3 7h12a2 2 0 0 1 2 2v12") },
  crosshair: { b: RING + M(P("M12 2.5v4", "M12 17.5v4", "M2.5 12h4", "M17.5 12h4")), m: "squeeze" },
  target: { b: RING + C(12, 12, 4.5) + M(D(12, 12, 1.25)), m: "pop" },
  frame: { b: P("M8 3v18", "M16 3v18", "M3 8h18", "M3 16h18") },
  pointer: { b: M(P("M5.5 4.5l13 5.2a.5.5 0 0 1 0 .93l-5.3 2.07-2.07 5.3a.5.5 0 0 1-.93 0Z")), m: "ne" },
  hand: { b: M(P("M8 13V6.25a1.5 1.5 0 0 1 3 0V11.5", "M11 11V4.75a1.5 1.5 0 0 1 3 0V11", "M14 11V6.25a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.4a6 6 0 0 1-4.85-2.47L3.3 15.2a1.5 1.5 0 0 1 2.35-1.86L8 15.5")), m: "wiggle" },
  eraser: { b: P("M9 20.5h11", "M4.6 14.1l9.5-9.5a2 2 0 0 1 2.8 0l3 3a2 2 0 0 1 0 2.8L12 18.3a3 3 0 0 1-2.1.9H8.2a3 3 0 0 1-2.1-.9l-1.5-1.5a2 2 0 0 1 0-2.7Z", "M9.5 9.2l5.8 5.8"), m: "wiggle" },
  line: { b: P("M17 5L7 19") },
  type: { b: P("M5 7.5V5h14v2.5", "M12 5v14", "M9.5 19h5") },
  sigma: { b: P("M18 7.5V4.5H6.5l5.5 7.5-5.5 7.5H18v-3") },
  layers: { b: M(P("M12 3.5l8.5 4.5L12 12.5 3.5 8Z")) + P("M3.5 12l8.5 4.5 8.5-4.5", "M3.5 16l8.5 4.5 8.5-4.5"), m: "lift" },
  component: { b: M(P("M12 3l2.75 2.75L12 8.5 9.25 5.75Z", "M12 15.5l2.75 2.75L12 21l-2.75-2.75Z")) + M2(P("M5.75 9.25L8.5 12l-2.75 2.75L3 12Z", "M18.25 9.25L21 12l-2.75 2.75L15.5 12Z")), m: "squeeze" },
  group: { b: P("M3.5 7.5V6a2.5 2.5 0 0 1 2.5-2.5h1.5", "M16.5 3.5H18A2.5 2.5 0 0 1 20.5 6v1.5", "M20.5 16.5V18a2.5 2.5 0 0 1-2.5 2.5h-1.5", "M7.5 20.5H6A2.5 2.5 0 0 1 3.5 18v-1.5") + R(7, 7, 6, 5, 1.25) + R(11, 12, 6, 5, 1.25) },
  layout: { b: R(3.5, 3.5, 17, 6.5, 2) + R(3.5, 13, 8, 7.5, 2) + R(14.5, 13, 6, 7.5, 2) },
  columns: { b: R(3.5, 4, 17, 16, 3) + P("M12 4v16") },
  sheet: { b: R(3.5, 4, 17, 16, 3) + P("M3.5 9.5h17", "M3.5 14.75h17", "M10 9.5V20") },
  deck: { b: P("M3 4h18", "M4.5 4v9a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V4", "M12 15v3", "M8.5 21l3.5-3 3.5 3") + M(P("M8.5 11l2.5-2.5 2 2 2.5-2.5")), m: "u" },
  "align-left": { b: P("M4 3.5v17") + M(R(7.5, 6, 11, 4, 1.5) + R(7.5, 14, 7, 4, 1.5)), m: "l" },
  "align-right": { b: P("M20 3.5v17") + M(R(5.5, 6, 11, 4, 1.5) + R(9.5, 14, 7, 4, 1.5)), m: "r" },
  "align-center": { b: P("M12 3.5v2.5", "M12 10v4", "M12 18v2.5") + R(6, 6, 12, 4, 1.5) + R(8, 14, 8, 4, 1.5) },
  "align-top": { b: P("M3.5 4h17") + M(R(6, 7.5, 4, 11, 1.5) + R(14, 7.5, 4, 7, 1.5)), m: "u" },
  "align-bottom": { b: P("M3.5 20h17") + M(R(6, 5.5, 4, 11, 1.5) + R(14, 9.5, 4, 7, 1.5)), m: "d" },
  "align-middle": { b: P("M3.5 12h2.5", "M10 12h4", "M18 12h2.5") + R(6, 6, 4, 12, 1.5) + R(14, 8, 4, 8, 1.5) },
  "distribute-horizontal": { b: P("M4 3.5v17", "M20 3.5v17") + R(9, 7, 6, 10, 1.5) },
  "distribute-vertical": { b: P("M3.5 4h17", "M3.5 20h17") + R(7, 9, 10, 6, 1.5) },

  // dev
  terminal: { b: R(3, 4.5, 18, 15, 3) + P("M7 9.5l3 2.5-3 2.5") + M(P("M12.5 15h4.5")), m: "blink" },
  braces: { b: M(P("M8.5 4H7.75a2 2 0 0 0-2 2v3.5A2.5 2.5 0 0 1 3.5 12a2.5 2.5 0 0 1 2.25 2.5V18a2 2 0 0 0 2 2h.75")) + M2(P("M15.5 4h.75a2 2 0 0 1 2 2v3.5A2.5 2.5 0 0 0 20.5 12a2.5 2.5 0 0 0-2.25 2.5V18a2 2 0 0 1-2 2h-.75")), m: "shift" },
  branch: { b: C(6.5, 5.75, 2.25) + C(6.5, 18.25, 2.25) + C(17.5, 7.75, 2.25) + P("M6.5 8v8", "M17.5 10c0 3.5-2.5 4.75-6 5.25-2.6.4-4.2.9-5 1") },
  fork: { b: C(6.5, 5.5, 2.25) + C(17.5, 5.5, 2.25) + C(12, 18.5, 2.25) + P("M6.5 7.75V9a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3V7.75", "M12 12v4.25") },
  "pull-request": { b: C(6.5, 5.5, 2.25) + C(6.5, 18.5, 2.25) + C(17.5, 18.5, 2.25) + P("M6.5 7.75v8.5", "M17.5 16.25V9a3 3 0 0 0-3-3H11") + M(P("M13.25 3.5L10.75 6l2.5 2.5")), m: "l" },
  diff: { b: C(6, 6, 2.25) + C(18, 18, 2.25) + P("M18 15.75V9a3 3 0 0 0-3-3h-3", "M6 8.25V15a3 3 0 0 0 3 3h3") + M(P("M14 3.5L11.5 6 14 8.5")) + M2(P("M10 15.5l2.5 2.5-2.5 2.5")), m: "shift" },
  workflow: { b: R(3.5, 3.5, 7, 7, 2) + R(13.5, 13.5, 7, 7, 2) + P("M7 10.5V14a3 3 0 0 0 3 3h3.5"), m: "pop" },
  database: { b: P("M4.5 6c0-1.4 3.36-2.5 7.5-2.5s7.5 1.1 7.5 2.5-3.36 2.5-7.5 2.5S4.5 7.4 4.5 6Z", "M4.5 6v12c0 1.4 3.36 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6", "M4.5 12c0 1.4 3.36 2.5 7.5 2.5s7.5-1.1 7.5-2.5") },
  cube: { b: P("M12 3l8 4.5v9L12 21l-8-4.5v-9Z", "M4 7.5l8 4.5 8-4.5", "M12 12v9"), m: "turn" },
  app: { b: M(P("M9 3v4", "M15 3v4")) + P("M6.5 7h11v3a5.5 5.5 0 0 1-11 0Z", "M12 15.5V21"), m: "u" },
  wrench: { b: M(P("M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.1-3.1a5.75 5.75 0 0 1-7.6 7.6l-6.4 6.4a2.1 2.1 0 0 1-3-3l6.4-6.4a5.75 5.75 0 0 1 7.6-7.6Z")), m: "wiggle" },
  settings: { b: M(P(gear(8, 9, 7, 9, 7))) + C(12, 12, 3), m: "turn" },
  activity: { b: P("M3 12h3.5l2.5-7 5 14 2.5-7H21") },

  // status
  help: { b: RING + P("M9.6 9.6a2.4 2.4 0 1 1 3.3 2.25c-.5.2-.9.65-.9 1.2v.45") + D(12, 16.4, 0.95), m: "tilt" },
  info: { b: RING + P("M12 11v5.5") + D(12, 7.9, 0.95) },
  alert: { b: RING + P("M12 7.5v5.25") + D(12, 16.25, 0.95) },
  warning: { b: P("M10.27 4.4a2 2 0 0 1 3.46 0l7.07 12.35A2 2 0 0 1 19.07 19.75H4.93a2 2 0 0 1-1.73-3L10.27 4.4Z", "M12 9.5v4") + D(12, 16.6, 0.95) },
  "error-circle": { b: RING + M(P("M9.25 9.25l5.5 5.5", "M14.75 9.25l-5.5 5.5")), m: "rot" },
  success: { b: RING + DRAW("M8.25 12.25l2.5 2.5 5-5"), m: "draw" },
  ban: { b: RING + P("M6 6l12 12") },
  verified: { b: P("M12 3l2.1 1.55 2.6-.15.8 2.5 2.15 1.45-.85 2.45.85 2.45-2.15 1.45-.8 2.5-2.6-.15L12 21l-2.1-1.55-2.6.15-.8-2.5-2.15-1.45.85-2.45-.85-2.45 2.15-1.45.8-2.5 2.6.15Z") + DRAW("M9 12l2 2 4-4"), m: "draw" },
  loader: { b: P("M12 3.5a8.5 8.5 0 1 0 8.5 8.5") },
  circle: { b: RING, on: `<circle class="gf" cx="12" cy="12" r="8.5"/>` },
  "circle-dashed": { b: dashed(RING) },
  square: { b: R(4.5, 4.5, 15, 15, 3.5), on: `<rect class="gf" x="4.5" y="4.5" width="15" height="15" rx="3.5"/>` },
  upgrade: { b: RING + M(P("M12 16V8", "M8.5 11.5L12 8l3.5 3.5")), m: "u" },
  shield: { b: P(SHIELD) + DRAW("M9 12l2 2 4-4"), m: "draw" },
  "shield-alert": { b: P(SHIELD, "M12 8.5v4") + D(12, 15.5, 0.95) },
  "shield-off": { b: SLASHED(P(SHIELD)) },
  lock: { b: R(5, 10.5, 14, 10, 3) + M(P("M8 10.5V7.5a4 4 0 0 1 8 0v3")) + D(12, 15.5, 1.25), m: "u" },
  unlock: { b: R(5, 10.5, 14, 10, 3) + M(P("M8 10.5V7.5a4 4 0 0 1 7.75-1.4")) + D(12, 15.5, 1.25), m: "u" },
  key: { b: M(C(8, 15.5, 4.5) + P("M11.25 12.25L20 3.5", "M16.5 7l2.5 2.5", "M18.25 5.25l2 2")), m: "turn" },
  fingerprint: { b: P("M5 11.5a7 7 0 0 1 12.6-4.2", "M19 10.5c.1.5.1 1 .1 1.5v1", "M8.25 19.5A11 11 0 0 1 7.5 15.5v-3.5a4.5 4.5 0 0 1 9 0v1", "M12 11.75v3a9 9 0 0 0 1.75 5.5", "M16.5 16.5c-.1 1.2-.3 2.4-.7 3.5", "M4.75 15.5c-.15-.6-.25-1.1-.25-1.75") },

  // people and messages
  people: { b: C(9, 8, 3.25) + P("M3 19.5a6 6 0 0 1 12 0", "M15.75 4.8a3.25 3.25 0 0 1 0 6.4", "M18 13.6a6 6 0 0 1 3 5.9"), m: "lift" },
  profile: { b: C(12, 8, 3.75) + P("M5 20a7 7 0 0 1 14 0"), m: "lift" },
  "profile-edit": { b: C(10, 8, 3.5) + P("M3.5 20a6.5 6.5 0 0 1 9.25-5.9") + M(P("M18.6 13.4a1.4 1.4 0 0 1 2 2L16 20l-2.5.5.5-2.5Z")), m: "wiggle" },
  mail: { b: R(3.5, 5, 17, 14, 3) + M(P("M4.5 7l7.5 6 7.5-6")), m: "d" },
  inbox: { b: P("M3.5 13.5l2.55-7.1A2.75 2.75 0 0 1 8.65 4.5h6.7a2.75 2.75 0 0 1 2.6 1.9l2.55 7.1V17a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17Z") + M(P("M3.5 13.5H8l1 2h6l1-2h4.5")), m: "d" },
  bell: { b: M(P("M18 16V11a6 6 0 0 0-12 0v5l-1.5 2h15Z", "M10 20.5a2 2 0 0 0 4 0")), m: "swing" },
  megaphone: { b: M(P("M4 10v4a1 1 0 0 0 1 1h2.25l8.75 4.5V4.5L7.25 9H5a1 1 0 0 0-1 1Z", "M7.25 15l1 4.5h2.5", "M19.5 9.5v5")), m: "tilt" },
  broadcast: { b: D(12, 12, 1.6) + `<g class="gw" style="--i:0"><path d="M8.5 15.5a5 5 0 0 1 0-7"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></g><g class="gw" style="--i:1"><path d="M5.6 18.4a9 9 0 0 1 0-12.8"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/></g>`, m: "wave" },
  citation: { b: P("M20.5 6H3.5", "M20.5 12H8.5", "M20.5 18H8.5", "M3.5 11v8") },
  instructions: { b: P("M8 20.5h8.5a3 3 0 0 0 3-3V6.5a3 3 0 0 0-3-3H7.5a3 3 0 0 0-3 3V17", "M4.5 17a3.5 3.5 0 0 0 3.5 3.5", "M9 8h6", "M9 11.5h6", "M9 15h3.5") },
  memory: { b: P("M13 3.5H8a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V12", "M3.5 8h3", "M3.5 12h3", "M3.5 16h3") + M(P("M18.4 3.6a1.9 1.9 0 0 1 2.7 2.7L15 12.4l-3.4.9.9-3.4Z")), m: "wiggle" },
  sources: { b: P("M12 6.5C10.2 5 7.7 4.5 3.5 4.5v14c4.2 0 6.7.5 8.5 2 1.8-1.5 4.3-2 8.5-2v-14c-4.2 0-6.7.5-8.5 2Z", "M12 6.5v14"), m: "pop" },
  learn: { b: M(P("M12 4.5L2.5 9l9.5 4.5L21.5 9Z")) + P("M6.5 11v4.5c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3V11", "M21.5 9v5"), m: "lift" },
  thought: { b: M(P("M12 3a6 6 0 0 0-3.4 10.95c.55.38.9 1 .9 1.67V16.5h5v-.88c0-.67.35-1.29.9-1.67A6 6 0 0 0 12 3Z")) + P("M9.5 19h5", "M10.5 21.5h3"), m: "pop" },
  "deep-field": { b: C(7, 16, 3.5) + C(17, 16, 3.5) + P("M10.5 16V8a2 2 0 0 0-2-2H7.4a2 2 0 0 0-1.95 1.55L3.6 15.2", "M13.5 16V8a2 2 0 0 1 2-2h1.1a2 2 0 0 1 1.95 1.55l1.85 7.65", "M10.5 11h3"), m: "lift" },

  // time and nature
  clock: { b: RING + M(P("M12 7.5V12l3 2")), m: "turn" },
  timer: { b: C(12, 13.5, 7.5) + P("M10 2.75h4", "M17.75 7.75l1.4-1.4") + M(P("M12 13.5V9.75")), m: "turn" },
  calendar: { b: R(4, 5, 16, 15, 3) + P("M8.5 3v4", "M15.5 3v4", "M4 10h16") + D(8.5, 14) + D(12, 14) + D(15.5, 14) + D(8.5, 17) + D(12, 17), m: "pop" },
  sun: { b: C(12, 12, 3.75) + M(P("M12 2.75v2", "M12 19.25v2", "M2.75 12h2", "M19.25 12h2", "M5.45 5.45l1.4 1.4", "M17.15 17.15l1.4 1.4", "M5.45 18.55l1.4-1.4", "M17.15 6.85l1.4-1.4")), m: "turn" },
  moon: { b: M(P("M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z")), m: "tilt" },
  cloud: { b: M(P(CLOUD)), m: "r" },
  globe: { b: RING + P("M3.5 12h17") + M(P("M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z")), m: "squeeze" },
  map: { b: P("M9 4.5L3.5 6.5v13l5.5-2 6 2 5.5-2v-13l-5.5 2Z", "M9 4.5v13", "M15 6.5v13"), m: "pop" },
  link: { b: M(P("M9.5 17H7a5 5 0 0 1 0-10h2.5")) + M2(P("M14.5 7H17a5 5 0 0 1 0 10h-2.5")) + P("M8.5 12h7"), m: "squeeze" },
  "link-off": { b: SLASHED(P("M9.5 17H7a5 5 0 0 1 0-10h2.5", "M14.5 7H17a5 5 0 0 1 0 10h-2.5", "M8.5 12h7")) },
  star: { b: M(P(STAR)), on: F(STAR), m: "pop" },
  bolt: { b: M(P("M13 3L5 13.5h6.5L11 21l8-10.5h-6.5Z")), m: "pop" },
  pin: { b: M(P(PIN, "M12 14.5v6")), on: F("M10.25 3.5h3.5v5.25l3 3.75v2h-9.5v-2l3-3.75Z") + P("M9.5 3.5h5", "M12 14.5v6"), m: "tilt" },
  unpin: { b: SLASHED(P(PIN, "M12 14.5v6")) },
  bookmark: { b: M(P("M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z")), on: F("M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z"), m: "pop" },
  "thumbs-up": { b: M(P(THUMB) + THUMB_CUFF), m: "tilt" },
  "thumbs-down": { b: flipY(M(P(THUMB) + THUMB_CUFF)), m: "tilt" },
  eye: { b: P("M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z") + M(C(12, 12, 3)), m: "blink" },
  "eye-off": { b: SLASHED(P("M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z") + C(12, 12, 3)) },
  appearance: { b: M(P("M12 3l4.5 7.5h-9Z")) + C(7.5, 16.5, 4) + R(13, 12.5, 8, 8, 2), m: "turn" },
  coins: { b: C(9.5, 9.5, 5.75) + M(P("M17.2 9.9a5.75 5.75 0 1 1-7.3 7.3")), m: "shift" },
  billing: { b: R(3, 5.5, 18, 13, 3) + P("M3 10h18") + M(P("M7 14.75h3")), m: "r" },
  receipt: { b: P("M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z", "M9 8h6", "M9 11.5h6", "M9 15h3.5") },
  calculator: { b: R(5, 3, 14, 18, 3) + R(8, 6, 8, 3.5, 1) + D(8.75, 13.25) + D(12, 13.25) + D(15.25, 13.25) + D(8.75, 16.75) + D(12, 16.75) + D(15.25, 16.75) },
};

/** Drawings an export shows instead of its concept's (two names that share a concept but not a picture). */
export const DISPLAY_OVERRIDES: Record<string, Glyph> = {
  Sparkles: { b: M(P("M11 3.5c.55 3.7 2.8 5.95 6.5 6.5-3.7.55-5.95 2.8-6.5 6.5-.55-3.7-2.8-5.95-6.5-6.5 3.7-.55 5.95-2.8 6.5-6.5Z")) + M2(P("M18 14.75c.25 1.55 1.2 2.5 2.75 2.75-1.55.25-2.5 1.2-2.75 2.75-.25-1.55-1.2-2.5-2.75-2.75 1.55-.25 2.5-1.2 2.75-2.75Z")), m: "turn" },
  Flame: { b: M(P("M12 21a6.5 6.5 0 0 0 6.5-6.5c0-3.5-2.4-5.6-3.6-8.5-1 2-2 3-3.4 3.5C11.2 7 10.6 5 10 3 7.4 5.6 5.5 9.5 5.5 14.5A6.5 6.5 0 0 0 12 21Z")), m: "pop" },
  CheckCircle2: { b: RING + DRAW("M8.25 12.25l2.5 2.5 5-5"), on: `<circle class="gf" cx="12" cy="12" r="8.5"/>` + `<path d="M8.25 12.25l2.5 2.5 5-5" stroke="var(--background-color, hsl(var(--background)))"/>`, m: "draw" },
  PartyPopper: { b: P("M4.5 19.5l3.8-10.3 6.5 6.5Z", "M13 4.5c.5 1 .4 2-.3 2.8", "M17.5 9.5c1.2-.6 2.4-.5 3 .3") + M(D(15.5, 4.5) + D(19.5, 6) + D(19, 13.5)), m: "pop" },
  Cpu: { b: R(6.5, 6.5, 11, 11, 2.5) + R(9.5, 9.5, 5, 5, 1) + P("M9.5 3.5v3", "M14.5 3.5v3", "M9.5 17.5v3", "M14.5 17.5v3", "M3.5 9.5h3", "M3.5 14.5h3", "M17.5 9.5h3", "M17.5 14.5h3") },
  BriefcaseBusiness: { b: R(3.5, 7, 17, 12.5, 3) + M(P("M8.75 7V5.5a2 2 0 0 1 2-2h2.5a2 2 0 0 1 2 2V7")) + P("M3.5 12.5h17"), m: "u" },
  SearchX: { b: C(10.75, 10.75, 6.75) + P("M15.75 15.75L20 20", "M8.75 8.75l4 4", "M12.75 8.75l-4 4") },
  MailWarning: { b: P("M20.5 12V8a3 3 0 0 0-3-3h-11a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3H13", "M4.5 7l7.5 6 7.5-6", "M18.5 14.5v3") + D(18.5, 20.25, 0.95) },
  BookmarkPlus: { b: M(P("M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.5l-6.5 4V5A1.5 1.5 0 0 1 7 3.5Z")) + P("M12 7.5v5", "M9.5 10h5"), m: "pop" },
  JunoCode: { b: M(P("M8.5 7l-5 5 5 5")) + M2(P("M15.5 7l5 5-5 5")) + P("M13.5 5l-3 14"), m: "shift" },
};

