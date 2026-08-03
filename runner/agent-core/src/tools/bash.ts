import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolResult } from './types.js';
import { buildContainerArgs } from './container-sandbox.js';

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * The environment an agent-authored command gets when the caller supplied none.
 *
 * Emphatically NOT `process.env`. The driver builds a scrubbed environment and
 * passes it in, but the fallback has to be safe on its own: a future caller
 * that forgets to pass one — a new entry point, a test harness, a subagent path
 * — would otherwise hand the whole process environment to arbitrary agent
 * shell, including whatever CI put there. Failing closed costs a broken PATH at
 * worst; failing open costs a credential.
 */
const MINIMAL_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  LANG: 'C.UTF-8',
};

export const bashTool: ToolDefinition = {
  kind: 'command',
  spec: {
    name: 'bash',
    description:
      'Run a shell command with bash -c in the project working directory. Returns combined stdout/stderr and the exit code. Use for builds, tests, git, and inspection commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number', description: `Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
      },
      required: ['command'],
    },
  },
  summarize: (i) => `$ ${String(i.command).slice(0, 200)}`,
  execute(input, ctx): Promise<ToolResult> {
    const command = String(input.command);
    const timeout = Math.min(Number(input.timeout_ms ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
    return new Promise((resolveResult) => {
      // In the cloud runner the command goes to a container holding only the
      // worktree; locally it runs here. Either way the environment passed is
      // the scrubbed one — `docker run` receives no `--env`, so the container
      // starts from the image's environment and nothing of the host's.
      const invocation = ctx.containerSandbox
        ? { file: 'docker', args: buildContainerArgs(command, ctx.containerSandbox) }
        : { file: '/bin/bash', args: ['-c', command] };

      const child = spawn(invocation.file, invocation.args, {
        cwd: ctx.cwd,
        env: ctx.env ?? MINIMAL_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so the timeout below can kill everything the
        // command started rather than just the shell that started it.
        detached: true,
      });
      let out = '';
      let killed = false;

      /**
       * Kills the whole process group.
       *
       * `child.kill()` signals bash alone. Anything it spawned — a background
       * `&`, a dev server, a fork bomb, a `python -c` that outlives its parent
       * — kept running after the timeout "handled" it, holding the runner's CPU
       * and file handles for the rest of the job. The negative pid is what
       * addresses the group.
       */
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Already gone, or the group vanished between the check and the
          // signal. Fall back to the direct kill so a live child still dies.
          try {
            child.kill('SIGKILL');
          } catch {
            /* nothing left to kill */
          }
        }
      };

      const timer = setTimeout(() => {
        killed = true;
        killGroup();
      }, timeout);
      const append = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT_CHARS) out += chunk.toString('utf8');
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (err) => {
        clearTimeout(timer);
        resolveResult({ output: `Failed to spawn: ${err.message}`, isError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let output = out;
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS) + `\n…[output truncated at ${MAX_OUTPUT_CHARS} chars]`;
        }
        if (killed) {
          resolveResult({ output: `${output}\n[command timed out after ${timeout}ms]`, isError: true });
        } else if (code !== 0) {
          resolveResult({ output: `${output}\n[exit code ${code}]`, isError: true });
        } else {
          resolveResult({ output: output || '(no output)' });
        }
      });
    });
  },
};
