/**
 * Supervision of the agent host `utilityProcess`.
 *
 * The host embeds `@juno/agent-core` and is therefore the most privileged
 * process in the app: it reads and writes the workspace, spawns shells, and
 * drives providers. Everything crossing this boundary is validated in both
 * directions, and the boundary itself is a `MessagePort` rather than a
 * localhost socket — nothing else on the machine can reach it.
 *
 * Three properties this module is responsible for:
 *
 *   1. **Lazy start.** A user who never opens Code never pays for a second
 *      process. The host is forked on first use.
 *   2. **Bounded restart.** A host that crashes is restarted, but a host that
 *      crashes repeatedly is left down with a visible status instead of being
 *      restarted forever — a crash loop that hides itself is worse than an
 *      outage that admits it.
 *   3. **No orphans.** Shutdown is awaited, and the process is killed if it
 *      does not exit within a grace period.
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  HostMessageSchema,
  type HostCommand,
  type HostMessage,
} from '../agent-host/host-protocol.js';
import { createLogger } from './logger.js';

const log = createLogger('agent');

export type AgentHostStatus = 'stopped' | 'starting' | 'running' | 'crashed';

/** Beyond this many crashes without a clean run, stay down and say so. */
const MAX_RESTARTS = 3;
/** How long a `shutdown` gets to complete before the process is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
/** How long a command waits for its reply before being rejected. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface AgentHostEvents {
  /** Every `event` frame, already validated. */
  onAgentEvent: (sessionId: string, event: unknown) => void;
  onStatusChange: (status: AgentHostStatus, detail: string | null) => void;
}

/**
 * `Omit` over a union collapses it to a single member, which here silently
 * reduced every command to `configure`. Distributing over the union first keeps
 * each variant — and keeps the discriminant meaningful at the call site.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command as callers write it: the envelope fields are added by `send`. */
export type HostCommandDraft = DistributiveOmit<HostCommand, 'seq' | 'requestId'>;

interface Pending {
  resolve: (message: HostMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * `out/main/agent-host.js`, resolved relative to this module.
 *
 * Derived from `import.meta.url`, not `__dirname`: the main bundle is ESM, where
 * `__dirname` does not exist. That would have thrown at the moment the first
 * Code session started — the one path least likely to be exercised before a
 * release.
 */
function defaultEntryPath(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), 'agent-host.js');
}

export class AgentHostSupervisor {
  #process: UtilityProcess | null = null;
  #status: AgentHostStatus = 'stopped';
  #restarts = 0;
  #seq = 0;
  #requestCounter = 0;
  #starting: Promise<void> | null = null;
  #shuttingDown = false;

  readonly #pending = new Map<string, Pending>();
  readonly #events: AgentHostEvents;
  readonly #entryPath: string;

  constructor(events: AgentHostEvents, entryPath = defaultEntryPath()) {
    this.#events = events;
    this.#entryPath = entryPath;
  }

  get status(): AgentHostStatus {
    return this.#status;
  }

  get restarts(): number {
    return this.#restarts;
  }

