"use client";

import * as React from "react";
import { enterKeyHintFor, isHardwareOnlyKey, returnSends, type ReturnContext } from "@/lib/composer-keys";
import { readUiPrefs, useUiPrefs } from "@/lib/ui-prefs";

/*
 * The browser half of the touch-Return rule (src/lib/composer-keys.ts, G35):
 * what kind of pointer and keyboard this device has, read live. The rule
 * itself is pure and lives beside the other Enter rules.
 */

/** Below this many pixels of visual-viewport shortfall, no on-screen keyboard is up. */
const SOFT_KEYBOARD_MIN_PX = 120;

let hardwareKeyboardSeen = false;
let watching = false;

function watchForHardwareKeys() {
  if (watching || typeof window === "undefined") return;
  watching = true;
  window.addEventListener(
    "keydown",
    (event) => {
      if (!hardwareKeyboardSeen && isHardwareOnlyKey(event)) hardwareKeyboardSeen = true;
    },
    { capture: true, passive: true },
  );
}

/** A finger is the primary pointer and nothing finer is attached. */
export function isTouchPrimary(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
}

/** Whether the on-screen keyboard is up, from the visual viewport; null when unmeasurable. */
export function isSoftKeyboardOpen(): boolean | null {
  if (typeof window === "undefined") return null;
  const viewport = window.visualViewport;
  if (!viewport) return null;
  // Pinch zoom shrinks the visual viewport too; scale it back out.
  const shortfall = window.innerHeight - viewport.height * viewport.scale;
  return shortfall > SOFT_KEYBOARD_MIN_PX;
}

function currentContext(prefs = readUiPrefs()): ReturnContext {
  watchForHardwareKeys();
  return {
    sendKey: prefs.sendKey,
    touchReturn: prefs.touchReturn,
    touchPrimary: isTouchPrimary(),
    hardwareKeyboardSeen,
    softKeyboardOpen: isSoftKeyboardOpen(),
  };
}

/**
 * For a keydown that `enterIntent` called "send": does it send, or should the
 * field break the line? Read at the moment of the press, so a keyboard
 * attached or detached mid-draft is honoured.
 */
export function plainReturnSends(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return returnSends(currentContext(), event.metaKey || event.ctrlKey);
}

/**
 * The touch half alone, for composers that do not follow "Send with ⌘ Enter"
 * (Code and Work, whose ⌘↵ means steer or queue): true when this Return comes
 * from an on-screen keyboard and should break the line.
 */
export function touchReturnBreaksLine(event: { key: string; shiftKey?: boolean; altKey?: boolean; metaKey: boolean; ctrlKey: boolean }): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  return !returnSends({ ...currentContext(), sendKey: "enter" }, false);
}

/** Whether this device is touch-first (re-evaluated when a pointer is attached or removed). */
export function useTouchPrimary(): boolean {
  const [touch, setTouch] = React.useState(false);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const coarse = window.matchMedia("(pointer: coarse)");
    const fine = window.matchMedia("(any-pointer: fine)");
    const sync = () => setTouch(isTouchPrimary());
    sync();
    coarse.addEventListener("change", sync);
    fine.addEventListener("change", sync);
    return () => {
      coarse.removeEventListener("change", sync);
      fine.removeEventListener("change", sync);
    };
  }, []);
  return touch;
}

/**
 * The `enterkeyhint` for a composer field: "enter" (a return arrow) where
 * Return breaks the line, "send" where it sends. Server-renders as "send" and
 * settles after mount, which is invisible: no keyboard is up before a focus.
 */
export function useEnterKeyHint(scope: "all" | "touch" = "all"): "enter" | "send" {
  const prefs = useUiPrefs();
  const touch = useTouchPrimary();
  React.useEffect(() => {
    watchForHardwareKeys();
  }, []);
  return enterKeyHintFor({
    // "touch": a composer whose ⌘↵ means something else follows only the touch rule.
    sendKey: scope === "touch" ? "enter" : prefs.sendKey,
    touchReturn: prefs.touchReturn,
    touchPrimary: touch,
    hardwareKeyboardSeen,
    softKeyboardOpen: null,
  });
}
