import { workflowGuestAvailable } from '../harness/workflow.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentSession, type AgentOptions } from '../agent.js';
import type { ProviderRequest } from '../providers/types.js';
import type { AgentEvent, ApprovalDecision } from '../types.js';
import type { TurnItemOp } from '../harness/turn-items.js';
import type { RoleRouting } from '../contracts/code-v2.js';
import type { UsageReporter } from '../usage.js';
import {
  call,
  done,
  gitRepo,
  isChild,
  lastUserText,
  say,
  scriptedProvider,
  tmpdir,
  userText,
  type Script,
  type ScriptedProvider,
} from './fake-provider.js';

function session(
  provider: ScriptedProvider,
  cwd: string,
  extra: Partial<AgentOptions> = {},
): { session: AgentSession; events: AgentEvent[]; items: TurnItemOp[] } {
  process.env.JUNO_HOME = tmpdir('alevr-home-');
  const events: AgentEvent[] = [];
  const items: TurnItemOp[] = [];
  const s = AgentSession.create({
    provider,
    cwd,
    mode: 'full',
    ...extra,
    callbacks: {
      onEvent: (e) => events.push(e),
      requestApproval: async (): Promise<ApprovalDecision> => 'allow',
      onTurnItem: (op) => items.push(op),
    },
  });
  return { session: s, events, items };
}

/** Routes root requests by their ordinal and child requests through `child`. */
function router(root: (req: ProviderRequest, n: number) => Script, child: (req: ProviderRequest) => Script) {
  let rootCalls = 0;
  return (req: ProviderRequest): Script => (isChild(req) ? child(req) : root(req, rootCalls++));
}

const agentIdIn = (text: string): string => {
  const match = /agent ([0-9a-f]{8})|"id":"([0-9a-f]{8})"|id="([0-9a-f]{8})"/.exec(text);
  assert.ok(match, `no agent id in: ${text.slice(0, 300)}`);
  return (match[1] ?? match[2] ?? match[3])!;
};

test('a background child settles with exactly one notice, delivered as the parent\'s next step', async () => {
  const cwd = gitRepo();
  const rootRequests: ProviderRequest[] = [];
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        rootRequests.push(req);
        if (n === 0) return call('s1', 'spawn_agent', { description: 'Scan TODOs', prompt: 'find TODOs', role: 'explorer' });
        if (n === 1) return say('I will wait for the scan.');
        return say('The scan found 3.');
      },
      () => ({ delayMs: 60, events: say('FOUND-3', 10, 5) }),
    ),
  );
  const { session: s, events, items } = session(provider, cwd);
  await s.prompt('scan the repo');

  // The recorded copies: the live request objects share the mutated transcript.
  assert.equal(rootRequests.length, 3);
  rootRequests.splice(0, rootRequests.length, ...provider.requests.filter((r) => !isChild(r)));
  assert.match(lastUserText(rootRequests[1]!), /Started agent [0-9a-f]{8}/);
  const notice = lastUserText(rootRequests[2]!);
  assert.match(notice, /<agent_settled id="[0-9a-f]{8}" title="Scan TODOs" status="completed"/);
  assert.match(notice, /FOUND-3/);
  // Exactly once across every request the parent made.
  const deliveries = rootRequests.map((r) => (userText(r).match(/<agent_settled id="[0-9a-f]{8}" title=/g) ?? []).length);
  assert.deepEqual(deliveries, [0, 0, 1]);
  assert.ok(events.some((e) => e.type === 'turn_finished'));
  const subagentItems = items.filter((op) => op.op !== 'delta' && op.item.kind === 'subagent');
  assert.ok(subagentItems.length >= 2);
  const last = subagentItems[subagentItems.length - 1]!;
  assert.ok(last.op !== 'delta' && last.item.kind === 'subagent' && last.item.status === 'completed' && last.item.closingText === 'FOUND-3');
});

