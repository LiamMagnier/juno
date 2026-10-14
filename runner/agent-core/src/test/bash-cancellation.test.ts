import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bashTool } from '../tools/bash.js';
import { BackgroundJobs, jobAwareShellTools } from '../harness/jobs.js';
import { AgentSession } from '../agent.js';
import type { ToolDefinition } from '../tools/types.js';
import type { AgentEvent } from '../types.js';
import { call, say, scriptedProvider } from './fake-provider.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'the command did not reach the expected state');
    await delay(10);
  }
}

const implementations: Array<{ name: string; create: () => { tool: ToolDefinition; dispose: () => void } }> = [
  { name: 'plain bash', create: () => ({ tool: bashTool, dispose() {} }) },
  {
    name: 'foreground jobs',
    create: () => {
      const jobs = new BackgroundJobs();
      return { tool: jobAwareShellTools(jobs)[0], dispose: () => jobs.killAll() };
    },
  },
];

for (const implementation of implementations) {
  test(`${implementation.name}: an already cancelled turn never starts a command`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
    const { tool, dispose } = implementation.create();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await tool.execute({ command: 'touch should-not-start' }, { cwd, signal: controller.signal });
      assert.equal(result.isError, true);
      assert.match(result.output, /cancelled/i);
      assert.equal(result.exitCode, undefined);
      assert.equal(existsSync(join(cwd, 'should-not-start')), false);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${implementation.name}: Stop kills the shell and its descendants before delayed writes`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
    const { tool, dispose } = implementation.create();
    const controller = new AbortController();
    try {
      const running = tool.execute(
        { command: '(sleep 0.6; touch delayed-write) & touch ready; wait', timeout_ms: 2_000 },
        { cwd, signal: controller.signal },
      );
      await waitFor(() => existsSync(join(cwd, 'ready')));
      const stoppedAt = Date.now();
      controller.abort();
      const result = await running;
      assert.equal(result.isError, true);
      assert.match(result.output, /cancelled/i);
      assert.equal(result.exitCode, undefined, 'cancellation has no fabricated process exit code');
      assert.ok(Date.now() - stoppedAt < 1_000, 'Stop should not wait for the shell timeout');
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      await delay(800);
      assert.equal(existsSync(join(cwd, 'delayed-write')), false, 'a descendant wrote after Stop');
    } finally {
      controller.abort();
      dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test(`${implementation.name}: success, failure and spawn errors release the turn signal`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
    const { tool, dispose } = implementation.create();
    try {
      const success = new AbortController();
      const ok = await tool.execute({ command: 'printf done' }, { cwd, signal: success.signal });
      assert.equal(ok.output, 'done');
      assert.equal(ok.exitCode, 0);
      assert.equal(getEventListeners(success.signal, 'abort').length, 0);
      success.abort();

      const failure = new AbortController();
      const failed = await tool.execute({ command: 'exit 7' }, { cwd, signal: failure.signal });
      assert.equal(failed.isError, true);
      assert.equal(failed.exitCode, 7);
      assert.equal(getEventListeners(failure.signal, 'abort').length, 0);

      const spawnError = new AbortController();
      const missing = await tool.execute({ command: 'touch never-written' }, { cwd: join(cwd, 'missing'), signal: spawnError.signal });
      assert.equal(missing.isError, true);
      assert.match(missing.output, /Failed to spawn/);
      assert.equal(getEventListeners(spawnError.signal, 'abort').length, 0);
    } finally {
      dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test('plain bash: its timeout still terminates the command and releases cancellation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
  try {
    const controller = new AbortController();
    const result = await bashTool.execute({ command: 'sleep 30', timeout_ms: 50 }, { cwd, signal: controller.signal });
    assert.equal(result.isError, true);
    assert.match(result.output, /timed out after 50ms/);
    assert.equal(result.exitCode, undefined);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    controller.abort();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('background jobs: an already cancelled turn cannot explicitly start a job', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
  const jobs = new BackgroundJobs();
  try {
    const controller = new AbortController();
    controller.abort();
    const [tool] = jobAwareShellTools(jobs);
    const result = await tool.execute({ command: 'touch should-not-start', run_in_background: true }, { cwd, signal: controller.signal });
    assert.equal(result.isError, true);
    assert.match(result.output, /cancelled/i);
    assert.equal(result.background, undefined);
    assert.equal(jobs.list().length, 0);
    assert.equal(existsSync(join(cwd, 'should-not-start')), false);
  } finally {
    jobs.killAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('background jobs: Stop cancels only jobs from that turn, including explicit background work', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
  const jobs = new BackgroundJobs();
  const stopped = new AbortController();
  try {
    const [tool] = jobAwareShellTools(jobs);
    const cancelled = await tool.execute(
      { command: '(sleep 0.6; touch cancelled-write) & touch ready; wait', run_in_background: true },
      { cwd, signal: stopped.signal },
    );
    const independent = new AbortController();
    const retained = await tool.execute(
      { command: 'sleep 0.1; touch retained-write', run_in_background: true },
      { cwd, signal: independent.signal },
    );
    assert.ok(cancelled.background);
    assert.ok(retained.background);
    await waitFor(() => existsSync(join(cwd, 'ready')));
    stopped.abort();
    await waitFor(() => jobs.running === 0);
    await delay(800);
    assert.equal(existsSync(join(cwd, 'cancelled-write')), false);
    assert.equal(existsSync(join(cwd, 'retained-write')), true);
    assert.equal(jobs.list().find((job) => job.id === cancelled.background?.jobId)?.status, 'killed');
    assert.equal(jobs.list().find((job) => job.id === retained.background?.jobId)?.exitCode, 0);
    assert.equal(getEventListeners(stopped.signal, 'abort').length, 0);
    assert.equal(getEventListeners(independent.signal, 'abort').length, 0);
  } finally {
    stopped.abort();
    jobs.killAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('background jobs: a foreground timeout still backgrounds work, and Stop can then cancel it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
  const jobs = new BackgroundJobs();
  const controller = new AbortController();
  try {
    const [tool] = jobAwareShellTools(jobs);
    const result = await tool.execute(
      { command: '(sleep 0.6; touch delayed-write) & wait', timeout_ms: 20 },
      { cwd, signal: controller.signal },
    );
    assert.ok(result.background);
    assert.equal(result.isError, undefined);
    assert.equal(jobs.running, 1);
    controller.abort();
    await waitFor(() => jobs.running === 0);
    await delay(800);
    assert.equal(existsSync(join(cwd, 'delayed-write')), false);
    assert.equal(jobs.list()[0].status, 'killed');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally {
    controller.abort();
    jobs.killAll();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('AgentSession: Stop interrupts its default shell tool without leaving a delayed effect', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-cancel-'));
  const sessionHome = mkdtempSync(join(tmpdir(), 'juno-cancel-home-'));
  const previousHome = process.env.JUNO_HOME;
  process.env.JUNO_HOME = sessionHome;
  let session: AgentSession | undefined;
  try {
    const events: AgentEvent[] = [];
    const provider = scriptedProvider('mock', (_request, index) => index === 0
      ? call('shell', 'bash', { command: '(sleep 0.6; touch delayed-write) & touch ready; wait', timeout_ms: 2_000 })
      : say('done'));
    session = AgentSession.create({
      provider,
      cwd,
      mode: 'full',
      subagents: false,
      callbacks: { onEvent: (event) => events.push(event), requestApproval: async () => 'allow' },
    });
    const running = session.prompt('Run the command until I stop it.');
    await waitFor(() => existsSync(join(cwd, 'ready')));
    session.abort();
    await running;
    const tool = events.find((event) => event.type === 'tool_finished');
    assert.ok(tool && tool.type === 'tool_finished');
    assert.equal(tool.isError, true);
    assert.match(tool.output, /cancelled/i);
    const finished = events.find((event) => event.type === 'turn_finished');
    assert.ok(finished && finished.type === 'turn_finished');
    assert.equal(finished.stopReason, 'aborted');
    assert.equal(provider.requests.length, 1, 'Stop should not start a follow-up model request');
    await delay(800);
    assert.equal(existsSync(join(cwd, 'delayed-write')), false);
  } finally {
    session?.dispose();
    if (previousHome === undefined) delete process.env.JUNO_HOME;
    else process.env.JUNO_HOME = previousHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionHome, { recursive: true, force: true });
  }
});
