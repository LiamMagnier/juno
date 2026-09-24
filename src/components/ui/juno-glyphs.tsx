/**
 * Juno's own drawings — the five marks the product is recognised by.
 *
 * Everything else in `icons.tsx` is Phosphor geometry. These five are drawn for
 * Juno because they are the ones a reader sees on every screen and associates
 * with the product itself: the places (Chat, Code, Design, Library) and the one
 * verb (send). All but Library borrow the two motifs of the Juno mark
 * (`public/juno-mark.png`):
 *
 * - the OPEN RING that ends in a DOT — the bubble in the logo is a ring that
 *   stops short at the top right, with a ball terminal beside the gap;
 * - the FOUR-POINT SPARK — the concave star at the heart of the logo.
 *
 * Chat is the logo's bubble drawn as a line. Code puts the spark between the
 * two chevrons, where `</>` puts a slash: code that Juno writes. Design is two
 * primitives stacked like cut paper — the circle stops short of the square in
 * front of it instead of crossing it, so the mark stays quiet at 16px. Send is
 * an arrow whose head has the spark's concave flanks. Library is two volumes on
 * a shelf, one leaning toward the other, with one band each; it was drawn to be
 * legible where Phosphor's Books hatched into grey, and a spark or a ball on a
 * spine read as a label rather than as Juno, so it keeps only the grid and line.
 *
 * THE GRID IS PHOSPHOR'S, so these sit in a row of Phosphor glyphs without
 * looking borrowed: a 256-unit box, a 16-unit line at `regular` (1px at 16px),
 * round caps and joins, the live area inside 24–232. They are drawn as strokes
 * rather than outlines, so every weight is the same drawing at a different
 * line — thin 8, light 12, regular 16, bold 24 — and `fill` is a solid drawing
 * of its own, for the selected state.
 *
 * IN USE through `icons.tsx`: `JunoChat` (AppIcons.home / .conversation),
 * `JunoCode` (AppIcons.code), `JunoDesign` (AppIcons.design), `JunoLibrary`
 * (AppIcons.library) and `Send` (every send action). Never import this file
 * from a call site: a mark that bypasses `glyph()` loses the optical weight
 * choice, aria and hover articulation.
 *
 * MOTION. The moving part of each drawing carries `juno-part juno-part--*`, and
 * globals.css moves just that part when the control around the mark is hovered
 * (the `parts` articulation): the ball terminal pops out of the gap, the spark
 * twinkles a quarter turn, the circle slides back from the square, the leaning
 * volume straightens and lifts. A part never carries a `transform` attribute:
 * its CSS `rotate` would re-pivot it, so any turn is baked into the path.
 *
 * No hooks, no context: safe in server components.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

type GlyphWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export type JunoGlyphProps = ComponentPropsWithoutRef<"svg"> & {
  alt?: string;
  color?: string;
  size?: string | number;
  weight?: GlyphWeight;
  mirrored?: boolean;
};

const LINE: Record<Exclude<GlyphWeight, "fill">, number> = {
  thin: 8,
  light: 12,
  regular: 16,
  bold: 24,
  duotone: 16,
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A point on a circle; angles in degrees, clockwise from three o'clock. */
function onCircle(r: number, deg: number, cx = 128, cy = 128): [number, number] {
  const t = (deg * Math.PI) / 180;
  return [r2(cx + r * Math.cos(t)), r2(cy + r * Math.sin(t))];
}

/** The logo's four-point spark: four points joined by concave curves. */
function sparkPath(cx: number, cy: number, h: number): string {
  const k = r2(h * 0.2);
  return (
    `M${cx},${cy - h} Q${cx + k},${cy - k} ${cx + h},${cy} ` +
    `Q${cx + k},${cy + k} ${cx},${cy + h} Q${cx - k},${cy + k} ${cx - h},${cy} ` +
    `Q${cx - k},${cy - k} ${cx},${cy - h} Z`
  );
}

function defineGlyph(
  name: string,
  draw: (line: number) => ReactNode,
  drawFill: () => ReactNode,
) {
  const Glyph = forwardRef<SVGSVGElement, JunoGlyphProps>(function Glyph(
    { alt, color = "currentColor", size = "1em", weight = "regular", mirrored = false, children, ...rest },
    ref,
  ) {
    const solid = weight === "fill";
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="none"
        stroke={color}
        strokeWidth={solid ? LINE.regular : LINE[weight]}
        strokeLinecap="round"
        strokeLinejoin="round"
        color={color === "currentColor" ? undefined : color}
        transform={mirrored ? "scale(-1, 1)" : undefined}
        {...rest}
      >
        {alt ? <title>{alt}</title> : null}
        {children}
        {solid ? drawFill() : draw(LINE[weight])}
      </svg>
    );
  });
  Glyph.displayName = name;
  return Glyph;
}

// ---------------------------------------------------------------------------
// Chat — the logo's bubble as a line: a ring that stops short at the top right,
// a ball terminal in the gap, the tail at the lower left.
// ---------------------------------------------------------------------------

