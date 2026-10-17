import { SCRIPT_COLOR } from "@/lib/design/tokens.generated";

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
 * It used to be converted from globals.css by hand, and its comment still
 * quoted the warm ground the graphite retune replaced. It now comes from the
 * token projection (`npm run design:tokens`), so a move of `--background`
 * reaches the OS chrome in the same change.
 */
export const THEME_COLOR = {
  light: SCRIPT_COLOR.background.light,
  dark: SCRIPT_COLOR.background.dark,
} as const;
