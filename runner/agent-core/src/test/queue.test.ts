import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';

/*
 * The two things a cloud follow-up needs from the session: the conversation
 * it continues, and a way to take an instruction while a turn is running.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-queue-test-'));
}

/** Scripted provider that also records every request's transcript and lets a
 *  test act in the middle of a step, which is where a steer arrives. */
function recordingProvider(
  turns: ProviderStreamEvent[][],
  onStream?: (call: number) => void,
): { provider: ProviderAdapter; requests: ChatMessage[][] } {
  const requests: ChatMessage[][] = [];
  let call = 0;
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock-1',
    models: () => ['mock-1'],
    capabilities: () => ({
      tools: true,
      vision: false,
      computerUse: false,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      // Snapshot: the loop mutates the array in place between steps.
      requests.push(req.messages.map((m) => ({ ...m, content: [...m.content] }) as ChatMessage));
      const script = turns[call] ?? [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      onStream?.(call);
      call++;
      for (const ev of script) yield ev;
    },
  };
  return { provider, requests };
}

const END: ProviderStreamEvent[] = [
  { type: 'text_delta', text: 'done' },
  { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
];

test('seedHistory puts the earlier turns ahead of the first prompt, and refuses afterwards', async () => {
  process.env.JUNO_HOME = tmpdir();
  const { provider, requests } = recordingProvider([END]);
  const session = AgentSession.create({
    provider,
    cwd: tmpdir(),
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  session.seedHistory([
    { role: 'user', text: 'add a login form' },
    { role: 'assistant', text: 'Added LoginForm.tsx.' },
    { role: 'user', text: '   ' },
  ]);
  await session.prompt('now add tests for it');

  const first = requests[0];
  assert.equal(first.length, 3, 'two seeded turns (the blank one dropped) and the live prompt');
  assert.deepEqual(first[0], { role: 'user', content: [{ type: 'text', text: 'add a login form' }] });
  assert.deepEqual(first[1], { role: 'assistant', content: [{ type: 'text', text: 'Added LoginForm.tsx.' }] });
  assert.deepEqual(first[2], { role: 'user', content: [{ type: 'text', text: 'now add tests for it' }] });

  assert.throws(() => session.seedHistory([{ role: 'user', text: 'too late' }]), /already has messages/);
});

test('a message queued mid-turn rides into the next step and resolves when taken', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello');

  let session: AgentSession | null = null;
  let consumed = false;
  let queued: Promise<void> | null = null;
  const { provider, requests } = recordingProvider(
    [
      // Step 1: the model reads a file. The steer arrives while this step runs.
      [
        { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'notes.txt' } },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      END,
    ],
    (call) => {
      if (call === 0 && session) {
        queued = session.queueUserMessage('also check the README').then(() => {
          consumed = true;
        });
      }
      if (call === 1) {
        // Taken at the top of this step — before the provider was asked.
        assert.equal(consumed, true, 'the promise resolves before the next request goes out');
      }
    },
  );
  session = AgentSession.create({
    provider,
    cwd,
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await session.prompt('summarise notes.txt');
  await queued;

  assert.equal(requests.length, 2);
  const second = requests[1];
  const last = second[second.length - 1];
  assert.equal(last.role, 'user');
  // The tool result the step is answering, then the instruction beside it —
  // one user message, so the alternation every provider requires holds.
  assert.equal(last.content[0].type, 'tool_result');
  assert.deepEqual(last.content[last.content.length - 1], { type: 'text', text: 'also check the README' });
  assert.equal(session.hasQueuedUserMessages, false);
});

test('instructions left after the turn are drained by the host, which resolves them', async () => {
  process.env.JUNO_HOME = tmpdir();
  const { provider } = recordingProvider([END]);
  const session = AgentSession.create({
    provider,
    cwd: tmpdir(),
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await session.prompt('first');
  let resolved = 0;
  const a = session.queueUserMessage('one').then(() => resolved++);
  const b = session.queueUserMessage('two').then(() => resolved++);
  assert.equal(session.hasQueuedUserMessages, true);
  assert.deepEqual(session.takeQueuedUserMessages(), ['one', 'two']);
  await Promise.all([a, b]);
  assert.equal(resolved, 2);
  assert.equal(session.hasQueuedUserMessages, false);
});
