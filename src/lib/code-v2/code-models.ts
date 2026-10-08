/**
 * The Code model catalogue (Code v2 SPEC §4): which catalogue models can drive
 * an agent loop, in "best for coding" order, and the contract-shaped
 * `ProviderModel` list the Alevr and BYOK provider instances offer.
 *
 * The filter is the catalogue's own answer, not a second opinion: a chat model
 * that the catalogue marks agentic (`agenticTools`), whose transport takes
 * function tools (`toolCapabilitiesFor`), that is callable today (not coming
 * soon, not retired). Image, video and audio models never appear.
 *
 * The order is curated: `CODE_MODEL_RANKING` lists the models the Code team
 * would pick for agentic coding today, best first. Everything else that passes
 * the filter follows, by the catalogue's intelligence grade and then recency.
 * A model that trains on prompts stays selectable but is never ranked into the
 * curated head, so no automatic "first in list" choice can land on it.
 */
import { hasRetired, MODEL_LIST, MODELS, resolveModel, trainsOnPrompts, type ModelInfo } from "@/lib/models";
import { getModelMetrics, reasoningCaps } from "@/lib/model-metrics";
import { toolCapabilitiesFor } from "@/lib/model-tools";
import { supportsFastMode } from "@/lib/pricing";
import type { EffortLevel, ProviderModel } from "@/lib/code-v2/contracts";
import { tiersFor } from "@/lib/code-v2/context-tiers";

/**
 * Best for agentic coding, best first. Canonical `provider:model` ids; an id
 * that leaves the catalogue simply drops out (tests pin that every entry is
 * live today).
 */
export const CODE_MODEL_RANKING: readonly string[] = [
  "anthropic:claude-opus-5-5",
  "openai:gpt-6.1-sol",
  "anthropic:claude-fable-5-1",
  "openai:gpt-6-astra",
  "anthropic:claude-sonnet-5-5",
  "google:gemini-3.8-flash",
  "xai:grok-4.7",
  "openai:gpt-5.6-terra",
  "zhipu:glm-5.3",
  "moonshot:kimi-k3",
  "deepseek:deepseek-v4-pro",
  "qwen:qwen3.8-max",
  "moonshot:kimi-k2.7-code",
  "xai:grok-build-0.1",
  "openai:gpt-6-luna",
  "openai:gpt-5.4-mini",
  "minimax:MiniMax-M3",
  "deepseek:deepseek-flash",
  "anthropic:claude-haiku-4-5",
];

const RANK = new Map(CODE_MODEL_RANKING.map((id, i) => [id, i]));

/**
 * A CURATED catalogue model for an id (aliases of retired ids migrate), or
 * null. Unlike `resolveModel` it never fabricates an entry for an id the
 * catalogue has not met, and never answers for Auto: a Code selection or a
 * context tier must name a model whose window and price are actually known.
 */
export function catalogModel(id: string): ModelInfo | null {
  const m = resolveModel(id);
  return m && MODELS[m.id] === m ? m : null;
}

/** Whether the model can drive a Code agent loop at all. */
export function isCodeAgentModel(model: ModelInfo): boolean {
  if (model.modality !== "chat") return false;
  if (!model.agenticTools) return false;
  if (model.comingSoon) return false;
  if (hasRetired(model)) return false;
  return toolCapabilitiesFor(model).supported;
}

/** Position in the curated ranking, or null when the model is not in it. */
export function codeRank(model: Pick<ModelInfo, "id">): number | null {
  return RANK.get(model.id) ?? null;
}

export interface CodeModelOptions {
  /** Include legacy and deprecated rows (the picker's "Older models"). Default false. */
  includeLegacy?: boolean;
}

/** Comparator: curated rank, then intelligence (desc), then release (newest first), then name. */
export function compareForCoding(a: ModelInfo, b: ModelInfo): number {
  const ra = trainsOnPrompts(a) ? null : codeRank(a);
  const rb = trainsOnPrompts(b) ? null : codeRank(b);
  if (ra !== null || rb !== null) {
    if (ra === null) return 1;
    if (rb === null) return -1;
    return ra - rb;
  }
  const ia = getModelMetrics(a).intelligence;
  const ib = getModelMetrics(b).intelligence;
  if (ia !== ib) return ib - ia;
  const da = a.released ?? "";
  const db = b.released ?? "";
  if (da !== db) return db.localeCompare(da);
  return a.name.localeCompare(b.name);
}

/** Agentic coding models, best for coding first. */
export function codeModels(models: readonly ModelInfo[] = MODEL_LIST, options: CodeModelOptions = {}): ModelInfo[] {
  return models
    .filter(isCodeAgentModel)
    .filter((m) => options.includeLegacy || (m.status ?? "current") === "current")
    .sort(compareForCoding);
}

const EFFORTS: readonly EffortLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The model's effort ladder in contract vocabulary (`none` when thinking can be turned off). */
export function codeEffortLevels(model: ModelInfo): { levels: EffortLevel[]; defaultEffort?: EffortLevel } {
  const caps = reasoningCaps(model);
  const levels: EffortLevel[] = [];
  if (caps.canDisable && model.reasoning) levels.push("none");
  for (const t of caps.tiers) if ((EFFORTS as readonly string[]).includes(t)) levels.push(t as EffortLevel);
  const defaultEffort = caps.defaultLevel && (EFFORTS as readonly string[]).includes(caps.defaultLevel) ? (caps.defaultLevel as EffortLevel) : undefined;
  return { levels, ...(model.reasoning && defaultEffort ? { defaultEffort } : {}) };
}

/**
 * The models an Alevr-engine instance (`alevr`, or `byok:<provider>` limited
 * to that provider) offers, in contract shape. The first is the default.
 */
export function codeProviderModels(
  models: readonly ModelInfo[] = MODEL_LIST,
  options: CodeModelOptions & { provider?: ModelInfo["provider"]; at?: Date | number } = {},
): ProviderModel[] {
  const list = codeModels(models, options).filter((m) => !options.provider || m.provider === options.provider);
  return list.map((m, i) => {
    const effort = codeEffortLevels(m);
    const out: ProviderModel = {
      id: m.id,
      label: m.name,
      contextTiers: tiersFor(m, options.at),
      ...(effort.levels.length ? { effortLevels: effort.levels } : {}),
      ...(effort.defaultEffort ? { defaultEffort: effort.defaultEffort } : {}),
      ...(supportsFastMode(m) ? { supportsFast: true } : {}),
      ...(i === 0 ? { isDefault: true } : {}),
    };
    return out;
  });
}
