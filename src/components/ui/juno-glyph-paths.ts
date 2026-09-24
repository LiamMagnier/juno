/**
 * The geometry of Juno's own marks, as data — no JSX, no React, no imports.
 *
 * Two readers draw from this one file, which is why it exists:
 *
 * - `juno-glyphs.tsx` renders each drawing as an `<svg>` for the web, element
 *   for element, so the web's marks are exactly what they were when the path
 *   builders lived inline there.
 * - `scripts/generate-native-icons.mjs` hands the same drawings to the native
 *   pipeline, which outlines the strokes and ships them as SF Symbol templates
 *   (`juno.chat`, `juno.code`, …). A mark redrawn here reaches the Mac and iPhone
 *   on the next `npm run native:icons -- --outline-juno`, and the icon check
 *   fails until it does.
 *
 * Keeping it JSX-free is what lets plain Node import it (type stripping only —
 * so no enums, namespaces or other syntax that needs compiling).
 *
 * THE GRID IS PHOSPHOR'S (see `juno-glyphs.tsx` for the drawings' rationale): a
 * 256-unit box, a 16-unit line at `regular`, round caps and joins, and the live
 * area inside 24–232. Every weight is the same drawing at a different line;
 * `fill` is a solid drawing of its own, for the selected state.
 */

export type JunoGlyphWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

/** The part of a drawing that articulates on hover (`globals.css`). */
export type JunoGlyphPart = "ball" | "spark" | "disc" | "volume" | "eyes";

/**
 * One SVG element of a drawing. `attrs` carries React's camelCase attribute
 * names (`fillRule`, `strokeWidth`) because the web spreads them straight onto
 * the element; the native pipeline converts them. Paint the element does not
 * set is inherited from the root `<svg>`: `fill="none"`, a `currentColor`
 * stroke at the drawing's `line`, round caps and joins.
 *
 * A `g` is a group of `children` that moves as one part: the web renders the
 * `<g>` around them (so a part drawn in two strokes turns about one box), and
 * the native pipeline flattens it, since a symbol has no moving parts.
 */
export type JunoGlyphElement = {
  tag: "path" | "circle" | "rect" | "g";
  attrs: Record<string, string | number>;
  part?: JunoGlyphPart;
  /** A `g`'s elements, in paint order. */
  children?: JunoGlyphElement[];
  /**
   * Native only: cut this element out of everything drawn before it rather
   * than painting it. The web never renders a knockout element (its only use
   * is the private ghost's `fill` cut, which the web does not draw).
   */
  knockout?: boolean;
};

export type JunoGlyphDrawing = {
  /** The coordinate box: 256 for the Phosphor grid, 48 for the ghost. */
  viewBox: number;
  /** The root `<svg>`'s stroke width, in `viewBox` units. */
  line: number;
  elements: JunoGlyphElement[];
};

export const JUNO_LINE: Record<Exclude<JunoGlyphWeight, "fill">, number> = {
  thin: 8,
  light: 12,
  regular: 16,
  bold: 24,
  duotone: 16,
};

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** A point on a circle; angles in degrees, clockwise from three o'clock. */
export function onCircle(r: number, deg: number, cx = 128, cy = 128): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [r2(cx + r * Math.cos(t)), r2(cy + r * Math.sin(t))];
}

/** The logo's four-point spark: four points joined by concave curves. */
export function sparkPath(cx: number, cy: number, h: number): string {
  const k = r2(h * 0.2);
  return (
    `M${cx},${cy - h} Q${cx + k},${cy - k} ${cx + h},${cy} ` +
    `Q${cx + k},${cy + k} ${cx},${cy + h} Q${cx - k},${cy + k} ${cx - h},${cy} ` +
    `Q${cx - k},${cy - k} ${cx},${cy - h} Z`
  );
}

// ---------------------------------------------------------------------------
// Chat — the logo's bubble as a line: a ring that stops short at the top right,
// a ball terminal in the gap, the tail at the lower left.
// ---------------------------------------------------------------------------

