import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AgentSession } from '../agent.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest } from '../types.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-subagent-test-'));
}

function gitRepo(files: Record<string, string> = { 'README.md': 'hello\n' }): string {
  const cwd = tmpdir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
    fs.writeFileSync(path.join(cwd, name), content);
  }
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync(
    'git',
    ['-c', 'user.email=test@juno.dev', '-c', 'user.name=Juno', 'commit', '-q', '-m', 'init'],
    { cwd },
  );
  return cwd;
}

function taskText(req: ProviderRequest): string {
  const first = req.messages[0];
  if (!first || first.role !== 'user') return '';
  const block = first.content[0];
  return block && block.type === 'text' ? block.text : '';
}

function isChildRequest(req: ProviderRequest): boolean {
  return req.system.includes('SUBAGENT');
}

/** Router provider: each stream() call is answered by the routing function. */
function routedProvider(
  route: (req: ProviderRequest, rootCall: number) => ProviderStreamEvent[] | 'hang',
): ProviderAdapter {
  let rootCalls = 0;
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
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      const index = isChildRequest(req) ? -1 : rootCalls++;
      const script = route(req, index);
      if (script === 'hang') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return;
      }
      for (const ev of script) yield ev;
    },
  };
}

const done = (
  stop: 'end_turn' | 'tool_use' | 'max_tokens' | 'other',
  input = 1,
  output = 1,
): ProviderStreamEvent => ({
  type: 'done',
  stopReason: stop,
  usage: { inputTokens: input, outputTokens: output },
});

function delegateCall(tasks: unknown): ProviderStreamEvent[] {
  return [
    { type: 'tool_call', id: 'd1', name: 'delegate_tasks', input: { tasks } },
    done('tool_use'),
  ];
}

const awaitCall: ProviderStreamEvent[] = [
  { type: 'tool_call', id: 'a1', name: 'await_subagents', input: {} },
  done('tool_use'),
];

function makeSession(
  provider: ProviderAdapter,
  cwd: string,
  opts: {
    mode?: 'plan' | 'ask' | 'auto-edit' | 'full';
    onApproval?: (req: ApprovalRequest) => ApprovalDecision;
    subagents?: Record<string, unknown>;
  } = {},
): { session: AgentSession; events: AgentEvent[]; approvals: ApprovalRequest[] } {
  const events: AgentEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const session = AgentSession.create({
    provider,
    cwd,
    mode: opts.mode ?? 'full',
    subagents: opts.subagents,
    callbacks: {
      onEvent: (e) => events.push(e),
      requestApproval: async (req): Promise<ApprovalDecision> => {
        approvals.push(req);
        return opts.onApproval ? opts.onApproval(req) : 'allow';
      },
    },
  });
  return { session, events, approvals };
}

test('root delegates read-only children with isolated contexts and aggregates results', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = gitRepo();
  const childRequests: ProviderRequest[] = [];

  const provider = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) {
      childRequests.push(req);
      const text = taskText(req);
      if (text.includes('# Task: Alpha')) {
        return [{ type: 'text_delta', text: 'ALPHA-RESULT' }, done('end_turn', 10, 5)];
      }
      return [{ type: 'text_delta', text: 'BETA-RESULT' }, done('end_turn', 20, 7)];
    }
    if (rootCall === 0) {
      return delegateCall([
        { title: 'Alpha', prompt: 'investigate alpha', role: 'explorer' },
        { title: 'Beta', prompt: 'investigate beta', role: 'explorer' },
      ]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'synthesis' }, done('end_turn')];
  });

  const { session, events } = makeSession(provider, cwd);
  await session.prompt('run two investigations');

  // Both children ran with FRESH, isolated contexts (their own task only).
  assert.equal(childRequests.length, 2);
  for (const req of childRequests) {
    const text = taskText(req);
    const mentions = ['investigate alpha', 'investigate beta'].filter((m) => text.includes(m));
    assert.equal(mentions.length, 1);
    assert.ok(req.system.includes('SUBAGENT'));
    assert.ok(req.system.includes('CANNOT delegate'));
  }

  // The parent got structured summaries back (never transcripts).
  const messages = session.store.loadMessages();
  const flat = JSON.stringify(messages);
  assert.ok(flat.includes('ALPHA-RESULT'));
  assert.ok(flat.includes('BETA-RESULT'));

  // Lifecycle snapshots streamed, and both completed.
  const updates = events.filter((e) => e.type === 'subagent_update');
  assert.ok(updates.length >= 4);
  const finalStates = session.subagents!.states();
  assert.equal(finalStates.length, 2);
  assert.ok(finalStates.every((s) => s.status === 'completed'));

  // Child usage aggregated onto the turn (real model calls, never hidden).
  const turnEnd = events.find((e) => e.type === 'turn_finished');
  assert.ok(turnEnd && turnEnd.type === 'turn_finished');
  assert.deepEqual(turnEnd.subagentUsage, { inputTokens: 30, outputTokens: 12 });
  delete process.env.JUNO_HOME;
});

