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
export const PROVIDER_GLOWS: Record<Provider, string> = {
  ...PROVIDER_ACCENTS,
  openai: "#10a37f",
  moonshot: "#6a5bff",
  xai: "#8ea3c0",
};

export function providerGlow(provider: Provider): string {
  return PROVIDER_GLOWS[provider] ?? PROVIDER_GLOWS.openai;
}
