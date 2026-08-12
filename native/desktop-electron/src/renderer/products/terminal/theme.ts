/**
 * The terminal palette, derived from Juno's CSS custom properties.
 *
 * ## The rule
 *
 * Nothing in this file is a hardcoded colour. Every value is read from computed
 * style at runtime, so the terminal follows light/dark, the runtime accent
 * swap on `[data-accent]`, and any future theme, without this module knowing
 * that any of those exist.
 *
 * ## The problem, stated honestly
 *
 * A terminal needs sixteen distinguishable ANSI colours. Juno's design system
 * has six semantic hues and a neutral ramp — there is no blue token at all, and
 * no bright variants. So the palette is derived in three tiers:
 *
 *   1. **`--terminal-*` tokens, if the design system provides them.** These are
 *      the contract; the full list is `TERMINAL_TOKENS` below. A designer who
 *      wants a hand-tuned terminal palette adds those twenty properties and
 *      this file stops deriving anything.
 *   2. **Nearest semantic token.** `red` ← `--destructive`, `green` ←
 *      `--success`, `yellow` ← `--warning`, `cyan` ← `--source`, `magenta` ←
 *      `--ultra`. These already carry the right connotation, which is why a
 *      failing test in a terminal looks like a failing anything else in Juno.
 *   3. **Arithmetic on a real token.** `blue` is `--source` rotated +30° (teal
 *      → blue), the neutral ramp is a mix of `--card` and `--foreground`, and
 *      the bright variants step *away from the background* — lighter on a dark
 *      theme, darker on a light one. That last part is the correction the
 *      conventional "bright = lighter" rule needs: on a light background,
 *      lightening a colour makes it less legible, not more.
 *
 * Tier 3 is a stopgap and is labelled as one. The safety net under it is
 * `minimumContrastRatio`, which makes xterm lift any cell colour that fails
 * against its background — so a derived palette can be a bit off, but it cannot
 * be unreadable.
 */

import type { ITheme } from '@xterm/xterm';
import { adjust, mix, relativeLuminance, resolveTokenColor, rotateHue, withAlpha } from './color.js';

/**
 * The custom properties the design system may define to take control of the
 * palette. All optional; each one that is present wins over the derivation.
 */
export const TERMINAL_TOKENS = [
  '--terminal-background',
  '--terminal-foreground',
  '--terminal-cursor',
  '--terminal-cursor-accent',
  '--terminal-selection',
  '--terminal-ansi-black',
  '--terminal-ansi-red',
  '--terminal-ansi-green',
  '--terminal-ansi-yellow',
  '--terminal-ansi-blue',
  '--terminal-ansi-magenta',
  '--terminal-ansi-cyan',
  '--terminal-ansi-white',
  '--terminal-ansi-bright-black',
  '--terminal-ansi-bright-red',
  '--terminal-ansi-bright-green',
  '--terminal-ansi-bright-yellow',
  '--terminal-ansi-bright-blue',
  '--terminal-ansi-bright-magenta',
  '--terminal-ansi-bright-cyan',
  '--terminal-ansi-bright-white',
] as const;

/**
 * How far xterm may lift a cell colour to keep it legible.
 *
 * 4.5:1 is WCAG AA for body text. It is set this high *because* the palette is
 * partly derived: `white` on a light theme is near-white by definition, and
 * without this a program that prints in ANSI white would be invisible. It can
 * be relaxed to 1 (off) the day the `--terminal-ansi-*` tokens above exist and
 * have been checked by a human.
 */
export const MINIMUM_CONTRAST_RATIO = 4.5;

/**
 * The monospace stack.
 *
 * A font stack, not a colour — hardcoding a fallback chain here is correct,
 * because a missing font degrades to a different shape rather than to an
 * unreadable one. `--font-mono` still wins when the design system sets it.
 */
export const TERMINAL_FONT_FALLBACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Courier New", monospace';

interface TokenReader {
  (name: string): string | null;
}

function makeReader(styles: CSSStyleDeclaration): TokenReader {
  return (name) => resolveTokenColor(styles.getPropertyValue(name));
}

/** First token that resolves, else the fallback colour. */
function pick(read: TokenReader, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const value = read(name);
    if (value) return value;
  }
  return fallback;
}

export interface TerminalThemeResult {
  theme: ITheme;
  fontFamily: string;
  /** True when the resolved background is darker than its foreground. */
  isDark: boolean;
}

/**
 * Build the palette from whatever `element` inherits.
 *
 * Reading from the *element* rather than from `document.documentElement` means
 * a terminal nested inside a locally-themed region (a `.dark` preview card, a
 * settings sheet with its own accent) picks up that region's tokens rather than
 * the page's. It costs nothing and it is the difference between a themeable
 * component and one that merely happens to work at the root.
 */