  #setStatus(status: AgentHostStatus, detail: string | null = null): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#events.onStatusChange(status, detail);
  }

  /**
   * Start the host if it is not already up.
   *
   * Concurrent callers share one start — two Code sessions opened in the same
   * tick must not fork two hosts, which would give each its own session store
   * over the same directory.
   */
  async ensureStarted(): Promise<void> {
    if (this.#process && this.#status === 'running') return;
    if (this.#starting) return this.#starting;

    if (this.#restarts >= MAX_RESTARTS) {
      throw new Error(
        'The agent host has stopped repeatedly and has been left down. Restart Juno to try again.',
      );
    }

    this.#starting = this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    this.#setStatus('starting');
    log.info('starting agent host', { entry: this.#entryPath });

    const child = utilityProcess.fork(this.#entryPath, [], {
      serviceName: 'juno-agent-host',
      /* A scrubbed environment. The host derives provider credentials through
         its own configured path; inheriting this process's environment would
         hand it every secret Juno holds. */
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        SHELL: process.env['SHELL'] ?? '',
        LANG: process.env['LANG'] ?? 'en_US.UTF-8',
        TMPDIR: process.env['TMPDIR'] ?? '',
      },
      stdio: 'pipe',
    });

    this.#process = child;

    child.on('message', (raw: unknown) => {
      this.#receive(raw);
    });

    child.on('exit', (code) => {
      this.#onExit(code);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      /* Bounded and logged, never forwarded to the renderer: a provider CLI can
         print a credential to stderr. */
      log.warn('agent host stderr', { text: chunk.toString('utf8').slice(0, 2_000) });
    });

    /* The host announces itself with `ready`; treating spawn as success would
       report "running" for a process that failed during module load. */
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('The agent host did not start in time.'));
      }, 15_000);

      const onReady = (raw: unknown): void => {
        const parsed = HostMessageSchema.safeParse(raw);
        if (!parsed.success || parsed.data.type !== 'ready') return;
        clearTimeout(timer);
        child.off('message', onReady);
        this.#setStatus('running');
        log.info('agent host ready');
        resolve();
      };
      child.on('message', onReady);
    });
  }

  #onExit(code: number | undefined): void {
    this.#process = null;
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The agent host stopped.'));
    }
    this.#pending.clear();

    if (this.#shuttingDown) {
      this.#setStatus('stopped');
      return;
    }

    this.#restarts += 1;
    const detail = `The agent host exited (code ${String(code ?? 'unknown')}).`;
    log.error('agent host exited unexpectedly', { code, restarts: this.#restarts });
    this.#setStatus('crashed', detail);
  }

  #receive(raw: unknown): void {
    const parsed = HostMessageSchema.safeParse(raw);
    if (!parsed.success) {
      log.error('discarded malformed agent-host message', {
        reason: z.prettifyError(parsed.error),
      });
      return;
    }
    const message = parsed.data;

    if (message.type === 'event') {
      this.#events.onAgentEvent(message.sessionId, message.event);
      return;
    }
    if (message.type === 'log') return;
    if (message.type === 'heartbeat') return;

    const requestId = 'requestId' in message ? message.requestId : undefined;
    if (requestId === undefined) return;

    const pending = this.#pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);

    if (message.type === 'command_error' || message.type === 'protocol_error') {
      pending.reject(new Error(message.message));
      return;
    }
    pending.resolve(message);
  }

  /**
   * Send a command and await its reply.
   *
   * `seq` and `requestId` are assigned here rather than by callers, so the
   * ordering guarantee and the reply correlation cannot be got wrong at a call
   * site.
   */
  async send<T extends HostMessage['type']>(
    command: HostCommandDraft,
    expect: T,
  ): Promise<Extract<HostMessage, { type: T }>> {
    await this.ensureStarted();
    const child = this.#process;
    if (!child) throw new Error('The agent host is not running.');

    this.#seq += 1;
    this.#requestCounter += 1;
    const requestId = `req_${String(this.#requestCounter)}`;
    const framed = { ...command, seq: this.#seq, requestId } as HostCommand;

    const reply = await new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error('The agent host did not respond in time.'));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(requestId, { resolve, reject, timer });
      child.postMessage(framed);
    });

    if (reply.type !== expect) {
      throw new Error(`The agent host replied with ${reply.type}, expected ${expect}.`);
    }
    return reply as Extract<HostMessage, { type: T }>;
  }

  /**
   * Ask the host to shut down, then make sure it actually did.
   *
   * The grace period exists so transcripts flush; the kill exists because a
   * wedged host must not keep the app alive or leave its own children running.
   */
  async shutdown(): Promise<void> {
    const child = this.#process;
    if (!child) {
      this.#setStatus('stopped');
      return;
    }
    this.#shuttingDown = true;

    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => {
        resolve();
      });
    });

    try {
      this.#seq += 1;
      child.postMessage({ type: 'shutdown', seq: this.#seq, requestId: 'req_shutdown' });
    } catch {
      /* Already gone. */
    }

    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS)),
    ]);

    if (timedOut) {
      log.warn('agent host did not exit within the grace period; killing');
      child.kill();
      await exited;
    }

    this.#process = null;
    this.#shuttingDown = false;
    this.#setStatus('stopped');
  }
}
