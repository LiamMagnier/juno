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
