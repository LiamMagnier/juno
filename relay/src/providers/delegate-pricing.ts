import type { VoiceReasoningEffort } from "../protocol.js";

/**
 * GPT-Live bills its voice layer per minute and the backend it delegates to
 * (GPT-6.1 Sol, with hosted web search) separately — and the relay's estimate
 * covered the voice layer alone, so every delegated turn was the operator's.
 *
 * Sol: $2/M input, $10/M output incl. reasoning; web search $10 per 1,000
 * calls (Juno's catalog, src/lib/pricing.ts, and OpenAI's tool pricing). A
 * delegated turn is charged THIS estimate when `session.delegation.created`
 * arrives — ~8k input tokens of conversation and instructions, reasoning
 * output scaled by effort, one search — and topped up if a Responses usage
 * report later says it cost more. Never reduced: an estimate above the truth
 * is the safe error.
 */
const DELEGATE_OUTPUT_TOKENS: Record<VoiceReasoningEffort, number> = { low: 1_500, medium: 3_000, high: 6_000, xhigh: 12_000 };

export function gptLiveDelegationEstimateUsd(effort: VoiceReasoningEffort, webSearch: boolean): number {
  return (8_000 * 2 + DELEGATE_OUTPUT_TOKENS[effort] * 10) / 1_000_000 + (webSearch ? 0.01 : 0);
}

/** A Responses `usage` (+ web_search calls) priced at Sol's rates, USD. */
export function gptLiveDelegationUsageUsd(
  usage: { input_tokens?: number; output_tokens?: number } | null | undefined,
  webSearchCalls = 0
): number | null {
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return null;
  return ((usage.input_tokens ?? 0) * 2 + (usage.output_tokens ?? 0) * 10) / 1_000_000 + webSearchCalls * 0.01;
}

