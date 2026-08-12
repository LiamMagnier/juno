/**
 * ACP transport — JSON-RPC 2.0 over a child process's stdio.
 *
 * ACP's stdio transport is newline-delimited UTF-8 JSON: one complete message
 * per line, no embedded newlines. That sounds trivial and is the single most
 * commonly botched part of a stdio protocol, so the framing here is explicit
 * about the three cases that actually happen in production:
 *
 *   1. a chunk holds part of a line (write it to the carry buffer, wait);
 *   2. a chunk holds several complete lines (dispatch them all, in order);
 *   3. a line is bigger than any one chunk (accumulate — but only up to a cap).
 *
 * Case 3 is where the security boundary lives. A buggy or hostile agent that
 * emits an unterminated stream would otherwise grow the carry buffer until the
 * Electron main process dies, taking the user's unsaved work with it. Once the
 * carry exceeds `maxLineBytes` the connection is torn down: a dead session with
 * a clear error beats an out-of-memory kill of the whole app.
 *
 * Multi-byte safety: chunks are decoded through `StringDecoder`, so a UTF-8
 * sequence split across a chunk boundary is held back rather than turned into a
 * replacement character. Splitting a Buffer on `0x0A` first and decoding after
 * would also work; decoding incrementally keeps the byte accounting in one
 * place.
 *
 * Process hygiene, in one list because every item has bitten someone:
 *   - `spawn` with an ARGUMENT ARRAY and `shell: false`. No prompt, path, model
 *     output or MCP config is ever interpolated into a command string.
 *   - The environment is an ALLOWLIST, not `process.env` minus a few names.
 *     Agents in the `cli-managed` auth model read their own credential stores;
 *     forwarding the user's shell secrets to them buys nothing.
 *   - Shutdown is stdin EOF, then SIGTERM, then SIGKILL. Every live child is
 *     registered so a crash of the parent cannot leave an orphan holding the
 *     workspace.
 *   - stderr is captured to a bounded ring buffer and redacted before it can
 *     reach a log. Agents print credentials to stderr more often than anyone
 *     would like.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import {
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  AGENT_METHODS,
  CLIENT_METHODS,
  EmptyResponseSchema,
  InitializeResponseSchema,
  ListSessionsResponseSchema,
  LoadSessionResponseSchema,
  NewSessionResponseSchema,
  PromptResponseSchema,
  ReadTextFileRequestSchema,
  RequestPermissionRequestSchema,
  SessionNotificationSchema,
  WriteTextFileRequestSchema,
  classifyInbound,
  type InitializeResponse,
  type JsonRpcError,
  type JsonRpcId,
  type ListSessionsResponse,
  type NewSessionParams,
  type NewSessionResponse,
  type PromptParams,
  type PromptResponse,
  type ReadTextFileRequest,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionNotification,
  type WriteTextFileRequest,
} from './schema.js';
import type { LaunchCommand } from '../types.js';
import type { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Patterns that must never reach a log file or a crash report.
 *
 * Ordered longest-match-first where two could overlap (a bearer header before
 * the bare token shapes) so the more specific replacement wins. This is a net,
 * not a proof: it is paired with never logging stdout payloads at all.
 */
const REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/\b(authorization|proxy-authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [redacted]'],
  [/\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]'],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{8,}/g, 'xox*-[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted-aws-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[redacted-google-key]'],
  [
    /\b([A-Za-z0-9_]*(?:key|token|secret|password|passwd|credential)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
    '$1=[redacted]',
  ],
];

/**
 * Scrub a string for logging. Also collapses the user's home directory, which
 * is personal data in its own right (it usually contains their real name) and
 * shows up in every agent's stack traces.
 */
export function redactForLog(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  const home = homedir();
  if (home.length > 1) out = out.split(home).join('~');
  return out;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Names an agent legitimately needs. Everything else is dropped.
 *
 * `PATH` and `HOME` are the load-bearing two: `HOME` is how a `cli-managed`
 * agent finds the credentials it already has, and `PATH` is how it finds `git`.
 */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'TMPDIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

const ENV_ALLOWED_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

/** Belt and braces: an allowlisted name that still looks like a secret is dropped. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION)/i;

export interface ScrubEnvOptions {
  /** Names the provider descriptor explicitly permits despite looking secret. */
  readonly passthrough?: readonly string[];
  /** Values Juno sets itself (e.g. an agent's autoupdate-off flag). Always kept. */
  readonly extra?: Readonly<Record<string, string>>;
}

/**
 * Build the child's environment from an allowlist.
 *
 * Deliberately allowlist-shaped. A denylist ("drop anything with KEY in it")
 * fails open on the variable nobody thought of, and the failure mode is handing
 * an unrelated vendor's credentials to a third-party binary.
 */
export function scrubEnvironment(
  base: NodeJS.ProcessEnv,
  options: ScrubEnvOptions = {},
): Record<string, string> {
  const passthrough = new Set(options.passthrough ?? []);
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const allowed =
      ENV_ALLOWLIST.includes(name) ||
      ENV_ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      passthrough.has(name);
    if (!allowed) continue;
    if (SECRETISH.test(name) && !passthrough.has(name)) continue;
    out[name] = value;
  }

  for (const [name, value] of Object.entries(options.extra ?? {})) out[name] = value;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Line framing                                                                */
/* -------------------------------------------------------------------------- */

export class LineTooLongError extends Error {
  constructor(readonly limit: number) {
    super(`agent emitted a line longer than ${limit} bytes without a newline`);
    this.name = 'LineTooLongError';
  }
}

/**
 * Incremental newline framer.
 *
 * Holds at most one partial line. `push` returns every line completed by this
 * chunk, in arrival order, and throws once the partial exceeds the cap.
 */
export class LineFramer {
  readonly #decoder = new StringDecoder('utf8');
  #carry = '';

  constructor(private readonly maxLineBytes: number) {}

  push(chunk: Buffer): string[] {
    const text = this.#decoder.write(chunk);
    if (text.length === 0) return [];

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const index = text.indexOf('\n', start);
      if (index === -1) break;
      const line = this.#carry + text.slice(start, index);
      this.#carry = '';
      start = index + 1;
      const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (trimmed.length > 0) lines.push(trimmed);
    }

    if (start < text.length) {
      this.#carry += text.slice(start);
      // Byte length, not character count: the cap is about memory, and one
      // character can be four bytes.
      if (Buffer.byteLength(this.#carry, 'utf8') > this.maxLineBytes) {
        this.#carry = '';
        throw new LineTooLongError(this.maxLineBytes);
      }
    }
    return lines;
  }

  /** Flush whatever is left when the stream closes without a trailing newline. */
  end(): string | null {
    const tail = this.#carry + this.#decoder.end();
    this.#carry = '';
    const trimmed = tail.endsWith('\r') ? tail.slice(0, -1) : tail;
    return trimmed.length > 0 ? trimmed : null;
  }
}

/* -------------------------------------------------------------------------- */
/* Bounded stderr                                                              */
/* -------------------------------------------------------------------------- */

/** Keeps only the most recent `limit` bytes. Diagnostics, not an audit log. */
class BoundedStderr {
  #buffer = '';
  #dropped = 0;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    this.#buffer += chunk.toString('utf8');
    if (this.#buffer.length > this.limit) {
      const overflow = this.#buffer.length - this.limit;
      this.#dropped += overflow;
      this.#buffer = this.#buffer.slice(overflow);
    }
  }

  /** Always redacted. There is no accessor that returns the raw text. */
  snapshot(): string {
    const body = redactForLog(this.#buffer);
    return this.#dropped > 0 ? `[…${this.#dropped} earlier bytes dropped]\n${body}` : body;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AcpError';
  }
}

export class AcpConnectionClosedError extends AcpError {
  constructor(detail: string) {
    super(`the agent connection closed: ${detail}`);
    this.name = 'AcpConnectionClosedError';
  }
}

export class AcpTimeoutError extends AcpError {
  constructor(method: string, ms: number) {
    super(`the agent did not answer ${method} within ${ms}ms`);
    this.name = 'AcpTimeoutError';
  }
}

/* -------------------------------------------------------------------------- */
/* Orphan prevention                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every live child, so an unexpected parent exit does not leave an agent
 * running against the user's repository. `process.on('exit')` may only do
 * synchronous work, which `kill` is.
 */
const LIVE_CHILDREN = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const child of LIVE_CHILDREN) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* the process is already gone; nothing useful to do during exit */
      }
    }
  });
}

