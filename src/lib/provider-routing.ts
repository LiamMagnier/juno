import type { ModelInfo } from "@/lib/models";
import { toolCapabilitiesFor } from "@/lib/model-tools";

/** The concrete transport used for one model request. */
export type ProviderAdapter =
  | "anthropic-native"
  | "gemini-native"
  | "openai-responses"
  /** The Responses adapter pointed at `api.x.ai/v1`, in xAI's dialect (SPEC §5.5). */
  | "xai-responses"
  | "openai-compatible";

/**
 * Whether every OpenAI model goes through the Responses API.
 *
 * On unless `OPENAI_RESPONSES=0`. The escape hatch is for a deployment whose
 * `OPENAI_BASE_URL` points at a proxy that only speaks `/chat/completions`:
 * there only the Responses-only snapshots and Pro mode keep the Responses
 * route, which is the routing this replaced (SPEC §5.0, O-32).
 */
export function openAIResponsesEnabled(): boolean {
  return process.env.OPENAI_RESPONSES !== "0";
}

/**
 * Resolve transport from the effective model, never from a default provider.
 * Kept pure so routing every lab through its intended API is regression-tested
 * without credentials or a live provider request.
 *
 * EVERY OPENAI MODEL IS A RESPONSES MODEL. GPT-6 Astra cannot call a tool on
 * `/chat/completions` at all, and GPT-6 Sol/Luna and the GPT-5.6 line only at
 * effort "none", so a tooled turn on the old route was a 400 at any real
 * thinking level (gap-provider §0.1). Grok follows for its own reason: xAI
 * retired Live Search on Chat Completions (410 since 2026-01-12), and its
 * server-side search exists only on Responses. A Grok model whose capability
 * record says it is not served there (an unconfirmed slug) stays on compat.
 *
 * `id` and `tools` are optional so callers that only know the provider keep
 * compiling; without an id a model is routed on its lab's capabilities.
 */
export function providerAdapterFor(
  model: Pick<ModelInfo, "provider" | "api"> & Partial<Pick<ModelInfo, "id" | "tools">>,
  proMode = false,
): ProviderAdapter {
  if (model.provider === "anthropic") return "anthropic-native";
  if (model.provider === "google") return "gemini-native";
  if (model.provider === "openai") {
    return openAIResponsesEnabled() || model.api === "responses" || proMode ? "openai-responses" : "openai-compatible";
  }
  if (model.provider === "xai") {
    const caps = toolCapabilitiesFor({ provider: "xai", id: model.id ?? "", api: model.api, tools: model.tools });
    if (caps.responses) return "xai-responses";
  }
  return "openai-compatible";
}
