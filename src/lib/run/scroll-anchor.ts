/**
 * Keeping the reader's place through a height change they did not cause
 * (SPEC §7.5, the "every automatic height change" table).
 *
 * The run block changes height on its own in a handful of places: the peek
 * opens once and collapses at the first answer text, an approval card is
 * inserted and later folds into its receipt. At the tail of a transcript the
 * reader pinned to the bottom simply follows; anywhere else the change would
 * shove what they are reading. Safari has no `overflow-anchor`, so the anchor
 * is kept by hand: before the change, note the first message still visible and
 * its offset from the top of the scroller; after it, scroll so that message is
 * back where it was.
 */

/** What the transcript marks each message with, so the anchor can find the first visible one. */
const MESSAGE_SELECTOR = "[data-message-id], [data-render-key]";

/** The nearest scrollable ancestor of `element`. */
export function findScroller(element: Element | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  while (node) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** The reader is at the bottom (within `slack` px): growth follows them, no anchoring needed. */
export function isPinnedToBottom(scroller: HTMLElement, slack = 4): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= slack;
}

export interface ScrollAnchor {
  /** Put the anchored message back at its offset. Safe to call more than once. */
  restore(): void;
}

const NOOP: ScrollAnchor = { restore() {} };

/**
 * Captures the first message visible in `element`'s scroller. Call before a
 * height change and `restore()` after it (on `transitionend`, or on the next
 * frame for an instant change). Returns a no-op when the reader is pinned to
 * the bottom, or there is no scroller.
 */
export function captureAnchor(element: Element | null): ScrollAnchor {
  if (typeof window === "undefined" || !element) return NOOP;
  const scroller = findScroller(element);
  if (!scroller || isPinnedToBottom(scroller)) return NOOP;
  const top = scroller.getBoundingClientRect().top;
  const anchor = [...scroller.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)].find(
    (candidate) => candidate.getBoundingClientRect().bottom > top,
  );
  if (!anchor) return NOOP;
  const before = anchor.getBoundingClientRect().top - top;
  return {
    restore() {
      const after = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const delta = after - before;
      if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
    },
  };
}

/**
 * Runs `change` with the reader's place kept: captures, lets the change
 * happen, and restores on every frame until `settleMs` (the transition's
 * length) has passed, so a grid-rows collapse above the reader never moves
 * what they are reading, not even mid-transition.
 */
export function anchored(element: Element | null, change: () => void, settleMs = 0): void {
  const anchor = captureAnchor(element);
  change();
  if (anchor === NOOP) return;
  const until = performance.now() + settleMs + 50;
  const frame = () => {
    anchor.restore();
    if (performance.now() < until) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
