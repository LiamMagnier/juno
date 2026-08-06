import OpenAI from 'openai';
import type {
  ModelCapabilities,
  ProviderAdapter,
  ProviderRequest,
  ProviderStreamEvent,
  ReasoningEffort,
} from './types.js';
import type { ChatMessage } from '../types.js';
import { resolveKey } from './credentials.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './timeouts.js';

/**
 * One adapter for every OpenAI-compatible lab. Each configured provider gets
 * its own instance with a base URL, key source, and curated model table with
 * capability flags (mirrors the Juno web app's provider matrix).
 */
export interface CompatProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  envVar: string;
  defaultModel: string;
  models: Record<string, { label: string; capabilities: ModelCapabilities }>;
  /**
   * True only for labs whose API actually defines OpenAI's top-level
   * `reasoning_effort`.
   *
   * Opt-in rather than opt-out, and a flag rather than a guess from the id,
   * because the two failure modes are not symmetrical. A lab that ignores an
   * unknown field costs nothing; a lab that validates its body — several do —
   * answers 400 and the run dies before its first token over a preference the
   * user could have lived without. Every other dialect (`thinking:{type}`,
   * `enable_thinking`) is deliberately absent: the request carries the user's
   * tier, and a provider with no way to receive it drops it.
   */
  reasoningEffortParam?: boolean;
  /** Wall-clock ceiling for one request. See timeouts.ts for why it is set. */
  timeoutMs?: number;
}

/**
 * The user's tier, on the wire, unchanged.
 *
 * Deliberately not clamped here, and that is a correction rather than an
 * omission: an earlier version of this adapter mapped `xhigh` and `max` down to
 * `high`, and a Work run that asked `gpt-5.6-luna` for `xhigh` — a tier that
 * model does accept — was observed sending `high` instead. Which tiers a
 * particular model takes is per-model, live-probed knowledge, and it already
 * exists in exactly one place: `reasoningCaps`/`clampReasoningEffort` in
 * src/lib/model-metrics.ts, which the caller consults before handing the tier
 * over. A second, cruder clamp here can only disagree with the first, and when
 * it does the user's choice is the thing that loses.
 *
 * The cast is the seam between two vocabularies that happen to coincide: Juno's
 * six tiers are a subset of the enum the SDK types accept, and this is where
 * that is asserted once instead of at the call site.
 */
function toOpenAIEffort(
  effort: ReasoningEffort,
): NonNullable<OpenAI.Chat.Completions.ChatCompletionCreateParams['reasoning_effort']> {
  return effort;
}

function caps(overrides: Partial<ModelCapabilities> = {}): ModelCapabilities {
  return {
    tools: true,
    vision: true,
    computerUse: false,
    reasoningLevels: [],
    maxContext: 200_000,
    streaming: true,
    mcp: false,
    ...overrides,
  };
}

export const COMPAT_PROVIDERS: Record<string, CompatProviderConfig> = {
  zhipu: {
    id: 'zhipu',
    name: 'Z.ai · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envVar: 'ZHIPU_API_KEY',
    defaultModel: 'glm-5.2',
    models: {
      'glm-5.2': { label: 'GLM-5.2', capabilities: caps({ maxContext: 204_800 }) },
      'glm-5-air': { label: 'GLM-5 Air', capabilities: caps({ maxContext: 131_072 }) },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI · GPT',
    baseUrl: 'https://api.openai.com/v1',
    envVar: 'OPENAI_API_KEY',
    reasoningEffortParam: true,
    defaultModel: 'gpt-5.5',
    models: {
      'gpt-5.5': { label: 'GPT-5.5', capabilities: caps({ maxContext: 1_050_000 }) },
      'gpt-5.4-mini': { label: 'GPT-5.4 Mini', capabilities: caps({ maxContext: 400_000 }) },
      'gpt-5.3-codex': { label: 'GPT-5.3 Codex', capabilities: caps({ maxContext: 400_000 }) },
    },
  },
};

function toCompatMessages(system: string, messages: ChatMessage[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
  ];
  for (const m of messages) {
    if (m.role === 'user') {
      const toolResults = m.content.filter((c) => c.type === 'tool_result');
      for (const r of toolResults) {
        if (r.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
        }
      }
      const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
          continue;
        }
        if (part.type === 'image') {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          });
        }
      }
      if (content.length > 0) {
        out.push({
          role: 'user',
          content,
        });
      }
    } else {
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join('');
      const calls = m.content.filter((c) => c.type === 'tool_call');
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || null,
      };
      if (calls.length > 0) {
        msg.tool_calls = calls.map((c) =>
          c.type === 'tool_call'
            ? {
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              }
            : { id: '', type: 'function' as const, function: { name: '', arguments: '{}' } },
        );
      }
      out.push(msg);
    }
  }
  return out;
}

