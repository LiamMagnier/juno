"use client";

import * as React from "react";

/**
 * Which keyboard conventions the reader's machine follows.
 *
 * The settings modal printed "⌘," on every platform, so a Windows or Linux
 * user was shown a key their keyboard does not have for a shortcut that
 * works for them as Ctrl+,. One test, shared: chat-view.tsx already answered
 * the same question privately to decide whether Ctrl+F belongs to macOS.
 *
 * User agent, not `navigator.platform` (deprecated) or `userAgentData` (not
 * in Safari): the UA string still names the family on every browser that
 * matters, and a wrong guess costs one glyph in a hint, not a feature.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** The modifier glyph a shortcut hint should print: "⌘" on Apple, "Ctrl" elsewhere. */
export function modifierKeyLabel(): string {
  return isApplePlatform() ? "⌘" : "Ctrl";
}

/**
 * The same glyph, safe to render: the server does not know the platform, so
 * the first paint says "⌘" (the majority of this product's readers) and the
 * hint corrects itself after mount rather than tripping a hydration mismatch.
 */
export function useModifierKeyLabel(): string {
  const [label, setLabel] = React.useState("⌘");
  React.useEffect(() => setLabel(modifierKeyLabel()), []);
  return label;
}
