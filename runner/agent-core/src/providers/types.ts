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
}

export interface ProviderAdapter {
  id: string;
  name: string;
  defaultModel: string;
  models(): string[];
  capabilities(model: string): ModelCapabilities;
  stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent>;
}
