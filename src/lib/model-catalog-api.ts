import { discoverModels } from "@/lib/model-discovery";
import { getModelMetrics } from "@/lib/model-metrics";
import { GEN_MODELS, type ModelInfo } from "@/lib/models";
import { configuredProviders, PROVIDERS } from "@/lib/providers";
import { isVideoGenSupported } from "@/lib/video-gen";

// The native manifest builder lives in its own module because this one reaches
// for `model-discovery`, which is server-only — the manifest shape itself is
// pure and must stay directly testable.
export { nativeModelCatalog } from "@/lib/native-model-manifest";

export async function loadAvailableModels(): Promise<ModelInfo[]> {
  const configured = new Set(configuredProviders());
  const chat = await discoverModels();
  const generated = GEN_MODELS.filter((model) => configured.has(model.provider) && (model.modality !== "video" || isVideoGenSupported(model)));
  const byId = new Map<string, ModelInfo>();
  for (const model of [...chat, ...generated]) byId.set(model.id, model);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The backend model catalog in the shape `@juno/agent-core`'s proxy provider
 * expects (BackendConfig.models — see runner/agent-core/src/providers/proxy.ts).
 * Built from the SAME server source the Mac app consumes (loadAvailableModels),
 * so the cloud runner and the native host bill/route identically.
 *
 * `provider` is the path segment under /api/agent; `model` is the id sent to the
 * provider API. Chat models only, and never Responses-only entries (the proxy
 * provider speaks /chat/completions or /v1/messages, not the Responses API).
 */
export interface BackendAgentModel {
  provider: string;
  providerName: string;
  kind: "anthropic" | "openai";
  model: string;
  label: string;
  available: boolean;
  vision: boolean;
  contextWindow: number;
}

export function backendAgentCatalog(models: ModelInfo[]): BackendAgentModel[] {
  return models
    .filter((model) => model.modality === "chat" && model.api !== "responses" && !model.comingSoon)
    .map((model) => {
      const metrics = getModelMetrics(model);
      return {
        provider: model.provider,
        providerName: PROVIDERS[model.provider].label,
        kind: PROVIDERS[model.provider].kind,
        model: model.providerModel,
        label: model.name,
        // loadAvailableModels only returns models from configured providers, so
        // every chat entry here is callable through the proxy.
        available: true,
        vision: model.vision,
        contextWindow: model.contextWindow ?? metrics.contextTokens,
      };
    });
}
