"use client";

import * as React from "react";
import { isApplePlatform } from "@/components/ui/platform";

/**
 * Chords in the reader's platform form (spec §5.7, D7, M11).
 *
 * Every chord is authored once, in Apple glyphs ("⇧⌘F", "⌥⌘A", "⌘↩"). On a
 * Mac, iPhone or iPad it prints as written, in Apple's modifier order
 * ⌃⌥⇧⌘. Everywhere else ⌘ becomes Ctrl, ⌥ becomes Alt, ⇧ becomes Shift and
 * ⌃ becomes Ctrl, joined with "+" in the Windows order Ctrl, Alt, Shift:
 *
 *   "⇧⌘F"  → "Ctrl+Shift+F"
 *   "⌥⌘A"  → "Alt+Shift+A"   (spec §5.7 maps ⌥⌘ to Alt+Shift: Ctrl+Alt is AltGr)
 *   "⌘↩"   → "Ctrl+Enter"
 *
 * The ⌥⌘ pair is the one chord that does not translate glyph by glyph: on
 * Windows and Linux Ctrl+Alt is AltGr on many layouts, so the spec moves
 * every ⌥⌘ chord to Alt+Shift (D7, D22).
 */

const APPLE_ORDER = ["⌃", "⌥", "⇧", "⌘"] as const;
const OTHER_NAMES: Record<string, string> = { "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌘": "Ctrl" };
const KEY_NAMES: Record<string, string> = { "↩": "Enter", "⏎": "Enter", "⌫": "Backspace", "⎋": "Esc", "⇥": "Tab", "␣": "Space" };
const OTHER_ORDER = ["Ctrl", "Alt", "Shift"] as const;

export interface ParsedChord {
  modifiers: string[];
  key: string;
}

/** Splits an Apple-glyph chord into its modifiers and the key. */
export function parseChord(chord: string): ParsedChord {
  const chars = Array.from(chord.trim());
  const modifiers: string[] = [];
  let i = 0;
  while (i < chars.length && (APPLE_ORDER as readonly string[]).includes(chars[i])) modifiers.push(chars[i++]);
  return { modifiers, key: chars.slice(i).join("") };
}

/** One chord in the platform form. `apple` defaults to the reader's machine. */
export function platformChord(chord: string, apple: boolean = isApplePlatform()): string {
  const { modifiers, key } = parseChord(chord);
  if (apple) {
    const ordered = APPLE_ORDER.filter((m) => modifiers.includes(m));
    return `${ordered.join("")}${key}`;
  }
  const set = new Set<string>();
  const altCommand = modifiers.includes("⌥") && modifiers.includes("⌘");
  for (const m of modifiers) {
    if (altCommand && m === "⌘") {
      set.add("Shift");
      continue;
    }
    set.add(OTHER_NAMES[m]);
  }
  const names = OTHER_ORDER.filter((m) => set.has(m));
  const keyName = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  return [...names, keyName].join("+");
}

/** The single modifier glyph for a hint: "⌘" on Apple, "Ctrl" elsewhere. */
export function modifierLabel(apple: boolean = isApplePlatform()): string {
  return apple ? "⌘" : "Ctrl";
}

/**
 * The reader's platform, safe to render: the server cannot know it, so the
 * first paint is Apple (the majority of this product's readers) and the label
 * corrects itself after mount instead of tripping a hydration mismatch.
 */
export function useIsApplePlatform(): boolean {
  const [apple, setApple] = React.useState(true);
  React.useEffect(() => setApple(isApplePlatform()), []);
  return apple;
}

/** `platformChord` as a hook: `useModifierKeyLabel("⇧⌘F")` → "⇧⌘F" or "Ctrl+Shift+F". */
export function useModifierKeyLabel(chord?: string): string {
  const apple = useIsApplePlatform();
  return chord === undefined ? modifierLabel(apple) : platformChord(chord, apple);
}