test('send_message continues a finished child with its own transcript; interrupt keeps it continuable', async () => {
  const cwd = gitRepo();
  const childRequests: ProviderRequest[] = [];
  let id = '';
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        if (n === 0) return call('s1', 'spawn_agent', { description: 'Draft', prompt: 'write a plan', background: false });
        if (n === 1) {
          id = agentIdIn(lastUserText(req));
          return call('m1', 'send_message', { id, message: 'and now the second part' });
        }
        if (n === 2) return say('waiting');
        if (n === 3) return say('both parts done');
        return say('extra');
      },
      (req) => {
        childRequests.push(req);
        const text = userText(req);
        return text.includes('and now the second part') ? say('SECOND') : say('FIRST');
      },
    ),
  );
  const { session: s } = session(provider, cwd);
  await s.prompt('plan in two parts');

  assert.equal(childRequests.length, 2);
  const second = childRequests[1]!;
  // The continuation carries the child's own earlier answer.
  assert.ok(second.messages.some((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'text' && p.text === 'FIRST')));
  const state = s.agents().find((a) => a.id === id)!;
  assert.equal(state.status, 'completed');
  assert.equal(state.runs, 2);
  assert.equal(state.summary, 'SECOND');

  // A hanging child: interrupt keeps it continuable; send_message resumes it.
  let hang = true;
  const provider2 = scriptedProvider('mock', (req) => (isChild(req) ? (hang ? 'hang' : say('RESUMED')) : say('ok')));
  const second2 = session(provider2, cwd);
  const started = second2.session.subagents!.handleToolCall(0, { id: 'x', name: 'spawn_agent', input: { description: 'Long', prompt: 'p' } });
  const startedText = (await started).type === 'tool_result' ? ((await started) as { content: string }).content : '';
  const childId = agentIdIn(startedText);
  await new Promise((r) => setTimeout(r, 30));
  second2.session.interruptAgent(childId);
  await second2.session.subagents!.waitForSettlement();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(second2.session.agents()[0]!.status, 'interrupted');
  assert.equal(second2.session.agents()[0]!.continuable, true);
  hang = false;
  const resumed = second2.session.messageAgent(childId, 'carry on');
  assert.equal(resumed.ok, true);
  await second2.session.subagents!.drainActive();
  assert.equal(second2.session.agents()[0]!.status, 'completed');
  assert.equal(second2.session.agents()[0]!.summary, 'RESUMED');
});

test('a fork replays the parent\'s system, tools and transcript prefix', async () => {
  const cwd = gitRepo();
  let rootFirst: ProviderRequest | null = null;
  let forkRequest: ProviderRequest | null = null;
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        if (n === 0) {
          rootFirst = req;
          return call('f1', 'spawn_agent', { description: 'Try variant', prompt: 'try the other approach', mode: 'fork', background: false });
        }
        return say('done');
      },
      (req) => {
        forkRequest = req;
        return say('forked-ok');
      },
    ),
  );
  const { session: s } = session(provider, cwd);
  await s.prompt('secret context XYZZY');
  assert.ok(rootFirst && forkRequest);
  const root = rootFirst as ProviderRequest;
  const fork = forkRequest as ProviderRequest;
  assert.equal(fork.system, root.system);
  assert.deepEqual(fork.tools.map((t) => t.name), root.tools.map((t) => t.name));
  // Same leading message bytes: the prompt cache can serve the prefix.
  assert.deepEqual(fork.messages[0], root.messages[0]);
  assert.match(lastUserText(fork), /<fork>[\s\S]*try the other approach/);
  // The pending spawn call is answered so the transcript stays valid.
  assert.ok(fork.messages.some((m) => m.role === 'user' && m.content.some((p) => p.type === 'tool_result' && p.toolCallId === 'f1')));
});

test('role routing runs workers and explorers on other providers; subscription children are not billed', async () => {
  const cwd = gitRepo();
  const parent = scriptedProvider(
    'alevr',
    router(
      (_req, n) => {
        if (n === 0) return call('w', 'spawn_agent', { description: 'Implement', prompt: 'do it', role: 'worker', background: false });
        if (n === 1) return call('e', 'spawn_agent', { description: 'Look around', prompt: 'map it', role: 'explorer', background: false });
        return say('done');
      },
      () => say('parent-should-not-run-children'),
    ),
  );
  const worker = scriptedProvider('openai', () => say('from-worker', 7, 3));
  const explorer = scriptedProvider('claude-sub', () => say('from-explorer', 5, 2));
  const routing: RoleRouting = {
    preset: 'lead-workers',
    orchestrator: { instanceId: 'alevr', model: 'anthropic:claude-opus-5-5' },
    workers: [{ instanceId: 'byok:openai', model: 'openai:gpt-6', effort: 'high' }],
    explorer: { instanceId: 'claude-agent:default', model: 'haiku' },
  };
  const recorded: string[] = [];
  const usageReporter: UsageReporter = {
    reserve: async () => ({ allowed: true }),
    record: async (model: string) => {
      recorded.push(model);
    },
    refund: async () => {},
  } as unknown as UsageReporter;
  const { session: s, items } = session(parent, cwd, {
    routing,
    usageReporter,
    resolveProvider: (selection) => {
      if (selection.instanceId === 'byok:openai') return { adapter: worker, model: 'gpt-6', billable: false };
      if (selection.instanceId === 'claude-agent:default') return { adapter: explorer, model: 'claude-haiku-4-5', billable: false };
      return null;
    },
  });
  await s.prompt('build it');

  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0]!.model, 'gpt-6');
  assert.equal(worker.requests[0]!.reasoningEffort, 'high');
  assert.equal(explorer.requests.length, 1);
  assert.equal(explorer.requests[0]!.model, 'claude-haiku-4-5');
  const states = s.agents();
  assert.deepEqual(states.map((a) => a.selection.instanceId), ['byok:openai', 'claude-agent:default']);
  assert.deepEqual(states.map((a) => a.contractRole), ['worker', 'explorer']);
  // Only the parent's own turn is billed to Alevr.
  assert.deepEqual(recorded, ['alevr-model']);
  const agentItem = items.find((op) => op.op !== 'delta' && op.item.kind === 'subagent');
  assert.ok(agentItem && agentItem.op !== 'delta' && agentItem.item.kind === 'subagent' && agentItem.item.model.instanceId === 'byok:openai');
});

