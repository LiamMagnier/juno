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
 * THE VOICE GLOW'S PALETTES: the call's state, told in colour.
 *
 * The composer shows no meter and no status line during a call; the glow is
 * the state (with a live region for assistive technology). So each state has
 * its own light, drawn from the painted plates the front door is built on:
 *
 * - `you`: warm dawn (apricot, clay, gold, rose). You are talking, or Juno is
 *   listening for you. Rises with your voice.
 * - `juno`: cool dusk (sky, teal, sage, periwinkle). Juno is talking. Rises
 *   with Juno's voice.
 * - `thinking`: both, gathered by the glow's `processing` into one beam that
 *   travels side to side. Motion as much as colour says "working".
 * - `muted`: a quiet grey, held still.
 *
 * Tuned per theme: the package's stock rainbow turns candy pink on Juno's
 * cream paper, and a single clay family read as an orange shine. `colors` is
 * centre first, then the pairs outward (the package's order).
 */
export type VoiceGlowTone = "you" | "juno" | "thinking" | "muted";

const VOICE_PALETTES: Record<"light" | "dark", Record<VoiceGlowTone, { colors: string[]; bandColors: { core: string; above: string; mid: string; below: string } }>> = {
  light: {
    you: {
      colors: ["#f07f52", "#f2ad3f", "#ec6f5f", "#e8839b", "#f29a6e", "#e3a24c", "#d9765a"],
      bandColors: { core: "#ffd9bf", above: "#f07f52", mid: "#ec6f5f", below: "#f2ad3f" },
    },
    juno: {
      colors: ["#6f9fd8", "#5fb3ab", "#8b93dc", "#6fb383", "#7cb6e0", "#76a9c9", "#63a79a"],
      bandColors: { core: "#d6e6f7", above: "#6f9fd8", mid: "#5fb3ab", below: "#6fb383" },
    },
    thinking: {
      colors: ["#f07f52", "#6f9fd8", "#f2ad3f", "#5fb3ab", "#e8839b", "#6fb383", "#8b93dc"],
      bandColors: { core: "#f3e3d6", above: "#f07f52", mid: "#6f9fd8", below: "#5fb3ab" },
    },
    muted: {
      colors: ["#b8b3aa", "#c6c1b8", "#aca79e", "#cfcac2", "#b0aba2", "#c2bdb4", "#a8a39a"],
      bandColors: { core: "#e6e2da", above: "#bdb8af", mid: "#c9c4bb", below: "#aca79e" },
    },
  },
  dark: {
    you: {
      colors: ["#ff9a6b", "#ffc15f", "#ff7f73", "#f59bb0", "#ffab7f", "#f2b866", "#ec8a6c"],
      bandColors: { core: "#fff1e4", above: "#ff9a6b", mid: "#ff7f73", below: "#ffc15f" },
    },
    juno: {
      colors: ["#86b9f2", "#79d0c8", "#a3aaf5", "#86d19a", "#95c9f0", "#8cc0dc", "#77c2b3"],
      bandColors: { core: "#e8f3ff", above: "#86b9f2", mid: "#79d0c8", below: "#86d19a" },
    },
    thinking: {
      colors: ["#ff9a6b", "#86b9f2", "#ffc15f", "#79d0c8", "#f59bb0", "#86d19a", "#a3aaf5"],
      bandColors: { core: "#fff4ea", above: "#ff9a6b", mid: "#86b9f2", below: "#79d0c8" },
    },
    muted: {
      colors: ["#77736d", "#86827b", "#6c6863", "#8f8b84", "#716d67", "#817d77", "#66625d"],
      bandColors: { core: "#a39f98", above: "#7d7973", mid: "#8a867f", below: "#6c6863" },
    },
  },
};

export function junoVoicePalette(theme: "light" | "dark" | null, tone: VoiceGlowTone = "you") {
  return VOICE_PALETTES[theme ?? "light"][tone];
}
