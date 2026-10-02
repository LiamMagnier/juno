/**
 * The tones a brand drawing may take. Uniform graphite on light, pale neutral
 * on dark (`ink`, which is --foreground in both themes); `presence` only where
 * the mark reports real activity; `inverse` for a mark on an ink field;
 * `current` inherits the surrounding text colour.
 */
export type BrandTone = "ink" | "muted" | "presence" | "inverse" | "current";

export const BRAND_TONE_COLOR: Readonly<Record<BrandTone, string | undefined>> = {
  ink: "hsl(var(--foreground))",
  muted: "hsl(var(--muted-foreground))",
  presence: "hsl(var(--primary-ink))",
  inverse: "hsl(var(--background))",
  current: undefined,
};
