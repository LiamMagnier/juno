/**
 * Background shell jobs (SPEC §3.10: "bash timeout → background job").
 *
 * The plain bash tool kills a command at its timeout, which loses a dev server,
 * a long test suite or a slow install that was about to finish. Here a command
 * that outlives its timeout is not killed: it becomes a job that keeps
 * running, the model gets what it printed so far and the job id, and reads the
 * rest with `bash_output` or stops it with `kill_job`. A model can also start a
 * job deliberately with `run_in_background`. Jobs end with the session, and
 * none outlives `MAX_JOB_RUNTIME_MS`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildContainerArgs } from '../tools/container-sandbox.js';
import { MINIMAL_ENV } from '../tools/bash.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../tools/types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Kept in memory per job; older output is dropped from the front. */
const MAX_JOB_BUFFER_CHARS = 2_000_000;
/** What one foreground answer or one bash_output read returns at most. */
const MAX_READ_CHARS = 30_000;
export const MAX_JOB_RUNTIME_MS = 30 * 60_000;

export type JobStatus = 'running' | 'exited' | 'killed';

export interface JobSnapshot {
  id: string;
  command: string;
  status: JobStatus;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  outputChars: number;
}

interface Job {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  /** Characters dropped from the front of `output` when it was capped. */
  dropped: number;
  /** Absolute offset already returned to the model. */
  readOffset: number;
  status: JobStatus;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  exited: Promise<void>;
  hardLimit: ReturnType<typeof setTimeout>;
}

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export class BackgroundJobs {
  private readonly jobs = new Map<string, Job>();

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job));
  }

  get running(): number {
    return [...this.jobs.values()].filter((job) => job.status === 'running').length;
  }

  private snapshot(job: Job): JobSnapshot {
    return {
      id: job.id,
      command: job.command,
      status: job.status,
      ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
      startedAt: new Date(job.startedAt).toISOString(),
      ...(job.endedAt ? { endedAt: new Date(job.endedAt).toISOString() } : {}),
      outputChars: job.dropped + job.output.length,
    };
  }

  /** Start a command; the job is registered immediately. */
  start(command: string, ctx: ToolContext): Job {
    const invocation = ctx.containerSandbox
      ? { file: 'docker', args: buildContainerArgs(command, ctx.containerSandbox) }
      : { file: '/bin/bash', args: ['-c', command] };
    const child = spawn(invocation.file, invocation.args, {
      cwd: ctx.cwd,
      env: ctx.env ?? MINIMAL_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const id = `job-${randomUUID().slice(0, 6)}`;
    let resolveExit: () => void = () => {};
    const job: Job = {
      id,
      command,
      child,
      output: '',
      dropped: 0,
      readOffset: 0,
      status: 'running',
      startedAt: Date.now(),
      exited: new Promise<void>((resolve) => {
        resolveExit = resolve;
      }),
      hardLimit: setTimeout(() => this.kill(id), MAX_JOB_RUNTIME_MS),
    };
    job.hardLimit.unref?.();
    const append = (chunk: Buffer) => {
      job.output += chunk.toString('utf8');
      if (job.output.length > MAX_JOB_BUFFER_CHARS) {
        const cut = job.output.length - MAX_JOB_BUFFER_CHARS;
        job.output = job.output.slice(cut);
        job.dropped += cut;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      job.output += `\nFailed to spawn: ${err.message}`;
      if (job.status === 'running') job.status = 'exited';
      job.endedAt = Date.now();
      clearTimeout(job.hardLimit);
      resolveExit();
    });
    child.on('close', (code) => {
      if (job.status === 'running') job.status = 'exited';
      if (typeof code === 'number') job.exitCode = code;
      job.endedAt = Date.now();
      clearTimeout(job.hardLimit);
      resolveExit();
    });
    this.jobs.set(id, job);
    return job;
  }

  /** Output since the last read (capped), and the job's state. */
  read(id: string): { text: string; snapshot: JobSnapshot } | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    const startAbs = Math.max(job.readOffset, job.dropped);
    const skipped = startAbs - job.readOffset;
    let text = job.output.slice(startAbs - job.dropped);
    let truncated = 0;
    if (text.length > MAX_READ_CHARS) {
      truncated = text.length - MAX_READ_CHARS;
      text = text.slice(-MAX_READ_CHARS);
    }
    job.readOffset = job.dropped + job.output.length;
    const notes: string[] = [];
    if (skipped > 0 || truncated > 0) notes.push(`[${(skipped + truncated).toLocaleString('en-US')} earlier characters not shown]`);
    return { text: [...notes, text].filter(Boolean).join('\n'), snapshot: this.snapshot(job) };
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return false;
    job.status = 'killed';
    killGroup(job.child);
    return true;
  }

  /** Session end: nothing a session started keeps running after it. */
  killAll(): void {
    for (const job of this.jobs.values()) this.kill(job.id);
  }

  /**
   * Runs `command` for up to `timeoutMs`. Finished in time: the plain bash
   * result. Still running: the output so far, and the job keeps going.
   */
  async runForeground(command: string, ctx: ToolContext, timeoutMs: number): Promise<ToolResult> {
    const job = this.start(command, ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      job.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut && job.status === 'running') {
      const read = this.read(job.id)!;
      return {
        output: `${read.text || '(no output yet)'}\n[still running after ${Math.round(timeoutMs / 1000)}s — moved to background job ${job.id}. Read more with bash_output {"id":"${job.id}"}; stop it with kill_job.]`,
        background: { jobId: job.id },
      };
    }
    // Finished: report like the plain tool and forget the job.
    this.jobs.delete(job.id);
    let output = job.dropped > 0 ? `[${job.dropped} earlier characters not kept]\n${job.output}` : job.output;
    if (output.length > MAX_READ_CHARS * 14) output = output.slice(-MAX_READ_CHARS * 14);
    const exitCode = job.exitCode;
    if (job.status === 'killed') return { output: `${output}\n[killed]`, isError: true };
    if (exitCode !== 0) {
      return { output: `${output}\n[exit code ${exitCode ?? 'unknown'}]`, isError: true, ...(exitCode === undefined ? {} : { exitCode }) };
    }
    return { output: output || '(no output)', exitCode };
  }
}

