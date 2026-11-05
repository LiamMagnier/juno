/**
 * Whether a sideways row has more to scroll past its end (`more`) or has been
 * scrolled past its start (`past`): the home's phone chip row fades the edge
 * that has more past it (home-starters.css). A pixel of slack absorbs
 * subpixel widths; the absolute scroll offset keeps it right in a
 * right-to-left row too.
 */
export function rowOverflow(row: Pick<HTMLElement, "scrollLeft" | "scrollWidth" | "clientWidth">): { more: boolean; past: boolean } {
  const offset = Math.abs(row.scrollLeft);
  return { past: offset > 1, more: offset + row.clientWidth < row.scrollWidth - 1 };
}
