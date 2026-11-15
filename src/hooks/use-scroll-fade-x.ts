"use client";

import * as React from "react";

/**
 * The fallback for `.scroll-fade-x` (signature.css §14) where scroll-driven
 * animations are missing (Safari before 26, Firefox before 159). With the
 * scrollbar hidden, the fade is the only sign a row scrolls, so it cannot
 * simply be left out there.
 *
 * It marks the edges that have more to scroll with `data-more-start` and
 * `data-more-end`: an IntersectionObserver, rooted on the scroller, watches
 * the row's first and last items (its first and last button or link, so a
 * row whose one child is wider than the scroller still has two ends to
 * watch). An item not fully in view means there is more beyond it.
 * Elsewhere the CSS does the whole job and this does nothing.
 */
export function useScrollFadeX(ref: React.RefObject<HTMLElement | null>, deps: React.DependencyList = []) {
  React.useEffect(() => {
    const scroller = ref.current;
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    if (typeof CSS !== "undefined" && CSS.supports("animation-timeline", "scroll()")) return;
    const items = scroller.querySelectorAll<HTMLElement>("button, a[href]");
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, intersectionRatio } of entries) {
          // One item alone is both ends.
          if (target === first) scroller.toggleAttribute("data-more-start", intersectionRatio < 1);
          if (target === last) scroller.toggleAttribute("data-more-end", intersectionRatio < 1);
        }
      },
      // Without the margin a sub-pixel width leaves an end item a fraction short of fully visible.
      { root: scroller, threshold: 1, rootMargin: "1px" }
    );
    observer.observe(first);
    if (last !== first) observer.observe(last);
    return () => {
      observer.disconnect();
      scroller.removeAttribute("data-more-start");
      scroller.removeAttribute("data-more-end");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `deps` re-runs it when the row's items change
  }, [ref, ...deps]);
}
