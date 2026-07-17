import { spawn } from 'node:child_process';
import type { ToolDefinition, ToolResult } from './types.js';

const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

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
      const child = spawn('/bin/bash', ['-c', command], {
        cwd: ctx.cwd,
        // Prefer the caller-provided (scrubbed) env; fall back to the driver's
        // own env only when none was supplied.
        env: ctx.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
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
