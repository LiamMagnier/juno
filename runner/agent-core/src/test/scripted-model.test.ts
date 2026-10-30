/**
 * The scripted Work model (work/scripted-model.ts): a fixed list of steps,
 * one per assistant turn, for tests and local demos with no provider key.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_BUDGET,
  WorkAgentSession,
  WorkPlan,
  createScriptedWorkProvider,
  parseScriptedWorkScript,
  scriptedExpectationFailure,
  type ScriptedWorkScript,
} from '../work/index.js';
import type { WorkEmittedEvent, WorkToolDefinition } from '../work/types.js';
import type { ChatMessage } from '../types.js';
import type { ProviderStreamEvent } from '../providers/types.js';

/** A safe tool that echoes what it was given and counts its calls. */
function echoTool(calls: string[]): WorkToolDefinition {
  return {
    kind: 'read',
    tier: 'shell',
    intents: ['echo.say'],
    intentFor: () => 'echo.say',
    actionFor: () => 'work.echo.say',
    riskFor: () => 'safe',
    provenanceFor: () => ({ source: 'echo', sourceKind: 'model', action: 'work.echo.say', trust: 'trusted' }),
    spec: { name: 'echo', description: 'Echo text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    summarize: (input) => `Echo ${String(input.text ?? '')}`,
    async execute(input) {
      calls.push(String(input.text ?? ''));
      return { output: `echo: ${String(input.text ?? '')}` };
    },
  };
}

/** What the scripted model wrote, turn by turn. */
function saidIn(events: WorkEmittedEvent[]): string[] {
  return events.flatMap((e) => (e.kind === 'assistant_message' ? [e.text] : []));
}

async function collect(stream: AsyncGenerator<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const SCRIPT: ScriptedWorkScript = {
  version: 1,
  vision: false,
  steps: [
    { say: 'First.', call: { name: 'echo', input: { text: 'one' } } },
    { expect: 'echo: one', call: { name: 'echo', input: { text: 'two' } } },
    { expect: 'echo: two', say: 'All done.', end: true },
  ],
};

function runSession(script: ScriptedWorkScript, calls: string[], events: WorkEmittedEvent[] = []) {
  return new WorkAgentSession({
    runId: 'run_scripted',
    goal: 'Echo twice.',
    provider: createScriptedWorkProvider(script),
    model: 'scripted-work-model',
    cwd: '/tmp',
    tools: [echoTool(calls)],
    plan: new WorkPlan([{ id: 'step_1', title: 'Echo' }]),
    budget: NO_BUDGET,
    approvalMode: 'conservative',
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async () => 'allowed',
      askQuestion: async () => 'ok',
    },
  });
}

test('steps run in order', async () => {
  const calls: string[] = [];
  const events: WorkEmittedEvent[] = [];
  await runSession(SCRIPT, calls, events).run();
  assert.deepEqual(calls, ['one', 'two'], 'each step made its one call, in order');
  const said = saidIn(events);
  assert.ok(said.some((text) => text.includes('First.')));
  assert.ok(said.some((text) => text.includes('All done.')));
});

test('a failed expectation ends the run with the sentence', async () => {
  const calls: string[] = [];
  const script: ScriptedWorkScript = {
    version: 1,
    vision: true,
    steps: [
      { call: { name: 'echo', input: { text: 'one' } } },
      { expect: 'never said', call: { name: 'echo', input: { text: 'two' } } },
    ],
  };
  const events: WorkEmittedEvent[] = [];
  await runSession(script, calls, events).run();
  assert.deepEqual(calls, ['one'], 'nothing ran after the failed expectation');
  assert.ok(
    saidIn(events).some((text) => /^Scripted step 2 expected \/never said\/; the tool said: .*echo: one/s.test(text)),
    'the run ends with the sentence naming the step and what the tool said',
  );
  assert.equal(
    scriptedExpectationFailure(2, 'x', 'y'.repeat(500)).length,
    'Scripted step 2 expected /x/; the tool said: '.length + 200,
    'the tool output is cut at 200 characters',
  );
});

test('a resumed transcript continues at the right step', async () => {
  const provider = createScriptedWorkProvider(SCRIPT);
  // Two assistant turns already happened before the run was set aside.
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'Echo twice.' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'scripted-call-1', name: 'echo', input: { text: 'one' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'scripted-call-1', content: 'echo: one' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 'scripted-call-2', name: 'echo', input: { text: 'two' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 'scripted-call-2', content: 'echo: two' }] },
  ];
  const events = await collect(provider.stream({ model: 'scripted-work-model', system: '', messages, tools: [] }));
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'All done.' },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
  ]);
  // And the first step from an empty transcript.
  const first = await collect(provider.stream({ model: 'x', system: '', messages: messages.slice(0, 1), tools: [] }));
  assert.equal(first.find((e) => e.type === 'tool_call')?.type, 'tool_call');
  assert.equal(provider.capabilities('anything').vision, false, 'vision comes from the script');
});

test('a malformed script is refused with a sentence', () => {
  assert.throws(() => parseScriptedWorkScript({ version: 2, vision: true, steps: [{}] }), /version must be 1/);
  assert.throws(() => parseScriptedWorkScript({ version: 1, vision: true, steps: [] }), /non-empty/);
  assert.throws(() => parseScriptedWorkScript({ version: 1, vision: true, steps: [{ expect: '(' }] }), /not a valid regular expression/);
  assert.deepEqual(parseScriptedWorkScript(JSON.parse(JSON.stringify(SCRIPT))), SCRIPT);
});
