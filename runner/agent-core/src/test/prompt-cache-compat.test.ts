import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { OpenAICompatAdapter, type CompatProviderConfig } from '../providers/openai-compat.js';
import { OpenAIResponsesAdapter } from '../providers/openai-responses.js';
import { normalizeCacheKey } from '../providers/prompt-cache.js';
import type { ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage, ToolSpec } from '../types.js';
import { openAIStream, recordingFetch } from './recorded.js';

/*
 * Prompt caching on the OpenAI-shaped wires: each lab gets the routing key or
 * markers its documentation defines, and nothing it does not.
 */

function config(id: string): CompatProviderConfig {
  return { id, name: id, baseUrl: `https://${id}.test/v1`, envVar: '', defaultModel: 'm', models: {} };
}

function chatReply(usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }): Response {
  return openAIStream([
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage },
  ]);
}

function toolReply(id: string): Response {
  return openAIStream([
    {
      id: 'c',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'm',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] },
          finish_reason: null,
        },
      ],
    },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]);
}

const TOOLS: ToolSpec[] = [
  { name: 'write_file', description: 'w', inputSchema: { type: 'object' } },
  { name: 'read_file', description: 'r', inputSchema: { type: 'object' } },
];

const CONVERSATION: ChatMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'read notes.txt' }] },
  { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'notes.txt' } }] },
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'hello' }] },
  { role: 'assistant', content: [{ type: 'tool_call', id: 't2', name: 'read_file', input: { path: 'b.txt' } }] },
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: 'world' }, { type: 'text', text: 'also this' }] },
];

