import type { Provider } from "@/lib/providers";

export const PROVIDER_ACCENTS: Record<Provider, string> = {
  anthropic: "#d97859",
  openai: "#111111",
  google: "#4285f4",
  zhipu: "#2f66ff",
  moonshot: "#111827",
  deepseek: "#4f7cff",
  mistral: "#ff8a00",
  xai: "#0f0f0f",
  seedance: "#7c3aed",
};

export function providerAccent(provider: Provider): string {
  return PROVIDER_ACCENTS[provider] ?? PROVIDER_ACCENTS.openai;
}
