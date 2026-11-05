/**
 * Named custom agents (`.alevr/agents`, `.juno/agents`, `.claude/agents`):
 * parsing, discovery precedence, and that spawn_agent / delegate_tasks apply
 * an agent's brief, tools, model and step cap without ever widening what the
 * session allows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AgentSession } from '../agent.js';
import { loadCustomAgents, parseAgentFile, renderCustomAgents } from '../harness/custom-agents.js';
import type { ProviderRequest } from '../providers/types.js';
import type { ApprovalDecision } from '../types.js';
import { gitRepo, isChild, say, scriptedProvider, tmpdir } from './fake-provider.js';

const REVIEWER = `---
name: Security Reviewer
description: Reviews a change for injection and auth mistakes.
tools: Read, Grep, Glob
model: inherit
mode: read_only
maxSteps: 7
---
Check every query for injection. Cite file:line for each finding.
`;

test('parseAgentFile reads the Claude Code format and maps its tool names', () => {
  const agent = parseAgentFile(REVIEWER, '/r/.claude/agents/sec.md', '.claude/agents/sec.md', 'project');
  assert.ok(agent);
  assert.equal(agent.name, 'security-reviewer');
  assert.equal(agent.description, 'Reviews a change for injection and auth mistakes.');
  assert.deepEqual(agent.tools, ['read_file', 'grep', 'glob']);
  assert.equal(agent.model, undefined, 'inherit means the parent model');
  assert.equal(agent.readOnly, true);
  assert.equal(agent.maxSteps, 7);
  assert.match(agent.instructions, /Cite file:line/);
});

test('parseAgentFile takes YAML list tools, a file-stem name, and refuses an empty body', () => {
  const listed = parseAgentFile('---\ntools:\n  - Bash\n  - "Edit"\nmodel: fast\n---\nRun the tests.\n', '/r/x/tester.md', 'x/tester.md', 'project');
  assert.ok(listed);
  assert.equal(listed.name, 'tester');
  assert.deepEqual(listed.tools, ['bash', 'bash_output', 'kill_job', 'edit_file', 'edit_files']);
  assert.equal(listed.model, 'fast');
  assert.equal(listed.readOnly, false);
  assert.equal(parseAgentFile('---\nname: empty\n---\n', '/r/e.md', 'e.md', 'project'), null);
});

test('loadCustomAgents: nearest folder wins, the home tier is read, a symlink out of the repo is ignored', () => {
  const cwd = gitRepo({
    'README.md': 'hi\n',
    '.alevr/agents/reviewer.md': '---\nname: reviewer\ndescription: alevr one\n---\nA\n',
    '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: claude one\n---\nB\n',
    '.claude/agents/docs.md': '---\ndescription: writes docs\n---\nWrite docs.\n',
  });
  const outside = tmpdir('alevr-outside-');
  fs.writeFileSync(path.join(outside, 'leak.md'), '---\nname: leak\n---\nsecret\n');
  fs.symlinkSync(path.join(outside, 'leak.md'), path.join(cwd, '.claude/agents/leak.md'));
  const home = tmpdir('alevr-home-');
  fs.mkdirSync(path.join(home, 'agents'));
  fs.writeFileSync(path.join(home, 'agents', 'mine.md'), '---\nname: mine\ndescription: my own\n---\nMine.\n');

  const agents = loadCustomAgents(cwd, home);
  assert.deepEqual(agents.map((a) => a.name), ['docs', 'mine', 'reviewer']);
  assert.equal(agents.find((a) => a.name === 'reviewer')?.description, 'alevr one');
  assert.equal(agents.find((a) => a.name === 'mine')?.scope, 'user');
  assert.equal(loadCustomAgents(cwd, null).some((a) => a.name === 'mine'), false);
  assert.equal(renderCustomAgents([]), '');
  assert.match(renderCustomAgents(agents), /- docs: writes docs/);
});

function session(cwd: string, route: (req: ProviderRequest) => ReturnType<typeof say>) {
  process.env.JUNO_HOME = tmpdir('alevr-agents-home-');
  const provider = scriptedProvider('mock', route);
  const s = AgentSession.create({
    provider,
    cwd,
    mode: 'full',
    subagents: { readBeforeEdit: false },
    callbacks: { onEvent: () => {}, requestApproval: async (): Promise<ApprovalDecision> => 'allow' },
  });
  return { s, provider };
}

function text(result: unknown): string {
  const r = result as { type?: string; content?: string };
  return r.type === 'tool_result' ? String(r.content) : '';
}

test('spawn_agent with agent applies the brief, and narrows tools; it never widens', async () => {
  const cwd = gitRepo({ 'README.md': 'hi\n', '.claude/agents/sec.md': REVIEWER });
  const { s, provider } = session(cwd, () => say('No findings.'));

  const unknown = await s.subagents!.handleToolCall(0, { id: 'a', name: 'spawn_agent', input: { description: 'x', prompt: 'y', agent: 'nope' } });
  assert.match(text(unknown), /No agent named 'nope'. Available: security-reviewer/);

  const writes = await s.subagents!.handleToolCall(0, {
    id: 'b',
    name: 'spawn_agent',
    input: { description: 'x', prompt: 'y', agent: 'security-reviewer', writes: true },
  });
  assert.match(text(writes), /read-only/);

  const ok = await s.subagents!.handleToolCall(0, {
    id: 'c',
    name: 'spawn_agent',
    input: { description: 'Review auth', prompt: 'Review src/auth.ts', agent: 'Security Reviewer', background: false },
  });
  assert.doesNotMatch(text(ok), /No agent|read-only/, text(ok));
  const child = provider.requests.find(isChild);
  assert.ok(child, 'the child ran');
  assert.match(child.system, /working as the security-reviewer agent \(\.claude\/agents\/sec\.md\)/);
  assert.match(child.system, /Check every query for injection/);
  const tools = child.tools.map((t) => t.name).sort();
  assert.ok(tools.length > 0);
  for (const name of tools) assert.ok(['glob', 'grep', 'read_file'].includes(name), `unexpected child tool ${name}`);
  const state = s.subagents!.states().find((t) => t.title === 'Review auth');
  assert.ok(state);
});

test('the root system prompt lists the repository agents, and delegate_tasks takes agent', async () => {
  const cwd = gitRepo({ 'README.md': 'hi\n', '.alevr/agents/sec.md': REVIEWER });
  const { s, provider } = session(cwd, () => say('done'));
  await s.prompt('hello');
  const root = provider.requests.find((req) => !isChild(req));
  assert.ok(root);
  assert.match(root.system, /Named agents from this repository/);
  assert.match(root.system, /- security-reviewer: Reviews a change for injection and auth mistakes\. \(read-only\)/);

  const bad = await s.subagents!.handleToolCall(1, {
    id: 'd',
    name: 'delegate_tasks',
    input: { tasks: [{ title: 'Audit', prompt: 'audit it', role: 'reviewer', agent: 'ghost' }] },
  });
  assert.match(text(bad), /Task 1 \('Audit'\): No agent named 'ghost'/);
  const good = await s.subagents!.handleToolCall(1, {
    id: 'e',
    name: 'delegate_tasks',
    input: { tasks: [{ title: 'Audit', prompt: 'audit it', role: 'reviewer', agent: 'security-reviewer' }] },
  });
  assert.match(text(good), /Created 1 subagent task/);
  await s.subagents!.drainActive();
});
