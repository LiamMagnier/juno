"use client";

import * as React from "react";

/**
 * Keeps a conditionally rendered surface mounted long enough to animate out.
 *
 * Every surface that animates in should animate out (the motion symmetry rule
 * in docs/rework/program/COMPETITIVE_AUDIT_2026-10-15.md): a popover, a dock,
 * a palette or a toast that unmounts the moment its flag clears pops out of
 * existence while its entrance was eased. With this hook the node stays in the
 * tree while `closing` is true; the caller marks it `data-state="closed"` and
 * its stylesheet plays the exit (about 0.65x the entrance, on the accelerate
 * curve). It unmounts when that exit animation ends on the node itself, or
 * after `fallbackMs` if no animation runs (display: none, an old browser).
 *
 * Reopening during the exit simply flips it back: the node never unmounted, so
 * the entrance plays again from wherever the exit had reached.
 *
 *   const pop = usePresence(open, 200);
 *   {pop.mounted && <div data-state={pop.closing ? "closed" : "open"} onAnimationEnd={pop.onAnimationEnd} />}
 */
export function usePresence(open: boolean, fallbackMs: number) {
  const [present, setPresent] = React.useState(open);
  // Derived during render, so an opening surface mounts in the same commit.
  if (open && !present) setPresent(true);

  React.useEffect(() => {
    if (open || !present) return;
    const timer = window.setTimeout(() => setPresent(false), fallbackMs);
    return () => window.clearTimeout(timer);
  }, [open, present, fallbackMs]);

  const onAnimationEnd = React.useCallback(
    (event: React.AnimationEvent<Element>) => {
      if (!open && event.target === event.currentTarget) setPresent(false);
    },
    [open],
  );

  return { mounted: open || present, closing: !open && present, onAnimationEnd };
}

/**
 * The last non-empty value, so a surface that is leaving keeps showing what it
 * showed (a toast's words, a dock's tab) while it animates out.
 */
export function useLatest<T>(value: T | null | undefined | false): T | null {
  const given = value === null || value === undefined || value === false ? null : value;
  const [latest, setLatest] = React.useState<T | null>(given);
  if (given !== null && !Object.is(given, latest)) setLatest(given);
  return given ?? latest;
}
