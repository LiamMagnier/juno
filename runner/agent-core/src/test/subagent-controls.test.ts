/**
 * A person's controls over running subagents (REA backlog 10, the web Agents
 * tree): Pause / Resume between steps, Steer into the next step, and bounded
 * budget top-ups. All cooperative: nothing here cuts a request or a tool call
 * in half, and nothing answers an approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../agent.js';
import { BudgetLedger } from '../harness/budget.js';
import { runAgentLoop } from '../loop.js';
import { SUBAGENT_TOP_UP_LIMITS } from '../subagents.js';
import type { ProviderRequest } from '../providers/types.js';
import type { ApprovalDecision } from '../types.js';
import { call, done, gitRepo, isChild, lastUserText, say, scriptedProvider, tmpdir, type Script } from './fake-provider.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeSession(route: (req: ProviderRequest) => Script, subagents: Record<string, unknown> = {}) {
  process.env.JUNO_HOME = tmpdir('alevr-controls-');
  const provider = scriptedProvider('mock', route);
  const session = AgentSession.create({
    provider,
    cwd: gitRepo(),
    mode: 'full',
    subagents: { readBeforeEdit: false, ...subagents },
    callbacks: { onEvent: () => {}, requestApproval: async (): Promise<ApprovalDecision> => 'allow' },
  });
  return { session, provider };
}

async function spawn(session: AgentSession, description = 'Long job'): Promise<string> {
  const result = await session.subagents!.handleToolCall(0, { id: 'x', name: 'spawn_agent', input: { description, prompt: 'work through it' } });
  const text = result.type === 'tool_result' ? result.content : '';
  const id = /agent ([0-9a-f]{8})/.exec(text)?.[1];
  assert.ok(id, text);
  return id;
}

test('beforeStep holds the loop before any request, and an abort while held stops it', async () => {
  const provider = scriptedProvider('mock', () => say('hi'));
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const aborter = new AbortController();
  const run = runAgentLoop({
    provider,
    model: 'mock-model',
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [],
    signal: aborter.signal,
    maxSteps: 3,
    beforeStep: () => held,
    executeToolCall: async () => ({ type: 'tool_result', toolCallId: 'x', content: '' }),
  });
  await tick();
  assert.equal(provider.requests.length, 0, 'nothing is sent while held');
  release();
  const result = await run;
  assert.equal(provider.requests.length, 1);
  assert.equal(result.finalText, 'hi');

  // Held, then aborted: the hold settles on abort and the loop ends without a request.
  const provider2 = scriptedProvider('mock', () => say('never'));
  const aborter2 = new AbortController();
  const run2 = runAgentLoop({
    provider: provider2,
    model: 'mock-model',
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [],
    signal: aborter2.signal,
    maxSteps: 3,
    beforeStep: () => new Promise<void>((r) => aborter2.signal.addEventListener('abort', () => r(), { once: true })),
    executeToolCall: async () => ({ type: 'tool_result', toolCallId: 'x', content: '' }),
  });
  aborter2.abort();
  const result2 = await run2;
  assert.equal(result2.stopReason, 'aborted');
  assert.equal(provider2.requests.length, 0);
  void aborter;
});

test('pause holds a running child between steps; a steer sent while paused rides into the first step after resume', async () => {
  let childCalls = 0;
  const { session, provider } = makeSession((req) => {
    if (!isChild(req)) return say('lead');
    childCalls += 1;
    if (childCalls < 4) return { delayMs: 15, events: call(`r${childCalls}`, 'read_file', { path: 'README.md' }) };
    return say('CHILD DONE');
  });
  const id = await spawn(session);
  const paused = session.pauseAgent(id);
  assert.equal(paused.ok, true);
  await tick(60);
  const heldAt = childCalls;
  assert.ok(heldAt <= 1, `paused before its second step (made ${heldAt} requests)`);
  await tick(80);
  assert.equal(childCalls, heldAt, 'no request goes out while paused');
  const state = session.agents().find((a) => a.id === id)!;
  assert.equal(state.paused, true);
  assert.equal(state.currentActivity, 'Paused');
  assert.ok(state.status === 'running' || state.status === 'preparing' || state.status === 'queued', state.status);

  // Pausing again is a no-op that still succeeds (idempotent).
  assert.equal(session.pauseAgent(id).ok, true);

  // Steer while held: delivered at the next step.
  const steered = session.messageAgent(id, 'Focus on the README only.');
  assert.equal(steered.ok, true);
  assert.equal(session.resumeAgent(id).ok, true);
  assert.equal(session.resumeAgent(id).ok, true, 'resuming a running agent is a no-op');
  await session.subagents!.drainActive();

  const done = session.agents().find((a) => a.id === id)!;
  assert.equal(done.status, 'completed');
  assert.equal(done.summary, 'CHILD DONE');
  assert.equal(done.paused, undefined);
  const childRequests = provider.requests.filter(isChild);
  const firstAfterResume = childRequests[heldAt]!;
  assert.ok(lastUserText(firstAfterResume).includes('Focus on the README only.'), 'the steer reached the first step after resume');
  delete process.env.JUNO_HOME;
});

test('stop while paused releases the hold and interrupts the child; pausing a finished child is refused', async () => {
  const { session } = makeSession((req) => (isChild(req) ? { delayMs: 10, events: call('r', 'read_file', { path: 'README.md' }) } : say('lead')));
  const id = await spawn(session);
  session.pauseAgent(id);
  await tick(50);
  session.interruptAgent(id);
  await session.subagents!.drainActive();
  const state = session.agents().find((a) => a.id === id)!;
  assert.equal(state.status, 'interrupted');
  assert.equal(state.paused, undefined);
  assert.equal(session.pauseAgent(id).ok, false);
  assert.equal(session.pauseAgent('nope').ok, false);
  delete process.env.JUNO_HOME;
});

test('pause and resume with no agent id act on every live child', async () => {
  const { session } = makeSession((req) => (isChild(req) ? { delayMs: 10, events: call('r', 'read_file', { path: 'README.md' }) } : say('lead')));
  const a = await spawn(session, 'A');
  const b = await spawn(session, 'B');
  const all = session.pauseAgent();
  assert.equal(all.ok, true);
  assert.equal(all.count, 2);
  await tick(40);
  assert.ok(session.agents().every((s) => s.paused));
  assert.equal(session.resumeAgent().count, 2);
  session.interruptAgent(a);
  session.interruptAgent(b);
  await session.subagents!.drainActive();
  delete process.env.JUNO_HOME;
});

test('a top-up raises one child cap within bounds, so a child that would stop at its cap finishes', async () => {
  let childCalls = 0;
  const route = (req: ProviderRequest): Script => {
    if (!isChild(req)) return say('lead');
    childCalls += 1;
    // 600 tokens a step: the 1,000 cap stops it at step 2 unless topped up.
    if (childCalls < 4) return { delayMs: 10, events: [{ type: 'tool_call', id: `r${childCalls}`, name: 'read_file', input: { path: 'README.md' } }, done('tool_use', 400, 200)] };
    return say('FINISHED', 400, 200);
  };
  const { session } = makeSession(route, { childTokenBudget: 1000 });
  const id = await spawn(session);
  session.pauseAgent(id);

  // Bounds: too small, too large, unknown agent, run budget absent.
  assert.equal(session.topUpAgent(id, { tokens: 5 }).ok, false);
  assert.equal(session.topUpAgent(id, { tokens: SUBAGENT_TOP_UP_LIMITS.maxTokensPerTopUp + 1 }).ok, false);
  assert.equal(session.topUpAgent(id, { tokens: 10_000.5 }).ok, false);
  assert.equal(session.topUpAgent(id, { usd: 1 }).ok, false, 'an agent is topped up in tokens');
  assert.equal(session.topUpAgent('nope', { tokens: 20_000 }).ok, false);
  assert.equal(session.topUpAgent(undefined, { tokens: 20_000 }).ok, false, 'no run budget to raise');

  const topped = session.topUpAgent(id, { tokens: 20_000 });
  assert.equal(topped.ok, true, topped.message);
  assert.equal(topped.tokenBudget, 21_000);
  assert.equal(session.agents().find((a) => a.id === id)!.tokenBudget, 21_000);
  assert.equal(session.agents().find((a) => a.id === id)!.tokenTopUp, 20_000);

  session.resumeAgent(id);
  await session.subagents!.drainActive();
  const state = session.agents().find((a) => a.id === id)!;
  assert.equal(state.status, 'completed', state.error);
  assert.equal(state.summary, 'FINISHED');

  // The lifetime cap per agent holds.
  for (let i = 0; i < 2; i++) assert.equal(session.topUpAgent(id, { tokens: 400_000 }).ok, true);
  const over = session.topUpAgent(id, { tokens: 400_000 });
  assert.equal(over.ok, false);
  assert.match(over.message, /most is 1,200,000/);
  delete process.env.JUNO_HOME;
});

test('a run top-up raises the session budget only where a limit exists, within bounds', async () => {
  const { session } = makeSession(() => say('lead'), { budget: { maxUsd: 2 } });
  assert.equal(session.topUpAgent(undefined, { tokens: 50_000 }).ok, false, 'no token budget to raise');
  assert.equal(session.topUpAgent(undefined, { usd: 0.1 }).ok, false);
  assert.equal(session.topUpAgent(undefined, { usd: 21 }).ok, false);
  const raised = session.topUpAgent(undefined, { usd: 5 });
  assert.equal(raised.ok, true, raised.message);
  assert.equal(raised.budget?.maxUsd, 7);
  assert.equal(session.subagents!.budgetSnapshot().maxUsd, 7);
  delete process.env.JUNO_HOME;
});

test('BudgetLedger.raise revives an exhausted ledger once it is under the new limit', () => {
  const ledger = new BudgetLedger({ maxTokens: 100 });
  let heard = 0;
  ledger.onExhausted(() => (heard += 1));
  assert.equal(ledger.charge({ inputTokens: 80, outputTokens: 40 }), true);
  assert.equal(heard, 1);
  ledger.raise({ maxTokens: 10 });
  assert.equal(ledger.exhausted, true, 'still over: 120 >= 110');
  const snap = ledger.raise({ maxTokens: 100, maxUsd: 5 });
  assert.equal(snap.maxTokens, 210);
  assert.equal(snap.maxUsd, undefined, 'an uncapped dimension stays uncapped');
  assert.equal(ledger.exhausted, false);
  assert.equal(ledger.charge({ inputTokens: 100, outputTokens: 0 }), true);
  assert.equal(heard, 2, 'listeners hear the next exhaustion');

  // A parent's exhaustion still stops a raised child ledger.
  const parent = new BudgetLedger({ maxTokens: 10 });
  const child = parent.child({ maxTokens: 1000 });
  child.charge({ inputTokens: 20, outputTokens: 0 });
  child.raise({ maxTokens: 1000 });
  assert.equal(child.exhausted, true);
});
