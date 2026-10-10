import OpenAI from 'openai';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
  ReasoningEffort,
} from './types.js';
import type { ChatMessage, Usage } from '../types.js';
import { classifyProviderError } from './errors.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.js';
import type { CompatAdapterOptions, CompatProviderConfig } from './openai-compat.js';
import { promptCachePlan, sortedTools } from './prompt-cache.js';

/**
 * OpenAI's Responses API, for the models that speak only it (the Pro and Codex
 * lines answer chat/completions with a 404) and for reasoning that has to
 * survive a tool loop.
 *
 * Chat Completions never hands a model's reasoning back to the caller, so a
 * reasoning model re-derives its plan from scratch on every step of a tool
 * loop. Responses does, as a `reasoning` item, and with `store: false` — Juno
 * keeps nothing at OpenAI, and the proxy refuses stored responses outright —
 * the item arrives with `encrypted_content` when the request asks for it with
 * `include: ["reasoning.encrypted_content"]`. Sent back unchanged in its place
 * in the next request's input, it is the model's own reasoning again. The loop
 * records it like an Anthropic thinking block: in stream order, stamped with
 * the model that wrote it, and never sent to a different one.
 *
 * Everything else — the tool-call shape, usage, failure classification — is
 * the Responses spelling of what openai-compat.ts does for chat completions.
 */

/** Room for reasoning on top of the answer: reasoning tokens count against
 *  `max_output_tokens`, and a model that spends its whole allowance thinking
 *  returns nothing. The same tiers the Anthropic adapter gives adaptive
 *  thinking. */
const REASONING_HEADROOM: Record<ReasoningEffort, number> = {
  minimal: 4096,
  low: 8192,
  medium: 16384,
  high: 32000,
  xhigh: 48000,
  max: 56000,
};

type InputItem = OpenAI.Responses.ResponseInputItem;

/**
 * The transcript as Responses input items. A user message becomes its tool
 * outputs and then, if it says anything, an input message; an assistant
 * message becomes its parts in the order they streamed — which is the order a
 * reasoning item must keep relative to the call or message it led to.
 */
export function toResponsesInput(messages: readonly ChatMessage[], model: string): InputItem[] {
  const items: InputItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const content: OpenAI.Responses.ResponseInputContent[] = [];
      for (const part of message.content) {
        if (part.type === 'tool_result') {
          items.push({ type: 'function_call_output', call_id: part.toolCallId, output: part.content });
        } else if (part.type === 'text') {
          content.push({ type: 'input_text', text: part.text });
        } else {
          content.push({ type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: 'auto' });
        }
      }
      if (content.length > 0) items.push({ role: 'user', content });
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) items.push({ role: 'assistant', content: part.text });
      } else if (part.type === 'tool_call') {
        items.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
      } else if (part.type === 'reasoning' && part.model === model) {
        items.push({
          type: 'reasoning',
          id: part.id,
          summary: part.summary.map((text) => ({ type: 'summary_text' as const, text })),
          encrypted_content: part.encryptedContent,
        });
      }
      // Another lab's signed thinking means nothing here.
    }
  }
  return items;
}

/** A mid-stream failure, given the status its code stands for so the shared
 *  classifier can tell a limit from a fault. */
function streamFailure(code: string | null | undefined, message: string): Error {
  const status =
    code === 'rate_limit_exceeded' ? 429 : code === 'server_error' ? 500 : code === 'context_length_exceeded' ? 400 : undefined;
  return Object.assign(new Error(message), { code: code ?? undefined, ...(status === undefined ? {} : { status }) });
}

