import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutHostWorkspaceTools, workspaceTools } from '../work/tools.js';
import type { WorkToolDefinition } from '../work/types.js';

const fake = (name: string, tier: WorkToolDefinition['tier']): WorkToolDefinition => ({
  tier,
  intents: [],
  intentFor: () => 'test',
  actionFor: () => 'test.action',
  riskFor: () => 'safe',
  provenanceFor: () => ({
    source: 'test',
    sourceKind: 'local_app',
    action: 'test.action',
    trust: 'trusted',
  }),
  spec: {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  },
  kind: 'read',
  summarize: () => name,
  execute: async () => ({ output: '' }),
});

test('cloud work excludes every host workspace tool but keeps cloud tools', () => {
  const localNames = new Set(workspaceTools().map((tool) => tool.spec.name));
  const cloudFiles = fake('cloud_file_write', 'structured_file');
  const tools = withoutHostWorkspaceTools([
    ...workspaceTools(),
    cloudFiles,
  ]);

  assert.deepEqual(
    new Set(tools.map((tool) => tool.spec.name)),
    new Set(['cloud_file_write']),
  );
  assert.ok(localNames.size > 0);
});

test('a Work run cannot overwrite a file it never read, and can once it has read it', async () => {
  const { WorkAgentSession } = await import('../work/session.js');
  const { WorkPlan } = await import('../work/plan.js');
  const { workspaceTools } = await import('../work/tools.js');
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const cwd = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'alevr-work-guard-'));
  fsMod.writeFileSync(pathMod.join(cwd, 'report.md'), 'the person wrote this\n');
  const results: Array<{ id: string; isError: boolean; text: string }> = [];
  const turns = [
    [{ type: 'tool_call', id: 'w1', name: 'write_file', input: { path: 'report.md', content: 'replaced\n' } }],
    [{ type: 'tool_call', id: 'r1', name: 'read_file', input: { path: 'report.md' } }],
    [{ type: 'tool_call', id: 'w2', name: 'write_file', input: { path: 'report.md', content: 'revised\n' } }],
    [{ type: 'text_delta', text: 'Done.' }],
  ];
  const provider = {
    id: 'mock', name: 'Mock', defaultModel: 'mock-1', models: () => ['mock-1'],
    capabilities: () => ({ tools: true, vision: false, computerUse: false, reasoningLevels: [], maxContext: 100_000, streaming: true, mcp: false }),
    async *stream(req: { messages: Array<{ role: string; content: Array<{ type: string; toolCallId?: string; isError?: boolean; content?: unknown }> }> }) {
      for (const message of req.messages) {
        for (const part of message.content) {
          if (part.type === 'tool_result' && part.toolCallId && !results.some((r) => r.id === part.toolCallId)) {
            results.push({ id: part.toolCallId, isError: part.isError === true, text: JSON.stringify(part.content) });
          }
        }
      }
      const turn = turns.shift() ?? [{ type: 'text_delta', text: 'Done.' }];
      for (const event of turn) yield event;
      yield { type: 'done', stopReason: turn[0]?.type === 'tool_call' ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
    },
  };
  const session = new WorkAgentSession({
    runId: 'run-guard', goal: 'Revise the report.', provider: provider as never, model: 'mock-1', cwd,
    tools: workspaceTools(), plan: new WorkPlan([{ id: 's1', title: 'Revise' }]),
    budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, approvalMode: 'conservative',
    callbacks: { onEvent: () => {}, askQuestion: () => Promise.resolve('no'), requestApproval: () => Promise.resolve('allowed') },
  });
  await session.run();
  const blind = results.find((r) => r.id === 'w1');
  assert.equal(blind?.isError, true, 'the unread overwrite is refused');
  assert.match(blind?.text ?? '', /read report\.md/);
  assert.equal(results.find((r) => r.id === 'w2')?.isError, false, 'after reading, the write goes through');
  assert.equal(fsMod.readFileSync(pathMod.join(cwd, 'report.md'), 'utf8'), 'revised\n');
});
