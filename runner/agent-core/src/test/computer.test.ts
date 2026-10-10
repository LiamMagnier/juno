import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { remoteComputerTools } from '../computer.js';
import type { ProviderAdapter, ProviderRequest, ProviderStreamEvent } from '../providers/types.js';
import type { AgentEvent } from '../types.js';
import { scriptedProvider, call, say, isChild, tmpdir } from './fake-provider.js';

test('computer screenshot reaches vision input but is omitted from events and persistence', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-computer-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'juno-computer-work-'));
  process.env.JUNO_HOME = home;
  const png = Buffer.from('safe-test-png').toString('base64');
  const requests: ProviderRequest[] = [];
  let call = 0;
  const provider: ProviderAdapter = {
    id: 'mock',
    name: 'Mock',
    defaultModel: 'mock',
    models: () => ['mock'],
    capabilities: () => ({
      tools: true,
      vision: true,
      computerUse: true,
      reasoningLevels: [],
      maxContext: 100_000,
      streaming: true,
      mcp: false,
    }),
    async *stream(req: ProviderRequest): AsyncGenerator<ProviderStreamEvent> {
      requests.push(structuredClone(req));
      if (call++ === 0) {
        yield { type: 'tool_call', id: 'screen-1', name: 'computer_screenshot', input: {} };
        yield {
          type: 'done',
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      } else {
        yield { type: 'text_delta', text: 'I can see the screen.' };
        yield {
          type: 'done',
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      }
    },
  };
  const events: AgentEvent[] = [];
  const session = AgentSession.create({
    provider,
    cwd,
    mode: 'ask',
    tools: remoteComputerTools(async () => `data:image/png;base64,${png}`),
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async () => 'allow',
    },
  });

  await session.prompt('Inspect the display.');

  const secondRequest = requests[1];
  assert.ok(
    secondRequest.messages.some(
      (message) =>
        message.role === 'user' &&
        message.content.some(
          (content) => content.type === 'image' && content.data === png,
        ),
    ),
  );
  assert.ok(!JSON.stringify(events).includes(png));
  const stored = session.store.loadMessages();
  assert.ok(!JSON.stringify(stored).includes(png));
  assert.ok(JSON.stringify(stored).includes('Ephemeral Computer Use screenshot omitted'));
  delete process.env.JUNO_HOME;
});

test('computer input tools remain permission-gated commands', () => {
  const tools = remoteComputerTools(async () => 'ok');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_screenshot')?.kind, 'read');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_click')?.kind, 'command');
  assert.equal(tools.find((tool) => tool.spec.name === 'computer_type')?.kind, 'command');
});

test('portable tool images and execution context reach the lead and a delegated child', async () => {
  const previousHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = tmpdir('portable-computer-home-');
  const png = Buffer.from('portable-screen-image').toString('base64');
  const contexts: import('../tools/types.js').ToolContext[] = [];
  const events: AgentEvent[] = [];
  let leadCalls = 0;
  let childCalls = 0;
  const finished: string[] = [];
  const provider = scriptedProvider('mock', (req) => {
    assert.ok(req.tools.some((t) => t.name === 'computer_use'));
    if (isChild(req)) {
      return childCalls++ === 0 ? call('child-shot', 'computer_use', { action: 'screenshot' }) : say('Child saw the app.');
    }
    if (leadCalls++ === 0) return call('lead-shot', 'computer_use', { action: 'screenshot' });
    if (leadCalls === 2) return call('spawn', 'spawn_agent', { description: 'Inspect app', prompt: 'Inspect the app', background: false });
    return say('Both agents saw the app.');
  });
  try {
    const session = AgentSession.create({
      provider, cwd: tmpdir('portable-computer-cwd-'), mode: 'full',
      extraTools: [{
        spec: { name: 'computer_use', description: 'Observe an app', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
        kind: 'read', summarize: () => 'Observe app',
        execute: async (_input, ctx) => {
          contexts.push(ctx);
          return { output: ctx.agentId ? 'Target moved; observe the current app before retrying.' : 'Screenshot of app',
            isError: !!ctx.agentId, images: [{ mediaType: 'image/png', data: png }] };
        },
        finishSubagent: async (id) => { finished.push(id); },
      }],
      callbacks: { onEvent: (event) => events.push(event), requestApproval: async () => 'allow' },
    });
    await session.prompt('Inspect an app, then ask a child to verify.');
    assert.deepEqual(contexts.map((ctx) => ctx.callId), ['lead-shot', 'child-shot']);
    assert.ok(contexts.every((ctx) => ctx.signal && ctx.model && ctx.permissionMode));
    assert.ok(contexts.every((ctx) => ctx.supportsVision === provider.capabilities(ctx.model!).vision));
    assert.equal(contexts[0]!.permissionMode, 'full');
    assert.equal(contexts[1]!.permissionMode, 'plan', 'an explorer keeps its read-only ceiling');
    assert.ok(contexts[1]!.agentId);
    assert.deepEqual(finished, [contexts[1]!.agentId]);
    const sawImage = (req: ProviderRequest) => req.messages.some((m) => m.role === 'user' && m.content.some((c) => c.type === 'image' && c.data === png));
    assert.ok(provider.requests.filter((r) => !isChild(r)).some(sawImage));
    assert.ok(provider.requests.filter(isChild).some(sawImage));
    assert.ok(provider.requests.filter(isChild).some((req) => req.messages.some((m) => m.role === 'user'
      && m.content.some((c) => c.type === 'tool_result' && c.isError))), 'recovery screenshots preserve the failure result');
    assert.ok(!JSON.stringify(events).includes(png));
    assert.ok(!JSON.stringify(session.store.loadMessages()).includes(png));
  } finally {
    if (previousHome === undefined) delete process.env.JUNO_HOME;
    else process.env.JUNO_HOME = previousHome;
  }
});
