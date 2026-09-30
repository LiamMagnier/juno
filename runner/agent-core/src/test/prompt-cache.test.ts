import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { AnthropicAdapter } from '../providers/anthropic.js';
import { OpenAICompatAdapter } from '../providers/openai-compat.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { ChatMessage } from '../types.js';
import { WorkAgentSession } from '../work/session.js';
import { WorkPlan } from '../work/plan.js';
import { anthropicStream, anthropicTurn, openAIStream, recordingFetch, type RecordedRequest } from './recorded.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'juno-cache-test-'));
}

/** Every `cache_control` in a request body, by where it sits. */
function breakpoints(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  const tools = (body.tools ?? []) as Array<Record<string, unknown>>;
  tools.forEach((tool, index) => {
    if (tool.cache_control) found.push(`tools[${index}]`);
  });
  const system = (body.system ?? []) as Array<Record<string, unknown>>;
  system.forEach((block, index) => {
    if (block.cache_control) found.push(`system[${index}]`);
  });
  const messages = (body.messages ?? []) as Array<{ content: Array<Record<string, unknown>> | string }>;
  messages.forEach((message, m) => {
    if (typeof message.content === 'string') return;
    message.content.forEach((block, b) => {
      if (block.cache_control) found.push(`messages[${m}][${b}]`);
    });
  });
  return found;
}

/** A request with its breakpoints removed: what the cache actually keys on. */
function withoutBreakpoints<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner))) as T;
}

const TOOL_TURN = (id: string) =>
  anthropicTurn({
    blocks: [{ type: 'tool_use', id, name: 'read_file', input: { path: 'notes.txt' } }],
    stopReason: 'tool_use',
    usage: { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 1500 },
  });
const TEXT_TURN = (text: string) =>
  anthropicTurn({
    blocks: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 1500, cache_creation_input_tokens: 40 },
  });

test('Anthropic requests carry four breakpoints: tools, system, the previous tail and the newest block', async () => {
  const { fetch, requests } = recordingFetch([() => anthropicStream(TEXT_TURN('ok'))]);
  const adapter = new AnthropicAdapter('key', { fetch });
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'read notes.txt' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'read_file', input: { path: 'notes.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't2', name: 'read_file', input: { path: 'b.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: 'world' }, { type: 'text', text: 'also this' }] },
  ];
  const tools = [
    { name: 'read_file', description: 'r', inputSchema: { type: 'object' } },
    { name: 'bash', description: 'b', inputSchema: { type: 'object' } },
  ];
  for await (const _ of adapter.stream({ model: 'claude-sonnet-5', system: 'You are Juno.', messages, tools })) {
    // drain
  }
  const body = requests[0]!.body;
  assert.deepEqual(breakpoints(body), ['tools[1]', 'system[0]', 'messages[2][0]', 'messages[4][1]']);
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are Juno.', cache_control: { type: 'ephemeral' } }]);

  // A side call that nothing will read back does not pay for a cache write.
  const side = recordingFetch([() => anthropicStream(TEXT_TURN('summary'))]);
  const sideAdapter = new AnthropicAdapter('key', { fetch: side.fetch });
  for await (const _ of sideAdapter.stream({ model: 'claude-sonnet-5', system: 's', messages, tools, cache: false })) {
    // drain
  }
  assert.deepEqual(breakpoints(side.requests[0]!.body), []);
});

