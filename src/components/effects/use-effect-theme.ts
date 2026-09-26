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

/**
 * THE VOICE GLOW'S PALETTE: the dawn plate, as light.
 *
 * Two palettes failed first. One clay-coral family on every lobe (the old
 * `sunset` tuning) read as an orange shine, not a voice. The package's own
 * `colorful` default is right on a dark ground and turns candy pink and
 * magenta on Juno's cream paper. So the glow takes its hues from the painted
 * plates the front door is built on (public/brand/plates): apricot and clay
 * at the centre where the voice rises, then sage and a misty blue at the
 * edges, the cool counterpoint the valley at dawn has. Warm enough to be
 * Juno's, varied enough to read as sound. A touch brighter on dark so it
 * reads as light rather than paint.
 *
 * `colors` is centre first, then the pairs outward (the package's order).
 */
export function junoVoicePalette(theme: "light" | "dark" | null) {
  return theme === "dark"
    ? {
        colors: ["#ff9a6b", "#ffc15f", "#ff7f73", "#86d19a", "#f59bb0", "#86b9f2", "#79d0c8"],
        bandColors: { core: "#fff1e4", above: "#ff9a6b", mid: "#86d19a", below: "#86b9f2" },
      }
    : {
        colors: ["#f07f52", "#f2ad3f", "#ec6f5f", "#6fb383", "#e8839b", "#6f9fd8", "#5fb3ab"],
        bandColors: { core: "#ffd9bf", above: "#f07f52", mid: "#6fb383", below: "#6f9fd8" },
      };
}