/** Pids of every agent process this module currently owns. For diagnostics. */
export function liveAgentPids(): number[] {
  return [...LIVE_CHILDREN].map((child) => child.pid).filter((pid): pid is number => pid !== undefined);
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface AcpLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const NOOP_LOGGER: AcpLogger = { debug: () => {}, warn: () => {}, error: () => {} };

/**
 * What Juno does when the agent calls back.
 *
 * `onRequestPermission` is required — an agent that asks and gets no answer
 * hangs the turn. The filesystem handlers are optional and their absence is
 * reported honestly in the handshake (`clientCapabilities.fs`), so an agent
 * never discovers the gap by getting a "method not found" mid-turn.
 */
export interface AcpClientHandlers {
  onSessionUpdate(notification: SessionNotification): void;
  onRequestPermission(request: RequestPermissionRequest): Promise<RequestPermissionOutcome>;
  onReadTextFile?(request: ReadTextFileRequest): Promise<string>;
  onWriteTextFile?(request: WriteTextFileRequest): Promise<void>;
  /** A frame that failed validation, or an unimplemented inbound method. */
  onProtocolWarning?(message: string): void;
  /** Fired exactly once. `stderr` is already redacted. */
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void;
}

export interface AcpClientOptions {
  readonly launch: LaunchCommand;
  /** Working directory for the child. Also the natural session `cwd`. */
  readonly cwd: string;
  readonly handlers: AcpClientHandlers;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  readonly envPassthrough?: readonly string[];
  readonly logger?: AcpLogger;
  /** Default per-request deadline. `prompt` opts out; a turn can take minutes. */
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxStderrBytes?: number;
  readonly shutdownGraceMs?: number;
}

interface Pending {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

const DEFAULTS = {
  requestTimeoutMs: 60_000,
  maxLineBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  shutdownGraceMs: 5_000,
} as const;

export class AcpClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #framer: LineFramer;
  #stderr: BoundedStderr;
  #pending = new Map<JsonRpcId, Pending>();
  #nextId = 1;
  #closed = false;
  #closeReason = 'not started';
  #exited: Promise<void> | undefined;
  #writeChain: Promise<void> = Promise.resolve();

  private readonly logger: AcpLogger;
  private readonly requestTimeoutMs: number;
  private readonly shutdownGraceMs: number;

  constructor(private readonly options: AcpClientOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.shutdownGraceMs = options.shutdownGraceMs ?? DEFAULTS.shutdownGraceMs;
    this.#framer = new LineFramer(options.maxLineBytes ?? DEFAULTS.maxLineBytes);
    this.#stderr = new BoundedStderr(options.maxStderrBytes ?? DEFAULTS.maxStderrBytes);
  }

  /** Pid of the agent process, once spawned. */
  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get isRunning(): boolean {
    return this.#child !== undefined && !this.#closed;
  }

  /** Redacted tail of the agent's stderr. Safe to show in a diagnostics pane. */
  stderrSnapshot(): string {
    return this.#stderr.snapshot();
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Spawn the agent and complete the ACP handshake.
   *
   * Returns the agent's own `initialize` response so the caller can derive a
   * capability manifest from what the agent actually said.
   */
  async start(): Promise<InitializeResponse> {
    if (this.#child) throw new AcpError('this client has already been started');
    installExitHook();

    const { launch } = this.options;
    const env = scrubEnvironment(process.env, {
      passthrough: this.options.envPassthrough ?? [],
      extra: launch.env,
    });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, [...launch.args], {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // No shell, ever. The argument array is the whole interface.
        shell: false,
        windowsHide: true,
        detached: false,
      });
    } catch (error) {
      throw new AcpError(`could not launch the agent: ${describeError(error)}`);
    }

    this.#child = child;
    LIVE_CHILDREN.add(child);
    this.#closed = false;

    this.#exited = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        LIVE_CHILDREN.delete(child);
        this.#failAll(
          new AcpConnectionClosedError(
            signal ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`,
          ),
          signal ? `killed by ${signal}` : `exited with code ${code ?? 'unknown'}`,
        );
        this.options.handlers.onExit?.({ code, signal, stderr: this.#stderr.snapshot() });
        resolve();
      });
    });

    child.once('error', (error) => {
      // ENOENT lands here rather than throwing from spawn.
      this.#failAll(new AcpError(`agent process error: ${describeError(error)}`), describeError(error));
    });

    child.stdout.on('data', (chunk: Buffer) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => this.#stderr.append(chunk));
    child.stdout.on('error', (error) => this.logger.warn(`agent stdout error: ${describeError(error)}`));
    child.stdin.on('error', (error) => this.logger.warn(`agent stdin error: ${describeError(error)}`));

    const info = this.options.clientInfo ?? { name: 'juno-desktop', version: '0.1.0' };
    const response = await this.request(
      AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: { name: info.name, version: info.version },
        clientCapabilities: {
          fs: {
            readTextFile: this.options.handlers.onReadTextFile !== undefined,
            writeTextFile: this.options.handlers.onWriteTextFile !== undefined,
          },
          terminal: false,
        },
      },
      InitializeResponseSchema,
    );

    if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
      // Not fatal: ACP negotiates down, and an agent answering with a lower
      // version is telling us what it can speak. Anything we then send that it
      // does not understand comes back as -32601, which is survivable.
      this.logger.warn(
        `agent negotiated protocol version ${response.protocolVersion}; Juno targets ${ACP_PROTOCOL_VERSION}`,
      );
    }
    return response;
  }

  /**
   * Stop the agent: stdin EOF, then SIGTERM, then SIGKILL.
   *
   * The EOF step is first because most agents treat a closed stdin as "the
   * editor went away" and shut down cleanly, flushing whatever they were
   * writing. Signalling first would cut that short.
   */
  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#closed = true;

    const exited = this.#exited ?? Promise.resolve();
    let done = false;
    void exited.then(() => {
      done = true;
    });

    try {
      child.stdin.end();
    } catch {
      /* stdin may already be closed */
    }
    if (await raceExit(exited, Math.max(250, Math.floor(this.shutdownGraceMs / 4)))) return;

    if (!done) child.kill('SIGTERM');
    if (await raceExit(exited, this.shutdownGraceMs)) return;

    if (!done) {
      this.logger.warn(`agent pid ${child.pid ?? '?'} ignored SIGTERM; sending SIGKILL`);
      child.kill('SIGKILL');
    }
    await exited;
  }

  /* ---------------------------------------------------------------------- */
  /* Typed calls                                                            */
  /* ---------------------------------------------------------------------- */

  async authenticate(methodId: string): Promise<void> {
    await this.request(AGENT_METHODS.authenticate, { methodId }, EmptyResponseSchema);
  }

  async newSession(params: NewSessionParams): Promise<NewSessionResponse> {
    return this.request(AGENT_METHODS.sessionNew, params, NewSessionResponseSchema);
  }

  async loadSession(
    params: NewSessionParams & { readonly sessionId: string },
  ): Promise<z.infer<typeof LoadSessionResponseSchema>> {
    return this.request(AGENT_METHODS.sessionLoad, params, LoadSessionResponseSchema);
  }

  async listSessions(cwd?: string): Promise<ListSessionsResponse> {
    return this.request(
      AGENT_METHODS.sessionList,
      cwd === undefined ? {} : { cwd },
      ListSessionsResponseSchema,
    );
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.request(AGENT_METHODS.sessionSetMode, { sessionId, modeId }, EmptyResponseSchema);
  }

  /**
   * Run one turn.
   *
   * No timeout by default: a turn legitimately runs for many minutes, and a
   * deadline here would abandon a request the agent is still working on while
   * leaving its side of the conversation alive. Liveness comes from process
   * exit (which rejects everything) and from `cancel`.
   *
   * On abort Juno sends `session/cancel` and keeps waiting: ACP requires the
   * agent to still answer the original request, with `stopReason: "cancelled"`.
   * Rejecting locally instead would desynchronise the id map.
   */
  async prompt(params: PromptParams, signal?: AbortSignal): Promise<PromptResponse> {
    if (signal?.aborted) {
      this.cancel(params.sessionId);
    }
    const onAbort = (): void => this.cancel(params.sessionId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.request(AGENT_METHODS.sessionPrompt, params, PromptResponseSchema, null);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Fire-and-forget cancellation notification. */
  cancel(sessionId: string): void {
    this.notify(AGENT_METHODS.sessionCancel, { sessionId });
  }

  /* ---------------------------------------------------------------------- */
  /* JSON-RPC plumbing                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Issue a request and validate the reply.
   *
   * `timeoutMs: null` disables the deadline. Every response is parsed with the
   * caller's schema before it escapes this method, so no unvalidated agent data
   * reaches the adapter.
   */
  async request<S extends z.ZodType>(
    method: string,
    params: unknown,
    schema: S,
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<z.infer<S>> {
    if (this.#closed || !this.#child) {
      throw new AcpConnectionClosedError(this.#closeReason);
    }
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const pending: Pending = { method, resolve, reject, timer: undefined };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new AcpTimeoutError(method, timeoutMs));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
    });

    this.#write({ jsonrpc: '2.0', id, method, params });
    const raw = await promise;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new AcpError(`the agent's reply to ${method} did not match the ACP schema`, undefined, {
        issues: parsed.error.issues.slice(0, 8),
      });
    }
    return parsed.data;
  }

  notify(method: string, params: unknown): void {
    if (this.#closed || !this.#child) return;
    this.#write({ jsonrpc: '2.0', method, params });
  }

  /**
   * Serialise and enqueue one frame.
   *
   * `JSON.stringify` cannot emit a raw newline inside a string (it escapes to
   * `\n`), so appending exactly one terminator is sufficient to satisfy ACP's
   * "no embedded newlines" rule. Writes are chained rather than fired in
   * parallel so backpressure on a slow agent cannot reorder frames.
   */
  #write(message: unknown): void {
    const child = this.#child;
    if (!child) return;
    let line: string;
    try {
      line = JSON.stringify(message);
    } catch (error) {
      throw new AcpError(`could not serialise an ACP frame: ${describeError(error)}`);
    }
    const payload = `${line}\n`;

    this.#writeChain = this.#writeChain
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (!child.stdin.writable) {
              resolve();
              return;
            }
            const flushed = child.stdin.write(payload, 'utf8', () => resolve());
            if (!flushed) child.stdin.once('drain', () => resolve());
          }),
      )
      .catch((error: unknown) => {
        this.logger.warn(`agent stdin write failed: ${describeError(error)}`);
      });
  }

  #onStdout(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.#framer.push(chunk);
    } catch (error) {
      // Unbounded output is a protocol violation, not a recoverable hiccup.
      this.logger.error(`framing failure from the agent: ${describeError(error)}`);
      this.#failAll(new AcpError(describeError(error)), 'framing failure');
      void this.stop();
      return;
    }
    for (const line of lines) this.#onLine(line);
  }

  #onLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#warn(`the agent emitted a line that is not JSON (${line.length} chars)`);
      return;
    }

    const classified = classifyInbound(raw);
    if (!classified.ok) {
      this.#warn(`the agent emitted a frame that is not valid JSON-RPC: ${classified.error}`);
      return;
    }

    const frame = classified.frame;
    switch (frame.kind) {
      case 'result':
      case 'error': {
        if (frame.id === null) {
          // A null id means the agent could not even parse our frame. There is
          // no request to fail, so it is logged and the session continues.
          const detail = frame.kind === 'error' ? frame.error.message : 'unknown';
          this.#warn(`the agent reported an error with no request id: ${detail}`);
          return;
        }
        const pending = this.#pending.get(frame.id);
        if (!pending) {
          this.#warn(`the agent answered request ${String(frame.id)}, which is not outstanding`);
          return;
        }
        this.#pending.delete(frame.id);
        if (pending.timer) clearTimeout(pending.timer);
        if (frame.kind === 'result') pending.resolve(frame.result);
        else pending.reject(toAcpError(pending.method, frame.error));
        return;
      }
      case 'notification':
        this.#onNotification(frame.method, frame.params);
        return;
      case 'request':
        void this.#onRequest(frame.id, frame.method, frame.params);
        return;
      default: {
        const exhaustive: never = frame;
        void exhaustive;
        return;
      }
    }
  }

  #onNotification(method: string, params: unknown): void {
    if (method !== CLIENT_METHODS.sessionUpdate) {
      // elicitation/complete and the nes/document families land here. Ignored
      // rather than errored: a notification has no reply channel, and Juno
      // never advertised those capabilities in the first place.
      this.#warn(`ignoring an unhandled agent notification: ${method}`);
      return;
    }
    const parsed = SessionNotificationSchema.safeParse(params);
    if (!parsed.success) {
      this.#warn(`a session/update did not match the ACP schema: ${firstIssue(parsed.error)}`);
      return;
    }
    try {
      this.options.handlers.onSessionUpdate(parsed.data);
    } catch (error) {
      this.logger.error(`session update handler threw: ${describeError(error)}`);
    }
  }

  async #onRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.#dispatch(method, params);
      this.#write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const code = error instanceof AcpError && error.code !== undefined ? error.code : ACP_ERROR_CODES.internalError;
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code, message: redactForLog(describeError(error)) },
      });
    }
  }

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    const handlers = this.options.handlers;
    switch (method) {
      case CLIENT_METHODS.sessionRequestPermission: {
        const request = parseOrThrow(RequestPermissionRequestSchema, params, method);
        const outcome = await handlers.onRequestPermission(request);
        return { outcome };
      }
      case CLIENT_METHODS.fsReadTextFile: {
        if (!handlers.onReadTextFile) throw methodNotFound(method);
        const request = parseOrThrow(ReadTextFileRequestSchema, params, method);
        return { content: await handlers.onReadTextFile(request) };
      }
      case CLIENT_METHODS.fsWriteTextFile: {
        if (!handlers.onWriteTextFile) throw methodNotFound(method);
        const request = parseOrThrow(WriteTextFileRequestSchema, params, method);
        await handlers.onWriteTextFile(request);
        return {};
      }
      default:
        // terminal/*, elicitation/*, mcp/* — Juno does not advertise these, so
        // a well-behaved agent never asks. Answering -32601 is the protocol's
        // own way of saying so.
        throw methodNotFound(method);
    }
  }

  #warn(message: string): void {
    const safe = redactForLog(message);
    this.logger.warn(safe);
    this.options.handlers.onProtocolWarning?.(safe);
  }

  /** Reject every outstanding request. Called exactly once per connection. */
  #failAll(error: Error, reason: string): void {
    if (this.#closed && this.#pending.size === 0) return;
    this.#closed = true;
    this.#closeReason = reason;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function parseOrThrow<S extends z.ZodType>(schema: S, params: unknown, method: string): z.infer<S> {
  const parsed = schema.safeParse(params);
  if (parsed.success) return parsed.data;
  throw new AcpError(
    `invalid params for ${method}: ${firstIssue(parsed.error)}`,
    ACP_ERROR_CODES.invalidParams,
  );
}

function methodNotFound(method: string): AcpError {
  return new AcpError(`Juno does not implement ${method}`, ACP_ERROR_CODES.methodNotFound);
}

function toAcpError(method: string, error: JsonRpcError): AcpError {
  return new AcpError(`${method} failed: ${error.message}`, error.code, error.data);
}

function firstIssue(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0];
  if (!issue) return 'unknown validation failure';
  const path = issue.path.map(String).join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Resolves true when the process exited first, false when the deadline won. */
async function raceExit(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([exited.then(() => true), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
