"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A vertical scroll region with progressive-blur edges.
 *
 * Wraps its children in an `overflow-y-auto` viewport and pins two blur bands
 * (top and bottom) that the content dissolves under as it scrolls past — the
 * standard "there is more this way" affordance, but a soft blur ramp instead of
 * a hard clip. Each band fades in only when there is actually more to scroll in
 * that direction, so the first and last rows stay crisp at the extremes.
 *
 * Drop-in for any `<div className="overflow-y-auto">`: move the scroll classes'
 * sizing here and pass the padding via `viewportClassName`. The styling lives in
 * `.scroll-fade-edge` (globals.css), which also carries the reduced-transparency
 * and reduced-motion fallbacks.
 */
export function ScrollFade({
  children,
  className,
  viewportClassName,
  viewportRef,
  onViewportScroll,
}: {
  children: React.ReactNode;
  /** The wrapper — put sizing here (e.g. `min-h-0 flex-1`). */
  className?: string;
  /** The scroller — put padding here (e.g. `p-1.5`). */
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
}) {
  const innerRef = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ top: false, bottom: false });

  const measure = React.useCallback(() => {
    const el = innerRef.current;
    if (!el) return;
    const top = el.scrollTop > 1;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    // Skip the state churn when nothing changed — this runs on every scroll tick.
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
  }, []);

  // Re-measure when the content resizes (list loads, items filter) and on mount.
  React.useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      measure();
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    measure();
    return () => ro.disconnect();
  }, [measure]);

  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof viewportRef === "function") viewportRef(node);
      else if (viewportRef) (viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    [viewportRef],
  );

  // Wrapper is a flex column so the scroller can be a bounded `flex-1 min-h-0`
  // child — the reliable way to make a nested region scroll. `h-full` failed
  // (percentage height against a flex-sized parent isn't treated as definite,
  // so the list overflowed the footer); `absolute inset-0` failed the other way
  // (out of flow, so the wrapper collapsed to nothing). The blur edges are
  // absolute to this wrapper, which never scrolls, so they stay pinned.
  // The caller sizes the wrapper (e.g. `flex-1 min-h-0`).
  return (
    <div className={cn("relative flex flex-col", className)}>
      <div
        ref={setRefs}
        onScroll={(e) => {
          measure();
          onViewportScroll?.(e);
        }}
        className={cn("min-h-0 flex-1 overflow-y-auto", viewportClassName)}
      >
        {children}
      </div>
      <div aria-hidden="true" data-edge="top" className={cn("scroll-fade-edge", !edges.top && "opacity-0")} />
      <div aria-hidden="true" data-edge="bottom" className={cn("scroll-fade-edge", !edges.bottom && "opacity-0")} />
    </div>
  );
}
