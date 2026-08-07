// Single source of truth for accent options — used by the settings UI,
// the settings API validator, and as the default. Keep in sync with the
// [data-accent="…"] rules in globals.css.

// These swatches had drifted from the [data-accent] rules they advertise — the
// old coral, hsl(15 63% 60%), was byte-identical to provider-colors.ts's
// `anthropic` badge, so the product's own brand chip and the Anthropic provider
// logo were literally the same colour. Every value below now matches globals.css.
export const ACCENTS = [
  { id: "coral", color: "hsl(15 54% 46%)" },
  { id: "juniper", color: "hsl(152 44% 31%)" },
  { id: "teal", color: "hsl(180 63% 31.5%)" },
  { id: "violet", color: "hsl(249 59% 60%)" },
  { id: "amber", color: "hsl(39 67% 55%)" },
  { id: "sage", color: "hsl(120 18% 42.5%)" },
] as const;

export const ACCENT_IDS = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;

export type AccentId = (typeof ACCENT_IDS)[number];
