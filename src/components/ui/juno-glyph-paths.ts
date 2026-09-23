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
export type JunoGlyphPart = "ball" | "spark" | "disc";

/**
 * One SVG element of a drawing. `attrs` carries React's camelCase attribute
 * names (`fillRule`, `strokeWidth`) because the web spreads them straight onto
 * the element; the native pipeline converts them. Paint the element does not
 * set is inherited from the root `<svg>`: `fill="none"`, a `currentColor`
 * stroke at the drawing's `line`, round caps and joins.
 */
export type JunoGlyphElement = {
  tag: "path" | "circle" | "rect";
  attrs: Record<string, string | number>;
  part?: JunoGlyphPart;
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
// Send — an up arrow whose head has the spark's concave flanks.
// ---------------------------------------------------------------------------

export const SEND = "M128,212 V52 M60,116 Q108,92 128,52 Q148,92 196,116";

// ---------------------------------------------------------------------------
// The four drawings, per weight. `draw` takes the line the weight sets; `drawFill`
// is the solid drawing for the selected state.
// ---------------------------------------------------------------------------

type GlyphDefinition = {
  draw: (line: number) => JunoGlyphElement[];
  drawFill: () => JunoGlyphElement[];
};

const SQUARE_RECT = { x: SQUARE.x, y: SQUARE.y, width: SQUARE.size, height: SQUARE.size, rx: SQUARE.rx };

export type JunoGlyphName = "chat" | "code" | "design" | "send";

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
