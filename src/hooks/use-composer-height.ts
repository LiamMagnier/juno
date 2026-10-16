"use client";

import * as React from "react";

/**
 * Publishes the mounted composer's height as `--composer-h` on <html>
 * (spec §3.12, C15), so things outside the chat column (the Toaster, the Jump
 * to latest pill) can clear it without knowing which route they are on. A
 * ResizeObserver keeps it current as the composer grows; unmounting resets
 * it to 0px, so a page with no composer gets the plain 16px toast offset.
 *
 * P5's composer calls this with a ref to its outer box. Two composers on one
 * page (never expected) would race; the last one to resize wins.
 */

export const COMPOSER_HEIGHT_VAR = "--composer-h";

/** Writes the variable; exported for tests and for a non-React composer. */
export function publishComposerHeight(px: number, root: HTMLElement = document.documentElement): void {
  const value = `${Math.max(0, Math.round(px))}px`;
  if (root.style.getPropertyValue(COMPOSER_HEIGHT_VAR) !== value) root.style.setProperty(COMPOSER_HEIGHT_VAR, value);
}

export function resetComposerHeight(root: HTMLElement = document.documentElement): void {
  root.style.setProperty(COMPOSER_HEIGHT_VAR, "0px");
}

export function useComposerHeight(ref: React.RefObject<HTMLElement | null>, enabled: boolean = true): void {
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof document === "undefined") return;
    const root = document.documentElement;
    const measure = () => publishComposerHeight(el.getBoundingClientRect().height, root);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      resetComposerHeight(root);
    };
  }, [ref, enabled]);
}