async function drain(stream: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function chatRequest(
  provider: string,
  model: string,
  extra: Partial<ProviderRequest> = {},
  usage?: Record<string, unknown>,
) {
  const { fetch, requests } = recordingFetch([() => chatReply(usage)]);
  const adapter = new OpenAICompatAdapter(config(provider), { apiKey: 'k', fetch });
  const events = await drain(
    adapter.stream({ model, system: 'You are Juno.', messages: CONVERSATION, tools: TOOLS, cacheKey: 'sess-1', ...extra }),
  );
  const done = events.find((event) => event.type === 'done');
  return { request: requests[0]!, usage: done?.type === 'done' ? done.usage : null };
}

/** Every `cache_control` in a chat body, by message and block. */
function qwenMarkers(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  (body.messages as Array<{ content: unknown }>).forEach((message, m) => {
    if (!Array.isArray(message.content)) return;
    (message.content as Array<Record<string, unknown>>).forEach((block, b) => {
      if (block.cache_control) found.push(`${m}.${b}`);
    });
  });
  return found;
}

test('OpenAI GPT-5.6+ chat: key, implicit options and an explicit breakpoint on the system text', async () => {
  const { request, usage } = await chatRequest('openai', 'gpt-5.6-luna', {}, {
    prompt_tokens: 2000,
    completion_tokens: 5,
    total_tokens: 2005,
    prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 300 },
  });
  const body = request.body;
  assert.equal(body.prompt_cache_key, 'sess-1');
  assert.deepEqual(body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
  assert.equal(body.prompt_cache_retention, undefined);
  assert.deepEqual((body.messages as unknown[])[0], {
    role: 'system',
    content: [{ type: 'text', text: 'You are Juno.', prompt_cache_breakpoint: { mode: 'explicit' } }],
  });
  assert.deepEqual(usage, { inputTokens: 2000, outputTokens: 5, cacheReadTokens: 1500, cacheWriteTokens: 300 });
  // Tools go out in name order, whatever order they were registered in.
  assert.deepEqual((body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name), ['read_file', 'write_file']);
});

test('OpenAI pre-5.6 chat: key and 24h retention, the system prompt stays a string', async () => {
  for (const model of ['gpt-5.5', 'gpt-5.4', 'gpt-5.1-codex', 'gpt-5', 'gpt-4.1-2025-04-14']) {
    const { request } = await chatRequest('openai', model);
    assert.equal(request.body.prompt_cache_key, 'sess-1', model);
    assert.equal(request.body.prompt_cache_retention, '24h', model);
    assert.equal(request.body.prompt_cache_options, undefined, model);
    assert.deepEqual((request.body.messages as unknown[])[0], { role: 'system', content: 'You are Juno.' }, model);
  }
  // Not on OpenAI's extended-retention list: the key only.
  for (const model of ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-5.3-codex']) {
    const { request } = await chatRequest('openai', model);
    assert.equal(request.body.prompt_cache_key, 'sess-1', model);
    assert.equal(request.body.prompt_cache_retention, undefined, model);
  }
  // An undocumented model gets the key and nothing else.
  const { request } = await chatRequest('openai', 'gpt-4o');
  assert.equal(request.body.prompt_cache_retention, undefined);
  assert.equal(request.body.prompt_cache_key, 'sess-1');
});

test('each other lab gets only the routing it documents', async () => {
  for (const provider of ['mistral', 'meta']) {
    const { request } = await chatRequest(provider, 'some-model');
    assert.equal(request.body.prompt_cache_key, 'sess-1', provider);
    assert.equal(request.headers['x-grok-conv-id'], undefined, provider);
  }
  const xai = await chatRequest('xai', 'grok-4.7');
  assert.equal(xai.request.headers['x-grok-conv-id'], 'sess-1');
  assert.equal(xai.request.body.prompt_cache_key, undefined);
  // The proxy's adapters carry `backend/<id>` but the lab is the same.
  const { fetch, requests } = recordingFetch([() => chatReply()]);
  const proxied = new OpenAICompatAdapter({ ...config('backend/xai'), id: 'xai' }, { apiKey: 'proxy', id: 'backend/xai', fetch });
  await drain(proxied.stream({ model: 'grok-4.7', system: 's', messages: CONVERSATION, tools: [], cacheKey: 'sess-1' }));
  assert.equal(requests[0]!.headers['x-grok-conv-id'], 'sess-1');

  for (const provider of ['zhipu', 'deepseek', 'moonshot', 'google']) {
    const { request } = await chatRequest(provider, 'some-model');
    for (const field of ['prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention']) {
      assert.equal(request.body[field], undefined, `${provider} ${field}`);
    }
    assert.equal(request.headers['x-grok-conv-id'], undefined, provider);
    assert.deepEqual(qwenMarkers(request.body), [], provider);
  }
  // No key, no key field.
  const keyless = await chatRequest('mistral', 'm', { cacheKey: undefined });
  assert.equal(keyless.request.body.prompt_cache_key, undefined);
});

test('DeepSeek reports its cache hits at the top level of usage', async () => {
  const { usage } = await chatRequest('deepseek', 'deepseek-v4', {}, {
    prompt_tokens: 900,
    completion_tokens: 3,
    total_tokens: 903,
    prompt_cache_hit_tokens: 640,
    prompt_cache_miss_tokens: 260,
  });
  assert.deepEqual(usage, { inputTokens: 900, outputTokens: 3, cacheReadTokens: 640 });
});

test('Qwen explicit cache: system, the previous tail and the newest block, and writes in usage', async () => {
  const { request, usage } = await chatRequest('qwen', 'qwen3.8-max', {}, {
    prompt_tokens: 1700,
    completion_tokens: 4,
    total_tokens: 1704,
    prompt_tokens_details: { cached_tokens: 0, cache_creation_input_tokens: 1605 },
  });
  const messages = request.body.messages as Array<{ role: string; content: unknown }>;
  // [system, user, assistant, tool t1, assistant, tool t2, user]
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'user']);
  assert.deepEqual(qwenMarkers(request.body), ['0.0', '3.0', '6.0']);
  assert.deepEqual(messages[0]!.content, [{ type: 'text', text: 'You are Juno.', cache_control: { type: 'ephemeral' } }]);
  // A tool result is a block list whether it carries the marker or not.
  assert.deepEqual(messages[5]!.content, [{ type: 'text', text: 'world' }]);
  assert.equal(request.body.prompt_cache_key, undefined);
  assert.deepEqual(usage, { inputTokens: 1700, outputTokens: 4, cacheWriteTokens: 1605 });

  for (const model of ['qwen3.7-plus', 'qwen3.8-flash']) {
    assert.equal(qwenMarkers((await chatRequest('qwen', model)).request.body).length, 3, model);
  }
  // Models without explicit caching, and side calls, get no markers.
  assert.deepEqual(qwenMarkers((await chatRequest('qwen', 'qwen-plus-latest')).request.body), []);
  assert.deepEqual(qwenMarkers((await chatRequest('qwen', 'qwen3.8-max', { cache: false })).request.body), []);
});

