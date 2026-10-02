import test from 'node:test';
import assert from 'node:assert/strict';
import { execTools, withoutHostWorkspaceTools } from '../work/tools.js';

test('run_code and check_run are hosted tools that survive the host-workspace filter', () => {
  const tools = execTools({
    runCode: async () => ({ output: 'ok', isError: false }),
    checkRun: async () => ({ output: 'ok', isError: false }),
  });
  assert.deepEqual(tools.map((tool) => tool.spec.name), ['run_code', 'check_run']);
  assert.deepEqual(withoutHostWorkspaceTools(tools).map((tool) => tool.spec.name), ['run_code', 'check_run']);
  for (const tool of tools) {
    assert.equal(tool.riskFor({}), 'safe');
    assert.equal(tool.tier, 'structured_file');
    assert.equal(tool.provenanceFor({}).trust, 'untrusted', 'program output is scanned and enveloped');
  }
});

test('the call id and the turn signal reach the effect; a call without an id is refused', async () => {
  const calls: Array<{ callId: string; signal?: AbortSignal }> = [];
  const [runCode] = execTools({
    runCode: async (_input, call) => {
      calls.push(call);
      return { output: 'Ran Python: exit code 0', isError: false, exitCode: 0, images: [{ mediaType: 'image/png', data: 'AAAA' }] };
    },
    checkRun: async () => ({ output: '', isError: false }),
  });
  const controller = new AbortController();
  const result = await runCode.execute({ code: 'print(1)' }, { cwd: '/nowhere', callId: 'toolu_1', signal: controller.signal });
  assert.equal(calls[0].callId, 'toolu_1');
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(result.exitCode, 0);
  assert.equal(result.images?.length, 1);
  const refused = await runCode.execute({ code: 'print(1)' }, { cwd: '/nowhere' });
  assert.equal(refused.isError, true);
  assert.match(refused.output, /Nothing was run/);
  assert.equal(calls.length, 1);
});
