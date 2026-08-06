/**
 * Which thinking parameters each Claude model actually accepts.
 *
 * This is a deliberate second copy of the website's `src/lib/anthropic-thinking.ts`,
 * which stays the source of truth. The copy exists for the same reason the rest
 * of this package is vendored: agent-core is built with the repository absent —
 * the Mac app and the cloud runner both compile it standalone — so it cannot
 * import from `src/`, and the Anthropic adapter that lives here is the one that
 * has to put the parameter on the wire. Re-sync this file whenever that one
 * changes; the shapes below are the part that 400s when it drifts.
 *
 * The distinction the matrix encodes is not cosmetic. `thinking: {type:'enabled',
 * budget_tokens}` is rejected outright by the adaptive-era models (Fable,
 * Mythos, Opus 4.7/4.8, Sonnet 5) and `thinking: {type:'adaptive'}` is rejected
 * by the older ones (Haiku 4.5, Opus 4.5, Sonnet 4.5). Sending the wrong one is
 * a hard 400 before a single token, which is precisely the failure this whole
 * change set exists to stop shipping.
 */

import type { ReasoningEffort } from './types.js';

/** Wire effort values Anthropic accepts. It has no `minimal`. */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AnthropicThinkingParam =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' };

export interface AnthropicThinkingBits {
  maxTokens: number;
  thinking?: AnthropicThinkingParam;
  outputConfig?: { effort: AnthropicEffort };
}

/** Soft `max_tokens` headroom so adaptive thinking has room to run. */
const ADAPTIVE_HEADROOM: Record<ReasoningEffort, number> = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 32000,
  xhigh: 48000,
  max: 56000,
};

/** Manual extended-thinking `budget_tokens` per tier. */
const MANUAL_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16000,
  xhigh: 24000,
  max: 32000,
};

function isManual(providerModel: string): boolean {
  const id = providerModel.toLowerCase();
  // Manual-only families are matched first: several of their ids also contain
  // substrings the adaptive test below would claim.
  if (id.includes('haiku')) return true;
  if (id.includes('opus-4-5') || id.includes('sonnet-4-5')) return true;
  if (id.includes('opus-4-1') || /claude-3/.test(id)) return true;
  // Everything else, including Claude ids this build has never heard of, is
  // treated as adaptive: manual is the shape that 400s on new models, so an
  // unknown id is safer guessed forward than backward.
  return false;
}

/** Adaptive thinking cannot be switched off on these; `disabled` is rejected. */
function adaptiveAlwaysOn(providerModel: string): boolean {
  const id = providerModel.toLowerCase();
  return id.includes('fable') || id.includes('mythos');
}

/** Adaptive is the default when `thinking` is omitted, so Instant must say so. */
function adaptiveDefaultOn(providerModel: string): boolean {
  return providerModel.toLowerCase().includes('sonnet-5');
}

/** Newest adaptive models omit the thinking text unless asked for a summary. */
function needsSummarizedDisplay(providerModel: string): boolean {
  const id = providerModel.toLowerCase();
  return (
    id.includes('fable') ||
    id.includes('mythos') ||
    id.includes('opus-4-8') ||
    id.includes('opus-4-7') ||
    id.includes('sonnet-5')
  );
}

function toAnthropicEffort(effort: ReasoningEffort): AnthropicEffort {
  return effort === 'minimal' ? 'low' : effort;
}

/**
 * The `max_tokens`, `thinking` and `output_config` for one request.
 *
 * `reasoningEffort` absent means the user chose Instant, which is a real choice
 * and not an omission — hence the explicit `{type:'disabled'}` on the models
 * that would otherwise think by default.
 */
export function anthropicThinkingBits(
  providerModel: string,
  maxTokens: number,
  reasoningEffort?: ReasoningEffort,
): AnthropicThinkingBits {
  const id = providerModel.toLowerCase();
  const manual = isManual(providerModel);
  // 128k output on the adaptive-era models; 64k on Haiku/4.5; 32k on legacy.
  const outputCap = /opus-4-1|claude-3/.test(id) ? 32000 : manual ? 64000 : 128000;

  if (!manual) {
    if (!reasoningEffort && !adaptiveAlwaysOn(providerModel)) {
      return adaptiveDefaultOn(providerModel)
        ? { maxTokens: Math.min(maxTokens, outputCap), thinking: { type: 'disabled' } }
        : { maxTokens: Math.min(maxTokens, outputCap) };
    }
    const effort = toAnthropicEffort(reasoningEffort ?? 'high');
    const headroom = ADAPTIVE_HEADROOM[reasoningEffort ?? 'high'];
    return {
      maxTokens: Math.min(maxTokens + headroom, outputCap),
      thinking: {
        type: 'adaptive',
        ...(needsSummarizedDisplay(providerModel) ? { display: 'summarized' as const } : {}),
      },
      outputConfig: { effort },
    };
  }

  if (!reasoningEffort) return { maxTokens: Math.min(maxTokens, outputCap) };

  const requested = MANUAL_BUDGET[reasoningEffort];
  const total = Math.min(requested + maxTokens, outputCap);
  // The budget must be below `max_tokens` and at least 1024, and a quarter of
  // the window is kept back for the answer — a run that thinks its whole
  // allowance and emits nothing has produced no deliverable at all.
  const budget = Math.max(1024, Math.min(requested, total - Math.ceil(total / 4)));
  return { maxTokens: total, thinking: { type: 'enabled', budget_tokens: budget } };
}
