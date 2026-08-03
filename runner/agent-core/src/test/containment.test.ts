import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from '../tools/bash.js';

/*
 * Containment for agent-authored shell.
 *
 * Application-level command classification is useful but it is not a boundary:
 * anything it recognises can be spelled another way. These pin the two things
 * that hold regardless of how a command is written — what the process can see
 * in its environment, and whether it can outlive the timeout that kills it.
 */

function run(command: string, opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout_ms?: number }) {
  return bashTool.execute(
    { command, ...(opts.timeout_ms ? { timeout_ms: opts.timeout_ms } : {}) },
    { cwd: opts.cwd, env: opts.env },
  ) as Promise<{ output: string; isError?: boolean }>;
}

test('a command with no supplied env does not inherit the process environment', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    // The shape of the leak: a credential in the driver's environment reachable
    // by any command the agent writes.
    process.env.JUNO_TEST_FAKE_TOKEN = 'super-secret-value';

    const result = await run('env', { cwd });

    assert.ok(
      !result.output.includes('super-secret-value'),
      'the fallback env must not be process.env',
    );
    assert.ok(!result.output.includes('JUNO_TEST_FAKE_TOKEN'));
  } finally {
    delete process.env.JUNO_TEST_FAKE_TOKEN;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the fallback env is still usable — PATH resolves core tools', async () => {
  // Failing closed must not mean failing broken: a scrubbed env that cannot run
  // `git` would push callers back to passing process.env.
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    const result = await run('echo ok && ls >/dev/null && echo done', { cwd });
    assert.ok(result.output.includes('ok'));
    assert.ok(result.output.includes('done'));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an explicitly supplied env is the only thing the command sees', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    process.env.JUNO_TEST_FAKE_TOKEN = 'super-secret-value';
    const result = await run('env', {
      cwd,
      env: { PATH: '/usr/bin:/bin', ONLY_THIS: 'yes' },
    });
    assert.ok(result.output.includes('ONLY_THIS=yes'));
    assert.ok(!result.output.includes('super-secret-value'));
  } finally {
    delete process.env.JUNO_TEST_FAKE_TOKEN;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a subprocess cannot read a credential through its parent shell either', async () => {
  // Shell indirection: reading the environment from a child rather than from
  // bash itself, which is what a classifier looking at the command string would
  // have to catch, and cannot.
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    process.env.JUNO_TEST_FAKE_TOKEN = 'super-secret-value';
    const result = await run(
      `sh -c 'env' ; cat /proc/self/environ 2>/dev/null || true`,
      { cwd },
    );
    assert.ok(!result.output.includes('super-secret-value'));
  } finally {
    delete process.env.JUNO_TEST_FAKE_TOKEN;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a timeout kills the whole process group, not just the shell', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  const marker = join(cwd, 'orphan-survived');
  try {
    // A background child that outlives its shell by two seconds. Before the
    // group kill, SIGKILL to bash left this running and it created the marker.
    const result = await run(
      `( sleep 2 && touch ${JSON.stringify(marker)} ) & sleep 30`,
      { cwd, timeout_ms: 300 },
    );

    assert.equal(result.isError, true);
    assert.match(result.output, /timed out/);

    // Wait past the moment the orphan would have fired.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.ok(
      !existsSync(marker),
      'a background child survived the timeout that was supposed to kill the command',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a runaway spawner is bounded by the timeout rather than running forever', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    const started = Date.now();
    // Deliberately not a real fork bomb — the point is that a command which
    // keeps spawning is terminated on schedule and reported, not that the host
    // survives an unbounded one, which is the container's job.
    const result = await run(
      'while true; do sh -c "true"; done',
      { cwd, timeout_ms: 500 },
    );
    const elapsed = Date.now() - started;

    assert.equal(result.isError, true);
    assert.match(result.output, /timed out/);
    assert.ok(elapsed < 15_000, `took ${elapsed}ms — the timeout did not bound it`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('output is bounded, so a command cannot exhaust memory through stdout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'juno-contain-'));
  try {
    const result = await run('yes abcdefghij | head -c 5000000', { cwd, timeout_ms: 20_000 });
    assert.ok(result.output.length < 200_000, `output was ${result.output.length} chars`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
