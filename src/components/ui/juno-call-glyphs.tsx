/**
 * The voice call's controls, drawn for Juno: microphone, microphone off, call
 * settings, stop and end call. They are the only glyphs in a call, sit on a
 * composer that is otherwise quiet, and the stock drawings they replace read
 * as generic (a phone receiver with a hand-set flourish, sliders with fat
 * knobs, a mic on a stand with a base plate).
 *
 * THE SAME GRID AS JUNO'S OWN MARKS (`juno-glyphs.tsx`): a 256-unit box, the
 * house line (8 thin, 12 light, 16 regular, 24 bold), round caps and joins, the
 * live area inside 24-232, so they sit beside every other glyph in the set
 * without looking borrowed. The drawings are deliberately spare:
 *
 * - Microphone: a capsule and the cradle under it, one short stem, no stand.
 * - Microphone off: the same, with one clean diagonal through it.
 * - Call settings: two rails, each with one open knob, offset left and right.
 * - Stop: a soft square, always solid (it is the one "halt" mark).
 * - End call: the receiver laid flat, drawn as one continuous outline.
 *
 * Web only, on purpose: these are the call's own marks, not places or verbs the
 * native icon pipeline (`juno-glyph-paths.ts`) mirrors. Never import this file
 * from a call site: use the names `icons.tsx` exports, which carry the optical
 * weight choice and the accessibility props.
 *
 * No hooks, no context: safe in server components.
 */
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";

type Weight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

const LINE: Record<Weight, number> = { thin: 8, light: 12, regular: 16, bold: 24, fill: 16, duotone: 16 };

type CallGlyphProps = ComponentPropsWithoutRef<"svg"> & {
  alt?: string;
  color?: string;
  size?: string | number;
  weight?: Weight;
  mirrored?: boolean;
};

function defineCallGlyph(name: string, draw: (weight: Weight) => ReactNode) {
  const Glyph = forwardRef<SVGSVGElement, CallGlyphProps>(function Glyph(
    { alt, color = "currentColor", size = "1em", weight = "regular", mirrored = false, children, ...rest },
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill="none"
        stroke={color}
        strokeWidth={LINE[weight]}
        strokeLinecap="round"
        strokeLinejoin="round"
        color={color === "currentColor" ? undefined : color}
        transform={mirrored ? "scale(-1, 1)" : undefined}
        {...rest}
      >
        {alt ? <title>{alt}</title> : null}
        {children}
        {draw(weight)}
      </svg>
    );
  });
  Glyph.displayName = name;
  return Glyph;
}

/** The capsule and cradle both marks share. */
function micBody(weight: Weight) {
  return (
    <>
      <rect x="92" y="28" width="72" height="124" rx="36" fill={weight === "fill" ? "currentColor" : "none"} />
      <path d="M60 120a68 68 0 0 0 136 0" />
      <path d="M128 188v36" />
    </>
  );
}

export const JunoMicGlyph = defineCallGlyph("JunoMicGlyph", (weight) => micBody(weight));

export const JunoMicOffGlyph = defineCallGlyph("JunoMicOffGlyph", (weight) => (
  <>
    {micBody(weight)}
    <path d="M44 44l168 168" />
  </>
));

export const JunoCallSettingsGlyph = defineCallGlyph("JunoCallSettingsGlyph", (weight) => (
  <>
    <path d="M36 92h92M188 92h32" />
    <circle cx="158" cy="92" r="26" fill={weight === "fill" ? "currentColor" : "none"} />
    <path d="M36 164h32M128 164h92" />
    <circle cx="98" cy="164" r="26" fill={weight === "fill" ? "currentColor" : "none"} />
  </>
));

export const JunoStopGlyph = defineCallGlyph("JunoStopGlyph", () => (
  <rect x="68" y="68" width="120" height="120" rx="28" fill="currentColor" />
));

/** The receiver laid flat: a shallow dome between two ear pads, one outline. */
export const JunoEndCallGlyph = defineCallGlyph("JunoEndCallGlyph", (weight) => (
  <path
    d="M34 146c0-38 42-60 94-60s94 22 94 60l-6 18a14 14 0 0 1-16 9l-30-6a14 14 0 0 1-11-14v-20c-20-7-42-7-62 0v20a14 14 0 0 1-11 14l-30 6a14 14 0 0 1-16-9Z"
    fill={weight === "fill" ? "currentColor" : "none"}
  />
));
