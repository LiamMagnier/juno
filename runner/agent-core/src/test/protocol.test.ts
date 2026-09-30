import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { AgentProtocolProjector } from '../protocol-projector.js';
import { LegacyTaskDowncast } from '../protocol-legacy.js';
import { validateAgentEvent, type AgentEvent as ProtocolEvent } from '../protocol.generated.js';
import type { ProviderAdapter, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent } from '../types.js';

/*
 * The engine's events, projected onto the canonical protocol by a real
 * session: the same path the cloud runner takes. Every event must be one a
 * strict validator accepts, tool outcomes must be typed, and a refusal the host
 * made by its permission mode must say so rather than inventing a user.
 */

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-protocol-test-'));
}

function scripted(turns: ProviderStreamEvent[][]): ProviderAdapter {
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
    async *stream(): AsyncGenerator<ProviderStreamEvent> {
      const script = turns[call] ?? [
        { type: 'text_delta', text: 'done' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ];
      call++;
      for (const ev of script) yield ev;
    },
  };
}

async function run(mode: 'full' | 'auto-edit') {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello');
  const engine: AgentEvent[] = [];
  const projector = new AgentProtocolProjector({
    sessionId: 'task-1',
    runId: 'run-1',
    repository: { owner: 'liam', name: 'juno' },
    now: () => new Date('2026-09-30T10:00:00.000Z'),
  });
  const events: ProtocolEvent[] = [];
  const session = AgentSession.create({
    provider: scripted([
      [
        { type: 'thinking_delta', text: 'Read first.' },
        { type: 'text_delta', text: 'Reading ' },
        { type: 'text_delta', text: 'the notes.' },
        { type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'notes.txt' } },
        { type: 'tool_call', id: 't2', name: 'bash', input: { command: 'rm -rf /tmp/juno-protocol-probe' } },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 120, outputTokens: 30 } },
      ],
      [
        { type: 'text_delta', text: 'Done.' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 200, outputTokens: 10 } },
      ],
    ]),
    cwd,
    mode,
    subagents: false,
    callbacks: {
      onEvent: (event) => {
        engine.push(event);
        events.push(...projector.project(event));
      },
      // The cloud runner's answer: the mode decides, and says so.
      requestApproval: async (request) => {
        const allowed = mode === 'full';
        projector.noteApprovalAnswer(request.callId, {
          by: 'mode',
          ...(allowed ? {} : { feedback: 'this run is set to Accept edits' }),
        });
        return allowed ? 'allow' : 'deny';
      },
    },
  });
  projector.queueTurnMessage({ text: 'Tidy the notes', delivery: 'prompt' });
  await session.prompt('Tidy the notes');
  return { engine, events };
}

test('every projected event is valid, and outcomes are typed', async () => {
  const { events } = await run('auto-edit');
  for (const event of events) assert.deepEqual(validateAgentEvent(event), [], `${event.type} breaks the contract`);

  const types = events.map((event) => event.type);
  assert.equal(types[0], 'session.created');
  assert.equal(types[1], 'turn.started');
  assert.equal(types[2], 'item.user_message', 'the prompt opens the turn it started');
  const created = events[0];
  assert.equal(created.type === 'session.created' ? created.mode : null, 'auto_edit');
  assert.deepEqual(created.type === 'session.created' ? created.repository : null, { owner: 'liam', name: 'juno' });
  assert.ok(types.includes('item.thinking.delta'));
  assert.equal(types.at(-1), 'turn.completed');

  const results = events.filter((event) => event.type === 'item.tool_result');
  const byItem = Object.fromEntries(results.map((event) => [event.itemId, event.status]));
  assert.equal(byItem.t1, 'ok');
  assert.equal(byItem.t2, 'denied', 'a refused command is denied, not failed');

  // The refusal is the mode's, with the mode's reason — never "the user declined".
  const resolved = events.find((event) => event.type === 'approval.resolved');
  assert.equal(resolved?.type === 'approval.resolved' ? resolved.by : null, 'mode');
  const denied = results.find((event) => event.itemId === 't2');
  assert.equal(denied?.summary, 'this run is set to Accept edits');

  // Every event of the turn names it, and the call it refused was announced
  // before its approval, with a title a person reads.
  const turnId = events[1].turnId;
  assert.ok(turnId);
  assert.ok(events.slice(1).every((event) => event.turnId === turnId));
  assert.equal(events[0].turnId, undefined, 'the session is not inside a turn');
  const call = events.find((event) => event.type === 'item.tool_call' && event.itemId === 't2');
  assert.equal(call?.type === 'item.tool_call' ? call.title : null, '$ rm -rf /tmp/juno-protocol-probe');
  assert.equal(call?.type === 'item.tool_call' ? call.toolKind : null, 'execute');

  const usage = events.filter((event) => event.type === 'usage.updated');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].type === 'usage.updated' ? usage[0].usage : null, { inputTokens: 320, outputTokens: 40 });
});

test('the legacy rows an old reader gets are the ones the runner always wrote', async () => {
  const { events } = await run('auto-edit');
  const downcast = new LegacyTaskDowncast({ approvalsAnsweredByMode: true, markDerived: true });
  const rows = events.flatMap((event) => downcast.rows(event));
  const kinds = rows.map((row) => row.kind);
  assert.deepEqual(kinds.filter((kind) => kind === 'approval_request'), [], 'nobody was asked, so no request row');
  const approval = rows.find((row) => row.kind === 'tool' && row.payload.name === 'approval');
  assert.match(String(approval?.payload.summary), /^Denied — this run is set to Accept edits: \$ rm -rf \/tmp\/juno-protocol-probe/);
  assert.equal(approval?.payload.risk, 'destructive');
  // One refused call is one row: its own denied row is not written again.
  assert.equal(rows.filter((row) => row.kind === 'tool' && String(row.payload.summary).startsWith('Denied bash')).length, 0);
  const read = rows.find((row) => row.kind === 'tool' && row.payload.name === 'read_file');
  assert.equal(read?.payload.summary, 'Read notes.txt', 'no " — ok" suffix: the outcome is typed');
  assert.equal(rows.filter((row) => row.kind === 'text').map((row) => row.payload.text).join(''), 'Reading the notes.Done.');
  assert.ok(rows.every((row) => typeof row.payload.protocolEventId === 'string'), 'every twin names its protocol event');
});

test('under full access the mode allows, and the row says it was automatic', async () => {
  const { events } = await run('full');
  const resolved = events.filter((event) => event.type === 'approval.resolved');
  for (const event of resolved) {
    assert.equal(event.type === 'approval.resolved' ? event.decision : null, 'allow_once');
    assert.equal(event.type === 'approval.resolved' ? event.by : null, 'mode');
  }
  const downcast = new LegacyTaskDowncast({ approvalsAnsweredByMode: true });
  const rows = events.flatMap((event) => downcast.rows(event));
  const allowed = rows.filter((row) => row.kind === 'tool' && row.payload.name === 'approval');
  assert.ok(allowed.every((row) => row.payload.autoAllowed === true));
});