function responsesReply(): Response {
  const final = {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'm',
    output: [],
    incomplete_details: null,
    error: null,
    usage: {
      input_tokens: 500,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 60 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 502,
    },
  };
  const events = [{ type: 'response.completed', response: final }];
  const body = events
    .map((event, index) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function responsesRequest(provider: string, model: string) {
  const { fetch, requests } = recordingFetch([() => responsesReply()]);
  const adapter = new OpenAIResponsesAdapter(config(provider), { apiKey: 'k', fetch });
  const events = await drain(adapter.stream({ model, system: 'You are Juno.', messages: CONVERSATION, tools: TOOLS, cacheKey: 'sess-1' }));
  const done = events.find((event) => event.type === 'done');
  return { request: requests[0]!, usage: done?.type === 'done' ? done.usage : null };
}

test('Responses: GPT-5.6+ moves the system prompt into the input behind a breakpoint', async () => {
  const { request, usage } = await responsesRequest('openai', 'gpt-5.6-pro');
  assert.equal(request.body.instructions, undefined);
  assert.equal(request.body.prompt_cache_key, 'sess-1');
  assert.deepEqual(request.body.prompt_cache_options, { mode: 'implicit', ttl: '30m' });
  assert.deepEqual((request.body.input as unknown[])[0], {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: 'You are Juno.', prompt_cache_breakpoint: { mode: 'explicit' } }],
  });
  assert.deepEqual(usage, { inputTokens: 500, outputTokens: 2, cacheReadTokens: 400, cacheWriteTokens: 60 });
  assert.deepEqual((request.body.tools as Array<{ name: string }>).map((tool) => tool.name), ['read_file', 'write_file']);

  const older = await responsesRequest('openai', 'gpt-5.5-pro');
  assert.equal(older.request.body.instructions, 'You are Juno.');
  assert.equal(older.request.body.prompt_cache_retention, '24h');
  assert.equal(older.request.body.prompt_cache_key, 'sess-1');

  const xai = await responsesRequest('xai', 'grok-4.7');
  assert.equal(xai.request.body.prompt_cache_key, 'sess-1');
  assert.equal(xai.request.headers['x-grok-conv-id'], undefined);
  assert.equal(xai.request.body.prompt_cache_retention, undefined);

  const mistral = await responsesRequest('zhipu', 'glm-5.2');
  assert.equal(mistral.request.body.prompt_cache_key, undefined);
});

test('cache keys are passed through when plain and digested when not', () => {
  assert.equal(normalizeCacheKey('a1b2c3d4-e5f6-4711-8899-aabbccddeeff'), 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff');
  const long = normalizeCacheKey('x'.repeat(200))!;
  assert.match(long, /^jc-[0-9a-f]{40}$/);
  assert.equal(normalizeCacheKey('x'.repeat(200)), long);
  assert.equal(normalizeCacheKey(undefined), undefined);
});

test('a Code session on Qwen keys every request to its session and keeps the prefix byte-stable', async () => {
  process.env.JUNO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-cache-compat-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-cache-compat-cwd-'));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello');
  const { fetch, requests } = recordingFetch([
    () => toolReply('t1'),
    () => toolReply('t2'),
    () => chatReply(),
    () => chatReply(),
  ]);
  const session = AgentSession.create({
    provider: new OpenAICompatAdapter(config('qwen'), { apiKey: 'k', fetch }),
    cwd,
    model: 'qwen3.8-max',
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await session.prompt('what does notes.txt say?');
  await session.prompt('and now?');
  assert.equal(requests.length, 4);

  const strip = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner))) as Array<unknown>;
  for (let n = 1; n < requests.length; n++) {
    assert.deepEqual(requests[n]!.body.tools, requests[0]!.body.tools, `tools moved at request ${n + 1}`);
    const earlier = strip(requests[n - 1]!.body.messages);
    const later = strip(requests[n]!.body.messages);
    assert.ok(later.length > earlier.length);
    assert.deepEqual(later.slice(0, earlier.length), earlier, `request ${n + 1} rewrote what request ${n} sent`);
  }
  for (const request of requests) assert.ok(qwenMarkers(request.body).length <= 4);

  // The same session on OpenAI sends its own id as the key on every step.
  const openai = recordingFetch([() => toolReply('t1'), () => chatReply()]);
  const keyed = AgentSession.create({
    provider: new OpenAICompatAdapter(config('openai'), { apiKey: 'k', fetch: openai.fetch }),
    cwd,
    model: 'gpt-5.5',
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await keyed.prompt('what does notes.txt say?');
  assert.equal(openai.requests.length, 2);
  for (const request of openai.requests) assert.equal(request.body.prompt_cache_key, normalizeCacheKey(keyed.sessionId));
});
