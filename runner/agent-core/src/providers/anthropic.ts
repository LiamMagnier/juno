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

/**
 * The transcript in Anthropic's shape.
 *
 * Reasoning blocks go back exactly as they streamed, in their place in the
 * turn, but only to the model that wrote them and only on a request that has
 * thinking switched on. A signature is bound to one model and one prefix: sent
 * to another model it is a 400 at worst and noise at best, and a request with
 * thinking off has no use for it. Dropping is always safe — the
 * `drop_block` binding (see `bindingTolerantThinking`) already tolerates a
 * missing or mismatched block — while keeping them is what lets a model on its
 * fortieth tool step still read why it started down this path.
 */
function toAnthropicMessages(
  messages: ChatMessage[],
  replay: { model: string; thinking: boolean },
): Anthropic.MessageParam[] {
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
    const content: Anthropic.ContentBlockParam[] = [];
    for (const c of m.content) {
      if (c.type === 'text') {
        if (c.text) content.push({ type: 'text', text: c.text });
      } else if (c.type === 'tool_call') {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
      } else if (replay.thinking && c.model === replay.model) {
        content.push(
          c.type === 'thinking'
            ? { type: 'thinking', thinking: c.thinking, signature: c.signature }
            : { type: 'redacted_thinking', data: c.data },
        );
      }
    }
    return { role: 'assistant', content };
  });
}

const EPHEMERAL: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

type CacheableBlock = Anthropic.ContentBlockParam & { cache_control?: Anthropic.CacheControlEphemeral | null };

/** Put a breakpoint on the last block of `message` that can carry one.
 *  Thinking blocks cannot; everything a user message holds can. */
function markLastCacheable(message: Anthropic.MessageParam | undefined): void {
  if (!message) return;
  if (typeof message.content === 'string') {
    if (message.content) message.content = [{ type: 'text', text: message.content, cache_control: EPHEMERAL }];
    return;
  }
  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index] as CacheableBlock;
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'text' && !block.text) continue;
    block.cache_control = EPHEMERAL;
    return;
  }
}

/**
 * The two rolling cache breakpoints on a conversation.
 *
 * The newest block writes the whole prefix, so the next request reads it. The
 * second sits where the previous request put its newest one — the last block
 * of the user message before the latest assistant turn — because the cache
 * looks back only about twenty blocks from a breakpoint for an earlier write:
 * a step with ten parallel tool calls adds twenty blocks on its own, and with
 * one rolling breakpoint the next request would miss the entry the last one
 * paid 1.25x to write. With the tools and the system prompt that is four, the
 * most a request may carry.
 */
