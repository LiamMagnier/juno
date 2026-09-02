import type { ModelInfo } from "@/lib/models";

/** The concrete transport used for one model request. */
export type ProviderAdapter =
  | "anthropic-native"
  | "gemini-native"
  | "openai-responses"
  | "openai-compatible";

/**
 * Resolve transport from the effective model, never from a default provider.
 * Kept pure so routing every lab through its intended API is regression-tested
 * without credentials or a live provider request.
 */
export function providerAdapterFor(
  model: Pick<ModelInfo, "provider" | "api">,
  proMode = false,
): ProviderAdapter {
  if (model.provider === "anthropic") return "anthropic-native";
  if (model.provider === "google") return "gemini-native";
  if (model.provider === "openai" && (model.api === "responses" || proMode)) {
    return "openai-responses";
  }
  return "openai-compatible";
}
