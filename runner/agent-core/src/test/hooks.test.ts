import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { ProjectHooks, parseProjectHooks, readProjectHooks } from '../hooks.js';
import { AgentSession } from '../agent.js';
import { bashTool } from '../tools/bash.js';
import type { ToolContext } from '../tools/types.js';
import type { AgentEvent, ApprovalRequest, ApprovalDecision } from '../types.js';
import { scriptedProvider, call, say } from './fake-provider.js';

function fixture(config: unknown) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alevr-hooks-test-'));
  fs.mkdirSync(path.join(cwd, '.alevr'));
  const file = path.join(cwd, '.alevr/hooks.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { cwd, file, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}
const config = (command: string) => ({ version: 1, hooks: { PreToolUse: [{ command, matcher: ['read_file'] }] } });

test('strict hook parsing refuses unsupported events, malformed commands and unbounded timeouts', () => {
  assert.deepEqual(parseProjectHooks(JSON.stringify(config('echo okay'))), config('echo okay'));
  for (const value of [null, {}, { version: 1, hooks: { PreToolUse: [{ command: '' }] } }, { version: 1, hooks: { OtherEvent: [] } }, { version: 1, hooks: { Stop: [{ command: 'echo x', timeoutMs: 600_001 }] } }, { version: 1, hooks: { Stop: [{ command: 'echo x', matcher: '(.*)+' }] } }, { version: 1, hooks: { Stop: [{ command: 'echo x', unexpected: true }] } }]) {
    assert.throws(() => parseProjectHooks(JSON.stringify(value)));
  }
});

test('hook discovery hashes exact bytes, rejects symlinks and bounds regular files', () => {
  const f = fixture(config('echo okay'));
  try {
    const first = readProjectHooks(f.cwd)!;
    fs.appendFileSync(f.file, '\n');
    assert.notEqual(readProjectHooks(f.cwd)!.hash, first.hash);
    fs.writeFileSync(f.file, 'x'.repeat(32_769));
    assert.throws(() => readProjectHooks(f.cwd), /32 KB/);
    fs.unlinkSync(f.file);
    fs.symlinkSync('/etc/hosts', f.file);
    assert.throws(() => readProjectHooks(f.cwd), /regular file/);
    fs.unlinkSync(f.file);
    fs.rmdirSync(path.dirname(f.file));
    fs.symlinkSync('/tmp', path.dirname(f.file));
    assert.throws(() => readProjectHooks(f.cwd), /inside the project/);
  } finally { f.cleanup(); }
});

test('denied trust leaves no hook side effect; a changed config is reviewed again', async () => {
  const f = fixture(config('echo ran >> marker'));
  const events: AgentEvent[] = [];
  const requests: ApprovalRequest[] = [];
  let answer: ApprovalDecision = 'deny';
  const hooks = new ProjectHooks({ emit: (e) => events.push(e), permission: () => 'allow', requestApproval: async (r) => { requests.push(r); return answer; } });
  const ctx = { cwd: f.cwd, permissionMode: 'full' as const };
  try {
    assert.equal((await hooks.run('PreToolUse', ctx, { tool: 'read_file' })).ok, false);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
    assert.equal(requests[0].requiresHuman, true);
    assert.equal(requests[0].risk, 'sensitive');
    answer = 'allow_always';
    assert.equal((await hooks.run('PreToolUse', ctx, { tool: 'read_file' })).ok, true);
    assert.equal((await hooks.run('PreToolUse', ctx, { tool: 'read_file' })).ok, true);
    assert.equal(requests.length, 2, 'session trust is remembered for this exact configuration');
    fs.writeFileSync(f.file, JSON.stringify(config('echo changed >> marker')));
    answer = 'deny';
    assert.equal((await hooks.run('PreToolUse', ctx, { tool: 'read_file' })).ok, false);
    assert.equal(requests.length, 3);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'marker'), 'utf8'), 'ran\nran\n');
    assert.ok(events.some((e) => e.type === 'tool_finished' && e.name === 'hook:PreToolUse'));
  } finally { f.cleanup(); }
});