export const CHAT = (() => {
  const r = 96;
  const start = onCircle(r, -90);
  const end = onCircle(r, -30);
  const ball = onCircle(r, -60);
  const tailIn = onCircle(r, 154);
  const tailOut = onCircle(r, 116);
  const tip = onCircle(136, 135);
  return {
    r,
    ball,
    line:
      `M${start} A${r},${r} 0 0 0 ${tailIn} L${tip} L${tailOut} ` +
      `A${r},${r} 0 0 0 ${end}`,
    shape:
      `M${start} A${r},${r} 0 0 0 ${tailIn} L${tip} L${tailOut} ` +
      `A${r},${r} 0 1 0 ${start} Z`,
  };
})();

// ---------------------------------------------------------------------------
// Code — the spark between two chevrons, where `</>` puts a slash.
// ---------------------------------------------------------------------------

export const CHEVRONS = "M76,72 L24,128 L76,184 M180,72 L232,128 L180,184";

// ---------------------------------------------------------------------------
// Design — a square in front of a circle, stacked like cut paper: the circle
// stops short of the square instead of crossing it.
// ---------------------------------------------------------------------------

export const SQUARE = { x: 28, y: 100, size: 120, rx: 24 };
export const DISC = { cx: 160, cy: 96, r: 66 };

/** The circle's visible arc, ending `clearance` units short of the square's
 *  edge whatever the line weight. */
export function discArc(line: number, clearance = 20) {
  const gap = clearance + line;
  const right = SQUARE.x + SQUARE.size + gap;
  const top = SQUARE.y - gap;
  const yAtRight = r2(DISC.cy + Math.sqrt(DISC.r ** 2 - (right - DISC.cx) ** 2));
  const xAtTop = r2(DISC.cx - Math.sqrt(DISC.r ** 2 - (top - DISC.cy) ** 2));
  return { right, top, yAtRight, xAtTop };
}

// ---------------------------------------------------------------------------
// Library — two volumes on a shelf, the right one leaning toward the left, one
// head band each. Phosphor's Books carried six bands across two volumes, which
// at 18px aliased into a grey hatch; one band is enough to say "spine".
// ---------------------------------------------------------------------------

export type Point = [number, number];
export type Volume = { x: number; y: number; w: number; h: number; r: number };

/** `[x, y]` turned `deg` about `pivot` (negative leans the top to the left), as "x,y". */
function turn([x, y]: Point, deg: number, [cx, cy]: Point): string {
  const t = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return `${r2(cx + dx * Math.cos(t) - dy * Math.sin(t))},${r2(cy + dx * Math.sin(t) + dy * Math.cos(t))}`;
}

/** A rounded rect as a path, turned about `pivot`. The lean is baked into the
 *  coordinates rather than set with a `transform` attribute because the volume
 *  is a moving part: its CSS `rotate` would re-pivot an attribute transform.
 *  Circular arcs survive a rotation, so only their end points turn. */
export function volumePath({ x, y, w, h, r }: Volume, deg = 0, pivot: Point = [x, y + h]): string {
  const p = (px: number, py: number) => turn([px, py], deg, pivot);
  return (
    `M${p(x + r, y)} L${p(x + w - r, y)} A${r},${r} 0 0 1 ${p(x + w, y + r)} ` +
    `L${p(x + w, y + h - r)} A${r},${r} 0 0 1 ${p(x + w - r, y + h)} ` +
    `L${p(x + r, y + h)} A${r},${r} 0 0 1 ${p(x, y + h - r)} ` +
    `L${p(x, y + r)} A${r},${r} 0 0 1 ${p(x + r, y)} Z`
  );
}

export function bandPath({ x, w }: Volume, y: number, deg = 0, pivot: Point = [0, 0]): string {
  return `M${turn([x, y], deg, pivot)} L${turn([x + w, y], deg, pivot)}`;
}

