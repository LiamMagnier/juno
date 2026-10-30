/**
 * Starting an agent's computer from a Work run (work/computer-tools.ts,
 * `withComputerStart`; docs/design/agents-v2/COMPUTERS_2026-10.md §S1.5), at
 * the definition level and through a real `WorkAgentSession` driven by the
 * scripted model. The gate here is a stand-in with the same states the
 * website's holder has (src/lib/computer/run-tools.ts, tested there too).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_START_ACTION,
  COMPUTER_START_DECLINED_TEXT,
  COMPUTER_START_PENDING_TEXT,
  NO_BUDGET,
  WorkAgentSession,
  WorkPlan,
  computerStartedText,
  computerTools,
  createScriptedWorkProvider,
  withComputerStart,
  type ComputerShotData,
  type ComputerStartGate,
  type ComputerToolsDeps,
  type ScriptedWorkScript,
  type StartState,
} from '../work/index.js';
import type { WorkApprovalAnswer, WorkApprovalRequest, WorkEmittedEvent, WorkToolDefinition } from '../work/types.js';

const POLICY_OFF = 'The person switched off your computer for tasks. Nothing was started. Carry on without it.';
const NOW_ASK = 'The person now wants to be asked before your computer starts. Call the tool again and they will be asked.';

interface GateState {
  policy: 'off' | 'ask' | 'allowed';
  approval: 'none' | 'pending' | 'approved' | 'declined';
  started: boolean;
  declinedHere: boolean;
  starts: boolean[];
  refreshes: number;
  requested: number;
}

function fakeGate(initial: Partial<GateState> = {}): { gate: ComputerStartGate; g: GateState } {
  const g: GateState = { policy: 'ask', approval: 'none', started: false, declinedHere: false, starts: [], refreshes: 0, requested: 0, ...initial };
  const gate: ComputerStartGate = {
    agentName: 'Mira',
    async refresh() {
      g.refreshes += 1;
    },
    state(): StartState {
      if (g.policy === 'off') return 'refused';
      if (g.started) return 'ready';
      if (g.approval === 'approved' || g.policy === 'allowed') return 'needs_start';
      if (g.approval === 'pending') return 'start_pending';
      if (g.approval === 'declined' || g.declinedHere) return 'declined';
      return 'needs_approval';
    },
    async start(how) {
      g.starts.push(how.approvedStart);
      if (g.policy === 'off') return POLICY_OFF;
      if (g.started) return null;
      if (g.policy === 'ask' && !how.approvedStart && g.approval !== 'approved') return NOW_ASK;
      g.started = true;
      return null;
    },
    noteStartUnanswered() {
      g.declinedHere = true;
    },
    onStartRequested() {
      g.requested += 1;
    },
  };
  return { gate, g };
}

function shot(): ComputerShotData {
  return { mediaType: 'image/jpeg', data: Buffer.from('jpeg').toString('base64'), width: 1280, height: 800, hash: 'h' };
}

function deps(calls: string[]): ComputerToolsDeps {
  const act = (name: string) => async () => {
    calls.push(name);
    return shot();
  };
  return {
    isHealthy: () => true,
    pageTakesPayment: () => false,
    currentUrl: () => 'https://example.com',
    screenEpoch: () => 1,
    screenshot: act('screenshot'),
    click: act('click'),
    type: act('type'),
    key: act('key'),
    scroll: act('scroll'),
    exec: async (command) => {
      calls.push(`exec:${command}`);
      return { stdout: 'ran', stderr: '', exitCode: 0, timedOut: false };
    },
    listFiles: async () => {
      calls.push('list');
      return [{ name: 'a.txt', path: '/home/agent/work/a.txt', type: 'file', size: 1 }];
    },
    readFile: async () => '',
    writeFile: async () => {},
    settle: false,
  };
}

function gatedTools(gate: ComputerStartGate, calls: string[]): WorkToolDefinition[] {
  return computerTools(deps(calls)).map((tool) => withComputerStart(tool, gate));
}

const shellOf = (tools: WorkToolDefinition[]) => tools.find((t) => t.spec.name === 'computer_shell')!;
const filesOf = (tools: WorkToolDefinition[]) => tools.find((t) => t.spec.name === 'computer_files')!;

function session(tools: WorkToolDefinition[], script: ScriptedWorkScript, answer: (r: WorkApprovalRequest) => WorkApprovalAnswer) {
  const approvals: WorkApprovalRequest[] = [];
  const events: WorkEmittedEvent[] = [];
  const s = new WorkAgentSession({
    runId: 'run_gate',
    goal: 'Use the computer.',
    provider: createScriptedWorkProvider(script),
    model: 'scripted-work-model',
    cwd: '/tmp',
    tools,
    plan: new WorkPlan([{ id: 'step_1', title: 'Work' }]),
    budget: NO_BUDGET,
    approvalMode: 'permissive',
    callbacks: {
      onEvent: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals.push(request);
        return answer(request);
      },
      askQuestion: async () => 'ok',
    },
  });
  return { s, approvals, events };
}

const results = (events: WorkEmittedEvent[]) =>
  events.flatMap((e) => (e.kind === 'tool_finished' ? [e] : []));

test('needs_approval: the call is the start, at risk sensitive, with its own words', async () => {
  const { gate } = fakeGate();
  const shell = shellOf(gatedTools(gate, []));
  const input = { command: 'ls -la' };
  assert.equal(shell.actionFor(input), COMPUTER_START_ACTION);
  assert.equal(shell.riskFor(input), 'sensitive');
  assert.equal(shell.summarize(input), 'Start Mira’s computer');
  assert.equal(shell.provenanceFor(input).trust, 'trusted', 'the start result is the platform’s own text');
  const preview = await shell.preview!(input, { callId: 'c1', forApproval: true });
  assert.equal(preview?.summary, 'Start Mira’s computer');
  assert.equal(preview?.detail?.next, 'What it wants to do next (asked separately): Run: ls -la (in /home/agent/work)');
});

test('ask: approving starts the computer and does nothing else; the repeat asks for itself and is not halted', async () => {
  const { gate, g } = fakeGate();
  const calls: string[] = [];
  const script: ScriptedWorkScript = {
    version: 1,
    vision: false,
    steps: [
      { call: { name: 'computer_shell', input: { command: 'echo hi' } } },
      { call: { name: 'computer_shell', input: { command: 'echo hi' } } },
      { say: 'Done.', end: true },
    ],
  };
  const { s, approvals, events } = session(gatedTools(gate, calls), script, () => 'allowed');
  await s.run();
  assert.equal(approvals.length, 2, 'one start card, then the shell’s own card');
  assert.equal(approvals[0]!.action, 'work.computer.start');
  assert.equal(approvals[0]!.risk, 'sensitive');
  assert.equal(approvals[0]!.summary, 'Start Mira’s computer');
  assert.equal(approvals[1]!.action, 'work.computer.shell');
  assert.equal(approvals[1]!.risk, 'sensitive');
  assert.notEqual(approvals[0]!.actionDigest, approvals[1]!.actionDigest, 'one approval authorises one thing');
  assert.deepEqual(g.starts, [true], 'the approved card started it');
  assert.deepEqual(calls, ['exec:echo hi'], 'the start ran nothing; the repeat ran the command once');
  const finished = results(events);
  assert.equal(finished.length, 2, 'the progress detector let the repeat through');
  assert.equal(events.some((e) => e.kind === 'tool_denied'), false);
  assert.equal(g.requested, 1, 'start_requested once');
});

test('a declined start is not asked again in the run', async () => {
  const { gate } = fakeGate();
  const calls: string[] = [];
  const script: ScriptedWorkScript = {
    version: 1,
    vision: false,
    steps: [
      { call: { name: 'computer_files', input: { action: 'list', path: '/home/agent/work' } } },
      { call: { name: 'computer_files', input: { action: 'list', path: '/home/agent/work' } } },
      { expect: 'did not start your computer', say: 'Carrying on.', end: true },
    ],
  };
  const { s, approvals, events } = session(gatedTools(gate, calls), script, () => 'denied');
  await s.run();
  assert.equal(approvals.length, 1, 'asked once');
  assert.deepEqual(calls, []);
  const said = events.flatMap((e) => (e.kind === 'assistant_message' ? [e.text] : []));
  assert.ok(said.includes('Carrying on.'), 'the second call answered with the declined sentence');
});

test('a declined start read from the run (a resumed process) is not asked again either', async () => {
  const { gate } = fakeGate({ approval: 'declined' });
  const files = filesOf(gatedTools(gate, []));
  // Not the tool's own card either: the call will only say it was declined.
  assert.equal(files.actionFor({ action: 'list' }), COMPUTER_START_ACTION);
  assert.equal(files.riskFor({ action: 'list' }), 'safe', 'no card at all');
  await files.preview!({ action: 'list' }, { callId: 'c1', forApproval: false });
  const result = await files.execute({ action: 'list' }, { cwd: '/tmp', callId: 'c1' });
  assert.deepEqual(result, { output: COMPUTER_START_DECLINED_TEXT, isError: true });
});

test('a second call while the start card is pending gets the waiting sentence', async () => {
  const { gate, g } = fakeGate({ approval: 'pending' });
  const calls: string[] = [];
  const shell = shellOf(gatedTools(gate, calls));
  await shell.preview!({ command: 'ls' }, { callId: 'c2', forApproval: false });
  assert.equal(shell.riskFor({ command: 'ls' }), 'safe', 'the shell’s own card is not raised for a call that will only wait');
  const result = await shell.execute({ command: 'ls' }, { cwd: '/tmp', callId: 'c2' });
  assert.deepEqual(result, { output: COMPUTER_START_PENDING_TEXT, isError: true });
  assert.deepEqual(g.starts, [], 'nothing started');
  assert.deepEqual(calls, []);
});

test('policy off: refused with its sentence, and an approved start that arrives afterwards does nothing', async () => {
  const { gate, g } = fakeGate();
  const calls: string[] = [];
  const shell = shellOf(gatedTools(gate, calls));
  // The card was raised under ask...
  assert.equal(shell.actionFor({ command: 'ls' }), COMPUTER_START_ACTION);
  await shell.preview!({ command: 'ls' }, { callId: 'c1', forApproval: true });
  // ...the person switched the computer off before answering it, then approved.
  g.policy = 'off';
  const result = await shell.execute({ command: 'ls' }, { cwd: '/tmp', callId: 'c1' });
  assert.deepEqual(result, { output: POLICY_OFF, isError: true });
  assert.equal(g.started, false);
  // Every later call is refused with the same sentence, and asks nothing:
  // not the start card, and not the shell's own card for a command that will not run.
  assert.equal(shell.actionFor({ command: 'ls' }), COMPUTER_START_ACTION);
  assert.equal(shell.riskFor({ command: 'ls' }), 'safe');
  const later = await shell.execute({ command: 'ls' }, { cwd: '/tmp', callId: 'c3' });
  assert.deepEqual(later, { output: POLICY_OFF, isError: true });
  assert.deepEqual(calls, []);
});

test('allowed: the first call starts lazily without a start card, then does what it asked', async () => {
  const { gate, g } = fakeGate({ policy: 'allowed' });
  const calls: string[] = [];
  const files = filesOf(gatedTools(gate, calls));
  assert.equal(files.actionFor({ action: 'list' }), 'work.computer.files');
  assert.equal(files.riskFor({ action: 'list' }), 'safe');
  await files.preview!({ action: 'list' }, { callId: 'c1', forApproval: false });
  const result = await files.execute({ action: 'list', path: '/home/agent/work' }, { cwd: '/tmp', callId: 'c1' });
  assert.equal(result.isError, undefined);
  assert.match(result.output, /a\.txt/);
  assert.deepEqual(g.starts, [false]);
  assert.deepEqual(calls, ['list']);
  assert.equal(files.actionFor({ action: 'list' }), 'work.computer.files', 'ready: the tool’s own action');
});

test('policy lowered from allowed to ask before the first start: nothing starts without a card', async () => {
  const { gate, g } = fakeGate({ policy: 'allowed' });
  const calls: string[] = [];
  const files = filesOf(gatedTools(gate, calls));
  // Decided under allowed...
  assert.equal(files.actionFor({ action: 'list' }), 'work.computer.files');
  await files.preview!({ action: 'list' }, { callId: 'c1', forApproval: false });
  g.policy = 'ask';
  const first = await files.execute({ action: 'list' }, { cwd: '/tmp', callId: 'c1' });
  assert.deepEqual(first, { output: NOW_ASK, isError: true });
  assert.deepEqual(calls, [], 'nothing ran');
  assert.equal(g.started, false);
  // ...and the next call is the card.
  assert.equal(files.actionFor({ action: 'list' }), COMPUTER_START_ACTION);
  assert.equal(files.riskFor({ action: 'list' }), 'sensitive');
});

test('ready: every per-action risk is unchanged', () => {
  const { gate } = fakeGate({ started: true });
  const tools = gatedTools(gate, []);
  const plain = computerTools(deps([]));
  for (const tool of tools) {
    const original = plain.find((p) => p.spec.name === tool.spec.name)!;
    for (const input of [{ command: 'ls' }, { text: 'hi' }, { keys: 'a' }, { keys: 'Tab' }, { action: 'write', path: 'x' }]) {
      assert.equal(tool.riskFor(input), original.riskFor(input), tool.spec.name);
      assert.equal(tool.actionFor(input), original.actionFor(input), tool.spec.name);
    }
  }
  assert.equal(computerStartedText('computer_shell'), 'Started your computer. Nothing else was done: call computer_shell again to do what you asked.');
});
