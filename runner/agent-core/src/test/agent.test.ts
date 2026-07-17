import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from '../types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-agent-test-'));
}

/** Scripted provider: replays a fixed sequence of turns, one per stream() call. */
function mockProvider(turns: ProviderStreamEvent[][]): ProviderAdapter {
  let call = 0;
  return {
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
    // eslint-disable-next-line require-yield
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const script = turns[call] ?? [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      call++;
      for (const ev of script) yield ev;
    },
  };
}

test('agent loop executes tools, gates approvals, checkpoints, and undoes', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'greet.txt'), 'hello');

  const provider = mockProvider([
    // step 1: model edits a file, then wants to run a command
    [
      { type: 'text_delta', text: 'Editing now.' },
      {
        type: 'tool_call',
        id: 't1',
        name: 'edit_file',
        input: { path: 'greet.txt', old_string: 'hello', new_string: 'goodbye' },
      },
      {
        type: 'tool_call',
        id: 't2',
        name: 'bash',
        input: { command: 'cat greet.txt' },
      },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
    ],
    // step 2: model finishes
    [
      { type: 'text_delta', text: 'All set.' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 3 } },
    ],
  ]);

  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'auto-edit', // edits auto-approved, commands must ask
    callbacks: {
      onEvent: (e) => events.push(e),
      requestApproval: async (req): Promise<ApprovalDecision> => {
        approvals.push(req);
        return 'allow';
      },
    },
  });

  await session.prompt('flip the greeting');

  // The edit ran without approval; the bash command required one.
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'bash');
  assert.equal(fs.readFileSync(path.join(cwd, 'greet.txt'), 'utf8'), 'goodbye');

  // Tool results flowed back and the loop reached end_turn.
  const finished = events.filter((e) => e.type === 'tool_finished');
  assert.equal(finished.length, 2);
  const turnEnd = events.find((e) => e.type === 'turn_finished');
  assert.ok(turnEnd && turnEnd.type === 'turn_finished' && turnEnd.stopReason === 'end_turn');
  assert.ok(events.some((e) => e.type === 'files_changed'));

  // Transcript persisted with tool_call + tool_result pairs for resume.
  const messages = session.store.loadMessages();
  const assistantWithTools = messages.find(
    (m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool_call'),
  );
  assert.ok(assistantWithTools);

  // Undo restores the pre-turn file state.
  const restored = session.undoLastTurn();
  assert.equal(restored.length, 1);
  assert.equal(fs.readFileSync(path.join(cwd, 'greet.txt'), 'utf8'), 'hello');
  delete process.env.JUNO_HOME;
});

test('plan mode denies mutating tools and tells the model why', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'v');

  const provider = mockProvider([
    [
      {
        type: 'tool_call',
        id: 'p1',
        name: 'write_file',
        input: { path: 'x.txt', content: 'mutated' },
      },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: 'text_delta', text: 'Understood, plan only.' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);

  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'plan',
    callbacks: {
      onEvent: (e) => events.push(e),
      requestApproval: async () => 'allow',
    },
  });
  await session.prompt('please plan');

  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'v'); // untouched
  const denied = events.find((e) => e.type === 'tool_denied');
  assert.ok(denied && denied.type === 'tool_denied' && denied.reason.includes('plan mode'));
  delete process.env.JUNO_HOME;
});

test('denied approval feeds an error result back and nothing executes', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();

  const provider = mockProvider([
    [
      {
        type: 'tool_call',
        id: 'd1',
        name: 'bash',
        input: { command: 'touch should-not-exist.txt' },
      },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      { type: 'text_delta', text: 'Okay, skipping.' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);

  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'ask',
    callbacks: {
      onEvent: () => {},
      requestApproval: async () => 'deny',
    },
  });
  await session.prompt('try something');

  assert.ok(!fs.existsSync(path.join(cwd, 'should-not-exist.txt')));
  const messages = session.store.loadMessages();
  const resultMsg = messages.find(
    (m) => m.role === 'user' && m.content.some((c) => c.type === 'tool_result' && c.isError),
  );
  assert.ok(resultMsg, 'denial should be recorded as an error tool_result');
  delete process.env.JUNO_HOME;
});

/** Records reserve/record/refund calls for the usage-accounting tests. */
function mockReporter(reserveResult: { allowed: boolean; message?: string } = { allowed: true }) {
  const calls: string[] = [];
  return {
    calls,
    reporter: {
      async reserve() { calls.push('reserve'); return reserveResult; },
      async record(model: string, usage: { inputTokens: number; outputTokens: number }) {
        calls.push(`record:${usage.inputTokens}/${usage.outputTokens}`);
      },
      async refund() { calls.push('refund'); },
    },
  };
}

test('usage: a productive turn reserves once and records tokens (no refund)', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  const provider = mockProvider([
    [
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5 } },
    ],
  ]);
  const { calls, reporter } = mockReporter();
  const session = AgentSession.create({
    provider, cwd, mode: 'ask',
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
    usageReporter: reporter,
  });
  await session.prompt('do a thing');
  // Exactly one reserve, one record, no refund — even though the turn is one
  // generation regardless of how many tool round-trips it would take.
  assert.deepEqual(calls, ['reserve', 'record:12/5']);
  delete process.env.JUNO_HOME;
});

test('usage: an exhausted plan blocks the turn before any model call', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  let streamed = false;
  const provider = mockProvider([]);
  const wrapped: typeof provider = {
    ...provider,
    async *stream(req) { streamed = true; yield* provider.stream(req); },
  };
  const { calls, reporter } = mockReporter({ allowed: false, message: 'Monthly limit reached.' });
  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider: wrapped, cwd, mode: 'ask',
    callbacks: { onEvent: (e) => events.push(e), requestApproval: async () => 'allow' },
    usageReporter: reporter,
  });
  await session.prompt('blocked');
  assert.equal(streamed, false, 'model must not be called when reservation is refused');
  assert.deepEqual(calls, ['reserve']);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error' && err.message.includes('limit'));
  delete process.env.JUNO_HOME;
});

test('usage: a turn that produces no tokens refunds the reservation', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  // Provider throws before any usage — mimics a provider 5xx / abort.
  const provider: ProviderAdapter = {
    id: 'mock', name: 'Mock', defaultModel: 'mock-1', models: () => ['mock-1'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('provider 500'); },
  };
  const { calls, reporter } = mockReporter();
  const session = AgentSession.create({
    provider, cwd, mode: 'ask',
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
    usageReporter: reporter,
  });
  await session.prompt('will fail');
  assert.deepEqual(calls, ['reserve', 'refund'], 'a failed/zero-token turn must refund, not burn quota');
  delete process.env.JUNO_HOME;
});
