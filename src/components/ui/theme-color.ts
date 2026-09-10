/**
 * `--background`, as the two hex values the OS needs.
 *
 * The browser chrome, the iOS status bar and the PWA splash are painted from
 * `themeColor` / `theme_color`, and a CSS custom property cannot reach them —
 * so the page ground has to be restated as hex in three places (the viewport
 * export, the web manifest, and global-error.tsx, which renders with no
 * stylesheet at all). Three copies had drifted into three different pairs.
 * This is the one copy.
 *
 * Converted from globals.css by hand: light `48 24% 97.2%` and dark
 * `30 5% 11.5%` (docs/design/FLAT_UI.md §3.1). When the ground moves there,
 * move it here in the same change.
 */
export const THEME_COLOR = {
  light: "#faf9f6",
  dark: "#1f1d1c",
} as const;
