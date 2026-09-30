import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicAdapter } from '../providers/anthropic.js';
import { OpenAICompatAdapter } from '../providers/openai-compat.js';
import { ProviderCallError, classifyProviderError } from '../providers/errors.js';
import { ProviderSilenceError, ToolExecutionError, failureCodeOf, runAgentLoop } from '../loop.js';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';
import { jsonResponse, recordingFetch } from './recorded.js';

const PLAN_SENTENCE = "You've used up your 5-hour usage limit. It frees up at 3:00 PM UTC.";
const PROXY_402 = { error: PLAN_SENTENCE, code: 'QUOTA_EXCEEDED', window: 'session' };

async function drain(stream: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const seen: ProviderStreamEvent[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

test("the proxy's plan limit, through the Anthropic SDK, is a plan limit", async () => {
  const { fetch, requests } = recordingFetch([() => jsonResponse(402, PROXY_402)]);
  const adapter = new AnthropicAdapter('proxy', { baseURL: 'https://juno.test/api/agent/anthropic', viaJunoProxy: true, fetch });
  await assert.rejects(
    drain(adapter.stream({ model: 'claude-sonnet-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })),
    (error: unknown) => {
      assert.ok(error instanceof ProviderCallError);
      assert.equal(error.kind, 'plan_limit');
      assert.equal(error.retryable, false);
      assert.equal(error.worthFailingOver, false);
      // The proxy's own sentence, which names the window and when it frees up.
      assert.equal(error.message, PLAN_SENTENCE);
      return true;
    },
  );
  // A 402 is never retried by the SDK either: one request, one refusal.
  assert.equal(requests.length, 1);
});

test("the OpenAI SDK drops the proxy's code, so the adapter's word that it is the proxy decides", async () => {
  const config = {
    id: 'zhipu',
    name: 'GLM',
    baseUrl: 'https://juno.test/api/agent/zhipu',
    envVar: '',
    defaultModel: 'glm-5.2',
    models: {},
  };
  const request = { model: 'glm-5.2', system: 's', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }], tools: [] };

  const viaProxy = new OpenAICompatAdapter(config, { apiKey: 'proxy', viaJunoProxy: true, fetch: recordingFetch([() => jsonResponse(402, PROXY_402)]).fetch });
  await assert.rejects(drain(viaProxy.stream(request)), (error: unknown) => {
    assert.ok(error instanceof ProviderCallError);
    assert.equal(error.kind, 'plan_limit');
    assert.equal(error.message, PLAN_SENTENCE);
    return true;
  });

  // The same 402 from a lab directly is the lab's account, which another lab
  // can get round.
  const direct = new OpenAICompatAdapter(config, { apiKey: 'k', fetch: recordingFetch([() => jsonResponse(402, PROXY_402)]).fetch });
  await assert.rejects(drain(direct.stream(request)), (error: unknown) => error instanceof ProviderCallError && error.kind === 'insufficient_balance');

  // And a lab's own out-of-credit 402, relayed through the proxy, stays the
  // lab's: its wording wins over the proxy's word.
  const relayed = new OpenAICompatAdapter(config, {
    apiKey: 'proxy',
    viaJunoProxy: true,
    fetch: recordingFetch([() => jsonResponse(402, { error: { message: 'Insufficient Balance', type: 'invalid_request_error' } })]).fetch,
  });
  await assert.rejects(drain(relayed.stream(request)), (error: unknown) => error instanceof ProviderCallError && error.kind === 'insufficient_balance');
});

test('a plan limit ends the turn at once: no retry, no wait', async () => {
  let calls = 0;
  const provider: ProviderAdapter = {
    id: 'p',
    name: 'Lab',
    defaultModel: 'm',
    models: () => ['m'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      calls += 1;
      throw classifyProviderError(Object.assign(new Error('402'), { status: 402, error: PROXY_402 }), 'Lab');
    },
  };
  const retries: number[] = [];
  const started = Date.now();
  await assert.rejects(
    runAgentLoop({
      provider,
      model: 'm',
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: [],
      signal: new AbortController().signal,
      maxSteps: 3,
      executeToolCall: async () => ({ type: 'tool_result', toolCallId: 'x', content: '' }),
      onProviderRetry: (info) => retries.push(info.delayMs),
    }),
    (error: unknown) => failureCodeOf(error) === 'plan_limit',
  );
  assert.equal(calls, 1);
  assert.deepEqual(retries, []);
  assert.ok(Date.now() - started < 1_000);
});

test('an over-long prompt is named as such, in each lab\'s words', () => {
  const anthropic = classifyProviderError(
    Object.assign(
      new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}'),
      { status: 400 },
    ),
    'Anthropic',
  );
  assert.equal(anthropic.kind, 'context_overflow');
  assert.equal(anthropic.retryable, false);

  const openai = classifyProviderError(Object.assign(new Error('400 too long'), { status: 400, code: 'context_length_exceeded' }), 'OpenAI');
  assert.equal(openai.kind, 'context_overflow');

  const proxyBody = classifyProviderError(Object.assign(new Error('413'), { status: 413 }), 'Juno');
  assert.equal(proxyBody.kind, 'context_overflow');

  // An ordinary bad request is still an ordinary bad request.
  assert.equal(classifyProviderError(Object.assign(new Error('400 unknown model'), { status: 400 }), 'Lab').kind, 'invalid_request');
});

function toolLoop(executeToolCall: () => Promise<never>) {
  const provider: ProviderAdapter = {
    id: 'p',
    name: 'Lab',
    defaultModel: 'm',
    models: () => ['m'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      yield { type: 'tool_call', id: 'c1', name: 'read_file', input: {} };
      yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }];
  return runAgentLoop({
    provider,
    model: 'm',
    system: 's',
    messages,
    tools: [],
    signal: new AbortController().signal,
    maxSteps: 2,
    executeToolCall,
  });
}

test('a tool that throws is a tool error, not a provider one', async () => {
  const crash = new TypeError('Cannot read properties of undefined');
  await assert.rejects(
    toolLoop(async () => {
      throw crash;
    }),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.toolName, 'read_file');
      assert.equal(error.callId, 'c1');
      assert.equal(error.cause, crash);
      assert.equal(error.message, crash.message);
      assert.equal(failureCodeOf(error), 'tool_error');
      return true;
    },
  );
});

test('a provider failure that surfaces through a tool keeps its kind', async () => {
  const limited = new ProviderCallError('rate_limit', 429, null, 'Lab', 'Lab is limiting us.');
  await assert.rejects(
    toolLoop(async () => {
      throw limited;
    }),
    (error: unknown) => error === limited && failureCodeOf(error) === 'rate_limited',
  );
  assert.equal(failureCodeOf(new ProviderSilenceError(120_000)), 'provider_silence');
  assert.equal(failureCodeOf(new Error('boom')), 'internal');
});
