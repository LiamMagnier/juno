"use client";

import * as React from "react";
import { keyboardInset } from "@/lib/sheet-gesture";

/**
 * Publishes how far the on-screen keyboard covers the layout viewport as
 * `--kb-inset` on <html> (spec §3.12, §5.3), from `visualViewport`. Where the
 * root viewport's `interactiveWidget: resizes-content` works (Chrome on
 * Android) the layout already shrinks and the inset stays 0; iOS Safari
 * ignores it, so the composer pads by this instead. A pinch zoom or a
 * toolbar settling is not a keyboard (lib/sheet-gesture.ts keyboardInset).
 *
 * Mount it once, in the shell that owns the composer. Unmounting resets it.
 */

export const KEYBOARD_INSET_VAR = "--kb-inset";

export function publishKeyboardInset(px: number, root: HTMLElement = document.documentElement): void {
  root.style.setProperty(KEYBOARD_INSET_VAR, `${Math.max(0, Math.round(px))}px`);
}

export function useKeyboardInset(enabled: boolean = true): void {
  React.useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      publishKeyboardInset(
        keyboardInset({
          layoutHeight: window.innerHeight,
          viewportHeight: viewport.height,
          viewportTop: viewport.offsetTop,
          scale: viewport.scale,
        }),
        root,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      publishKeyboardInset(0, root);
    };
  }, [enabled]);
}