test('children cannot nest delegation, and per-turn caps hold', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = gitRepo();
  let sawNestedRejection = false;

  const provider = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) {
      const lastUser = req.messages[req.messages.length - 1];
      const rejected =
        lastUser?.role === 'user' &&
        lastUser.content.some(
          (c) => c.type === 'tool_result' && c.content.includes('cannot delegate'),
        );
      if (rejected) {
        sawNestedRejection = true;
        return [{ type: 'text_delta', text: 'understood' }, done('end_turn')];
      }
      return [
        {
          type: 'tool_call',
          id: 'n1',
          name: 'delegate_tasks',
          input: { tasks: [{ title: 'nested', prompt: 'x', role: 'explorer' }] },
        },
        done('tool_use'),
      ];
    }
    if (rootCall === 0) {
      return delegateCall([{ title: 'Sneaky', prompt: 'try to nest', role: 'explorer' }]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });

  const { session } = makeSession(provider, cwd);
  await session.prompt('nest attempt');
  assert.ok(sawNestedRejection);
  assert.equal(session.subagents!.states().length, 1);

  // Per-turn cap: a 5-task delegation is refused outright.
  const provider2 = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) return [{ type: 'text_delta', text: 'x' }, done('end_turn')];
    if (rootCall === 0) {
      return delegateCall(
        [1, 2, 3, 4, 5].map((i) => ({ title: `T${i}`, prompt: 'p', role: 'explorer' })),
      );
    }
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });
  const second = makeSession(provider2, cwd);
  await second.session.prompt('too many');
  const transcript = JSON.stringify(second.session.store.loadMessages());
  assert.ok(transcript.includes('at most 4'));
  assert.equal(second.session.subagents!.states().length, 0);
  delete process.env.JUNO_HOME;
});

test('writing child works in a worktree; import is permission-gated; main checkout stays intact until approved', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = gitRepo({ 'file.txt': 'original\n' });
  let mainDuringChild = '';

  const provider = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) {
      const lastUser = req.messages[req.messages.length - 1];
      const wrote =
        lastUser?.role === 'user' &&
        lastUser.content.some((c) => c.type === 'tool_result' && !c.isError);
      if (wrote) {
        // The child already edited ITS worktree — the real checkout must
        // still be untouched at this exact moment.
        mainDuringChild = fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8');
        return [{ type: 'text_delta', text: 'edited the file' }, done('end_turn')];
      }
      return [
        {
          type: 'tool_call',
          id: 'w1',
          name: 'write_file',
          input: { path: 'file.txt', content: 'agent version\n' },
        },
        done('tool_use'),
      ];
    }
    if (rootCall === 0) {
      return delegateCall([
        { title: 'Edit file', prompt: 'change file.txt', role: 'builder', writes: true },
      ]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });

  // 'ask' mode: the import itself must come to the user for approval.
  const { session, approvals } = makeSession(provider, cwd, { mode: 'ask' });
  await session.prompt('edit via agent');

  assert.equal(mainDuringChild, 'original\n');
  const importApproval = approvals.find((a) => a.toolName === 'apply_subagent_changes');
  assert.ok(importApproval, 'import must be approval-gated in ask mode');
  assert.ok(importApproval.agentLabel?.includes('builder'));
  // Approved → applied to the real checkout, attributed as applied.
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'agent version\n');
  const state = session.subagents!.states()[0];
  assert.equal(state.status, 'completed');
  assert.equal(state.applied, true);
  assert.deepEqual(state.filesChanged, ['file.txt']);
  // Checkpoint-backed: undo restores the pre-import content.
  const restored = session.undoLastTurn();
  assert.ok(restored.some((p) => p.endsWith('file.txt')));
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'original\n');
  delete process.env.JUNO_HOME;
});