const CHAT = (() => {
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

export const JunoChatGlyph = defineGlyph(
  "JunoChatGlyph",
  (line) => (
    <>
      <path d={CHAT.line} />
      <circle
        className="juno-part juno-part--ball"
        cx={CHAT.ball[0]}
        cy={CHAT.ball[1]}
        r={r2(line * 0.8)}
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  // Selected: the bubble goes solid and the spark from the logo is cut out of it.
  () => (
    <>
      <path d={`${CHAT.shape} ${sparkPath(128, 128, 46)}`} fill="currentColor" fillRule="evenodd" stroke="none" />
      <path d={CHAT.shape} />
    </>
  ),
);

// ---------------------------------------------------------------------------
// Code — the spark between two chevrons, where `</>` puts a slash.
// ---------------------------------------------------------------------------

const CHEVRONS = "M76,72 L24,128 L76,184 M180,72 L232,128 L180,184";

export const JunoCodeGlyph = defineGlyph(
  "JunoCodeGlyph",
  (line) => (
    <>
      <path d={CHEVRONS} />
      <path className="juno-part juno-part--spark" d={sparkPath(128, 128, r2(40 + line * 0.5))} fill="currentColor" stroke="none" />
    </>
  ),
  () => (
    <>
      <path d={CHEVRONS} strokeWidth={LINE.bold} />
      <path className="juno-part juno-part--spark" d={sparkPath(128, 128, 54)} fill="currentColor" stroke="none" />
    </>
  ),
);

// ---------------------------------------------------------------------------
// Design — a square in front of a circle, stacked like cut paper: the circle
// stops short of the square instead of crossing it.
// ---------------------------------------------------------------------------

const SQUARE = { x: 28, y: 100, size: 120, rx: 24 };
const DISC = { cx: 160, cy: 96, r: 66 };

/** The circle's visible arc, ending `clearance` units short of the square's
 *  edge whatever the line weight. */
function discArc(line: number, clearance = 20) {
  const gap = clearance + line;
  const right = SQUARE.x + SQUARE.size + gap;
  const top = SQUARE.y - gap;
  const yAtRight = r2(DISC.cy + Math.sqrt(DISC.r ** 2 - (right - DISC.cx) ** 2));
  const xAtTop = r2(DISC.cx - Math.sqrt(DISC.r ** 2 - (top - DISC.cy) ** 2));
  return { right, top, yAtRight, xAtTop };
}

export const JunoDesignGlyph = defineGlyph(
  "JunoDesignGlyph",
  (line) => {
    const a = discArc(line);
    return (
      <>
        <rect x={SQUARE.x} y={SQUARE.y} width={SQUARE.size} height={SQUARE.size} rx={SQUARE.rx} />
        <path className="juno-part juno-part--disc" d={`M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top}`} />
      </>
    );
  },
  () => {
    const a = discArc(LINE.regular, 12);
    return (
      <>
        <rect
          x={SQUARE.x}
          y={SQUARE.y}
          width={SQUARE.size}
          height={SQUARE.size}
          rx={SQUARE.rx}
          fill="currentColor"
        />
        <path
          className="juno-part juno-part--disc"
          d={`M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top} L${a.right},${a.top} Z`}
          fill="currentColor"
          strokeWidth={8}
        />
      </>
    );
  },
);

// ---------------------------------------------------------------------------
// Agents — a face: the pebble body the agent roster draws, with the two
// rounded-square eyes that carry an agent's state everywhere else
// (docs/design/AGENTS.md §4). The eyes are the moving part: on hover they
// glance up and over, the way an agent looks up when you walk over. Filled,
// the face goes solid and the eyes are cut out of it.
// ---------------------------------------------------------------------------

const FACE = { x: 36, y: 44, w: 184, h: 168, rx: 64 };
const EYE = { w: 28, h: 40, rx: 13, y: 104, left: 90, right: 138 };

function eyeRects(): string {
  const rect = (x: number) =>
    `M${x + EYE.rx},${EYE.y} H${x + EYE.w - EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.w},${EYE.y + EYE.rx} ` +
    `V${EYE.y + EYE.h - EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.w - EYE.rx},${EYE.y + EYE.h} ` +
    `H${x + EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x},${EYE.y + EYE.h - EYE.rx} ` +
    `V${EYE.y + EYE.rx} A${EYE.rx},${EYE.rx} 0 0 1 ${x + EYE.rx},${EYE.y} Z`;
  return `${rect(EYE.left)} ${rect(EYE.right)}`;
}

function faceOutline(): string {
  const { x, y, w, h, rx } = FACE;
  return (
    `M${x + rx},${y} H${x + w - rx} A${rx},${rx} 0 0 1 ${x + w},${y + rx} V${y + h - rx} ` +
    `A${rx},${rx} 0 0 1 ${x + w - rx},${y + h} H${x + rx} A${rx},${rx} 0 0 1 ${x},${y + h - rx} ` +
    `V${y + rx} A${rx},${rx} 0 0 1 ${x + rx},${y} Z`
  );
}

export const JunoAgentsGlyph = defineGlyph(
  "JunoAgentsGlyph",
  () => (
    <>
      <rect x={FACE.x} y={FACE.y} width={FACE.w} height={FACE.h} rx={FACE.rx} />
      <path className="juno-part juno-part--eyes" d={eyeRects()} fill="currentColor" stroke="none" />
    </>
  ),
  () => <path d={`${faceOutline()} ${eyeRects()}`} fill="currentColor" fillRule="evenodd" stroke="none" />,
);

// ---------------------------------------------------------------------------
// Library — two volumes on a shelf, the right one leaning toward the left, one
// head band each. Phosphor's Books carried six bands across two volumes, which
// at 18px aliased into a grey hatch; one band is enough to say "spine".
// ---------------------------------------------------------------------------

type Point = [number, number];
type Volume = { x: number; y: number; w: number; h: number; r: number };

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
function volumePath({ x, y, w, h, r }: Volume, deg = 0, pivot: Point = [x, y + h]): string {
  const p = (px: number, py: number) => turn([px, py], deg, pivot);
  return (
    `M${p(x + r, y)} L${p(x + w - r, y)} A${r},${r} 0 0 1 ${p(x + w, y + r)} ` +
    `L${p(x + w, y + h - r)} A${r},${r} 0 0 1 ${p(x + w - r, y + h)} ` +
    `L${p(x + r, y + h)} A${r},${r} 0 0 1 ${p(x, y + h - r)} ` +
    `L${p(x, y + r)} A${r},${r} 0 0 1 ${p(x + r, y)} Z`
  );
}

function bandPath({ x, w }: Volume, y: number, deg = 0, pivot: Point = [0, 0]): string {
  return `M${turn([x, y], deg, pivot)} L${turn([x + w, y], deg, pivot)}`;
}

/** The volume a stroke of the regular line paints, as one outline. */
const grown = ({ x, y, w, h, r }: Volume, d = LINE.regular / 2): Volume => ({
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
function solidVolumePath(v: Volume, band: number, deg = 0, pivot: Point = [v.x, v.y + v.h]): string {
  const solid = grown(v);
  const inset = 12;
  const slot: Volume = {
    x: solid.x + inset,
    y: band - LINE.regular / 2,
    w: solid.w - 2 * inset,
    h: LINE.regular,
    r: LINE.regular / 2,
  };
  return `${volumePath(solid, deg, pivot)} ${volumePath(slot, deg, pivot)}`;
}

const LEAN = -13;
const UPRIGHT_BAND = 88;
const LEANING_BAND = 110;

/** Both volumes at a line weight. A heavier line would close the gap between
 *  them, so the upright steps left and the leaning volume steps right and slims
 *  by the difference: the clear gap is 18 units at every weight (1.1px at 16px),
 *  and the bold cut still lands inside the 24–232 live area. The upright's
 *  verticals, top, foot and band sit on the 16px pixel grid at `regular`.
 *  Corners are tighter than Design's square (10 against 24): a rounder volume
 *  read as a capsule or a battery at 48px, a squarer one as a book. */
function shelf(line: number) {
  const k = line - LINE.regular;
  const upright: Volume = { x: 40 - k / 2, y: 40, w: 64, h: 176, r: 10 };
  const leaning: Volume = { x: 170 + k / 2, y: 66, w: 54 - k, h: 150, r: 10 };
  // The leaning volume stands on its foot's inner corner, on the upright's shelf line.
  const pivot: Point = [leaning.x, leaning.y + leaning.h];
  return { upright, leaning, pivot };
}

export const JunoLibraryGlyph = defineGlyph(
  "JunoLibraryGlyph",
  (line) => {
    const { upright, leaning, pivot } = shelf(line);
    return (
      <>
        <path d={volumePath(upright)} />
        <path d={bandPath(upright, UPRIGHT_BAND)} />
        <g className="juno-part juno-part--volume">
          <path d={volumePath(leaning, LEAN, pivot)} />
          <path d={bandPath(leaning, LEANING_BAND, LEAN, pivot)} />
        </g>
      </>
    );
  },
  // Selected: both volumes solid, each with its band as a slot. The grown
  // leaning volume still turns about the regular one's foot, so it leans from
  // the same corner as the line drawing.
  () => {
    const { upright, leaning, pivot } = shelf(LINE.regular);
    return (
      <>
        <path d={solidVolumePath(upright, UPRIGHT_BAND)} fill="currentColor" fillRule="evenodd" stroke="none" />
        <path
          className="juno-part juno-part--volume"
          d={solidVolumePath(leaning, LEANING_BAND, LEAN, pivot)}
          fill="currentColor"
          fillRule="evenodd"
          stroke="none"
        />
      </>
    );
  },
);

// ---------------------------------------------------------------------------
// Send — an up arrow whose head has the spark's concave flanks.
// ---------------------------------------------------------------------------

const SEND = "M128,212 V52 M60,116 Q108,92 128,52 Q148,92 196,116";

export const JunoSendGlyph = defineGlyph(
  "JunoSendGlyph",
  () => <path d={SEND} />,
  () => <path d={SEND} strokeWidth={LINE.bold} />,
);
