/**
 * One field material for text, multiline text and choices. These semantic
 * colors are projected to Swift from globals.css, so theme/contrast changes
 * reach every client instead of diverging into per-component alpha values.
 *
 * A pointer darkens the edge; keyboard focus adds one continuous outer line.
 * Invalid fields keep the same geometry in the destructive ink. Color-only
 * feedback remains under reduced motion; nothing here scales or travels.
 */
export const fieldSurfaceClass =
  "border-field-border bg-field text-foreground shadow-none " +
  "transition-[color,border-color,box-shadow,background-color] duration-fast ease-out-soft " +
  "placeholder:text-muted-foreground " +
  "enabled:hover:border-field-hover focus:border-field-focus focus:bg-field-active focus:outline-none " +
  "kbd-focus:border-field-ring kbd-focus:shadow-[0_0_0_1px_hsl(var(--field-ring))] " +
  "forced-colors:focus-visible:outline forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2 forced-colors:focus-visible:outline-[Highlight] " +
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:enabled:hover:border-destructive " +
  "aria-[invalid=true]:focus:border-destructive aria-[invalid=true]:kbd-focus:border-destructive " +
  "aria-[invalid=true]:kbd-focus:shadow-[0_0_0_1px_hsl(var(--destructive))] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const fieldFrameClass =
  "w-full rounded-field border text-ui " + fieldSurfaceClass + " " +
  // Touch fields keep a full reading-sized label as their targets grow.
  "coarse:text-reading coarse:leading-normal";

export const fieldHeightClass = "h-9 coarse:h-11";

/** Search fields with a leading glyph and trailing result count share the edge. */
export const fieldGroupClass =
  "hover:border-field-hover focus-within:border-field-focus focus-within:bg-field-active " +
  "kbd-focus-within:border-field-ring kbd-focus-within:shadow-[0_0_0_1px_hsl(var(--field-ring))] " +
  "forced-colors:kbd-focus-within:outline forced-colors:kbd-focus-within:outline-2 forced-colors:kbd-focus-within:outline-offset-2 forced-colors:kbd-focus-within:outline-[Highlight]";

/** A Select remains visibly engaged while focus lives in its floating list. */
export const fieldChoiceClass =
  "data-[state=open]:border-field-focus data-[state=open]:bg-field-active " +
  "focus-visible:border-field-ring focus-visible:shadow-[0_0_0_1px_hsl(var(--field-ring))] " +
  "aria-[invalid=true]:data-[state=open]:border-destructive " +
  "aria-[invalid=true]:focus-visible:border-destructive " +
  "aria-[invalid=true]:focus-visible:shadow-[0_0_0_1px_hsl(var(--destructive))]";
