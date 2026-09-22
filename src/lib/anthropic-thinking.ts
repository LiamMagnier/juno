/**
 * Per-model Anthropic extended-thinking wire config.
 *
 * Source of truth for which Claude models take adaptive + output_config.effort
 * vs type:enabled + budget_tokens. Keep in sync with Anthropic's adaptive /
 * extended-thinking docs — wrong shape is a hard 400 from the API.
 *
 * Pure (no server-only) so unit tests can lock the matrix.
 */
import type { ReasoningEffort } from "@/types/chat";

/**
 * - **adaptive** — `thinking: { type: "adaptive" }` + `output_config.effort`.
 *   `type: "enabled"` + `budget_tokens` is rejected (400) on Fable/Mythos/Opus
 *   5.5/4.8/4.7/Sonnet 5, and deprecated on Opus 4.6 / Sonnet 4.6.
 * - **manual** — `thinking: { type: "enabled", budget_tokens }`. Adaptive is
 *   not supported (Haiku 4.5, Opus 4.5, Sonnet 4.5, earlier).
 */
export type AnthropicThinkingKind = "adaptive" | "manual";

/** Wire effort values Anthropic accepts (no `minimal`). */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingParam =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budget_tokens: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

export interface AnthropicThinkingBits {
  maxTokens: number;
  thinking?: AnthropicThinkingParam;
  outputConfig?: { effort: AnthropicEffort };
}

export function anthropicThinkingKind(providerModel: string): AnthropicThinkingKind {
  const id = providerModel.toLowerCase();
  // Manual-only families — match before broader adaptive patterns.
  if (id.includes("haiku")) return "manual";
  if (id.includes("opus-4-5") || id.includes("sonnet-4-5")) return "manual";
  if (id.includes("opus-4-1") || /claude-3/.test(id)) return "manual";
  // Adaptive-required: fable, mythos, opus-4-8, opus-4-7, sonnet-5.
  // Adaptive-preferred (enabled deprecated): opus-4-6, sonnet-4-6.
  if (
    id.includes("fable") ||
    id.includes("mythos") ||
    id.includes("opus-4-8") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4-6") ||
    id.includes("sonnet-5") || // claude-sonnet-5 only (not sonnet-4-5)
    id.includes("sonnet-4-6")
  ) {
    return "adaptive";
  }
  // Unknown future Claude ids: prefer adaptive (manual 400s on new models).
  return "adaptive";
}

/**
 * Adaptive thinking is always on; `disabled` is rejected — Fable / Mythos,
 * and Opus 5.5, whose launch made `{type: "disabled"}` a 400
 * ("thinking.type.disabled is not supported for this model"). Opus 5 still
 * accepts it, hence the exact `opus-5-5` rather than `opus-5`.
 */
export function adaptiveAlwaysOn(providerModel: string): boolean {
  const id = providerModel.toLowerCase();
  return id.includes("fable") || id.includes("mythos") || id.includes("opus-5-5");
}

/**
 * The effort an always-on model runs at when the caller asked for none —
 * the API's own default, so omitting a tier never silently costs more than
 * the provider would have charged. Opus 5.5 defaults to `medium`; Fable and
 * Mythos to `high`.
 */
function alwaysOnDefaultEffort(providerModel: string): ReasoningEffort {
  return providerModel.toLowerCase().includes("opus-5-5") ? "medium" : "high";
}

/**
 * Adaptive is the default when `thinking` is omitted (Sonnet 5). Instant
 * therefore requires an explicit `{ type: "disabled" }`.
 */
export function adaptiveDefaultOn(providerModel: string): boolean {
  return providerModel.toLowerCase().includes("sonnet-5");
}

/**
 * Newest adaptive models default `display` to `"omitted"` (empty thinking
 * field). Opt into `"summarized"` so the UI can stream reasoning text.
 */
export function needsSummarizedDisplay(providerModel: string): boolean {
  const id = providerModel.toLowerCase();
  return (
    id.includes("fable") ||
    id.includes("mythos") ||
    id.includes("opus-5") || // claude-opus-5 and claude-opus-5-5 alike
    id.includes("opus-4-8") ||
    id.includes("opus-4-7") ||
    id.includes("sonnet-5")
  );
}

function mapAnthropicEffort(effort: ReasoningEffort): AnthropicEffort {
  // Anthropic has no `minimal` effort level.
  if (effort === "minimal") return "low";
  return effort;
}

/** Soft max_tokens headroom so adaptive thinking has room to run. */
const ADAPTIVE_HEADROOM: Record<ReasoningEffort, number> = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 32000,
  xhigh: 48000,
  max: 56000,
};

/** Manual extended-thinking budget_tokens per effort tier. */
const MANUAL_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16000,
  xhigh: 24000,
  max: 32000,
};

/**
 * Build the per-model thinking + effort params so requests never 400 with
 * `"thinking.type.enabled" is not supported`.
 */
export function buildAnthropicThinkingBits(
  providerModel: string,
  maxTokens: number,
  reasoningEffort?: ReasoningEffort
): AnthropicThinkingBits {
  const kind = anthropicThinkingKind(providerModel);
  const id = providerModel.toLowerCase();
  // 128k output on adaptive-era models; 64k on Haiku/4.5; 32k on legacy.
  const outputCap = /opus-4-1|claude-3/.test(id)
    ? 32000
    : kind === "adaptive"
      ? 128000
      : 64000;

  if (kind === "adaptive") {
    const wantThinking = !!reasoningEffort || adaptiveAlwaysOn(providerModel);
    if (!wantThinking) {
      // Sonnet 5 defaults adaptive ON when thinking is omitted — Instant must
      // disable explicitly. Opus 4.7/4.8 default OFF when omitted.
      if (adaptiveDefaultOn(providerModel)) {
        return { maxTokens: Math.min(maxTokens, outputCap), thinking: { type: "disabled" } };
      }
      return { maxTokens: Math.min(maxTokens, outputCap) };
    }
    // Reached with no tier only on an always-on model (see wantThinking).
    const tier = reasoningEffort ?? alwaysOnDefaultEffort(providerModel);
    const effort = mapAnthropicEffort(tier);
    const headroom = ADAPTIVE_HEADROOM[tier];
    const total = Math.min(maxTokens + headroom, outputCap);
    const thinking: AnthropicThinkingParam = {
      type: "adaptive",
      ...(needsSummarizedDisplay(providerModel) ? { display: "summarized" as const } : {}),
    };
    return {
      maxTokens: total,
      thinking,
      outputConfig: { effort },
    };
  }

  // Manual budget_tokens path (Haiku 4.5, Opus 4.5, Sonnet 4.5, earlier).
  if (!reasoningEffort) {
    return { maxTokens: Math.min(maxTokens, outputCap) };
  }
  const requestedBudget = MANUAL_BUDGET[reasoningEffort];
  const totalTokens = Math.min(requestedBudget + maxTokens, outputCap);
  // budget must be < max_tokens and ≥ 1024; reserve ≥¼ of the window for the answer.
  const budget = Math.max(1024, Math.min(requestedBudget, totalTokens - Math.ceil(totalTokens / 4)));
  return {
    maxTokens: totalTokens,
    thinking: { type: "enabled", budget_tokens: budget },
  };
}
