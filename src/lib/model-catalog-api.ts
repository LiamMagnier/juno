import { createHash } from "node:crypto";
import { discoverModels } from "@/lib/model-discovery";
import { getModelMetrics, reasoningCaps, supportsProMode } from "@/lib/model-metrics";
import { GEN_MODELS, type ModelInfo } from "@/lib/models";
import { configuredProviders, PROVIDERS } from "@/lib/providers";
import { isVideoGenSupported } from "@/lib/video-gen";

export async function loadAvailableModels(): Promise<ModelInfo[]> {
  const configured = new Set(configuredProviders());
  const chat = await discoverModels();
  const generated = GEN_MODELS.filter((model) => configured.has(model.provider) && (model.modality !== "video" || isVideoGenSupported(model)));
  const byId = new Map<string, ModelInfo>();
  for (const model of [...chat, ...generated]) byId.set(model.id, model);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function nativeModelCatalog(models: ModelInfo[]) {
  const payload = models.map((model) => {
    const metrics = getModelMetrics(model);
    const reasoning = reasoningCaps(model);
    return {
      id: model.id,
      provider: { id: model.provider, displayName: PROVIDERS[model.provider].label },
      displayName: model.name,
      description: model.description ?? null,
      lifecycle: model.status === "deprecated" ? "deprecated" : model.status === "legacy" ? "legacy" : "active",
      availability: model.comingSoon ? "coming_soon" : "available",
      minimumPlan: model.minPlan.toLowerCase(),
      modalities: {
        input: model.vision ? ["text", "image"] : ["text"],
        output: [model.modality === "chat" ? "text" : model.modality],
      },
      contextWindowTokens: metrics.contextTokens,
      pricing: {
        class: model.cost === 3 ? "premium" : model.cost === 2 ? "standard" : "economy",
        inputPerMillion: metrics.inputUsdPerMTok,
        outputPerMillion: metrics.outputUsdPerMTok,
        currency: "USD",
        source: metrics.source,
      },
      supportedReasoningEfforts: reasoning.tiers,
      reasoning: {
        supported: model.reasoning,
        canDisable: reasoning.canDisable,
        onOffOnly: reasoning.onOff,
        supportsProMode: supportsProMode(model),
      },
      capabilities: {
        tools: model.modality === "chat",
        webSearch: model.webSearch,
        attachments: model.modality === "chat" || model.vision,
        streaming: model.modality === "chat",
      },
      deprecationNote: model.deprecationNote ?? null,
    };
  });
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { manifestVersion: `v1-${digest.slice(0, 16)}`, contractDigest: digest, models: payload };
}
