import Anthropic from '@anthropic-ai/sdk';
import { resolveKey } from './credentials.js';
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
        content: m.content.map((c): Anthropic.ContentBlockParam =>
          c.type === 'text'
            ? { type: 'text', text: c.text }
            : {
                type: 'tool_result',
                tool_use_id: c.toolCallId,
                content: c.content,
                is_error: c.isError ?? false,
              },
        ),
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

export class AnthropicAdapter implements ProviderAdapter {
  id = 'anthropic';
  name = 'Anthropic';
  defaultModel = 'claude-sonnet-5';
  private client: Anthropic;
  private modelCaps: Record<string, ModelCapabilities>;

  constructor(apiKey?: string, override?: AnthropicOverride) {
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
    // `max_tokens` comes back out of the matrix rather than going straight
    // through: extended thinking is billed against the same ceiling as the
    // answer, so a budget granted without headroom is a model that thinks its
    // whole allowance and returns an empty message.
    const bits = anthropicThinkingBits(req.model, req.maxTokens ?? 8192, req.reasoningEffort);
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
        ...(bits.thinking ? { thinking: bits.thinking as Anthropic.ThinkingConfigParam } : {}),
        // `output_config` rides alongside adaptive thinking and is not in the
        // SDK's typed params on every version, so it goes through the same
        // untyped door the website's own client uses.
        ...(bits.outputConfig ? { output_config: bits.outputConfig } : {}),
      } as Anthropic.MessageStreamParams,
      { signal: req.signal },
    );

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

    const final = await stream.finalMessage();
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
