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
 * THE GEOMETRY LIVES IN `juno-glyph-paths.ts`, as data, so the native apps
 * draw the very same marks: `scripts/generate-native-icons.mjs` reads it and
 * ships the outlined drawings as SF Symbol templates. This file only turns
 * each drawing into elements; redraw a mark there, not here.
 *
 * No hooks, no context: safe in server components.
 */
import { forwardRef, type ComponentPropsWithoutRef } from "react";

import {
  junoGlyphDrawing,
  type JunoGlyphElement,
  type JunoGlyphName,
  type JunoGlyphWeight,
} from "@/components/ui/juno-glyph-paths";

type GlyphWeight = JunoGlyphWeight;

export type JunoGlyphProps = ComponentPropsWithoutRef<"svg"> & {
  alt?: string;
  color?: string;
  size?: string | number;
  weight?: GlyphWeight;
  mirrored?: boolean;
};

/** One element of a drawing, with its articulating part named for globals.css.
 *  A group (`g`) renders its children inside it, so a part drawn in two strokes
 *  moves as one about the group's box. */
function renderElement({ tag: Tag, attrs, part, children }: JunoGlyphElement, index: number) {
  const className = part ? `juno-part juno-part--${part}` : undefined;
  if (children) {
    return (
      <Tag key={index} className={className} {...attrs}>
        {children.map(renderElement)}
      </Tag>
    );
  }
  return <Tag key={index} className={className} {...attrs} />;
}

function defineGlyph(name: string, glyph: JunoGlyphName) {
  const Glyph = forwardRef<SVGSVGElement, JunoGlyphProps>(function Glyph(
    { alt, color = "currentColor", size = "1em", weight = "regular", mirrored = false, children, ...rest },
    ref,
  ) {
    const drawing = junoGlyphDrawing(glyph, weight);
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="none"
        stroke={color}
        strokeWidth={drawing.line}
        strokeLinecap="round"
        strokeLinejoin="round"
        color={color === "currentColor" ? undefined : color}
        transform={mirrored ? "scale(-1, 1)" : undefined}
        {...rest}
      >
        {alt ? <title>{alt}</title> : null}
        {children}
        {drawing.elements.map(renderElement)}
      </svg>
    );
  });
  Glyph.displayName = name;
  return Glyph;
}

/** Chat — the logo's bubble as a line: a ring that stops short at the top
 *  right, a ball terminal in the gap, the tail at the lower left. Its `fill` is
 *  the bubble gone solid with the logo's spark cut out of it. */
export const JunoChatGlyph = defineGlyph("JunoChatGlyph", "chat");

/** Code — the spark between two chevrons, where `</>` puts a slash. */
export const JunoCodeGlyph = defineGlyph("JunoCodeGlyph", "code");

/** Design — a square in front of a circle, stacked like cut paper: the circle
 *  stops short of the square instead of crossing it. */
export const JunoDesignGlyph = defineGlyph("JunoDesignGlyph", "design");

/** Library — two volumes on a shelf, the right one leaning toward the left,
 *  one head band each. Its `fill` is both volumes solid, each band a slot. */
export const JunoLibraryGlyph = defineGlyph("JunoLibraryGlyph", "library");

/** Send — an up arrow whose head has the spark's concave flanks. */
export const JunoSendGlyph = defineGlyph("JunoSendGlyph", "send");