test('cache reads and writes are parsed into usage, and input stays inclusive', async () => {
  const { fetch } = recordingFetch([() => anthropicStream(TEXT_TURN('ok'))]);
  const adapter = new AnthropicAdapter('key', { fetch });
  const events: ProviderStreamEvent[] = [];
  for await (const event of adapter.stream({
    model: 'claude-sonnet-5',
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
  })) {
    events.push(event);
  }
  const done = events.find((event) => event.type === 'done');
  assert.deepEqual(done?.type === 'done' ? done.usage : null, {
    inputTokens: 12 + 1500 + 40,
    outputTokens: 4,
    cacheReadTokens: 1500,
    cacheWriteTokens: 40,
  });

  // OpenAI-compatible labs report the cached share inside prompt_tokens.
  const compat = recordingFetch([
    () =>
      openAIStream([
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.2', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
        { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'glm-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'glm-5.2',
          choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 5, total_tokens: 1005, prompt_tokens_details: { cached_tokens: 800 } },
        },
      ]),
  ]);
  const glm = new OpenAICompatAdapter(
    { id: 'zhipu', name: 'GLM', baseUrl: 'https://glm.test/v4', envVar: '', defaultModel: 'glm-5.2', models: {} },
    { apiKey: 'k', fetch: compat.fetch },
  );
  const compatEvents: ProviderStreamEvent[] = [];
  for await (const event of glm.stream({ model: 'glm-5.2', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) {
    compatEvents.push(event);
  }
  const compatDone = compatEvents.find((event) => event.type === 'done');
  assert.deepEqual(compatDone?.type === 'done' ? compatDone.usage : null, { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 800 });
});

test('a Code session sends a byte-identical prefix from step to step and turn to turn', async () => {
  process.env.JUNO_HOME = tmpdir();
  const cwd = tmpdir();
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello');
  const { fetch, requests } = recordingFetch([
    () => anthropicStream(TOOL_TURN('t1')),
    () => anthropicStream(TEXT_TURN('It says hello.')),
    () => anthropicStream(TOOL_TURN('t2')),
    () => anthropicStream(TEXT_TURN('Still hello.')),
  ]);
  const turnUsage: Array<Record<string, number | undefined>> = [];
  const session = AgentSession.create({
    provider: new AnthropicAdapter('key', { fetch }),
    cwd,
    model: 'claude-sonnet-5',
    mode: 'full',
    subagents: false,
    callbacks: {
      onEvent: (event) => {
        if (event.type === 'turn_finished') turnUsage.push({ ...event.usage });
      },
      requestApproval: async () => 'allow',
    },
  });
  await session.prompt('what does notes.txt say?');
  await session.prompt('and now?');
  assert.equal(requests.length, 4);

  const bodies = requests.map((request: RecordedRequest) => withoutBreakpoints(request.body));
  for (let n = 1; n < bodies.length; n++) {
    assert.deepEqual(bodies[n]!.system, bodies[0]!.system, `system prompt changed at request ${n + 1}`);
    assert.deepEqual(bodies[n]!.tools, bodies[0]!.tools, `tools changed at request ${n + 1}`);
    const earlier = bodies[n - 1]!.messages as unknown[];
    const later = bodies[n]!.messages as unknown[];
    assert.ok(later.length > earlier.length);
    assert.deepEqual(later.slice(0, earlier.length), earlier, `request ${n + 1} rewrote what request ${n} sent`);
  }
  // The date lives in the state block, never in the system prompt.
  assert.doesNotMatch(JSON.stringify(bodies[0]!.system), /\d{4}-\d{2}-\d{2}/);
  const firstUser = (bodies[0]!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!;
  assert.match(firstUser.content[1]?.text ?? '', /^<session_state>\nDate: \d{4}-\d{2}-\d{2}\nPermission mode: full\n<\/session_state>$/);
  // The unchanged state is not repeated on the second turn.
  const secondTurnPrompt = (bodies[2]!.messages as Array<{ content: Array<{ text?: string }> }>).at(-1)!;
  assert.deepEqual(secondTurnPrompt.content, [{ type: 'text', text: 'and now?' }]);

  // Turn usage carries the cache split, summed across the turn's steps.
  assert.deepEqual(turnUsage[0], {
    inputTokens: 20 + 1500 + 12 + 1500 + 40,
    outputTokens: 12,
    cacheReadTokens: 1500,
    cacheWriteTokens: 1540,
  });
});

test('a mode change reaches the model as a new state block, not a new system prompt', async () => {
  process.env.JUNO_HOME = tmpdir();
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock-1',
    models: () => ['mock-1'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const session = AgentSession.create({
    provider,
    cwd: tmpdir(),
    mode: 'full',
    subagents: false,
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' },
  });
  await session.prompt('one');
  session.setMode('auto-edit');
  await session.prompt('two');
  assert.equal(requests[0]!.system, requests[1]!.system);
  const last = requests[1]!.messages.at(-1)!;
  assert.equal(last.role, 'user');
  const texts = last.content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  assert.equal(texts[0], 'two');
  assert.match(texts[1] ?? '', /Permission mode: auto-edit/);
});

test('a Work run keeps its system prompt while the plan moves', async () => {
  const requests: ProviderRequest[] = [];
  const turns: ProviderStreamEvent[][] = [
    [
      { type: 'tool_call', id: 'p1', name: 'update_plan', input: { stepId: 's1', status: 'active' } },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 2 } },
    ],
    [
      { type: 'tool_call', id: 'p2', name: 'update_plan', input: { stepId: 's1', status: 'done' } },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 2 } },
    ],
    [
      { type: 'text_delta', text: 'Done.' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } },
    ],
  ];
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock-1',
    models: () => ['mock-1'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[] });
      for (const event of turns.shift() ?? []) yield event;
    },
  };
  const session = new WorkAgentSession({
    runId: 'run-cache',
    goal: 'Tidy the notes.',
    provider,
    model: 'mock-1',
    cwd: '/tmp',
    tools: [],
    plan: new WorkPlan([{ id: 's1', title: 'Tidy them' }]),
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
    approvalMode: 'conservative',
    callbacks: {
      onEvent: () => {},
      askQuestion: () => Promise.resolve('no'),
      requestApproval: () => Promise.resolve('allowed'),
    },
  });
  await session.run();
  assert.equal(requests.length, 3);
  assert.ok(requests.every((req) => req.system === requests[0]!.system), 'the system prompt moved with the plan');
  assert.doesNotMatch(requests[0]!.system, /s1: Tidy them/);

  // The plan rides in state blocks, one per change, never rewriting a sent one.
  const states = (req: ProviderRequest) =>
    req.messages.flatMap((message) =>
      message.role === 'user' ? message.content.flatMap((part) => (part.type === 'text' && part.text.startsWith('<session_state>') ? [part.text] : [])) : [],
    );
  assert.equal(states(requests[0]!).length, 1);
  assert.match(states(requests[0]!)[0]!, /- s1: Tidy them \[pending\]/);
  assert.match(states(requests[1]!).at(-1)!, /- s1: Tidy them \[active\]/);
  assert.match(states(requests[2]!).at(-1)!, /- s1: Tidy them \[done\]/);
  for (let n = 1; n < requests.length; n++) {
    assert.deepEqual(requests[n]!.messages.slice(0, requests[n - 1]!.messages.length), requests[n - 1]!.messages);
  }
});