export class OpenAIResponsesAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  private config: CompatProviderConfig;
  private client: OpenAI;
  private readonly viaJunoProxy: boolean;

  constructor(config: CompatProviderConfig, options: CompatAdapterOptions = {}) {
    this.config = config;
    this.id = options.id ?? config.id;
    this.name = config.name;
    this.defaultModel = config.defaultModel;
    this.viaJunoProxy = options.viaJunoProxy === true;
    this.client = new OpenAI({
      apiKey: options.apiKey ?? 'missing',
      baseURL: config.baseUrl,
      defaultHeaders: options.headers,
      // As in openai-compat.ts: the loop owns retries, so each one is seen.
      maxRetries: 0,
      timeout: config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  models(): string[] {
    return Object.keys(this.config.models);
  }

  capabilities(model: string): ModelCapabilities {
    return (
      this.config.models[model]?.capabilities ?? {
        tools: true,
        vision: false,
        computerUse: false,
        reasoningLevels: [],
        maxContext: 200_000,
        streaming: true,
        mcp: false,
      }
    );
  }

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const maxTokens = (req.maxTokens ?? 8192) + (req.reasoningEffort ? REASONING_HEADROOM[req.reasoningEffort] : 0);
    // Prompt caching, in each lab's own spelling; see prompt-cache.ts.
    const cachePlan = promptCachePlan({
      providerId: this.config.id,
      model: req.model,
      wire: 'responses',
      ...(req.cacheKey ? { cacheKey: req.cacheKey } : {}),
      ...(req.cache === false ? { cache: false } : {}),
    });
    // GPT-5.6+: the system prompt moves from `instructions` into the input as
    // a system message whose text part carries an explicit breakpoint, so the
    // static instructions keep their own cache entry (as the website does).
    const systemInput: InputItem[] =
      cachePlan.systemBreakpoint && req.system
        ? [
            {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: req.system, prompt_cache_breakpoint: { mode: 'explicit' } }],
            } as unknown as InputItem,
          ]
        : [];
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: req.model,
      ...(req.system && systemInput.length === 0 ? { instructions: req.system } : {}),
      input: [...systemInput, ...toResponsesInput(req.messages, req.model)],
      ...(cachePlan.fields as Partial<OpenAI.Responses.ResponseCreateParamsStreaming>),
      stream: true,
      // Nothing is kept at OpenAI; the reasoning comes back sealed instead.
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: maxTokens,
      ...(req.reasoningEffort
        ? {
            reasoning: {
              // The same seam as toOpenAIEffort in openai-compat.ts: Juno's
              // tiers are a subset of what the API takes; typings lag it.
              effort: req.reasoningEffort as NonNullable<OpenAI.Reasoning['effort']>,
              summary: 'auto',
            },
          }
        : {}),
      ...(req.tools.length > 0
        ? {
            tools: sortedTools(req.tools).map((tool) => ({
              type: 'function' as const,
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: false,
            })),
          }
        : {}),
    };

    let stream: AsyncIterable<OpenAI.Responses.ResponseStreamEvent>;
    try {
      stream = await this.client.responses.create(params, {
        signal: req.signal,
        ...(cachePlan.headers ? { headers: cachePlan.headers } : {}),
      });
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw classifyProviderError(err, this.name, { viaJunoProxy: this.viaJunoProxy });
    }

    let final: OpenAI.Responses.Response | null = null;
    let calledTools = false;
    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'response.output_text.delta':
            yield { type: 'text_delta', text: event.delta };
            break;
          case 'response.reasoning_summary_text.delta':
            yield { type: 'thinking_delta', text: event.delta };
            break;
          case 'response.output_item.done': {
            const item = event.item;
            if (item.type === 'reasoning') {
              // Without the sealed content the item cannot be sent back under
              // `store: false`; it was shown as a summary, and that is all.
              if (item.encrypted_content) {
                yield {
                  type: 'reasoning_block',
                  block: {
                    type: 'reasoning',
                    id: item.id,
                    encryptedContent: item.encrypted_content,
                    summary: item.summary.map((part) => part.text),
                  },
                };
              }
            } else if (item.type === 'function_call') {
              calledTools = true;
              let input: unknown = {};
              try {
                input = item.arguments ? JSON.parse(item.arguments) : {};
              } catch {
                input = {};
              }
              yield { type: 'tool_call', id: item.call_id, name: item.name, input };
            }
            break;
          }
          case 'response.completed':
          case 'response.incomplete':
            final = event.response;
            break;
          case 'response.failed':
            throw streamFailure(event.response.error?.code, event.response.error?.message ?? 'The response failed.');
          case 'error':
            throw streamFailure(event.code, event.message);
          default:
            break;
        }
      }
    } catch (err) {
      if (req.signal?.aborted) throw err;
      throw classifyProviderError(err, this.name, { viaJunoProxy: this.viaJunoProxy });
    }

    const incomplete = final?.status === 'incomplete' ? final.incomplete_details?.reason : undefined;
    const stopReason =
      incomplete === 'max_output_tokens'
        ? 'max_tokens'
        : incomplete === 'content_filter'
          ? 'refusal'
          : calledTools
            ? 'tool_use'
            : final
              ? 'end_turn'
              : 'other';
    // `input_tokens` already includes the cached share, as Usage does.
    const cached = final?.usage?.input_tokens_details?.cached_tokens ?? 0;
    const details = final?.usage?.input_tokens_details as { cache_write_tokens?: number; cache_creation_tokens?: number } | undefined;
    const written = details?.cache_write_tokens ?? details?.cache_creation_tokens ?? 0;
    const usage: Usage = {
      inputTokens: final?.usage?.input_tokens ?? 0,
      outputTokens: final?.usage?.output_tokens ?? 0,
      ...(cached > 0 ? { cacheReadTokens: cached } : {}),
      ...(written > 0 ? { cacheWriteTokens: written } : {}),
    };
    yield { type: 'done', stopReason, usage };
  }
}

/**
 * One provider, two wires: chat completions for most of its models, Responses
 * for the ones listed. The loop holds one adapter per run and the model is
 * fixed on it, so routing by the request's model is routing by the run's.
 */
export function routeResponsesModels(
  chat: ProviderAdapter,
  responses: ProviderAdapter,
  responsesModels: ReadonlySet<string>,
): ProviderAdapter {
  return {
    id: chat.id,
    name: chat.name,
    defaultModel: chat.defaultModel,
    models: () => chat.models(),
    capabilities: (model) => (responsesModels.has(model) ? responses : chat).capabilities(model),
    stream: (req) => (responsesModels.has(req.model) ? responses : chat).stream(req),
  };
}
