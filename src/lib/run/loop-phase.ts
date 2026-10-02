/**
 * Locking every loop to the page clock (SPEC §7.9 "Phase lock"), and pausing
 * the ones nobody can see (U5).
 *
 * A negative animation delay aligns a loop with the page clock only when it is
 * computed for that loop's own start and period, and `--loop-phase` does not
 * inherit across siblings: the glyph, the shimmer in the label and the markers
 * in the peek and the panel each need their own. So `usePhaseLock` writes
 * `--loop-phase = -(document.timeline.currentTime % period)` on the looping
 * element itself, on mount and whenever its animation changes — a new
 * `data-phase`, `data-calm`, `data-loop` or `data-offscreen` — so the glyph
 * and the shimmer start together and read as one gesture, and a line that
 * regains the loop (the panel closed) does not restart mid-loop.
 *
 * `observeOffscreen` sets `data-offscreen` straight on the element from one
 * shared IntersectionObserver; the CSS pauses every loop under it. Occlusion
 * the observer cannot see (a sheet over the transcript) is the loop arbiter's.
 */

import * as React from "react";
import type { RefObject } from "react";

/** The attributes whose change restarts an element's loop. */
const LOOP_ATTRIBUTES = ["data-phase", "data-calm", "data-loop", "data-offscreen", "data-state"];

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** The page clock in ms: the document timeline, which every CSS animation runs on. */
export function pageClock(): number {
  if (typeof document !== "undefined") {
    const current = document.timeline?.currentTime;
    if (typeof current === "number") return current;
  }
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** The delay that puts a loop of `periodMs` in phase with the page clock, e.g. "-812ms". */
export function loopPhase(periodMs: number, now: number = pageClock()): string {
  if (!(periodMs > 0) || !Number.isFinite(now)) return "0ms";
  const offset = now % periodMs;
  return `${offset === 0 ? 0 : -Math.round(offset)}ms`;
}

/**
 * Writes `--loop-phase` on the element in `ref` for a loop of `periodMs`, and
 * again whenever one of its loop attributes changes. The caller passes the
 * element's current period: 1,200 for the `tool` beat, 2,400 normally, 4,800
 * when calm or under reduced motion.
 */
export function usePhaseLock(ref: RefObject<HTMLElement | null>, periodMs: number): void {
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const lock = () => element.style.setProperty("--loop-phase", loopPhase(periodMs));
    lock();
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(lock);
    observer.observe(element, { attributes: true, attributeFilter: LOOP_ATTRIBUTES });
    return () => observer.disconnect();
  }, [ref, periodMs]);
}

// ── Offscreen ────────────────────────────────────────────────────────────────

type OffscreenCallback = (offscreen: boolean) => void;

let sharedObserver: IntersectionObserver | null = null;
const callbacks = new WeakMap<Element, Set<OffscreenCallback>>();

function observer(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const offscreen = !entry.isIntersecting;
      if (offscreen) entry.target.setAttribute("data-offscreen", "");
      else entry.target.removeAttribute("data-offscreen");
      for (const callback of callbacks.get(entry.target) ?? []) callback(offscreen);
    }
  });
  return sharedObserver;
}

/**
 * Marks `element` with `data-offscreen` while it is outside the viewport, and
 * tells `onChange` (optional). Returns the unobserve.
 */
export function observeOffscreen(element: Element, onChange?: OffscreenCallback): () => void {
  const io = observer();
  if (!io) return () => {};
  let set = callbacks.get(element);
  if (!set) {
    set = new Set();
    callbacks.set(element, set);
  }
  if (onChange) set.add(onChange);
  io.observe(element);
  return () => {
    if (onChange) set!.delete(onChange);
    if (!set!.size) {
      callbacks.delete(element);
      io.unobserve(element);
      element.removeAttribute("data-offscreen");
    }
  };
}

/** `observeOffscreen` for the element in `ref`, for as long as the component is mounted. */
export function useOffscreen(ref: RefObject<Element | null>, onChange?: OffscreenCallback): void {
  const latest = React.useRef(onChange);
  latest.current = onChange;
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return observeOffscreen(element, (offscreen) => latest.current?.(offscreen));
  }, [ref]);
}

// ── Reduced motion ───────────────────────────────────────────────────────────

const REDUCED = "(prefers-reduced-motion: reduce)";

/**
 * Whether motion at `element` is reduced: the reader's preference, or the
 * galleries' simulation (`data-motion="reduce"` on an ancestor), which the
 * browser pane needs because it cannot emulate the media query. Read at the
 * moment a scripted transition starts, so the gallery toggle takes effect on
 * the next one without any component re-rendering for it.
 */
export function reducedMotionAt(element: Element | null): boolean {
  if (typeof window !== "undefined" && window.matchMedia?.(REDUCED).matches) return true;
  return Boolean(element?.closest('[data-motion="reduce"]'));
}
