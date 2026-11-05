/**
 * `computer_fill_login` (work/computer-login-tool.ts;
 * docs/design/agents-v2/VAULT.md) through a real `WorkAgentSession` driven by
 * the scripted model: the first fill of a login asks at `sensitive` under
 * every approval mode, an approved login follows the mode at `command`, and a
 * call the host will refuse raises no card. The host's fill is a stand-in that
 * records whether the call was put to the person.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FILL_LOGIN_ACTION,
  FILL_LOGIN_TOOL_NAME,
  NO_BUDGET,
  WorkAgentSession,
  WorkPlan,
  computerFillLoginTool,
  createScriptedWorkProvider,
  mayHoldStandingAllowance,
  type FillLoginCallState,
} from '../work/index.js';
import type { WorkApprovalRequest, WorkEmittedEvent, WorkPermissionPolicy } from '../work/types.js';

function host(state: FillLoginCallState) {
  const fills: Array<{ login: string; approvedNow: boolean }> = [];
  let current = state;
  let refreshes = 0;
  const tool = computerFillLoginTool({
    description: 'Fill a saved login. Saved logins: "GitHub" (https://github.com).',
    classify: () => current,
    describe: (login) => (login === 'GitHub' ? { label: 'GitHub', site: 'github.com' } : null),
    refresh: async () => {
      refreshes++;
    },
    fill: async (request) => {
      fills.push(request);
      return { ok: true, output: 'Filled the login for GitHub.' };
    },
  });
  return {
    tool,
    fills,
    set: (next: FillLoginCallState) => (current = next),
    refreshes: () => refreshes,
  };
}

async function run(tool: ReturnType<typeof host>['tool'], mode: WorkPermissionPolicy, answer: 'allowed' | 'denied' = 'allowed') {
  const approvals: WorkApprovalRequest[] = [];
  const events: WorkEmittedEvent[] = [];
  const session = new WorkAgentSession({
    runId: 'run_login',
    goal: 'Sign in.',
    provider: createScriptedWorkProvider({
      version: 1,
      vision: true,
      steps: [
        { call: { name: FILL_LOGIN_TOOL_NAME, input: { login: 'GitHub' } } },
        { say: 'Done.', end: true },
      ],
    }),
    model: 'scripted-work-model',
    cwd: '/tmp',
    tools: [tool],
    plan: new WorkPlan([{ id: 'step_1', title: 'Sign in' }]),
    budget: NO_BUDGET,
    approvalMode: mode,
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals.push(request);
        return answer;
      },
      askQuestion: async () => 'ok',
    },
  });
  await session.run();
  return { approvals, events };
}

test('a login never approved asks at sensitive under every mode, Skip included, and the fill is told it was asked', async () => {
  for (const mode of ['conservative', 'balanced', 'permissive'] as const) {
    const h = host('unapproved');
    const { approvals, events } = await run(h.tool, mode);
    assert.equal(approvals.length, 1, mode);
    assert.equal(approvals[0]!.action, FILL_LOGIN_ACTION);
    assert.equal(approvals[0]!.risk, 'sensitive');
    assert.equal(approvals[0]!.summary, 'Sign in with your saved login “GitHub” on github.com');
    assert.deepEqual(approvals[0]!.detail.login, 'GitHub');
    assert.deepEqual(approvals[0]!.detail.site, 'github.com');
    assert.deepEqual(h.fills, [{ login: 'GitHub', approvedNow: true }]);
    assert.ok(h.refreshes() >= 1, 'the snapshot is read again after the call');
    const finished = events.find((e) => e.kind === 'tool_finished');
    assert.equal(finished?.kind === 'tool_finished' && finished.isError, false);
  }
});

test('a declined first fill fills nothing', async () => {
  const h = host('unapproved');
  const { approvals } = await run(h.tool, 'permissive', 'denied');
  assert.equal(approvals.length, 1);
  assert.equal(h.fills.length, 0);
});

test('an approved login follows the mode, and no standing allowance ever covers it', async () => {
  const skip = host('approved');
  assert.equal((await run(skip.tool, 'permissive')).approvals.length, 0);
  assert.deepEqual(skip.fills, [{ login: 'GitHub', approvedNow: false }], 'the host checks its own record of the approval');
  const manual = host('approved');
  const asked = await run(manual.tool, 'conservative');
  assert.equal(asked.approvals[0]?.risk, 'command');
  for (const risk of ['safe', 'edit', 'command'] as const) {
    assert.equal(mayHoldStandingAllowance(FILL_LOGIN_ACTION, risk), false, `"login" is a floor token (${risk})`);
  }
});

test('a call the host will refuse raises no card and is not marked as asked', async () => {
  for (const state of ['unknown', 'elsewhere'] as const) {
    const h = host(state);
    const { approvals } = await run(h.tool, 'conservative');
    assert.equal(approvals.length, 0, state);
    assert.deepEqual(h.fills, [{ login: 'GitHub', approvedNow: false }], state);
  }
});

test('the takeover fence stops a fill before the host is called', async () => {
  const fills: unknown[] = [];
  const tool = computerFillLoginTool({
    description: 'x',
    classify: () => 'approved',
    describe: () => null,
    refresh: async () => {},
    fill: async (request) => {
      fills.push(request);
      return { ok: true, output: 'Filled the login for GitHub.' };
    },
    blockedReason: () => 'The person has control of this computer right now.',
  });
  const result = await tool.execute({ login: 'GitHub' }, { cwd: '/tmp', callId: 'c1' });
  assert.equal(result.isError, true);
  assert.equal(fills.length, 0);
});