/** The volume a stroke of the regular line paints, as one outline. */
const grown = ({ x, y, w, h, r }: Volume, d = JUNO_LINE.regular / 2): Volume => ({
  x: x - d,
  y: y - d,
  w: w + 2 * d,
  h: h + 2 * d,
  r: r + d,
});

/** The fill weight's volume: solid, with the band as a slot one house line
 *  tall that stops short of both edges. A band cut clean across split each
 *  volume into a round head over a body, and at 16px the pair read as two
 *  pictogram figures rather than two books. The slot sits wholly inside the
 *  volume, so `evenodd` makes it a hole and nothing else. */
export function solidVolumePath(v: Volume, band: number, deg = 0, pivot: Point = [v.x, v.y + v.h]): string {
  const solid = grown(v);
  const inset = 12;
  const slot: Volume = {
    x: solid.x + inset,
    y: band - JUNO_LINE.regular / 2,
    w: solid.w - 2 * inset,
    h: JUNO_LINE.regular,
    r: JUNO_LINE.regular / 2,
  };
  return `${volumePath(solid, deg, pivot)} ${volumePath(slot, deg, pivot)}`;
}

export const LEAN = -13;
export const UPRIGHT_BAND = 88;
export const LEANING_BAND = 110;

/** Both volumes at a line weight. A heavier line would close the gap between
 *  them, so the upright steps left and the leaning volume steps right and slims
 *  by the difference: the clear gap is 18 units at every weight (1.1px at 16px),
 *  and the bold cut still lands inside the 24–232 live area. The upright's
 *  verticals, top, foot and band sit on the 16px pixel grid at `regular`.
 *  Corners are tighter than Design's square (10 against 24): a rounder volume
 *  read as a capsule or a battery at 48px, a squarer one as a book. */
export function shelf(line: number) {
  const k = line - JUNO_LINE.regular;
  const upright: Volume = { x: 40 - k / 2, y: 40, w: 64, h: 176, r: 10 };
  const leaning: Volume = { x: 170 + k / 2, y: 66, w: 54 - k, h: 150, r: 10 };
  // The leaning volume stands on its foot's inner corner, on the upright's shelf line.
  const pivot: Point = [leaning.x, leaning.y + leaning.h];
  return { upright, leaning, pivot };
}

// ---------------------------------------------------------------------------
// Agents — a face: the pebble body the agent roster draws, with the two
// rounded-square eyes that carry an agent's state everywhere else
// (docs/design/AGENTS.md §4). The eyes are the moving part: on hover they
// glance up and over, the way an agent looks up when you walk over. Filled,
// the face goes solid and the eyes are cut out of it.
// ---------------------------------------------------------------------------

export const FACE = { x: 36, y: 44, w: 184, h: 168, rx: 64 };
export const EYE = { w: 28, h: 40, rx: 13, y: 104, left: 90, right: 138 };

export function eyeRects(): string {
  const rect = (x: number) =>
    `M${x + EYE.rx},${EYE.y} H${x + EYE.w - EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.w},${EYE.y + EYE.rx} ` +
    `V${EYE.y + EYE.h - EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.w - EYE.rx},${EYE.y + EYE.h} ` +
    `H${x + EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x},${EYE.y + EYE.h - EYE.rx} ` +
    `V${EYE.y + EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.rx},${EYE.y} Z`;
  return `${rect(EYE.left)} ${rect(EYE.right)}`;
}

export function faceOutline(): string {
  const { x, y, w, h, rx } = FACE;
  return (
    `M${x + rx},${y} H${x + w - rx} A${rx},${rx} 0 0 1 ${x + w},${y + rx} V${y + h - rx} ` +
    `A${rx},${rx} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${rx} 0 0 1 ${x},${y + h - rx} ` +
    `V${y + rx} A${rx},${rx} 0 0 1 ${x + rx},${y} Z`
  );
}

// ---------------------------------------------------------------------------
// Send — an up arrow whose head has the spark's concave flanks.
// ---------------------------------------------------------------------------

export const SEND = "M128,212 V52 M60,116 Q108,92 128,52 Q148,92 196,116";