test('hash trust never bypasses a deny or an ask, and review-time mutations execute nothing', async () => {
  const f = fixture(config('echo bad > marker'));
  let permission: 'allow' | 'ask' | 'deny' = 'deny';
  let prompts = 0;
  const hash = readProjectHooks(f.cwd)!.hash;
  const hooks = new ProjectHooks({ trustedHashes: [hash], emit: () => {}, permission: () => permission, requestApproval: async () => { prompts++; return 'deny'; } });
  try {
    assert.equal((await hooks.run('PreToolUse', { cwd: f.cwd }, { tool: 'read_file' })).ok, false);
    assert.equal(prompts, 0);
    permission = 'ask';
    assert.equal((await hooks.run('PreToolUse', { cwd: f.cwd }, { tool: 'read_file' })).ok, false);
    assert.equal(prompts, 1);
    const racing = new ProjectHooks({ emit: () => {}, permission: () => 'allow', requestApproval: async () => { fs.appendFileSync(f.file, '\n'); return 'allow'; } });
    assert.match((await racing.run('PreToolUse', { cwd: f.cwd }, { tool: 'read_file' })).reason!, /changed during review/);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
  } finally { f.cleanup(); }
});

test('hook timeout and Stop cancellation terminate execution', async () => {
  const f = fixture({ version: 1, hooks: { Stop: [{ command: 'sleep 5; echo escaped > marker', timeoutMs: 100 }] } });
  const hooks = new ProjectHooks({ emit: () => {}, permission: () => 'allow', requestApproval: async () => 'allow' });
  try {
    const started = Date.now();
    assert.equal((await hooks.run('Stop', { cwd: f.cwd })).ok, false);
    assert.ok(Date.now() - started < 4000);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
    assert.equal((await hooks.run('Stop', { cwd: f.cwd, signal: AbortSignal.abort() })).ok, false);
  } finally { f.cleanup(); }
});

test('PreToolUse failure prevents the actual agent tool and Stop runs once at settlement', async () => {
  const f = fixture({ version: 1, hooks: { PreToolUse: [{ command: 'exit 7', matcher: ['read_file'] }], Stop: [{ command: 'echo stopped > stop-marker' }] } });
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  const provider = scriptedProvider('hooks', (_req, i) => i === 0 ? call('read-1', 'read_file', { path: 'source.txt' }) : say('done'));
  fs.writeFileSync(path.join(f.cwd, 'source.txt'), 'private source text');
  const events: AgentEvent[] = [];
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'full', subagents: false, callbacks: { onEvent: (e) => events.push(e), requestApproval: async () => 'allow_always' } });
  try {
    await session.prompt('read the source');
    const result = events.find((e) => e.type === 'tool_finished' && e.callId === 'read-1');
    assert.ok(result && result.type === 'tool_finished' && result.isError);
    assert.doesNotMatch(JSON.stringify(result), /private source text/);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'stop-marker'), 'utf8'), 'stopped\n');
    assert.equal(events.filter((e) => e.type === 'tool_started' && e.name === 'hook:Stop').length, 1);
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});

test('Plan refuses hook shell even when the underlying read tool is allowed', async () => {
  const f = fixture(config('echo forbidden > marker'));
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  const provider = scriptedProvider('plan-hooks', (_req, i) => i === 0 ? call('read-1', 'read_file', { path: 'source.txt' }) : say('done'));
  let approvals = 0;
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'plan', subagents: false, hooks: { trustedHashes: [readProjectHooks(f.cwd)!.hash] }, callbacks: { onEvent: () => {}, requestApproval: async () => { approvals++; return 'allow'; } } });
  try {
    await session.prompt('read the source');
    assert.equal(approvals, 0);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});