test('per-child tool filter, persona and output schema (with one correction round)', async () => {
  const cwd = gitRepo();
  const childRequests: ProviderRequest[] = [];
  let rootSecond: ProviderRequest | null = null;
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        if (n === 0) {
          return call('s', 'spawn_agent', {
            description: 'Count files',
            prompt: 'count them',
            tools: { deny: ['bash'] },
            persona: 'You are Ada, a meticulous counter.',
            output_schema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
            background: false,
          });
        }
        rootSecond = req;
        return say('ok');
      },
      (req) => {
        childRequests.push(req);
        return childRequests.length === 1 ? say('There are three files.') : say('{"count": 3}');
      },
    ),
  );
  const { session: s } = session(provider, cwd);
  await s.prompt('count');
  assert.equal(childRequests.length, 2);
  assert.ok(!childRequests[0]!.tools.some((t) => t.name === 'bash'));
  assert.ok(childRequests[0]!.tools.some((t) => t.name === 'read_file'));
  assert.match(childRequests[0]!.system, /You are Ada/);
  assert.match(lastUserText(childRequests[1]!), /must be ONE JSON value/);
  assert.match(lastUserText(rootSecond!), /Structured result: \{"count":3\}/);
  assert.deepEqual(s.agents()[0]!.structured, { count: 3 });

  // Unknown tool names in a filter are refused up front.
  const refused = await s.subagents!.handleToolCall(1, { id: 'z', name: 'spawn_agent', input: { description: 'x', prompt: 'y', tools: { allow: ['nope'] } } });
  assert.ok(refused.type === 'tool_result' && refused.isError && /Unknown tool name/.test(refused.content));
});

test('a hard session budget stops every child at the line and refuses new ones', async () => {
  const cwd = gitRepo();
  const rootRequests: ProviderRequest[] = [];
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        rootRequests.push(req);
        if (n === 0) {
          return [
            { type: 'tool_call', id: 'a', name: 'spawn_agent', input: { description: 'Loop A', prompt: 'loop' } },
            { type: 'tool_call', id: 'b', name: 'spawn_agent', input: { description: 'Loop B', prompt: 'loop' } },
            done('tool_use'),
          ];
        }
        if (n === 1) return say('waiting');
        if (n === 2 && !userText(req).includes('spawn refused')) return call('c', 'spawn_agent', { description: 'Loop C', prompt: 'loop' });
        return say('stopped');
      },
      // Each child step burns 60 tokens and asks for another read.
      () => ({ delayMs: 5, events: call(`r${Math.random()}`, 'read_file', { path: 'README.md' }, 30) }),
    ),
  );
  const { session: s } = session(provider, cwd, { subagents: { budget: { maxTokens: 200 } } });
  await s.prompt('loop forever');
  const states = s.agents();
  assert.equal(states.length, 2);
  for (const state of states) {
    assert.equal(state.status, 'failed');
    assert.match(state.error ?? '', /token budget/);
  }
  const budget = s.subagents!.budgetSnapshot();
  assert.ok(budget.exhausted);
  assert.ok(budget.tokens >= 200 && budget.tokens < 200 + 2 * 60 + 1, `overshoot bounded: ${budget.tokens}`);
  // The parent saw the settlements and a refusal for the third spawn.
  const all = provider.requests.filter((r) => !isChild(r)).map((r) => userText(r)).join('\n');
  assert.match(all, /status="failed"/);
  assert.match(all, /run budget is exhausted/);
});

