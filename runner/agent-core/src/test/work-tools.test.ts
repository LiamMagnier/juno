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
