import type { ReasoningCaps, ReasoningTier } from "@/lib/model-metrics";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";

export type ReasoningControlType = "none" | "automatic" | "on_off" | "enum" | "numeric_budget" | "adaptive";
export type ReasoningVerificationMethod = "official_docs" | "live_probe" | "both";

export type ModelReasoningCapability = {
  canonicalId: string;
  provider: ModelInfo["provider"];
  providerModel: string;
  supported: boolean;
  controlType: ReasoningControlType;
  tiers: ReasoningTier[];
  providerValues: Array<string | number | boolean>;
  defaultLevel: ReasoningCaps["defaultLevel"];
  canDisable: boolean;
  parameter: string | null;
  tierMapping: Partial<Record<ReasoningTier | "instant" | "thinking", string | number | boolean>>;
  apiSurface: string;
  officialDocs: string;
  verifiedAt: string;
  method: ReasoningVerificationMethod;
};

export const OFFICIAL_REASONING_DOCS: Partial<Record<ModelInfo["provider"], string>> = {
  anthropic: "https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking",
  openai: "https://platform.openai.com/docs/guides/reasoning",
  google: "https://ai.google.dev/gemini-api/docs/thinking",
  xai: "https://docs.x.ai/docs/guides/reasoning",
  mistral: "https://docs.mistral.ai/capabilities/reasoning/",
  deepseek: "https://api-docs.deepseek.com/guides/thinking_mode",
  zhipu: "https://docs.z.ai/guides/capabilities/thinking-mode",
  moonshot: "https://platform.moonshot.ai/docs/guide/use-kimi-k2-thinking-model",
  minimax: "https://platform.minimax.io/docs/api-reference/text-openai-api",
  meta: "https://ai.meta.com/resources/models-and-libraries/",
  qwen: "https://www.alibabacloud.com/help/en/model-studio/deep-thinking",
  mimo: "https://platform.xiaomimimo.com/#/docs/api/text-generation",
  longcat: "https://longcat.chat/platform/docs",
};

const LIVE_PROBED = new Set<ModelInfo["provider"]>([
  "openai", "google", "mistral", "deepseek", "zhipu", "moonshot", "qwen",
]);

function wireContract(model: ModelInfo, caps: ReasoningCaps) {
  const id = model.providerModel.toLowerCase();
  if (!model.reasoning) return { controlType: "none" as const, parameter: null, apiSurface: model.api ?? "chat" };
  if (model.provider === "anthropic") {
    const adaptive = !id.includes("4-5") && !id.includes("haiku");
    return {
      controlType: adaptive ? "adaptive" as const : caps.onOff ? "on_off" as const : "numeric_budget" as const,
      parameter: adaptive ? "thinking.type + output_config.effort" : "thinking.type + thinking.budget_tokens",
      apiSurface: "Anthropic Messages API",
    };
  }
  if (model.provider === "google") {
    return {
      controlType: caps.tiers.length ? "enum" as const : "automatic" as const,
      parameter: id.includes("2.5") ? "generationConfig.thinkingConfig.thinkingBudget" : "generationConfig.thinkingConfig.thinkingLevel",
      apiSurface: "Gemini generateContent",
    };
  }
  if (model.provider === "qwen") {
    return {
      controlType: caps.tiers.length ? "numeric_budget" as const : caps.canDisable ? "on_off" as const : "automatic" as const,
      parameter: "enable_thinking + thinking_budget",
      apiSurface: "DashScope OpenAI-compatible chat",
    };
  }
  const objectToggle = ["zhipu", "minimax", "mimo", "longcat"].includes(model.provider)
    || (model.provider === "moonshot" && !id.includes("k3"));
  return {
    controlType: caps.onOff ? "on_off" as const : caps.tiers.length ? "enum" as const : "automatic" as const,
    parameter: objectToggle ? "thinking.type" : caps.tiers.length || caps.canDisable ? "reasoning_effort" : null,
    apiSurface: model.api === "responses" ? "OpenAI Responses-compatible" : "OpenAI chat-compatible",
  };
}

function providerValue(tier: ReasoningTier): string | number {
  return tier;
}

/** Machine-readable provider contract for one selectable model. */
export function reasoningCapabilityForModel(model: ModelInfo): ModelReasoningCapability {
  const caps = reasoningCaps(model);
  const wire = wireContract(model, caps);
  const tierMapping: ModelReasoningCapability["tierMapping"] = Object.fromEntries(
    caps.tiers.map((tier) => [tier, providerValue(tier)]),
  );
  if (caps.canDisable) tierMapping.instant = wire.parameter === "thinking.type" ? "disabled" : false;
  if (caps.onOff) tierMapping.thinking = wire.parameter === "thinking.type" ? "enabled" : true;
  return {
    canonicalId: model.id,
    provider: model.provider,
    providerModel: model.providerModel,
    supported: model.reasoning,
    controlType: wire.controlType,
    tiers: [...caps.tiers],
    providerValues: caps.onOff
      ? [caps.canDisable ? "disabled" : "enabled", "enabled"]
      : caps.tiers.map(providerValue),
    defaultLevel: caps.defaultLevel,
    canDisable: caps.canDisable,
    parameter: wire.parameter,
    tierMapping,
    apiSurface: wire.apiSurface,
    officialDocs: OFFICIAL_REASONING_DOCS[model.provider] ?? "",
    verifiedAt: "2026-08-21",
    method: LIVE_PROBED.has(model.provider) ? "both" : "official_docs",
  };
}

export function buildReasoningCapabilityRegistry(models: ModelInfo[]): Record<string, ModelReasoningCapability> {
  return Object.fromEntries(models.map((model) => [model.id, reasoningCapabilityForModel(model)]));
}