// ---------------------------------------------------------------------------
// The six drawings, per weight. `draw` takes the line the weight sets; `drawFill`
// is the solid drawing for the selected state.
// ---------------------------------------------------------------------------

type GlyphDefinition = {
  draw: (line: number) => JunoGlyphElement[];
  drawFill: () => JunoGlyphElement[];
};

const SQUARE_RECT = { x: SQUARE.x, y: SQUARE.y, width: SQUARE.size, height: SQUARE.size, rx: SQUARE.rx };

export type JunoGlyphName = "chat" | "code" | "design" | "library" | "agents" | "send";

export const JUNO_GLYPHS: Record<JunoGlyphName, GlyphDefinition> = {
  chat: {
    draw: (line): JunoGlyphElement[] => [
      { tag: "path", attrs: { d: CHAT.line } },
      {
        tag: "circle",
        part: "ball",
        attrs: { cx: CHAT.ball[0], cy: CHAT.ball[1], r: r2(line * 0.8), fill: "currentColor", stroke: "none" },
      },
    ],
    // Selected: the bubble goes solid and the spark from the logo is cut out of it.
    drawFill: (): JunoGlyphElement[] => [
      {
        tag: "path",
        attrs: { d: `${CHAT.shape} ${sparkPath(128, 128, 46)}`, fill: "currentColor", fillRule: "evenodd", stroke: "none" },
      },
      { tag: "path", attrs: { d: CHAT.shape } },
    ],
  },
  code: {
    draw: (line): JunoGlyphElement[] => [
      { tag: "path", attrs: { d: CHEVRONS } },
      {
        tag: "path",
        part: "spark",
        attrs: { d: sparkPath(128, 128, r2(40 + line * 0.5)), fill: "currentColor", stroke: "none" },
      },
    ],
    drawFill: (): JunoGlyphElement[] => [
      { tag: "path", attrs: { d: CHEVRONS, strokeWidth: JUNO_LINE.bold } },
      { tag: "path", part: "spark", attrs: { d: sparkPath(128, 128, 54), fill: "currentColor", stroke: "none" } },
    ],
  },
  design: {
    draw: (line): JunoGlyphElement[] => {
      const a = discArc(line);
      return [
        { tag: "rect", attrs: { ...SQUARE_RECT } },
        { tag: "path", part: "disc", attrs: { d: `M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top}` } },
      ];
    },
    drawFill: (): JunoGlyphElement[] => {
      const a = discArc(JUNO_LINE.regular, 12);
      return [
        { tag: "rect", attrs: { ...SQUARE_RECT, fill: "currentColor" } },
        {
          tag: "path",
          part: "disc",
          attrs: {
            d: `M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top} L${a.right},${a.top} Z`,
            fill: "currentColor",
            strokeWidth: 8,
          },
        },
      ];
    },
  },
  library: {
    draw: (line): JunoGlyphElement[] => {
      const { upright, leaning, pivot } = shelf(line);
      return [
        { tag: "path", attrs: { d: volumePath(upright) } },
        { tag: "path", attrs: { d: bandPath(upright, UPRIGHT_BAND) } },
        {
          tag: "g",
          part: "volume",
          attrs: {},
          children: [
            { tag: "path", attrs: { d: volumePath(leaning, LEAN, pivot) } },
            { tag: "path", attrs: { d: bandPath(leaning, LEANING_BAND, LEAN, pivot) } },
          ],
        },
      ];
    },
    // Selected: both volumes solid, each with its band as a slot. The grown
    // leaning volume still turns about the regular one's foot, so it leans from
    // the same corner as the line drawing.
    drawFill: (): JunoGlyphElement[] => {
      const { upright, leaning, pivot } = shelf(JUNO_LINE.regular);
      return [
        {
          tag: "path",
          attrs: { d: solidVolumePath(upright, UPRIGHT_BAND), fill: "currentColor", fillRule: "evenodd", stroke: "none" },
        },
        {
          tag: "path",
          part: "volume",
          attrs: {
            d: solidVolumePath(leaning, LEANING_BAND, LEAN, pivot),
            fill: "currentColor",
            fillRule: "evenodd",
            stroke: "none",
          },
        },
      ];
    },
  },
  agents: {
    draw: (): JunoGlyphElement[] => [
      { tag: "rect", attrs: { x: FACE.x, y: FACE.y, width: FACE.w, height: FACE.h, rx: FACE.rx } },
      { tag: "path", part: "eyes", attrs: { d: eyeRects(), fill: "currentColor", stroke: "none" } },
    ],
    // Selected: the face goes solid and the eyes are cut out of it.
    drawFill: (): JunoGlyphElement[] => [
      { tag: "path", attrs: { d: `${faceOutline()} ${eyeRects()}`, fill: "currentColor", fillRule: "evenodd", stroke: "none" } },
    ],
  },
  send: {
    draw: (): JunoGlyphElement[] => [{ tag: "path", attrs: { d: SEND } }],
    drawFill: (): JunoGlyphElement[] => [{ tag: "path", attrs: { d: SEND, strokeWidth: JUNO_LINE.bold } }],
  },
};

