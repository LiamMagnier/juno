import { createHash } from 'node:crypto';

/**
 * Prompt caching for the OpenAI-shaped wires (Chat Completions and Responses).
 *
 * Every lab here caches a request's prefix on its own; what differs is what a
 * request must say to land on the server that holds that prefix, and whether
 * the lab needs the prefix marked. Each field below is sent only to the labs
 * whose documentation defines it: a lab that validates its body answers an
 * unknown field with a 400, and the run dies over an optimisation.
 *
 * - OpenAI: `prompt_cache_key` routes a conversation to one cache. GPT-5.6 and
 *   later add `prompt_cache_options` and an explicit breakpoint on the static
 *   system text; the older documented models take `prompt_cache_retention:
 *   "24h"`. Mirrors src/lib/openai-prompt-cache.ts on the website.
 *   https://developers.openai.com/api/docs/guides/prompt-caching
 * - Mistral: caching is opt-in, and happens only with `prompt_cache_key`.
 *   https://docs.mistral.ai/studio/conversations/advanced/prompt-caching
 * - Meta Model API: `prompt_cache_key` on both wires.
 *   https://dev.meta.ai/docs/prompt-caching
 * - xAI: the `x-grok-conv-id` header on Chat Completions (whose body has no
 *   key), `prompt_cache_key` on Responses.
 *   https://docs.x.ai/developers/advanced-api-usage/prompt-caching/maximizing-cache-hits
 * - Qwen (Model Studio): explicit `cache_control: {type: "ephemeral"}` markers
 *   on content blocks, at most four, for the models that support them.
 *   https://www.alibabacloud.com/help/en/model-studio/context-cache
 * - Zhipu, DeepSeek, Moonshot and the rest: implicit on a stable prefix, with
 *   nothing to send.
 */

export type CacheWire = 'chat' | 'responses';

/** What a request adds for its lab's prompt cache. */
export interface PromptCachePlan {
  /** Top-level body fields, spread onto the params. */
  fields: Record<string, unknown>;
  /** Per-request headers. */
  headers?: Record<string, string>;
  /** OpenAI GPT-5.6+: an explicit breakpoint on the system text part. */
  systemBreakpoint: boolean;
  /** Qwen: `cache_control` markers on the system and the moving tail. */
  qwenMarkers: boolean;
}

/** The lab behind an adapter id, whether it came from the table, a spec or
 *  the backend proxy (`backend/<id>`). */
export function cacheProviderOf(id: string): string {
  return id.replace(/^backend\//, '').toLowerCase();
}

const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The key as it goes on the wire: the session's own id when it is short and
 * plain, otherwise a digest of it. Stable either way, which is all a cache key
 * has to be, and never longer than the labs accept.
 */
export function normalizeCacheKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (SAFE_KEY.test(key)) return key;
  return `jc-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** GPT-5.6 and later: explicit breakpoints and `prompt_cache_options`. */
export function isOpenAIModernCacheModel(model: string): boolean {
  const id = model.toLowerCase();
  return /gpt-5\.(6|7|8|9|[1-9]\d)/.test(id) || /^gpt-[6-9]/.test(id);
}

/** The pre-5.6 models documented to take `prompt_cache_retention: "24h"`. */
const EXTENDED_RETENTION_MODELS = new Set(['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.2', 'gpt-5', 'gpt-5-codex', 'gpt-4.1']);

/** Same list as the web's `supportsOpenAIPromptCacheRetention`: exact ids, a dated snapshot counts as its model, the gpt-5.1 family whole. */
export function supportsOpenAIRetention(model: string): boolean {
  if (isOpenAIModernCacheModel(model)) return false;
  const id = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return EXTENDED_RETENTION_MODELS.has(id) || /^gpt-5\.1($|-)/.test(id);
}

/** The Qwen models whose explicit cache this runner marks. */
const QWEN_EXPLICIT = new Set(['qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-flash']);

export function isQwenExplicitCacheModel(provider: string, model: string): boolean {
  return provider === 'qwen' && QWEN_EXPLICIT.has(model.toLowerCase());
}

const CACHE_KEY_LABS: Record<CacheWire, ReadonlySet<string>> = {
  chat: new Set(['openai', 'mistral', 'meta']),
  responses: new Set(['openai', 'xai', 'meta']),
};

export function promptCachePlan(input: {
  providerId: string;
  model: string;
  wire: CacheWire;
  cacheKey?: string;
  /** False for a one-off side call: no paid explicit writes. */
  cache?: boolean;
}): PromptCachePlan {
  const provider = cacheProviderOf(input.providerId);
  const key = normalizeCacheKey(input.cacheKey);
  const write = input.cache !== false;
  const plan: PromptCachePlan = { fields: {}, systemBreakpoint: false, qwenMarkers: false };

  if (key && CACHE_KEY_LABS[input.wire].has(provider)) plan.fields.prompt_cache_key = key;
  if (key && provider === 'xai' && input.wire === 'chat') plan.headers = { 'x-grok-conv-id': key };

  if (provider === 'openai') {
    if (isOpenAIModernCacheModel(input.model)) {
      plan.fields.prompt_cache_options = { mode: 'implicit', ttl: '30m' };
      plan.systemBreakpoint = write;
    } else if (supportsOpenAIRetention(input.model)) {
      plan.fields.prompt_cache_retention = '24h';
    }
  }

  if (write && input.wire === 'chat' && isQwenExplicitCacheModel(provider, input.model)) plan.qwenMarkers = true;
  return plan;
}

const EPHEMERAL = { type: 'ephemeral' } as const;

type WireMessage = { role: string; content?: unknown };

/** Mark the last non-empty text-like block of a message; a string content
 *  becomes one text block so it can carry the marker. */
function markLast(message: WireMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string') {
    if (!message.content) return false;
    message.content = [{ type: 'text', text: message.content, cache_control: EPHEMERAL }];
    return true;
  }
  if (!Array.isArray(message.content)) return false;
  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index] as Record<string, unknown>;
    if (block.type === 'text' && !block.text) continue;
    block.cache_control = EPHEMERAL;
    return true;
  }
  return false;
}

/**
 * Qwen's explicit cache, on Chat Completions messages, in place.
 *
 * Three markers of the four allowed: the system prompt (tools count as part of
 * it), the newest message, which writes the whole conversation so the next
 * round reads it, and the tail the previous round marked — the last message
 * before the newest assistant turn — because Qwen looks back only twenty
 * blocks from a marker, and one round of parallel tool calls can add more.
 * Assistant messages are never marked: one that only called tools has no
 * content to carry a marker.
 */
export function markQwenCache(messages: WireMessage[]): void {
  // One shape for every round: a tool result is a block list whether or not it
  // carries a marker this time, so a message does not change form when the
  // marker moves past it.
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.content === 'string') {
      message.content = [{ type: 'text', text: message.content }];
    }
  }
  if (messages[0]?.role === 'system') markLast(messages[0]);
  const last = messages.length - 1;
  if (last < 1 || messages[last]!.role === 'assistant') return;
  markLast(messages[last]);
  for (let index = last - 1; index > 1; index--) {
    if (messages[index]!.role !== 'assistant') continue;
    if (messages[index - 1]!.role !== 'assistant' && messages[index - 1]!.role !== 'system') markLast(messages[index - 1]);
    return;
  }
}

/** Tools by name, so the bytes a cache keys on cannot move with the order a
 *  registry or an MCP server happened to list them in. Stable for equal names. */
export function sortedTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