export function buildTerminalTheme(element: Element): TerminalThemeResult {
  const styles = getComputedStyle(element);
  const read = makeReader(styles);

  /* `--card` before `--background`: the terminal is a distinct opaque object
     sitting *on* the app ground, not a hole in it. In Juno's dark theme the app
     ground is pure black and `--card` is a slightly lifted charcoal, which is
     what makes the pane read as a surface with edges. */
  const background = pick(read, ['--terminal-background', '--card', '--background'], '#101010');
  const foreground = pick(read, ['--terminal-foreground', '--foreground'], '#f2f0ea');

  const isDark = relativeLuminance(background) < relativeLuminance(foreground);
  /* "Brighter" means further from the background, in whichever direction that
     is. On a light theme the ANSI bright variants therefore get *darker*. */
  const brightStep = isDark ? 0.12 : -0.12;

  const red = pick(read, ['--terminal-ansi-red', '--destructive'], '#c0503c');
  const green = pick(read, ['--terminal-ansi-green', '--success'], '#4f9d68');
  const yellow = pick(read, ['--terminal-ansi-yellow', '--warning'], '#c39338');
  const cyan = pick(read, ['--terminal-ansi-cyan', '--source'], '#2f97a8');
  const magenta = pick(read, ['--terminal-ansi-magenta', '--ultra'], '#8b6cf0');
  /* Tier 3. `--source` is a teal at ~187°; +30° lands at ~217°, a true blue,
     while keeping the token's saturation and lightness — so it moves with the
     theme instead of sitting outside it. Replace with `--terminal-ansi-blue`. */
  const blue = pick(read, ['--terminal-ansi-blue'], rotateHue(cyan, 30));

  /* The neutral ramp, walked from whichever end is darker toward the lighter.
     ANSI black is dark in *both* themes and ANSI white is light in both — they
     are absolute, not relative to the background — so the ramp is anchored to
     the foreground/background pair rather than flipped with it. */
  const darkEnd = isDark ? background : foreground;
  const lightEnd = isDark ? foreground : background;

  const black = pick(read, ['--terminal-ansi-black'], mix(darkEnd, lightEnd, 0.12));
  const brightBlack = pick(
    read,
    ['--terminal-ansi-bright-black', '--muted-foreground'],
    mix(darkEnd, lightEnd, 0.42),
  );
  const white = pick(read, ['--terminal-ansi-white'], mix(darkEnd, lightEnd, 0.8));
  const brightWhite = pick(read, ['--terminal-ansi-bright-white'], lightEnd);

  const cursor = pick(read, ['--terminal-cursor', '--primary'], foreground);
  const selection = pick(read, ['--terminal-selection', '--primary'], cursor);

  const theme: ITheme = {
    background,
    foreground,
    cursor,
    /* The glyph under a block cursor. The background, so the cell inverts. */
    cursorAccent: pick(read, ['--terminal-cursor-accent'], background),
    /* Selection is the one place alpha is wanted: a solid block would hide the
       text it is selecting, and xterm composites this over the cell itself. */
    selectionBackground: withAlpha(selection, 0.32),
    selectionInactiveBackground: withAlpha(selection, 0.16),

    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,

    brightBlack,
    brightRed: pick(read, ['--terminal-ansi-bright-red'], adjust(red, brightStep, 0.05)),
    brightGreen: pick(read, ['--terminal-ansi-bright-green'], adjust(green, brightStep, 0.05)),
    brightYellow: pick(read, ['--terminal-ansi-bright-yellow'], adjust(yellow, brightStep, 0.05)),
    brightBlue: pick(read, ['--terminal-ansi-bright-blue'], adjust(blue, brightStep, 0.05)),
    brightMagenta: pick(
      read,
      ['--terminal-ansi-bright-magenta'],
      adjust(magenta, brightStep, 0.05),
    ),
    brightCyan: pick(read, ['--terminal-ansi-bright-cyan'], adjust(cyan, brightStep, 0.05)),
    brightWhite,
  };

  const fontToken = styles.getPropertyValue('--font-mono').trim();
  const fontFamily = fontToken ? `${fontToken}, ${TERMINAL_FONT_FALLBACK}` : TERMINAL_FONT_FALLBACK;

  return { theme, fontFamily, isDark };
}

/**
 * Cheap identity for a palette, so a repaint that changed nothing is skipped.
 *
 * `Terminal.options.theme = …` invalidates xterm's colour cache and forces a
 * full redraw. The theme is recomputed on several signals that often fire
 * together (a class change, a media query, and main's appearance push all
 * arrive for one system toggle), so comparing before assigning turns three full
 * redraws into one.
 */
export function themeFingerprint(theme: ITheme): string {
  return Object.entries(theme)
    .filter(([, value]) => typeof value === 'string')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join('|');
}