/** A mark at a weight, with the root line it inherits. `fill` draws at the
 *  regular line, as the web's root `<svg>` does. */
export function junoGlyphDrawing(name: JunoGlyphName, weight: JunoGlyphWeight): JunoGlyphDrawing {
  const glyph = JUNO_GLYPHS[name];
  if (weight === "fill") return { viewBox: 256, line: JUNO_LINE.regular, elements: glyph.drawFill() };
  return { viewBox: 256, line: JUNO_LINE[weight], elements: glyph.draw(JUNO_LINE[weight]) };
}

// ---------------------------------------------------------------------------
// The private-chat ghost (`private-chat-toggle.tsx`), on its own 48-unit box.
//
// The web draws it once, at a 2-unit line, with eyes that follow the pointer.
// The native apps carry it in the icon set, so it takes the set's lines there —
// 3 units on this box is 16 on the 256 grid, 4.5 is 24 — with the eyes still,
// and a `fill` cut for the "on" state: the body solid, the face cut out of it.
// ---------------------------------------------------------------------------

export const GHOST = {
  viewBox: 48,
  body:
    "M9.5 39V21C9.5 12 16 6.5 24 6.5S38.5 12 38.5 21v18c0 1.7-1.9 2.6-3.2 1.6l-3.4-2.6-3.4 2.6a2.5 2.5 0 0 1-3.1 0L22 38l-3.4 2.6a2.5 2.5 0 0 1-3.1 0l-3.4-2.6-3.4 2.6C11.4 41.6 9.5 40.7 9.5 39Z",
  eyes: [
    { cx: 19, cy: 22, r: 2.4 },
    { cx: 29, cy: 22, r: 2.4 },
  ],
  smile: "M20.5 30c1.7 1.4 5.3 1.4 7 0",
  /** The web toggle's line. */
  line: 2,
} as const;

/** The ghost at a native weight: `regular` and `bold` are the outline with the
 *  face drawn in; `fill` is the solid body with the face knocked out. */
export function junoGhostDrawing(weight: "regular" | "bold" | "fill"): JunoGlyphDrawing {
  const line = ((weight === "bold" ? JUNO_LINE.bold : JUNO_LINE.regular) * GHOST.viewBox) / 256;
  const solid = weight === "fill";
  const eyes: JunoGlyphElement[] = GHOST.eyes.map((eye) => ({
    tag: "circle",
    attrs: { cx: eye.cx, cy: eye.cy, r: eye.r, fill: "currentColor", stroke: "none" },
    knockout: solid,
  }));
  return {
    viewBox: GHOST.viewBox,
    line,
    elements: [
      { tag: "path", attrs: solid ? { d: GHOST.body, fill: "currentColor" } : { d: GHOST.body } },
      ...eyes,
      { tag: "path", attrs: { d: GHOST.smile }, knockout: solid },
    ],
  };
}
