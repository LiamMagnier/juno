/**
 * Shortcut hints, written the way the reader's platform writes them.
 *
 * The hints were built as `${mod}⇧O`, where `mod` is "⌘" on Apple and "Ctrl"
 * everywhere else, so a Windows or Linux reader saw "Ctrl⇧O": a word glued to
 * a Mac glyph, with the ⇧ drawn tiny in the mono keycap. Those platforms spell
 * every modifier as a word ("Ctrl+Shift+O"); macOS spells them as glyphs
 * ("⌘⇧O"). One rule, decided from the modifier label the caller already has
 * (`useModifierKeyLabel`), so a hint can never mix the two.
 */

/** The Mac key glyphs and the word each one is elsewhere. Arrows stay
 *  arrows: every platform draws them that way. */
const MODIFIER_WORDS: Record<string, string> = {
  "⌘": "Ctrl",
  "⇧": "Shift",
  "⌥": "Alt",
  "⌃": "Ctrl",
  "↵": "Enter",
};

/** Glyphs that are one key each when a hint is split into keycaps. */
const SINGLE_KEY_GLYPHS = "⌘⇧⌥⌃↵↑↓";

/** Whether `mod` (from `useModifierKeyLabel`) is the Apple one. */
export function isAppleModifier(mod: string): boolean {
  return mod === "⌘";
}

/**
 * A hint as keycaps: "⌘⇧O" → ["⌘", "⇧", "O"] on Apple, and on any other
 * platform the modifiers as words, ["Ctrl", "Shift", "O"]. A hint built
 * from the "Ctrl" label ("Ctrl⇧O", "Ctrl/") splits the same way. "Esc" →
 * ["Esc"].
 */
export function chordKeys(hint: string, mod: string): string[] {
  const out: string[] = [];
  let word = "";
  // "Ctrl/" is two keys, the same as "⌘/": read the word as the glyph it
  // stands for, so the split below treats both alike.
  const source = hint.startsWith("Ctrl") ? `⌘${hint.slice(4)}` : hint;
  for (const ch of source) {
    if (SINGLE_KEY_GLYPHS.includes(ch)) {
      if (word) out.push(word);
      word = "";
      out.push(ch);
    } else word += ch;
  }
  if (word) out.push(word);
  if (isAppleModifier(mod)) return out;
  return out.map((key) => MODIFIER_WORDS[key] ?? key);
}

/**
 * One key of a list that is already split into keycaps (the shortcuts sheet's
 * `["Ctrl", "⇧", "O"]`, lib/shortcut-groups.ts): the glyph on Apple and the
 * word elsewhere, so the sheet never reads "Ctrl ⇧ O" with a tiny ⇧ beside a
 * spelled-out Ctrl.
 */
export function keyCap(key: string, mod: string): string {
  return isAppleModifier(mod) ? key : (MODIFIER_WORDS[key] ?? key);
}

/**
 * A hint as ONE keycap's text: "⌘⇧O" on Apple, "Ctrl+Shift+O" elsewhere,
 * for the places that draw a single `<Kbd>` rather than a row of them.
 */
export function chordLabel(hint: string, mod: string): string {
  const keys = chordKeys(hint, mod);
  return isAppleModifier(mod) ? keys.join("") : keys.join("+");
}
