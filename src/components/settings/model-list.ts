import type { ModelInfo } from "@/lib/models";
import { PROVIDERS, type Provider } from "@/lib/providers";

/** A chat model as the settings pickers list it. */
export type PickerModel = ModelInfo;

/** The stored id of Juno's Auto routing. */
export const AUTO_MODEL_ID_SETTING = "juno:auto";

/** "Anthropic · Claude" → "Anthropic": the lab, which is what a group is headed by. */
export function providerName(provider: Provider): string {
  return PROVIDERS[provider]?.label.split(" · ")[0] ?? provider;
}

/** The chat models a picker offers, in the catalogue's display order. */
export function chatModels(models: readonly ModelInfo[]): PickerModel[] {
  return models.filter((m) => (m.modality ?? "chat") === "chat" && !m.comingSoon);
}
