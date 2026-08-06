import type { ChatMessage, ToolSpec, Usage } from '../types.js';

/**
 * Capability descriptor reported by every provider adapter for a given model.
 * Surfaces read these flags to grey out unsupported features with a reason —
 * a feature must never be silently broken by an unsupported model.
 */
export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  computerUse: boolean;
  reasoningLevels: string[];
  maxContext: number;
  streaming: boolean;
  mcp: boolean;
}

/**
 * How much thinking the user asked for, in the surfaces' own vocabulary.
 *
 * Six tiers rather than a provider's enum, because the control the user turns
 * is one control and every lab spells it differently: Anthropic takes a
 * `thinking` block, OpenAI a top-level `reasoning_effort`, and most labs take
 * nothing at all. `ReasoningLevels` on `ModelCapabilities` says what a model
 * could be asked for; this says what it was asked for. Absent means Instant —
 * no thinking requested — and is not the same as `minimal`.
 */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}

export type ProviderStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other'; usage: Usage };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * How hard to think about this request, when the model can be asked.
   *
   * Carried on every request rather than fixed on the adapter because it is a
   * per-run choice, and an adapter is shared. An adapter whose lab has no such
   * concept must drop it silently: the alternative — refusing the request — turns
   * a preference the user expressed once into a run that cannot start at all.
   */
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderAdapter {
  id: string;
  name: string;
  defaultModel: string;
  models(): string[];
  capabilities(model: string): ModelCapabilities;
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent>;
}
