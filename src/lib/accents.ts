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

/**
 * Ink that stays legible on an arbitrary swatch.
 *
 * The confirming glyph on an accent swatch was `text-white` at both call sites.
 * That is not a colour decision, it is an assumption that every accent is dark —
 * and it is wrong for the amber preset (white measures 2.3:1 on it) and wrong
 * for any pale colour a user picks out of the custom wheel, where the only
 * signal that their choice registered disappears into the swatch.
 *
 * A design token cannot express this: the swatch is a runtime colour, not a
 * themed surface, so the ink has to be computed from it and set inline
 * alongside it. White is kept unless white actually fails AA, so the presets
 * that were already fine are untouched.
 *
 * It lives HERE, next to the swatches it has to stay true for, because it was
 * previously a private function inside the settings page — which is why
 * onboarding's copy of the same picker still shipped the bug this fixes. A rule
 * about the accent list belongs with the accent list.
 */
export function swatchInk(color: string): string {
  const y = relativeLuminance(color);
  return y != null && 1.05 / (y + 0.05) < 4.5 ? "hsl(0 0% 6%)" : "hsl(0 0% 100%)";
}

/** WCAG relative luminance of an `hsl(h s% l%)` or `#rgb`/`#rrggbb` colour. */
export function relativeLuminance(color: string): number | null {
  const rgb = parseColor(color);
  if (!rgb) return null;
  const lin = rgb.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** The two notations the accent list actually uses: presets are hsl(), custom is hex. */
function parseColor(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  const hsl = /^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/i.exec(color.trim());
  if (!hsl) return null;
  const [h, s, l] = [Number(hsl[1]) / 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h * 6) % 6;
  const table: [number, number, number][] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  return table[seg].map((v) => v + m) as [number, number, number];
}
