import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../loop.js';
import { ProviderCallError } from '../providers/errors.js';
import { OpenAIResponsesAdapter, toResponsesInput } from '../providers/openai-responses.js';
import { createProxyProvider, type BackendCatalogModel } from '../providers/proxy.js';
import type { ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';
import { openAIStream, recordingFetch } from './recorded.js';

/*
 * OpenAI Responses with store:false: the reasoning item comes back sealed
 * (`encrypted_content`) when the request includes it, and goes back in the
 * next request's input, in its place, to the same model. Recorded-shape
 * Responses streams run through the real OpenAI SDK.
 */

function responsesStream(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const REASONING_ITEM = {
  id: 'rs_0a1b2c',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'Read the file before answering.' }],
  encrypted_content: 'gAAAAABo-sealed-reasoning==',
  status: 'completed',
};

function response(output: Array<Record<string, unknown>>, usage = { input: 120, cached: 80, output: 30 }, status = 'completed') {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status,
    model: 'gpt-5.3-codex',
    output,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    error: null,
    usage: {
      input_tokens: usage.input,
      input_tokens_details: { cached_tokens: usage.cached },
      output_tokens: usage.output,
      output_tokens_details: { reasoning_tokens: 20 },
      total_tokens: usage.input + usage.output,
    },
  };
}

const TOOL_STEP = () => {
  const call = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' };
  return responsesStream([
    { type: 'response.created', response: response([], { input: 0, cached: 0, output: 0 }, 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { ...REASONING_ITEM, summary: [], encrypted_content: null, status: 'in_progress' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_0a1b2c', output_index: 0, summary_index: 0, delta: 'Read the file ' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_0a1b2c', output_index: 0, summary_index: 0, delta: 'before answering.' },
    { type: 'response.output_item.done', output_index: 0, item: REASONING_ITEM },
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 1, delta: '{"path":"notes.txt"}' },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.completed', response: response([REASONING_ITEM, call]) },
  ]);
};

const TEXT_STEP = () => {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'It says hello.', annotations: [] }],
  };
  return responsesStream([
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'It says hello.' },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response: response([message], { input: 200, cached: 150, output: 5 }) },
  ]);
};

const CATALOG: BackendCatalogModel[] = [
  { provider: 'openai', kind: 'openai', model: 'gpt-5.5', label: 'GPT-5.5', available: true },
  { provider: 'openai', kind: 'openai', model: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', available: true, api: 'responses' },
];

test('a sealed reasoning item is yielded whole, in order, beside the call it led to', async () => {
  const { fetch, requests } = recordingFetch([TOOL_STEP]);
  const adapter = new OpenAIResponsesAdapter(
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.test/v1', envVar: '', defaultModel: 'gpt-5.3-codex', models: {} },
    { apiKey: 'k', fetch },
  );
  const seen: ProviderStreamEvent[] = [];
  for await (const event of adapter.stream({
    model: 'gpt-5.3-codex',
    system: 'You are Juno.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'what does notes.txt say?' }] }],
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
    reasoningEffort: 'high',
  })) {
    seen.push(event);
  }
  assert.deepEqual(
    seen.map((event) => event.type),
    ['thinking_delta', 'thinking_delta', 'reasoning_block', 'tool_call', 'done'],
  );
  assert.deepEqual(seen[2], {
    type: 'reasoning_block',
    block: { type: 'reasoning', id: 'rs_0a1b2c', encryptedContent: 'gAAAAABo-sealed-reasoning==', summary: ['Read the file before answering.'] },
  });
  assert.deepEqual(seen[3], { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'notes.txt' } });
  assert.deepEqual(seen[4], {
    type: 'done',
    stopReason: 'tool_use',
    usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80 },
  });

  // Asked for the sealed content, and kept nothing at OpenAI.
  const body = requests[0]!.body;
  assert.equal(requests[0]!.url, 'https://api.openai.test/v1/responses');
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.equal(body.instructions, 'You are Juno.');
});

test('the tool loop sends the sealed reasoning back in place, through the proxy', async () => {
  const { fetch, requests } = recordingFetch([TOOL_STEP, TEXT_STEP]);
  const provider = createProxyProvider(
    { baseUrl: 'https://juno.test/api/agent', cookie: '', authorization: 'Bearer cct_x', models: CATALOG, fetch },
    'backend/openai',
  );
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'what does notes.txt say?' }] }];
  const result = await runAgentLoop({
    provider,
    model: 'gpt-5.3-codex',
    system: 'You are Juno.',
    messages,
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
    signal: new AbortController().signal,
    maxSteps: 4,
    reasoningEffort: 'high',
    executeToolCall: async (call) => ({ type: 'tool_result', toolCallId: call.id, content: 'hello' }),
  });
  assert.equal(result.finalText, 'It says hello.');
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, 'https://juno.test/api/agent/openai/responses');
  assert.deepEqual(requests[1]!.body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'what does notes.txt say?' }] },
    {
      type: 'reasoning',
      id: 'rs_0a1b2c',
      summary: [{ type: 'summary_text', text: 'Read the file before answering.' }],
      encrypted_content: 'gAAAAABo-sealed-reasoning==',
    },
    { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"notes.txt"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'hello' },
  ]);
  // Recorded in the transcript as streamed, stamped with its model.
  assert.deepEqual(messages[1], {
    role: 'assistant',
    content: [
      { type: 'reasoning', id: 'rs_0a1b2c', encryptedContent: 'gAAAAABo-sealed-reasoning==', summary: ['Read the file before answering.'], model: 'gpt-5.3-codex' },
      { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'notes.txt' } },
    ],
  });
});

test('the provider still sends its chat models to chat/completions', async () => {
  const { fetch, requests } = recordingFetch([
    () =>
      openAIStream([
        { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.5', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]),
  ]);
  const provider = createProxyProvider(
    { baseUrl: 'https://juno.test/api/agent', cookie: '', authorization: 'Bearer cct_x', models: CATALOG, fetch },
    'backend/openai',
  );
  for await (const _ of provider.stream({ model: 'gpt-5.5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) {
    // drain
  }
  assert.equal(requests[0]!.url, 'https://juno.test/api/agent/openai/chat/completions');
});

test("another model's reasoning, and another lab's thinking, are not sent", () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', id: 'rs_1', encryptedContent: 'sealed', summary: [], model: 'gpt-5.2-codex' },
        { type: 'thinking', thinking: 't', signature: 's', model: 'gpt-5.3-codex' },
        { type: 'tool_call', id: 'c1', name: 'read_file', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'x' }] },
  ];
  assert.deepEqual(
    toResponsesInput(messages, 'gpt-5.3-codex').map((item) => ('type' in item ? item.type : 'message')),
    ['message', 'function_call', 'function_call_output'],
  );
});

test('a response that fails mid-stream is classified like any other failure', async () => {
  const { fetch } = recordingFetch([
    () =>
      responsesStream([
        {
          type: 'response.failed',
          response: {
            ...response([]),
            status: 'failed',
            error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' },
          },
        },
      ]),
  ]);
  const adapter = new OpenAIResponsesAdapter(
    { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.test/v1', envVar: '', defaultModel: 'gpt-5.3-codex', models: {} },
    { apiKey: 'k', fetch },
  );
  await assert.rejects(
    (async () => {
      for await (const _ of adapter.stream({ model: 'gpt-5.3-codex', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) {
        // drain
      }
    })(),
    (error: unknown) => error instanceof ProviderCallError && error.kind === 'context_overflow',
  );
});
