import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { AnthropicAdapter, THINKING_BINDING_BETA } from '../providers/anthropic.js';
import type { ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';
import { anthropicStream, anthropicTurn, recordingFetch } from './recorded.js';

/*
 * Thinking continuity: a model in the middle of a tool loop reads its own
 * earlier reasoning only if the signed blocks come back unchanged, in the
 * order they streamed, to the model that wrote them. These run recorded-shape
 * Messages streams through the real Anthropic SDK and look at what goes back
 * over the wire.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-thinking-test-'));
}

const SIG_A = 'EqQBCkYIBxgCKkDsignature-a+/=';
const SIG_B = 'EqQBCkYIBxgCKkDsignature-b+/=';

async function events(adapter: AnthropicAdapter, messages: ChatMessage[], effort?: 'high'): Promise<ProviderStreamEvent[]> {
  const seen: ProviderStreamEvent[] = [];
  for await (const event of adapter.stream({
    model: 'claude-sonnet-5',
    system: 's',
    messages,
    tools: [{ name: 'read_file', description: 'r', inputSchema: { type: 'object' } }],
    ...(effort ? { reasoningEffort: effort } : {}),
  })) {
    seen.push(event);
  }
  return seen;
}

test('signed and redacted blocks are yielded whole, in stream order, as each one closes', async () => {
  const { fetch } = recordingFetch([
    () =>
      anthropicStream(
        anthropicTurn({
          blocks: [
            { type: 'thinking', thinking: 'The file is small; read it first.', signature: SIG_A },
            { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' },
            { type: 'text', text: 'Reading it.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 30 },
        }),
      ),
  ]);
  const seen = await events(new AnthropicAdapter('key', { fetch }), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], 'high');
  assert.deepEqual(
    seen.map((event) => event.type),
    ['thinking_delta', 'thinking_delta', 'reasoning_block', 'reasoning_block', 'text_delta', 'tool_call', 'done'],
  );
  assert.deepEqual(seen[2], {
    type: 'reasoning_block',
    block: { type: 'thinking', thinking: 'The file is small; read it first.', signature: SIG_A },
  });
  assert.deepEqual(seen[3], { type: 'reasoning_block', block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix/LafPsn4a' } });
});

test('an unsigned thinking block is shown but never kept', async () => {
  const turn = anthropicTurn({
    blocks: [{ type: 'thinking', thinking: 'Hmm.', signature: 'x' }, { type: 'text', text: 'Hi.' }],
    stopReason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 5 },
  }).filter((event) => !(event.type === 'content_block_delta' && (event.delta as { type: string }).type === 'signature_delta'));
  const { fetch } = recordingFetch([() => anthropicStream(turn)]);
  const seen = await events(new AnthropicAdapter('key', { fetch }), [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], 'high');
  assert.ok(seen.some((event) => event.type === 'thinking_delta'));
  assert.ok(!seen.some((event) => event.type === 'reasoning_block'));
});

test('the tool loop sends each step its earlier reasoning back unchanged and in place', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello');
  const { fetch, requests } = recordingFetch([
    () =>
      anthropicStream(
        anthropicTurn({
          blocks: [
            { type: 'thinking', thinking: 'I should look at notes.txt before answering.', signature: SIG_A },
            { type: 'text', text: 'Let me read it.' },
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 40, output_tokens: 20 },
        }),
      ),
    () =>
      anthropicStream(
        anthropicTurn({
          blocks: [
            { type: 'thinking', thinking: 'It says hello.', signature: SIG_B },
            { type: 'text', text: 'It says hello.' },
          ],
          stopReason: 'end_turn',
          usage: { input_tokens: 60, output_tokens: 10 },
        }),
      ),
  ]);
  const session = AgentSession.create({
    provider: new AnthropicAdapter('key', { fetch }),
    cwd,
    model: 'claude-sonnet-5',
    mode: 'full',
    subagents: false,
    reasoningEffort: 'high',
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await session.prompt('what does notes.txt say?');
  assert.equal(requests.length, 2);

  const second = requests[1]!;
  assert.match(second.headers['anthropic-beta'] ?? '', new RegExp(THINKING_BINDING_BETA));
  const assistant = (second.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).find(
    (message) => message.role === 'assistant',
  )!;
  assert.deepEqual(
    assistant.content.map((block) => {
      const { cache_control: _ignored, ...rest } = block;
      return rest;
    }),
    [
      { type: 'thinking', thinking: 'I should look at notes.txt before answering.', signature: SIG_A },
      { type: 'text', text: 'Let me read it.' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
    ],
  );
});

test('blocks go back only to the model that wrote them, and only when it is thinking', async () => {
  const transcript = (model: string): ChatMessage[] => [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'plan', signature: SIG_A, model },
        { type: 'redacted_thinking', data: 'sealed', model },
        { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'a' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'x' }] },
  ];
  const sent = async (messages: ChatMessage[], effort?: 'high') => {
    const { fetch, requests } = recordingFetch([
      () => anthropicStream(anthropicTurn({ blocks: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })),
    ]);
    await events(new AnthropicAdapter('key', { fetch }), messages, effort);
    const assistant = (requests[0]!.body.messages as Array<{ role: string; content: Array<{ type: string }> }>)[1]!;
    return assistant.content.map((block) => block.type);
  };
  assert.deepEqual(await sent(transcript('claude-sonnet-5'), 'high'), ['thinking', 'redacted_thinking', 'tool_use']);
  // The run moved to another model: the signatures mean nothing to it.
  assert.deepEqual(await sent(transcript('claude-opus-4-8'), 'high'), ['tool_use']);
  // Thinking is off for this request.
  assert.deepEqual(await sent(transcript('claude-sonnet-5')), ['tool_use']);
});