test('PostToolUse failure preserves the authorized tool result and reports failure', async () => {
  const f = fixture({ version: 1, hooks: { PostToolUse: [{ command: 'exit 9' }] } });
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  let executions = 0;
  const events: AgentEvent[] = [];
  const provider = scriptedProvider('post-hooks', (_req, i) => i === 0 ? call('read-1', 'read_file', {}) : say('done'));
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'full', subagents: false,
    tools: [{ kind: 'read', spec: { name: 'read_file', description: '', inputSchema: {} }, summarize: () => '', execute: async () => { executions++; return { output: 'actual content' }; } }],
    callbacks: { onEvent: (e) => events.push(e), requestApproval: async () => 'allow' } });
  try {
    await session.prompt('read the source');
    const result = events.find((e) => e.type === 'tool_finished' && e.callId === 'read-1');
    assert.equal(executions, 1);
    assert.ok(result && result.type === 'tool_finished');
    assert.equal(result.isError, true);
    assert.match(result.output, /actual content/);
    assert.match(result.output, /PostToolUse hook failed/);
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});

test('hook execution preserves the sandbox and forwards only the supplied scrubbed environment', async () => {
  const f = fixture(config('echo checked'));
  const execute = bashTool.execute;
  let captured: ToolContext | undefined;
  bashTool.execute = async (_input, ctx) => { captured = ctx; return { output: 'okay', exitCode: 0 }; };
  const hooks = new ProjectHooks({ emit: () => {}, permission: () => 'allow', requestApproval: async () => 'allow' });
  try {
    const sandbox = { image: 'local-test-image', worktreeHostPath: f.cwd, network: 'none' as const, forwardEnv: ['PATH'] };
    await hooks.run('PreToolUse', { cwd: f.cwd, env: { PATH: '/usr/bin:/bin', OWNER_VALUE: 'test' }, containerSandbox: sandbox }, { tool: 'read_file', input: { path: 'source.txt' } });
    assert.equal(captured?.containerSandbox?.image, sandbox.image);
    assert.equal(captured?.containerSandbox?.network, 'none');
    assert.equal(captured?.containerSandbox?.worktreeHostPath, f.cwd);
    assert.deepEqual(captured?.containerSandbox?.forwardEnv, ['PATH', 'ALEVR_HOOK_CONTEXT']);
    assert.deepEqual(Object.keys(captured?.env ?? {}).sort(), ['ALEVR_HOOK_CONTEXT', 'OWNER_VALUE', 'PATH']);
    assert.equal(JSON.parse(captured!.env!.ALEVR_HOOK_CONTEXT!).input.path, 'source.txt');
    assert.deepEqual(sandbox.forwardEnv, ['PATH'], 'one invocation does not mutate the host sandbox');
  } finally { bashTool.execute = execute; f.cleanup(); }
});


test('a denied tool cannot run its pre-hook or the tool itself', async () => {
  const f = fixture({ version: 1, hooks: { PreToolUse: [{ command: 'echo escaped > marker', matcher: ['write_file'] }] } });
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  let executions = 0;
  let approvals = 0;
  const provider = scriptedProvider('denied-hook', (_req, i) => i === 0 ? call('write-1', 'write_file', {}) : say('done'));
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'plan', subagents: false,
    tools: [{ kind: 'edit', spec: { name: 'write_file', description: '', inputSchema: {} }, summarize: () => '', execute: async () => { executions++; return { output: 'changed' }; } }],
    callbacks: { onEvent: () => {}, requestApproval: async () => { approvals++; return 'allow'; } } });
  try {
    await session.prompt('try the write');
    assert.equal(executions, 0);
    assert.equal(approvals, 0);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});

test('a read-only child inherits project hooks and cannot run their shell in the parent Full access mode', async () => {
  const f = fixture(config('echo escaped > marker'));
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  fs.writeFileSync(path.join(f.cwd, 'source.txt'), 'private child source');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: f.cwd });
  execFileSync('git', ['add', '.'], { cwd: f.cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'], { cwd: f.cwd });
  let rootCalls = 0;
  let childCalls = 0;
  const events: AgentEvent[] = [];
  const provider = scriptedProvider('child-hooks', (req) => {
    if (req.system.includes('SUBAGENT')) return childCalls++ === 0 ? call('child-read', 'read_file', { path: 'source.txt' }) : say('child done');
    if (rootCalls++ === 0) return call('delegate-1', 'delegate_tasks', { tasks: [{ title: 'Read', prompt: 'read the source', role: 'explorer' }] });
    if (rootCalls === 2) return call('await-1', 'await_subagents', {});
    return say('done');
  });
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'full', callbacks: { onEvent: (e) => events.push(e), requestApproval: async () => 'allow' } });
  try {
    await session.prompt('delegate the read');
    const result = events.find((e) => e.type === 'tool_finished' && e.callId === 'child-read');
    assert.ok(result && result.type === 'tool_finished', 'the child attempted its own tool');
    assert.ok(result.agentId);
    assert.equal(result.isError, true);
    assert.match(result.output, /hook is blocked/);
    assert.doesNotMatch(result.output, /private child source/);
    assert.equal(fs.existsSync(path.join(f.cwd, 'marker')), false);
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});

