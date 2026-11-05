/**
 * Keeping the pressed chip of a sideways-scrolling chip strip on screen
 * (the search palette's type filters, command-palette.tsx).
 *
 * The math works on LAYOUT offsets (`offsetLeft`, `offsetWidth`,
 * `clientWidth`), not on `getBoundingClientRect`. The strip remounts whenever
 * the query goes from empty to typed, and at that moment two things are still
 * settling: the dialog may be mid-way through its open scale, which a client
 * rect includes, and the date and project Selects beside the strip have not
 * yet drawn their values (Radix fills `SelectValue` after mount), so the
 * strip is briefly wider than it will be. Measuring once then scrolled the
 * strip to where the chip WOULD have been visible, and when the Selects grew
 * the pressed "Tasks" slid back off the right edge. The caller re-runs this
 * whenever the strip's width changes, and offsets do not move with a
 * transform, so the answer holds once layout settles.
 */

/** Room kept between the chip and the strip's edge: the edge fade is 2rem. */
export const CHIP_REVEAL_MARGIN = 32;

export interface ChipStripBox {
  /** The chip's left edge within the strip's content (its `offsetLeft`, with the strip as offset parent). */
  chipLeft: number;
  chipWidth: number;
  scrollLeft: number;
  /** The strip's visible width (`clientWidth`). */
  clientWidth: number;
  /** The strip's content width (`scrollWidth`). */
  scrollWidth: number;
}

/**
 * The `scrollLeft` that shows the chip whole and clear of the edge fade, or
 * null when it already is (so a strip the reader scrolled by hand is left
 * where they put it). Clamped to the strip's scroll range.
 */
export function chipRevealScroll(box: ChipStripBox, margin = CHIP_REVEAL_MARGIN): number | null {
  const { chipLeft, chipWidth, scrollLeft, clientWidth, scrollWidth } = box;
  const max = Math.max(0, scrollWidth - clientWidth);
  const clamp = (v: number) => Math.min(max, Math.max(0, Math.round(v)));
  const chipRight = chipLeft + chipWidth;
  // A chip at either end of the content needs no margin on that side: the
  // fade only draws where the strip continues.
  const wantLeft = chipLeft <= 0 ? 0 : chipLeft - margin;
  const wantRight = chipRight >= scrollWidth ? scrollWidth : chipRight + margin;
  if (wantLeft < scrollLeft) return clamp(wantLeft);
  if (wantRight > scrollLeft + clientWidth) {
    const next = clamp(wantRight - clientWidth);
    return next === scrollLeft ? null : next;
  }
  return null;
}
