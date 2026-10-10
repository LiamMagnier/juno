import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSession } from '../agent.js';
import { delegationPromptSection, orchestrationToolSpecs } from '../subagents.js';
import { jobAwareShellTools, BackgroundJobs } from '../harness/jobs.js';
import type { ApprovalDecision } from '../types.js';
import { gitRepo, say, scriptedProvider, tmpdir } from './fake-provider.js';

// Pins the guidance that makes the agent use its tools well: plan first,
// verify before done, run a dev server and look at the page for web work,
// use the Simulator for app work, and delegate only when it pays off.

async function systemPrompt(): Promise<string> {
  process.env.JUNO_HOME = tmpdir('alevr-home-');
  const provider = scriptedProvider('mock', () => say('ok'));
  const session = AgentSession.create({
    provider,
    cwd: gitRepo(),
    mode: 'full',
    callbacks: { onEvent: () => {}, requestApproval: async (): Promise<ApprovalDecision> => 'allow' },
  });
  await session.prompt('hello');
  const first = provider.requests[0];
  assert.ok(first, 'the session made no request');
  return first.system;
}

test('the Code system prompt says when to plan, how to verify, and how to look at web and app work', async () => {
  const system = await systemPrompt();
  assert.match(system, /Plan first when a change spans several files/);
  assert.match(system, /Read your own diff before you say you are done/);
  assert.match(system, /Never claim something works that you did not see work/);
  assert.match(system, /Web UI work: start the dev server as a background job \(bash with run_in_background\)/);
  assert.match(system, /http:\/\/localhost:<port>/);
  assert.match(system, /opens its Preview on that address by itself/);
  assert.match(system, /iOS or macOS app work: build for the simulator/);
  assert.match(system, /xcrun simctl/);
});

test('the delegation section says when to delegate and which role to pick', () => {
  const section = delegationPromptSection({ maxConcurrent: 4, maxPerTurn: 6 });
  assert.match(section, /Delegate when it pays off: independent parts that can run in parallel/);
  assert.match(section, /a broad search across a large codebase \(role explorer\)/);
  assert.match(section, /an independent review or verification of your change \(roles reviewer, tester\)/);
  assert.match(section, /Never delegate one-line fixes/);
  assert.match(section, /Pick the role that fits the job/);
  assert.match(section, /self-contained prompt/);
});

test('the tool descriptions point at background servers and fresh-context children', () => {
  const bash = jobAwareShellTools(new BackgroundJobs()).find((tool) => tool.spec.name === 'bash');
  assert.ok(bash);
  assert.match(bash.spec.description, /Set run_in_background for servers and watchers/);
  const delegate = orchestrationToolSpecs().find((spec) => spec.name === 'delegate_tasks');
  assert.ok(delegate);
  assert.match(delegate.description, /independent work/);
  assert.match(delegate.description, /FRESH context/);
});