test('a hook FIFO is rejected without blocking the configuration reader', { skip: process.platform === 'win32' }, () => {
  const f = fixture(config('echo okay'));
  try {
    fs.unlinkSync(f.file);
    execFileSync('mkfifo', [f.file]);
    // CI runs compiled JavaScript without tsx installed in this package.
    const compiled = import.meta.url.endsWith('.js');
    const source = new URL(compiled ? '../hooks.js' : '../hooks.ts', import.meta.url).href;
    const loader = compiled ? [] : ['--import', import.meta.resolve('tsx')];
    const code = `import { readProjectHooks } from ${JSON.stringify(source)}; try { readProjectHooks(${JSON.stringify(f.cwd)}); process.exit(2); } catch (e) { if (!/regular file/.test(String(e))) throw e; }`;
    const child = spawnSync(process.execPath, [...loader, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined, 'the reader must never wait on a repository FIFO');
    assert.equal(child.status, 0, child.stderr);
  } finally { f.cleanup(); }
});


test('an authorized child tool receives the parent sandbox narrowed to its isolated worktree', async () => {
  const f = fixture({ version: 1, hooks: {} });
  const priorHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = path.join(f.cwd, 'session-home');
  fs.writeFileSync(path.join(f.cwd, 'source.txt'), 'fixture');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: f.cwd });
  execFileSync('git', ['add', '.'], { cwd: f.cwd });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'], { cwd: f.cwd });
  let rootCalls = 0;
  let childCalls = 0;
  const captured: ToolContext[] = [];
  const sandbox = { image: 'test-only-image', worktreeHostPath: f.cwd, network: 'none' as const, forwardEnv: ['PATH'] };
  const provider = scriptedProvider('child-sandbox', (req) => {
    if (req.system.includes('SUBAGENT')) return childCalls++ === 0 ? call('child-read', 'read_file', {}) : say('child done');
    if (rootCalls++ === 0) return call('delegate-1', 'delegate_tasks', { tasks: [{ title: 'Read', prompt: 'read in an isolated worktree', role: 'builder', writes: true }] });
    if (rootCalls === 2) return call('await-1', 'await_subagents', {});
    return say('done');
  });
  const session = AgentSession.create({ cwd: f.cwd, provider, mode: 'full', containerSandbox: sandbox,
    tools: [{ kind: 'read', spec: { name: 'read_file', description: '', inputSchema: {} }, summarize: () => '', execute: async (_input, ctx) => { captured.push(ctx); return { output: 'read' }; } }],
    callbacks: { onEvent: () => {}, requestApproval: async () => 'allow' } });
  try {
    await session.prompt('delegate the read');
    assert.equal(captured.length, 1);
    assert.notEqual(captured[0].cwd, f.cwd);
    assert.equal(captured[0].containerSandbox?.worktreeHostPath, captured[0].cwd);
    assert.equal(captured[0].containerSandbox?.image, sandbox.image);
    assert.equal(captured[0].containerSandbox?.network, 'none');
    assert.deepEqual(captured[0].containerSandbox?.forwardEnv, ['PATH']);
    assert.equal(sandbox.worktreeHostPath, f.cwd, 'the parent mount remains unchanged');
  } finally { session.dispose(); if (priorHome === undefined) delete process.env.JUNO_HOME; else process.env.JUNO_HOME = priorHome; f.cleanup(); }
});
