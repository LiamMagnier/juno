import { resolveModel } from "@/lib/models";
import { getModelMetrics } from "@/lib/model-metrics";

/** Above this estimate, starting Work requires an explicit second press. */
export const WORK_PREFLIGHT_CONFIRMATION_MICRO_USD = 500_000;

export interface WorkCostEstimate {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicroUsd: number;
  requiresConfirmation: boolean;
}

/**
 * Conservative, provider-neutral estimate shown before an unusually costly
 * Work run. It models four agent turns because each turn resends the growing
 * context, and reserves 10k output tokens for tool planning and synthesis. It
 * is intentionally a warning estimate, not the spend ledger: the ledger uses
 * provider-reported usage and the run's hard ceiling after dispatch.
 */
export function estimateWorkRunCost(input: {
  modelId: string;
  goalChars: number;
  attachmentChars?: number;
}): WorkCostEstimate {
  const model = resolveModel(input.modelId);
  const metrics = model ? getModelMetrics(model) : null;
  const inputUsdPerToken = metrics?.inputUsdPerMTok ?? 2;
  const outputUsdPerToken = metrics?.outputUsdPerMTok ?? 10;
  const promptTokensPerTurn = Math.max(
    2_000,
    Math.ceil(Math.max(0, input.goalChars + (input.attachmentChars ?? 0)) / 4) + 2_000
  );
  const inputTokens = promptTokensPerTurn * 4;
  const outputTokens = 10_000;
  const estimatedCostMicroUsd = Math.max(
    0,
    Math.round(inputTokens * inputUsdPerToken + outputTokens * outputUsdPerToken + 50_000)
  );

  return {
    modelId: input.modelId,
    inputTokens,
    outputTokens,
    estimatedCostMicroUsd,
    requiresConfirmation: estimatedCostMicroUsd >= WORK_PREFLIGHT_CONFIRMATION_MICRO_USD,
  };
}
