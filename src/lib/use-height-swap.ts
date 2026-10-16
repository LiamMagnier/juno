"use client";

import * as React from "react";

import { reducedMotionAt } from "@/lib/motion-preference";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * Animates an element's height when what it holds is swapped for something of
 * another height: the composer's textarea giving way to an approval, a task
 * card's live body settling into its result.
 *
 * Without it the box jumps to its new height in one frame, and everything
 * below it (or above it, for a bottom-anchored composer) jumps with it. Here
 * the swap commits as usual, then the box eases from the height it had to the
 * height it has now, clipped while it moves. Only a change of `swapKey`
 * animates: a textarea growing line by line as the reader types is the
 * reader's own doing and follows instantly.
 *
 * Reduced motion (the OS, the in-app choice or a gallery's simulation) keeps
 * the instant swap: a height change is travel for everything around it.
 */
export function useHeightSwap(
  ref: React.RefObject<HTMLElement | null>,
  swapKey: string,
  { duration = 220, easing = "cubic-bezier(0.32, 0.72, 0, 1)" }: { duration?: number; easing?: string } = {},
): void {
  const height = React.useRef<number | null>(null);
  const shownKey = React.useRef(swapKey);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = el.getBoundingClientRect().height;
    const prev = height.current;
    const swapped = shownKey.current !== swapKey;
    shownKey.current = swapKey;
    height.current = next;
    if (!swapped || prev === null || Math.abs(prev - next) < 1) return;
    if (typeof el.animate !== "function" || reducedMotionAt(el)) return;
    for (const running of el.getAnimations?.() ?? []) {
      if (running.id === "height-swap") running.cancel();
    }
    const overflow = el.style.overflow;
    el.style.overflow = "hidden";
    const animation = el.animate([{ height: `${prev}px` }, { height: `${next}px` }], { duration, easing, id: "height-swap" });
    const restore = () => {
      el.style.overflow = overflow;
    };
    animation.onfinish = restore;
    animation.oncancel = restore;
  }, [ref, swapKey, duration, easing]);

  // Between swaps the box may change height on its own (the textarea grows);
  // keep the remembered height current so the next swap starts from the truth.
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const moving = (el.getAnimations?.() ?? []).some((a) => a.id === "height-swap");
      if (!moving) height.current = el.getBoundingClientRect().height;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
