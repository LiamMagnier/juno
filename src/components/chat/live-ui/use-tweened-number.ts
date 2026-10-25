"use client";

import * as React from "react";
import { useReducedMotion } from "@/lib/motion-preference";

/**
 * A number that glides to its new value instead of jumping: a Live UI metric
 * counts from the old figure to the new one while a slider moves (the way
 * ChatGPT's interactive answers do), so the reader sees which way and how far
 * the result moved. The first value is shown as is; reduced motion snaps.
 *
 * Ease-out over 420 ms, restarted from wherever the glide currently is, so a
 * slider being dragged never queues a backlog of animations behind the thumb.
 */
export function useTweenedNumber(target: number, duration = 420): number {
  const reduced = useReducedMotion();
  const [shown, setShown] = React.useState(target);
  const shownRef = React.useRef(target);
  const frame = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const from = shownRef.current;
    if (reduced || !Number.isFinite(from) || !Number.isFinite(target) || from === target) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = t >= 1 ? target : from + (target - from) * eased;
      shownRef.current = v;
      setShown(v);
      frame.current = t >= 1 ? null : requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [target, duration, reduced]);

  return shown;
}
