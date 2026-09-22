/**
 * Juno's own drawings — the four marks the product is recognised by.
 *
 * Everything else in `icons.tsx` is Phosphor geometry. These four are drawn for
 * Juno because they are the ones a reader sees on every screen and associates
 * with the product itself: the three places (Chat, Code, Design) and the one
 * verb (send). They borrow the two motifs of the Juno mark (`public/juno-mark.png`):
 *
 * - the OPEN RING that ends in a DOT — the bubble in the logo is a ring that
 *   stops short at the top right, with a ball terminal beside the gap;
 * - the FOUR-POINT SPARK — the concave star at the heart of the logo.
 *
 * Chat is the logo's bubble drawn as a line. Code puts the spark between the
 * two chevrons, where `</>` puts a slash: code that Juno writes. Design is two
 * primitives stacked like cut paper — the circle stops short of the square in
 * front of it instead of crossing it, so the mark stays quiet at 16px. Send is
 * an arrow whose head has the spark's concave flanks.
 *
 * THE GRID IS PHOSPHOR'S, so these sit in a row of Phosphor glyphs without
 * looking borrowed: a 256-unit box, a 16-unit line at `regular` (1px at 16px),
 * round caps and joins, the live area inside 24–232. They are drawn as strokes
 * rather than outlines, so every weight is the same drawing at a different
 * line — thin 8, light 12, regular 16, bold 24 — and `fill` is a solid drawing
 * of its own, for the selected state.
 *
 * Each component takes the same props as a Phosphor icon, so `glyph()` in
 * `icons.tsx` wraps them exactly like the rest of the set (optical weight,
 * hover articulation, aria). Import them through `icons.tsx`, never directly.
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
      <circle cx={CHAT.ball[0]} cy={CHAT.ball[1]} r={r2(line * 0.8)} fill="currentColor" stroke="none" />
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
      <path d={sparkPath(128, 128, r2(40 + line * 0.5))} fill="currentColor" stroke="none" />
    </>
  ),
  () => (
    <>
      <path d={CHEVRONS} strokeWidth={LINE.bold} />
      <path d={sparkPath(128, 128, 54)} fill="currentColor" stroke="none" />
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
        <path d={`M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top}`} />
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
          d={`M${a.right},${a.yAtRight} A${DISC.r},${DISC.r} 0 1 0 ${a.xAtTop},${a.top} L${a.right},${a.top} Z`}
          fill="currentColor"
          strokeWidth={8}
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
