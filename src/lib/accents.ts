// Single source of truth for accent options — used by the settings UI,
// the settings API validator, and as the default. Keep in sync with the
// [data-accent="…"] rules in globals.css.

export const ACCENTS = [
  { id: "coral", color: "hsl(15 63% 60%)" },
  { id: "teal", color: "hsl(180 63% 33%)" },
  { id: "violet", color: "hsl(249 59% 64%)" },
  { id: "amber", color: "hsl(39 67% 55%)" },
  { id: "sage", color: "hsl(120 18% 52%)" },
] as const;

export const ACCENT_IDS = ["coral", "teal", "violet", "amber", "sage"] as const;

export type AccentId = (typeof ACCENT_IDS)[number];

export const DEFAULT_ACCENT: AccentId = "coral";
