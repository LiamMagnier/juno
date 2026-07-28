import type { Provider } from "@/lib/providers";

export const PROVIDER_ACCENTS: Record<Provider, string> = {
  anthropic: "#d97859",
  openai: "#111111",
  google: "#4285f4",
  meta: "#0073ff",
  zhipu: "#2f66ff",
  moonshot: "#111827",
  deepseek: "#4f7cff",
  mistral: "#ff8a00",
  xai: "#0f0f0f",
  seedance: "#7c3aed",
  minimax: "#18a0a0",
  mimo: "#ff6a00",
  qwen: "#615ced",
  longcat: "#f5a524",
  modal: "#7ee787",
};

export function providerAccent(provider: Provider): string {
  return PROVIDER_ACCENTS[provider] ?? PROVIDER_ACCENTS.openai;
}

/**
 * The same brands, but as light rather than as ink.
 *
 * PROVIDER_ACCENTS holds each lab's mark colour, which is right for a logo and
 * useless for a glow: three of these labs brand in near-black, and black does
 * not emit. So the flat ones carry a luminous stand-in the lab actually uses
 * elsewhere in its own product (OpenAI's green, Kimi's blue-violet), and xAI —
 * which has no second colour — gets a cool steel that reads as its monochrome
 * without pretending to be a brand value. Everything else is its real accent.
 */
const GLOW_SOURCES: Record<Provider, string> = {
  ...PROVIDER_ACCENTS,
  openai: "#10a37f",
  moonshot: "#6a5bff",
  xai: "#8ea3c0",
};

/** Hue 0-360, saturation and lightness 0-1. */
function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

/**
 * A brand colour turned into ambient light.
 *
 * A logo colour is meant to be seen at small size against a controlled
 * background, so it is picked for punch — a mark's worth of pure hue. Spread it
 * across a third of the screen as a wash and that same punch reads as a warning
 * light. What a bloom wants is a lot of hue and very little chroma: enough to
 * say "Gemini" or "Claude" without the page looking tinted by accident.
 *
 * So hue is kept exactly, saturation is cut to a bit over half and capped, and
 * lightness is pulled toward a common mid. That last part matters more than it
 * looks: fourteen brands sit anywhere from #0f0f0f to #f5a524, and without a
 * shared lightness the same effort setting would read as a whisper for one lab
 * and a floodlight for the next. Normalising it means the ladder means the same
 * thing whichever model you are talking to, and the aura's own ramp — which
 * takes lightness up at the core and down through the rim — does the rest.
 *
 * Derived rather than hand-written so the brand values above stay the single
 * source of truth; there is no second palette to drift out of step.
 */
function asAmbientLight(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  const softS = Math.min(s * 0.56, 0.5);
  // Pull two thirds of the way to the common mid, so a brand that is already
  // near it barely moves and the extremes stop being extreme.
  const softL = l + (0.52 - l) * 0.68;
  return `hsl(${h.toFixed(1)} ${(softS * 100).toFixed(1)}% ${(softL * 100).toFixed(1)}%)`;
}

export const PROVIDER_GLOWS: Record<Provider, string> = Object.fromEntries(
  Object.entries(GLOW_SOURCES).map(([k, v]) => [k, asAmbientLight(v)])
) as Record<Provider, string>;

export function providerGlow(provider: Provider): string {
  return PROVIDER_GLOWS[provider] ?? PROVIDER_GLOWS.openai;
}
