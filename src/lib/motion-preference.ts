/**
 * Whether motion is reduced, for script: the one place that answers it.
 *
 * Three inputs decide it, and every scripted animation used to read only the
 * first: the OS (`prefers-reduced-motion`), the in-app choice (Settings ›
 * Appearance › Motion, mirrored onto `<html data-motion>` by lib/ui-prefs.ts
 * before first paint), and a gallery that simulates the preference on its own
 * root because the browser pane cannot emulate the media query.
 *
 *   System   follow the OS
 *   Reduced  reduce, whatever the OS says
 *   Full     do not reduce, whatever the OS says
 *
 * CSS gets the same three answers from postcss/motion-preference.cjs, which
 * compiles every reduced-motion block into its `data-motion` twin, so a canvas
 * clock, a framer-motion spring and a stylesheet transition always agree.
 * `data-motion="reduce"` (the galleries' old spelling) is read as "reduced".
 *
 * Use `useReducedMotion()` in components (it replaces framer-motion's, which
 * reads only the OS) and `prefersReducedMotion()` / `reducedMotionAt(el)` at
 * the moment a scripted animation starts. Never query the media string
 * directly: eslint forbids it outside this file.
 */

import * as React from "react";

export type MotionPref = "system" | "reduced" | "full";

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** The choice in force at `element`: its nearest `data-motion` (a gallery root, or <html>). */
export function motionPrefAt(element: Element | null | undefined): MotionPref {
  const value = element?.closest?.("[data-motion]")?.getAttribute("data-motion");
  if (value === "reduced" || value === "reduce") return "reduced";
  if (value === "full") return "full";
  return "system";
}

/** The OS preference alone. */
export function osPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The rule itself, pure: Reduced always reduces, Full never does, System follows the OS. */
export function resolveReducedMotion(pref: MotionPref, osReduced: boolean): boolean {
  return pref === "reduced" || (pref === "system" && osReduced);
}

/**
 * Whether motion is reduced at `element` (default: the document). Read it when
 * a scripted transition starts, so a change applies to the next one without a
 * re-render.
 */
export function reducedMotionAt(element?: Element | null): boolean {
  const target = element ?? (typeof document === "undefined" ? null : document.documentElement);
  return resolveReducedMotion(motionPrefAt(target), osPrefersReducedMotion());
}

/** Whether motion is reduced for the page. */
export function prefersReducedMotion(): boolean {
  return reducedMotionAt(null);
}

/** framer-motion's `MotionConfig reducedMotion` for a choice. */
export function framerReducedMotion(pref: MotionPref): "always" | "never" | "user" {
  return pref === "reduced" ? "always" : pref === "full" ? "never" : "user";
}

/* One media listener and one attribute observer for the page, however many
   components subscribe: a transcript can mount hundreds of rows that ask. */
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

function attach(): () => void {
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
  media?.addEventListener?.("change", notify);
  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(notify);
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => {
    media?.removeEventListener?.("change", notify);
    observer?.disconnect();
  };
}

/** Calls `onChange` when the OS preference or the in-app choice changes. Returns the unsubscribe. */
export function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  listeners.add(onChange);
  detach ??= attach();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

const serverSnapshot = () => false;

/**
 * Whether motion is reduced for the page, live. Drop-in for framer-motion's
 * `useReducedMotion`, which reads only the OS and so ignored both the in-app
 * Reduced and Full choices.
 */
export function useReducedMotion(): boolean {
  return React.useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, serverSnapshot);
}