/** bash, with timeouts that background instead of kill, plus its two companions. */
export function jobAwareShellTools(jobs: BackgroundJobs): ToolDefinition[] {
  const bash: ToolDefinition = {
    kind: 'command',
    spec: {
      name: 'bash',
      description:
        'Run a shell command with bash -c in the project working directory. Returns combined stdout/stderr and the exit code. A command still running at its timeout is NOT killed: it continues as a background job whose output you read with bash_output. Set run_in_background for servers and watchers.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'number', description: `Wait this long before backgrounding (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
          run_in_background: { type: 'boolean', description: 'Start as a background job and return immediately.' },
        },
        required: ['command'],
      },
    },
    summarize: (i) => `$ ${String(i.command).slice(0, 200)}${i.run_in_background ? ' (background)' : ''}`,
    async execute(input, ctx) {
      const command = String(input.command);
      if (input.run_in_background === true) {
        const job = jobs.start(command, ctx);
        return {
          output: `Started background job ${job.id}. Read its output with bash_output {"id":"${job.id}"}; stop it with kill_job.`,
          background: { jobId: job.id },
        };
      }
      const raw = Number(input.timeout_ms ?? DEFAULT_TIMEOUT_MS);
      const timeout = Math.min(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      return jobs.runForeground(command, ctx, timeout);
    },
  };
  const bashOutput: ToolDefinition = {
    kind: 'read',
    spec: {
      name: 'bash_output',
      description: 'Read new output from a background job started by bash, and whether it is still running. Empty id lists every job.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
    summarize: (i) => (i.id ? `Read job ${i.id}` : 'List background jobs'),
    async execute(input) {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) {
        const list = jobs.list();
        if (list.length === 0) return { output: 'No background jobs.' };
        return {
          output: list
            .map((j) => `${j.id} · ${j.status}${j.exitCode === undefined ? '' : ` (exit ${j.exitCode})`} · $ ${j.command.slice(0, 120)}`)
            .join('\n'),
        };
      }
      const read = jobs.read(id);
      if (!read) return { output: `No background job ${id}.`, isError: true };
      const state =
        read.snapshot.status === 'running'
          ? '[still running]'
          : `[${read.snapshot.status}${read.snapshot.exitCode === undefined ? '' : `, exit code ${read.snapshot.exitCode}`}]`;
      return { output: `${read.text || '(no new output)'}\n${state}` };
    },
  };
  const killJob: ToolDefinition = {
    kind: 'command',
    spec: {
      name: 'kill_job',
      description: 'Stop a background job started by bash (its whole process group).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    summarize: (i) => `Stop job ${i.id}`,
    async execute(input) {
      const id = String(input.id ?? '');
      return jobs.kill(id) ? { output: `Stopped ${id}.` } : { output: `No running job ${id}.`, isError: true };
    },
  };
  return [bash, bashOutput, killJob];
}
