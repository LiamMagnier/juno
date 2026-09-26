"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { useReducedMotion } from "framer-motion";

/**
 * The theme the Libraries.dev effects are tuned for, as the app resolves it.
 *
 * Every effect package defaults to a dark tuning (border-beam) or to
 * `prefers-color-scheme` (the rest), and neither is the app's theme: Juno has
 * its own light / dark / system setting through next-themes. `null` until
 * mounted, so a caller renders its effect inactive on the server and on the
 * first client frame, and there is no hydration mismatch to chase.
 */
export function useEffectTheme(): "light" | "dark" | null {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return resolvedTheme === "dark" ? "dark" : "light";
}

/** `prefers-reduced-motion`, as a plain boolean (framer's hook, live). */
export function usePrefersReducedMotion(): boolean {
  return useReducedMotion() ?? false;
}

/**
 * True once `flag` has held for `ms` without a break.
 *
 * The placement rules are by wait length: a beam only for work longer than
 * 3s, an orb only past 2s. A flag that flips on and off inside that window
 * never lights anything, which is the point: a flash of an effect reads as a
 * glitch.
 */
export function useHeldFor(flag: boolean, ms: number): boolean {
  const [held, setHeld] = React.useState(false);
  React.useEffect(() => {
    if (!flag) {
      setHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setHeld(true), ms);
    return () => window.clearTimeout(timer);
  }, [flag, ms]);
  return flag && held;
}