function markConversationBreakpoints(messages: Anthropic.MessageParam[]): void {
  const last = messages.length - 1;
  if (last < 0) return;
  markLastCacheable(messages[last]);
  for (let index = last - 1; index > 0; index--) {
    if (messages[index]!.role !== 'assistant') continue;
    if (messages[index - 1]!.role === 'user') markLastCacheable(messages[index - 1]);
    return;
  }
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
  /** The base URL is Juno's `/api/agent` proxy, whose own 402 is the person's
   *  plan limit rather than a lab out of credit. See providers/errors.ts. */
  viaJunoProxy?: boolean;
  /** The transport, for a host that has its own; tests replay recorded
   *  streams through it. Defaults to the global `fetch`. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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
  private readonly viaJunoProxy: boolean;

  constructor(apiKey?: string, override?: AnthropicOverride) {
    this.defaultHeaders = override?.headers;
    this.viaJunoProxy = override?.viaJunoProxy === true;
    this.client = new Anthropic({
      // In proxy mode the key is a placeholder the proxy replaces server-side.
      apiKey: override?.baseURL ? (apiKey ?? 'proxy') : resolveAnthropicKey(apiKey),
      baseURL: override?.baseURL,
      defaultHeaders: override?.headers,
      // The SDK's own default is ten minutes, which is ten minutes of a run
      // looking alive and doing nothing when a host stops answering.
      timeout: override?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...(override?.fetch ? { fetch: override.fetch } : {}),
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
    // Prompt caching, on by default: an agent step re-sends everything before
    // it, and without breakpoints every step of a sixty-step run billed its
    // whole prefix at the full input price. A one-off side call opts out,
    // since a cache write costs more than it saves when nothing reads it.
    const cache = req.cache !== false;
    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
    if (cache && tools.length > 0) tools[tools.length - 1]!.cache_control = EPHEMERAL;
    const system: Anthropic.TextBlockParam[] = req.system
      ? [{ type: 'text', text: req.system, ...(cache ? { cache_control: EPHEMERAL } : {}) }]
      : [];
    const messages = toAnthropicMessages(req.messages, {
      model: req.model,
      thinking: thinking !== undefined && thinking.type !== 'disabled',
    });
    if (cache) markConversationBreakpoints(messages);
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: bits.maxTokens,
        ...(system.length > 0 ? { system } : {}),
        messages,
        tools,
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
    //
    // Reasoning blocks are assembled here, from the deltas, rather than read
    // off the final message, because their place in the turn matters: they
    // are yielded as each one closes, between the text before them and the
    // text after, which is the order the loop records and the order Anthropic
    // requires them back in. The SDK's own snapshot is no help for this — it
    // runs ahead of this iteration and is cleared when the stream ends.
    const open = new Map<number, { thinking: string; signature: string } | { data: string }>();
    let final: Anthropic.Message;
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'thinking') {
            open.set(event.index, { thinking: block.thinking ?? '', signature: block.signature ?? '' });
          } else if (block.type === 'redacted_thinking') {
            open.set(event.index, { data: block.data });
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text_delta', text: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            const block = open.get(event.index);
            if (block && 'thinking' in block) block.thinking += event.delta.thinking;
            yield { type: 'thinking_delta', text: event.delta.thinking };
          } else if (event.delta.type === 'signature_delta') {
            const block = open.get(event.index);
            if (block && 'signature' in block) block.signature = event.delta.signature;
          }
        } else if (event.type === 'content_block_stop') {
          const block = open.get(event.index);
          open.delete(event.index);
          if (block && 'data' in block) {
            yield { type: 'reasoning_block', block: { type: 'redacted_thinking', data: block.data } };
          } else if (block && block.signature) {
            // An unsigned block cannot be sent back; it was shown, and that is
            // all it can be.
            yield {
              type: 'reasoning_block',
              block: { type: 'thinking', thinking: block.thinking, signature: block.signature },
            };
          }
        }
      }
      final = await stream.finalMessage();
    } catch (err) {
      // A stop the user asked for is not a provider failure.
      if (req.signal?.aborted) throw err;
      throw classifyProviderError(err, this.name, { viaJunoProxy: this.viaJunoProxy });
    }

    for (const block of final.content) {
      if (block.type === 'tool_use') {
        yield { type: 'tool_call', id: block.id, name: block.name, input: block.input };
      }
    }

    // `model_context_window_exceeded` is newer than this SDK's typing of the
    // field, so the comparison is made on the string the API sends.
    const reason: string | null = final.stop_reason;
    const stopReason =
      final.stop_reason === 'end_turn'
        ? 'end_turn'
        : final.stop_reason === 'tool_use'
          ? 'tool_use'
          : final.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : reason === 'model_context_window_exceeded'
              ? 'context_window'
              : final.stop_reason === 'refusal'
                ? 'refusal'
                : 'other';

    // Anthropic counts cached tokens apart from `input_tokens`; Usage counts
    // them in it (see its note in types.ts) and breaks them out beside it.
    const cacheRead = final.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
    yield {
      type: 'done',
      stopReason,
      usage: {
        inputTokens: final.usage.input_tokens + cacheRead + cacheWrite,
        outputTokens: final.usage.output_tokens,
        ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
      },
    };
  }
}