test('the workflow tool fans out through the session and reports the budget', { skip: workflowGuestAvailable() ? false : 'node --permission cannot start on this host (emulated container)' }, async () => {
  const cwd = gitRepo();
  let rootSecond: ProviderRequest | null = null;
  const provider = scriptedProvider(
    'mock',
    router(
      (req, n) => {
        if (n === 0) {
          return call('w', 'workflow', {
            meta: { name: 'two-scans', description: 'scan twice' },
            script: "phase('Scan'); const r = await parallel([() => agent('alpha task'), () => agent('beta task')]); return r;",
          });
        }
        rootSecond = req;
        return say('merged');
      },
      (req) => say(userText(req).includes('alpha task') ? 'A-RESULT' : 'B-RESULT', 4, 1),
    ),
  );
  const { session: s, events, items } = session(provider, cwd);
  await s.prompt('scan twice');
  const result = JSON.parse(lastUserText(rootSecond!)) as { stopReason: string; value: string[]; agentsStarted: number; budget: { tokens: number } };
  assert.equal(result.stopReason, 'completed');
  assert.deepEqual(result.value, ['A-RESULT', 'B-RESULT']);
  assert.equal(result.agentsStarted, 2);
  assert.equal(result.budget.tokens, 10);
  assert.ok(events.some((e) => e.type === 'workflow_update' && e.progress?.type === 'phase'));
  assert.ok(items.some((op) => op.op !== 'delta' && op.item.kind === 'system_notice' && op.item.code === 'workflow_phase'));
  // Workflow children report to the workflow, not as parent notices.
  assert.ok(!userText(rootSecond!).includes('<agent_settled'));
});

test('best-of-N runs each worker model in its own worktree, the reviewer compares, the person picks', async () => {
  const cwd = gitRepo({ 'file.txt': 'original\n' });
  const candidate = (version: string) =>
    scriptedProvider(version, (req) => {
      const steps = req.messages.filter((m) => m.role === 'assistant').length;
      if (steps === 0) return call('r', 'read_file', { path: 'file.txt' });
      if (steps === 1) return call('w', 'edit_file', { path: 'file.txt', old_string: 'original', new_string: version });
      return say(`wrote ${version}`);
    });
  const p1 = candidate('one');
  const p2 = candidate('two');
  let reviewerSaw = '';
  const reviewer = scriptedProvider('reviewer', (req) => {
    reviewerSaw = userText(req);
    const ids = [...reviewerSaw.matchAll(/<candidate id="([0-9a-f]{8})" model="([^"]+)"/g)].map((m) => ({ id: m[1]!, model: m[2]! }));
    const two = ids.find((c) => c.model === 'm-two')!;
    const one = ids.find((c) => c.model === 'm-one')!;
    return say(JSON.stringify({ ranking: [two.id, one.id], recommended: two.id, notes: 'two is better' }));
  });
  const root = scriptedProvider('mock', (req) =>
    req.messages.some((m) => m.role === 'user' && m.content.some((p) => p.type === 'tool_result'))
      ? say('Here are the candidates.')
      : call('b', 'best_of_n', { prompt: 'change the file' }),
  );
  const routing: RoleRouting = {
    preset: 'best-of-n',
    orchestrator: { instanceId: 'alevr', model: 'x' },
    workers: [
      { instanceId: 'p1', model: 'm-one' },
      { instanceId: 'p2', model: 'm-two' },
    ],
    reviewer: { instanceId: 'rev', model: 'judge' },
  };
  const { session: s } = session(root, cwd, {
    mode: 'auto-edit',
    routing,
    resolveProvider: (sel) =>
      sel.instanceId === 'p1'
        ? { adapter: p1, model: 'm-one' }
        : sel.instanceId === 'p2'
          ? { adapter: p2, model: 'm-two' }
          : sel.instanceId === 'rev'
            ? { adapter: reviewer, model: 'judge' }
            : null,
  });
  assert.ok(root.requests.length === 0);
  await s.prompt('make it better');
  assert.ok(root.requests[0]!.tools.some((t) => t.name === 'best_of_n'));
  const runs = s.subagents!.bestOfNRuns();
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.status, 'awaiting_pick');
  assert.equal(run.candidates.length, 2);
  assert.ok(run.candidates.every((c) => c.status === 'completed' && c.filesChanged.includes('file.txt')));
  // Nothing applied before the pick.
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'original\n');
  assert.match(reviewerSaw, /\+two/);
  const pick = run.review!.recommended!;
  assert.equal(run.candidates.find((c) => c.agentId === pick)!.model, 'm-two');
  const applied = await s.applyBestOfN(run.id, pick);
  assert.equal(applied.applied, true);
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'two\n');
  assert.equal(s.subagents!.bestOfNRuns()[0]!.status, 'applied');
  // The losing worktree is gone.
  const loser = run.candidates.find((c) => c.agentId !== pick)!;
  assert.ok(loser.branch && !fs.existsSync(path.join(cwd, '.git', 'worktrees', loser.agentId)));
});
