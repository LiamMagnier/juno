import Anthropic from '@anthropic-ai/sdk';
import { resolveKey } from './credentials.js';
import { classifyProviderError } from './errors.js';
import { anthropicThinkingBits } from './thinking.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.js';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
} from './types.js';
import type { ChatMessage } from '../types.js';

const MODELS: Record<string, ModelCapabilities> = {
  'claude-sonnet-5': caps({ maxContext: 200_000 }),
  'claude-opus-4-8': caps({ maxContext: 200_000 }),
  'claude-haiku-4-5-20251001': caps({ maxContext: 200_000, computerUse: false }),
};

function caps(overrides: Partial<ModelCapabilities>): ModelCapabilities {
  return {
    tools: true,
    vision: true,
    computerUse: true,
    reasoningLevels: ['standard', 'extended'],
    maxContext: 200_000,
    streaming: true,
    mcp: true,
    ...overrides,
  };
}

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'user') {
      return {
        role: 'user',
        content: m.content.map((c): Anthropic.ContentBlockParam => {
          if (c.type === 'text') return { type: 'text', text: c.text };
          if (c.type === 'image') {
            return {
              type: 'image',
              source: { type: 'base64', media_type: c.mediaType, data: c.data },
            };
          }
          return {
            type: 'tool_result',
            tool_use_id: c.toolCallId,
            content: c.content,
            is_error: c.isError ?? false,
          };
        }),
      };
    }
    return {
      role: 'assistant',
      content: m.content.map((c): Anthropic.ContentBlockParam =>
        c.type === 'text'
          ? { type: 'text', text: c.text }
          : { type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} },
      ),
    };
  });
}

/**
 * Key resolution order: explicit arg → env var → ~/.juno/credentials.json
 * ({"anthropic":{"apiKey":"…"}}). The file path covers GUI-launched sidecars,
 * which don't inherit a shell environment.
 */
export function resolveAnthropicKey(explicit?: string): string | undefined {
  return resolveKey('anthropic', 'ANTHROPIC_API_KEY', explicit);
}

/**
 * Override to point the adapter at the Juno backend proxy instead of Anthropic
 * directly: baseURL = `<host>/api/agent/<provider>` (the SDK appends
 * /v1/messages), headers carry the session Cookie, and the catalog comes from
 * the backend. The proxy swaps in the real server key.
 */
export interface AnthropicOverride {
  id?: string;
  name?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  models?: Record<string, ModelCapabilities>;
  defaultModel?: string;
  /** Wall-clock ceiling for one request. See timeouts.ts for why it is set. */
  timeoutMs?: number;
}

export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

export type BoundAnthropicThinkingParam =
  | (Extract<import('./thinking.js').AnthropicThinkingParam, { type: 'adaptive' | 'enabled' }> & {
      block_binding: { prefix_mismatch_behavior: 'drop_block' };
    })
  | Extract<import('./thinking.js').AnthropicThinkingParam, { type: 'disabled' }>;

/**
 * Ported from BackendCodeModelClient.swift (`bindingTolerant`).
 * When `thinking.type` is `adaptive` or `enabled`, adds
 * `block_binding: { prefix_mismatch_behavior: 'drop_block' }` so image pruning
 * or message compaction on earlier turns never triggers a 400 signature mismatch.
 */
export function bindingTolerantThinking(
  thinking: import('./thinking.js').AnthropicThinkingParam | undefined,
): BoundAnthropicThinkingParam | undefined {
  if (!thinking) return undefined;
  if (thinking.type === 'adaptive' || thinking.type === 'enabled') {
    return {
      ...thinking,
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    };
  }
  return thinking;
}

/**
 * Computes the request headers for an Anthropic call so `block_binding` and
 * `anthropic-beta: thinking-binding-controls-2026-08-01` always travel together.
 */
export function anthropicRequestHeadersForThinking(
  thinking: BoundAnthropicThinkingParam | { block_binding?: unknown } | undefined,
  existingHeaders?: Record<string, string>,
): Record<string, string> | undefined {
  if (!thinking || !('block_binding' in thinking) || !thinking.block_binding) {
    return existingHeaders;
  }
  const out: Record<string, string> = { ...(existingHeaders ?? {}) };
  const betaKey =
    Object.keys(out).find((k) => k.toLowerCase() === 'anthropic-beta') ??
    'anthropic-beta';
  const existingBeta = out[betaKey]?.trim();
  if (!existingBeta) {
    out[betaKey] = THINKING_BINDING_BETA;
  } else {
    const parts = existingBeta
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.includes(THINKING_BINDING_BETA)) {
      parts.push(THINKING_BINDING_BETA);
    }
    out[betaKey] = parts.join(',');
  }
  return out;
}

export class AnthropicAdapter implements ProviderAdapter {
  id = 'anthropic';
  name = 'Anthropic';
  defaultModel = 'claude-sonnet-5';
  private client: Anthropic;
  private modelCaps: Record<string, ModelCapabilities>;
  private defaultHeaders?: Record<string, string>;

  constructor(apiKey?: string, override?: AnthropicOverride) {
    this.defaultHeaders = override?.headers;
    this.client = new Anthropic({
      // In proxy mode the key is a placeholder the proxy replaces server-side.
      apiKey: override?.baseURL ? (apiKey ?? 'proxy') : resolveAnthropicKey(apiKey),
      baseURL: override?.baseURL,
      defaultHeaders: override?.headers,
      // The SDK's own default is ten minutes, which is ten minutes of a run
      // looking alive and doing nothing when a host stops answering.
      timeout: override?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    if (override?.id) this.id = override.id;
    if (override?.name) this.name = override.name;
    if (override?.defaultModel) this.defaultModel = override.defaultModel;
    this.modelCaps = override?.models ?? MODELS;
  }

  models(): string[] {
    return Object.keys(this.modelCaps);
  }

  capabilities(model: string): ModelCapabilities {
    return this.modelCaps[model] ?? caps({ computerUse: false, mcp: false });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const bits = anthropicThinkingBits(req.model, req.maxTokens ?? 8192, req.reasoningEffort);
    const thinking = bindingTolerantThinking(bits.thinking);
    const headers = anthropicRequestHeadersForThinking(thinking, this.defaultHeaders);
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: bits.maxTokens,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...(thinking ? { thinking: thinking as unknown as Anthropic.ThinkingConfigParam } : {}),
        ...(bits.outputConfig ? { output_config: bits.outputConfig } : {}),
      } as Anthropic.MessageStreamParams,
      {
        signal: req.signal,
        ...(headers ? { headers } : {}),
      },
    );

    // Classified for the same reason the OpenAI-compatible adapter classifies —
    // see providers/errors.ts. `messages.stream` defers its request, so a 429 or
    // a 529 overload surfaces from the iteration rather than from the call
    // above, and both live inside this one boundary.
    let final: Anthropic.Message;
    try {
      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text_delta', text: event.delta.text };
        } else if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'thinking_delta'
        ) {
          yield { type: 'thinking_delta', text: event.delta.thinking };
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      // A stop the user asked for is not a provider failure.
      if (req.signal?.aborted) throw err;
      throw classifyProviderError(err, this.name);
    }

    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield { type: 'tool_call', id: block.id, name: block.name, input: block.input };
      }
    }

    const stopReason =
      final.stop_reason === 'end_turn'
        ? 'end_turn'
        : final.stop_reason === 'tool_use'
          ? 'tool_use'
          : final.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'other';

    yield {
      type: 'done',
      stopReason,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
      },
    };
  }
}
