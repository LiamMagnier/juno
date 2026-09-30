import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_HEADER, createProxyProvider, type BackendCatalogModel } from '../providers/proxy.js';
import type { ProviderStreamEvent } from '../providers/types.js';
import { anthropicStream, anthropicTurn, openAIStream, recordingFetch } from './recorded.js';

/*
 * Cost attribution: every call a cloud run makes through Juno's proxy says
 * which run it belongs to, so a spend row can be joined to a task rather than
 * only to its owner.
 */

const CATALOG: BackendCatalogModel[] = [
  { provider: 'anthropic', kind: 'anthropic', model: 'claude-sonnet-5', label: 'Sonnet 5', available: true },
  { provider: 'zhipu', kind: 'openai', model: 'glm-5.2', label: 'GLM-5.2', available: true },
];

async function drain(stream: AsyncGenerator<ProviderStreamEvent>): Promise<void> {
  for await (const _ of stream) {
    // drain
  }
}

const REQUEST = {
  system: 's',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
  tools: [],
};

test('both wires carry the run id beside the task bearer', async () => {
  const anthropic = recordingFetch([
    () => anthropicStream(anthropicTurn({ blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
  ]);
  const claude = createProxyProvider(
    { baseUrl: 'https://juno.test/api/agent', cookie: '', authorization: 'Bearer cct_x', models: CATALOG, runId: 'cmg1task42', fetch: anthropic.fetch },
    'backend/anthropic',
  );
  await drain(claude.stream({ ...REQUEST, model: 'claude-sonnet-5' }));
  assert.equal(anthropic.requests[0]!.url, 'https://juno.test/api/agent/anthropic/v1/messages');
  assert.equal(anthropic.requests[0]!.headers[RUN_HEADER], 'cmg1task42');
  assert.equal(anthropic.requests[0]!.headers.authorization, 'Bearer cct_x');

  const compat = recordingFetch([
    () =>
      openAIStream([
        { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'glm-5.2', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] },
      ]),
  ]);
  const glm = createProxyProvider(
    { baseUrl: 'https://juno.test/api/agent', cookie: '', authorization: 'Bearer cct_x', models: CATALOG, runId: 'cmg1task42', fetch: compat.fetch },
    'backend/zhipu',
  );
  await drain(glm.stream({ ...REQUEST, model: 'glm-5.2' }));
  assert.equal(compat.requests[0]!.headers[RUN_HEADER], 'cmg1task42');
});

test('no run, or a value that is not an id, sends no header', async () => {
  for (const runId of [undefined, 'two words', 'x'.repeat(200), 'a\nb']) {
    const { fetch, requests } = recordingFetch([
      () => anthropicStream(anthropicTurn({ blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
    ]);
    const provider = createProxyProvider(
      { baseUrl: 'https://juno.test/api/agent', cookie: 'session=1', models: CATALOG, ...(runId === undefined ? {} : { runId }), fetch },
      'backend/anthropic',
    );
    await drain(provider.stream({ ...REQUEST, model: 'claude-sonnet-5' }));
    assert.equal(requests[0]!.headers[RUN_HEADER], undefined, String(runId));
  }
});