test('conflicting import escalates to a sensitive approval and a denial preserves the branch', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = gitRepo({ 'shared.txt': 'base\n' });

  const provider = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) {
      const lastUser = req.messages[req.messages.length - 1];
      const wrote =
        lastUser?.role === 'user' &&
        lastUser.content.some((c) => c.type === 'tool_result' && !c.isError);
      if (wrote) {
        // Simulate the USER editing the same file while the agent worked.
        fs.writeFileSync(path.join(cwd, 'shared.txt'), 'user version\n');
        return [{ type: 'text_delta', text: 'edited' }, done('end_turn')];
      }
      return [
        {
          type: 'tool_call',
          id: 'w1',
          name: 'write_file',
          input: { path: 'shared.txt', content: 'child version\n' },
        },
        done('tool_use'),
      ];
    }
    if (rootCall === 0) {
      return delegateCall([
        { title: 'Conflicter', prompt: 'edit shared.txt', role: 'builder', writes: true },
      ]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });

  // FULL access mode — a conflicted import must STILL ask (sensitive gate).
  const { session, approvals } = makeSession(provider, cwd, {
    mode: 'full',
    onApproval: (req) => (req.toolName === 'apply_subagent_changes' ? 'deny' : 'allow'),
  });
  await session.prompt('conflict scenario');

  const importApproval = approvals.find((a) => a.toolName === 'apply_subagent_changes');
  assert.ok(importApproval, 'conflicted import must ask even in full mode');
  assert.equal(importApproval.risk, 'sensitive');
  // Denied → NOTHING overwritten; the branch is preserved and reported.
  assert.equal(fs.readFileSync(path.join(cwd, 'shared.txt'), 'utf8'), 'user version\n');
  const state = session.subagents!.states()[0];
  assert.equal(state.applied, undefined);
  assert.deepEqual(state.conflictedFiles, ['shared.txt']);
  assert.ok(state.worktreeBranch?.startsWith('juno/agent/'));
  assert.ok(state.warnings?.some((w) => w.includes('NOT applied')));
  delete process.env.JUNO_HOME;
});

test('budgets stop runaway children, and abort cancels running children', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = gitRepo();

  // Runaway child: burns tokens and keeps asking for tools.
  const provider = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) {
      return [
        { type: 'tool_call', id: 'r1', name: 'read_file', input: { path: 'README.md' } },
        done('tool_use', 400, 200),
      ];
    }
    if (rootCall === 0) {
      return delegateCall([{ title: 'Runaway', prompt: 'spin', role: 'explorer' }]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });
  const { session } = makeSession(provider, cwd, { subagents: { childTokenBudget: 1000 } });
  await session.prompt('budget check');
  const state = session.subagents!.states()[0];
  assert.equal(state.status, 'failed');
  assert.ok(state.error?.includes('token budget'));
  assert.ok(state.usage.inputTokens + state.usage.outputTokens >= 1000);

  // Abort mid-run: the child's provider stream hangs until the signal fires.
  const provider2 = routedProvider((req, rootCall) => {
    if (isChildRequest(req)) return 'hang';
    if (rootCall === 0) {
      return delegateCall([{ title: 'Sleeper', prompt: 'wait forever', role: 'explorer' }]);
    }
    if (rootCall === 1) return awaitCall;
    return [{ type: 'text_delta', text: 'done' }, done('end_turn')];
  });
  const second = makeSession(provider2, cwd);
  const turn = second.session.prompt('start then stop');
  await new Promise((resolve) => setTimeout(resolve, 150));
  second.session.abort();
  await turn;
  const sleeper = second.session.subagents!.states()[0];
  assert.ok(sleeper.status === 'cancelled' || sleeper.status === 'interrupted');
  delete process.env.JUNO_HOME;
});