export interface CompatAdapterOptions {
  /** Explicit key (or "proxy" placeholder in backend-proxy mode). */
  apiKey?: string;
  /** Extra headers — carries the session Cookie in backend-proxy mode. */
  headers?: Record<string, string>;
  /** Override the reported provider id (e.g. "backend/zhipu"). */
  id?: string;
}

export class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  private config: CompatProviderConfig;
  private client: OpenAI;

  constructor(config: CompatProviderConfig, opts?: CompatAdapterOptions | string) {
    // Back-compat: a bare string is the API key.
    const options: CompatAdapterOptions = typeof opts === 'string' ? { apiKey: opts } : (opts ?? {});
    this.config = config;
    this.id = options.id ?? config.id;
    this.name = config.name;
    this.defaultModel = config.defaultModel;
    this.client = new OpenAI({
      apiKey: options.apiKey ?? resolveKey(config.id, config.envVar, undefined) ?? 'missing',
      baseURL: config.baseUrl,
      defaultHeaders: options.headers,
      maxRetries: 2,
      // The SDK's own default is ten minutes, and with two retries on top a
      // lab that accepts the connection and answers nothing costs half an hour
      // of a run that looks alive. See timeouts.ts.
      timeout: config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  }

  models(): string[] {
    return Object.keys(this.config.models);
  }

  capabilities(model: string): ModelCapabilities {
    return this.config.models[model]?.capabilities ?? caps({ vision: false });
  }

  async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
    const maxTokens = req.maxTokens ?? 8192;
    // OpenAI's GPT-5/o-series reject `max_tokens` and require
    // `max_completion_tokens`; every other OpenAI-compatible lab accepts
    // `max_tokens`. (Matches the web app's openai-compat routing.)
    const isOpenAI = this.config.id === 'openai';
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: toCompatMessages(req.system, req.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(isOpenAI ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
        ...(req.reasoningEffort && this.config.reasoningEffortParam
          ? { reasoning_effort: toOpenAIEffort(req.reasoningEffort) }
          : {}),
        tools: req.tools.length
          ? req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            }))
          : undefined,
      },
      { signal: req.signal },
    );

    // Streamed tool-call fragments accumulate per choice index.
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: 'text_delta', text: delta.content };
      const reasoning = (delta as unknown as { reasoning_content?: string })?.reasoning_content;
      if (reasoning) yield { type: 'thinking_delta', text: reasoning };
      for (const tc of delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(tc.index, cur);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? usage.inputTokens,
          outputTokens: chunk.usage.completion_tokens ?? usage.outputTokens,
        };
      }
    }

    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.id || !call.name) continue;
      let input: unknown = {};
      try {
        input = call.args ? JSON.parse(call.args) : {};
      } catch {
        input = {};
      }
      yield { type: 'tool_call', id: call.id, name: call.name, input };
    }

    const stopReason =
      finishReason === 'tool_calls'
        ? 'tool_use'
        : finishReason === 'length'
          ? 'max_tokens'
          : finishReason === 'stop'
            ? 'end_turn'
            : 'other';
    yield { type: 'done', stopReason, usage };
  }
}
