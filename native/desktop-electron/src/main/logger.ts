/**
 * Structured, privacy-aware logging for the main process.
 *
 * Three properties this module is built around, in priority order:
 *
 *   1. **A log must never be the thing that leaks the credential.** Everything
 *      written passes through `redactValue`. Juno's main process is the only
 *      process that holds provider keys and session bearer tokens, so it is
 *      also the only process that can spill them into a file the user will
 *      later paste into a bug report. Redaction is applied at the sink, not at
 *      the call site, because "remember to redact" is not a control.
 *   2. **Logging must never block the UI.** Records are batched and appended
 *      asynchronously through a single serialised promise chain. The only
 *      synchronous write in this file is the shutdown flush, where blocking is
 *      the correct trade.
 *   3. **The log must be bounded.** A long-lived desktop app with an agent
 *      streaming events is entirely capable of writing gigabytes. Size-based
 *      rotation with a fixed generation count caps the footprint at
 *      `MAX_FILE_BYTES * MAX_FILES`.
 *
 * ## No Electron import, on purpose
 *
 * This module imports nothing from `electron`. The log directory and the
 * console flag are passed in by the caller:
 *
 * ```ts
 * configureLogging({
 *   directory: app.getPath('logs'),
 *   console: !app.isPackaged,
 * });
 * ```
 *
 * That keeps the redaction functions — the part most worth testing — importable
 * from a plain Vitest unit test with no Electron mock, and it removes an
 * ordering hazard: `app.getPath('logs')` is only meaningful once the app has a
 * name, whereas modules at the top of the import graph want to log immediately.
 * Records emitted before `configureLogging` are buffered and flushed to the file
 * as soon as it opens, so nothing from early startup is lost.
 */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* Channels and levels                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The named channels. Fixed rather than free-form: a closed set is greppable,
 * can be filtered on without a regex, and makes "which subsystem was noisy"
 * answerable from a log file alone.
 */
export const LOG_CHANNELS = [
  'app',
  'sync',
  'provider',
  'agent',
  'terminal',
  'git',
  'computer-use',
  'updater',
] as const;

export type LogChannel = (typeof LOG_CHANNELS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/** Structured context. Values are redacted and depth-bounded before writing. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface ChannelLogger {
  readonly channel: LogChannel;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** One JSON line. Field order is stable so a diff of two logs is readable. */
interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly channel: LogChannel;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Redaction — pure, dependency-free, unit-testable                            */
/* -------------------------------------------------------------------------- */

export const REDACTED = '[redacted]';

/**
 * Injecting the home directory keeps redaction deterministic under test.
 * Production callers omit it and get `os.homedir()`.
 */
export interface RedactionOptions {
  readonly homeDir: string;
}

/** Beyond this, a single logged string is truncated rather than written whole. */
const MAX_STRING_LENGTH = 8_192;
/** Guards against a cyclic or pathologically nested object stalling a flush. */
const MAX_DEPTH = 6;
const MAX_ARRAY_ENTRIES = 100;

/**
 * Header-shaped secrets: `Authorization: Bearer x`, `api-key=x`, `Cookie: x`.
 *
 * The value group deliberately runs to end-of-line (or to a closing quote)
 * rather than to the first space, because `Bearer <token>` contains a space and
 * a naive `\S+` match would preserve the token and redact the word "Bearer".
 */
const HEADER_SECRET_PATTERN =
  /\b(authorization|proxy-authorization|www-authenticate|x-api-key|api[-_]?key|cookie|set-cookie|x-auth-token)\b(\s*[:=]\s*)(["']?)([^\r\n"']*)/gi;

/** A bare bearer token anywhere in free text. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Vendor key shapes.
 *
 * Matching on shape rather than on context is what catches the case that
 * actually happens: a key pasted into an error message by a library we do not
 * control, with no surrounding `Authorization:` to key off.
 */
const KEY_SHAPE_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // Anthropic / OpenAI / Stripe-ish
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, // GitHub classic + app tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[baprse]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google API key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

/**
 * A URL's query string and fragment, captured separately from its path.
 *
 * Both halves matter. OAuth implicit-style callbacks put the token in the
 * *fragment*, and `redactUrl` in `security.ts` drops both for the same reason —
 * this is the free-text equivalent of that function.
 *
 * Scoped to strings that actually look like URLs, so an ordinary sentence
 * containing a question mark is left alone.
 */
const URL_TAIL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/[^\s?#'"<>]*)(\?[^\s#'"<>]*)?(#[^\s'"<>]*)?/gi;

/** Keys whose *entire value* is dropped, whatever shape the value has. */
const SENSITIVE_KEY_PATTERN =
  /^(authorization|cookie|set-cookie|password|passwd|pass|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|credential|credentials|session[_-]?key|auth|bearer|signature|otp|pin)$/i;

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact one string.
 *
 * Pure: same input, same options, same output. No filesystem, no clock, no
 * Electron. The order of the passes is load-bearing — key shapes are redacted
 * *before* query strings are collapsed, so that a key which appears inside a
 * query string is redacted rather than merely hidden behind `?[redacted]`
 * (the difference matters if the URL pass is ever narrowed).
 */
export function redactString(input: string, options?: RedactionOptions): string {
  const homeDir = options?.homeDir ?? homedir();
  let output = input;

  output = output.replace(
    HEADER_SECRET_PATTERN,
    (_match, name: string, separator: string, quote: string) =>
      `${name}${separator}${quote}${REDACTED}`,
  );

  output = output.replace(BEARER_PATTERN, `Bearer ${REDACTED}`);

  for (const pattern of KEY_SHAPE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }

  output = output.replace(
    URL_TAIL_PATTERN,
    (_match, base: string, query: string | undefined, fragment: string | undefined) => {
      const redactedQuery = query === undefined ? '' : `?${REDACTED}`;
      const redactedFragment = fragment === undefined ? '' : `#${REDACTED}`;
      return `${base}${redactedQuery}${redactedFragment}`;
    },
  );

  /* The real home directory becomes `~`. Case-insensitive because APFS is
     case-insensitive by default, so a path can legitimately arrive with
     different casing than `os.homedir()` reports. */
  if (homeDir.length > 1) {
    output = output.replace(new RegExp(escapeForRegExp(homeDir), 'gi'), '~');
  }

  /* Any *other* account's home directory is redacted rather than rewritten to
     `~`, because collapsing it to `~` would assert something false about whose
     files those are. */
  output = output.replace(/\/Users\/[^/\s:"'`]+/g, `/Users/${REDACTED}`);

  if (output.length > MAX_STRING_LENGTH) {
    output = `${output.slice(0, MAX_STRING_LENGTH)}… [truncated ${output.length - MAX_STRING_LENGTH} chars]`;
  }

  return output;
}

/**
 * Redact an arbitrary value, recursively.
 *
 * Errors are unwrapped explicitly: `JSON.stringify(new Error(...))` yields
 * `{}`, which is the single most common way for a log line to record that
 * something failed while recording nothing about what.
 */
export function redactValue(value: unknown, options?: RedactionOptions): unknown {
  return redactValueAt(value, options, 0, new WeakSet<object>());
}

function redactValueAt(
  value: unknown,
  options: RedactionOptions | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value ?? null;

  switch (typeof value) {
    case 'string':
      return redactString(value, options);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[function]';
    default:
      break;
  }

  if (depth >= MAX_DEPTH) return '[depth-limit]';

  const asObject = value as object;
  if (seen.has(asObject)) return '[circular]';
  seen.add(asObject);

  try {
    if (value instanceof Error) {
      const serialised: Record<string, unknown> = {
        name: value.name,
        message: redactString(value.message, options),
      };
      if (typeof value.stack === 'string') {
        serialised['stack'] = redactString(value.stack, options);
      }
      if (value.cause !== undefined) {
        serialised['cause'] = redactValueAt(value.cause, options, depth + 1, seen);
      }
      return serialised;
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof URL) return redactString(value.toString(), options);
    if (value instanceof Map) {
      return redactValueAt(Object.fromEntries(value.entries()), options, depth, seen);
    }
    if (value instanceof Set) {
      return redactValueAt([...value.values()], options, depth, seen);
    }

    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_ARRAY_ENTRIES);
      const mapped: unknown[] = kept.map((entry) =>
        redactValueAt(entry, options, depth + 1, seen),
      );
      if (value.length > MAX_ARRAY_ENTRIES) {
        mapped.push(`[+${value.length - MAX_ARRAY_ENTRIES} more]`);
      }
      return mapped;
    }

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? REDACTED
        : redactValueAt(entry, options, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(asObject);
  }
}

/* -------------------------------------------------------------------------- */
/* Sink                                                                        */
/* -------------------------------------------------------------------------- */

export interface LoggingOptions {
  /** Directory for log files. Production: `app.getPath('logs')`. */
  readonly directory: string;
  /** Mirror records to stdout/stderr. Production: `!app.isPackaged`. */
  readonly console: boolean;
  /** Records below this level are dropped entirely. Defaults to `debug` in dev. */
  readonly level?: LogLevel;
  /** Base filename, without extension. */
  readonly fileName?: string;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Live file plus `.1` … `.4`, so at most ~10 MiB on disk. */
const MAX_FILES = 5;
const FLUSH_INTERVAL_MS = 250;
/** If the sink stalls, drop the oldest records rather than grow without bound. */
const MAX_PENDING_LINES = 5_000;
/** After this many consecutive write failures the file sink gives up quietly. */
const MAX_CONSECUTIVE_FAILURES = 5;

interface FileSink {
  readonly directory: string;
  readonly baseName: string;
  readonly filePath: string;
  bytes: number;
  failures: number;
}

let sink: FileSink | null = null;
let minimumRank = LEVEL_RANK.debug;
let consoleEnabled = true;
let pending: string[] = [];
let droppedLines = 0;
let flushChain: Promise<void> = Promise.resolve();
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Open the file sink. Safe to call once; a second call reconfigures in place.
 *
 * Failure to open is not fatal: an app that cannot write a log file should
 * still start. The failure is reported to the console and logging continues
 * in memory-and-console mode.
 */
export function configureLogging(options: LoggingOptions): void {
  consoleEnabled = options.console;
  minimumRank = LEVEL_RANK[options.level ?? (options.console ? 'debug' : 'info')];

  const baseName = options.fileName ?? 'juno-main';
  const filePath = path.join(options.directory, `${baseName}.log`);

  try {
    mkdirSync(options.directory, { recursive: true });
    let bytes = 0;
    try {
      bytes = statSync(filePath).size;
    } catch {
      /* First run: the file does not exist yet, which is not an error. */
    }
    sink = { directory: options.directory, baseName, filePath, bytes, failures: 0 };
  } catch (error) {
    sink = null;
    console.error('[log] could not open log directory; continuing without a log file', error);
    return;
  }

  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer !== null || sink === null || pending.length === 0) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushChain = flushChain.then(flushPending, flushPending);
  }, FLUSH_INTERVAL_MS);
  /* Never keep the process alive for a pending log flush; quit paths call
     `flushLogsSync`, which does not depend on this timer. */
  flushTimer.unref();
}

async function flushPending(): Promise<void> {
  const active = sink;
  if (active === null || pending.length === 0) return;

  const batch = pending.join('');
  pending = [];

  try {
    await appendFile(active.filePath, batch, 'utf8');
    active.bytes += Buffer.byteLength(batch, 'utf8');
    active.failures = 0;
    if (active.bytes >= MAX_FILE_BYTES) await rotate(active);
  } catch (error) {
    active.failures += 1;
    console.error(`[log] write failed (${active.failures}/${MAX_CONSECUTIVE_FAILURES})`, error);
    if (active.failures >= MAX_CONSECUTIVE_FAILURES) {
      sink = null;
      consoleEnabled = true;
      console.error('[log] disabling the file sink after repeated failures');
    }
  } finally {
    scheduleFlush();
  }
}

function rotatedPath(active: FileSink, generation: number): string {
  return path.join(active.directory, `${active.baseName}.${generation}.log`);
}

/**
 * Shift generations down and start a fresh live file.
 *
 * Every step tolerates ENOENT: on the first few rotations most generations do
 * not exist yet, and treating that as an error would abort the rotation and
 * let the live file grow unbounded.
 */
async function rotate(active: FileSink): Promise<void> {
  try {
    await unlink(rotatedPath(active, MAX_FILES - 1)).catch(() => undefined);
    for (let generation = MAX_FILES - 2; generation >= 1; generation -= 1) {
      await rename(rotatedPath(active, generation), rotatedPath(active, generation + 1)).catch(
        () => undefined,
      );
    }
    await rename(active.filePath, rotatedPath(active, 1));
    active.bytes = 0;
  } catch (error) {
    /* Rotation failing is recoverable — the live file simply keeps growing
       until the next attempt — but it must not be silent. */
    console.error('[log] rotation failed', error);
    try {
      active.bytes = (await stat(active.filePath)).size;
    } catch {
      active.bytes = 0;
    }
  }
}

/**
 * Write everything still buffered, synchronously.
 *
 * Called from `before-quit`/`will-quit`. Blocking is acceptable — and required —
 * here: the alternative is losing the last few hundred milliseconds of records,
 * which is precisely the window in which a crash-on-quit lives.
 */
export function flushLogsSync(): void {
  const active = sink;
  if (active === null || pending.length === 0) return;
  const batch = pending.join('');
  pending = [];
  try {
    appendFileSync(active.filePath, batch, 'utf8');
    active.bytes += Buffer.byteLength(batch, 'utf8');
  } catch (error) {
    console.error('[log] final flush failed', error);
  }
}

/** Test/shutdown helper: drains asynchronously and forgets the sink. */
export async function shutdownLogging(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushChain = flushChain.then(flushPending, flushPending);
  await flushChain;
  sink = null;
}

/** Where the live log file is, for a "Reveal logs" menu item. */
export function getLogFilePath(): string | null {
  return sink?.filePath ?? null;
}

/* -------------------------------------------------------------------------- */
/* Emission                                                                    */
/* -------------------------------------------------------------------------- */

function enqueue(line: string): void {
  if (pending.length >= MAX_PENDING_LINES) {
    pending.shift();
    droppedLines += 1;
    if (droppedLines === 1 || droppedLines % 1_000 === 0) {
      console.warn(`[log] buffer full; dropped ${droppedLines} record(s)`);
    }
  }
  pending.push(line);
  scheduleFlush();
}

function write(channel: LogChannel, level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < minimumRank) return;

  const redactedFields =
    fields === undefined ? undefined : (redactValue(fields) as Record<string, unknown>);

  const record: LogRecord = {
    time: new Date().toISOString(),
    level,
    channel,
    message: redactString(message),
    ...(redactedFields === undefined ? {} : { fields: redactedFields }),
  };

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (error) {
    /* `redactValue` already flattens the shapes that break `JSON.stringify`
       (cycles, BigInt), so reaching here means something unusual. Record the
       failure rather than dropping the event. */
    line = `${JSON.stringify({
      time: record.time,
      level: 'error',
      channel,
      message: 'log record could not be serialised',
      fields: { original: record.message, reason: String(error) },
    })}\n`;
  }

  enqueue(line);

  if (consoleEnabled) {
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const suffix = redactedFields === undefined ? '' : ` ${JSON.stringify(redactedFields)}`;
    target(`[${channel}] ${record.message}${suffix}`);
  }
}

const loggerCache = new Map<LogChannel, ChannelLogger>();

/**
 * Get the logger for a channel. Cached, so `createLogger('app')` at the top of
 * a module is free to call from anywhere.
 */
export function createLogger(channel: LogChannel): ChannelLogger {
  const existing = loggerCache.get(channel);
  if (existing !== undefined) return existing;

  const logger: ChannelLogger = {
    channel,
    debug: (message, fields) => {
      write(channel, 'debug', message, fields);
    },
    info: (message, fields) => {
      write(channel, 'info', message, fields);
    },
    warn: (message, fields) => {
      write(channel, 'warn', message, fields);
    },
    error: (message, fields) => {
      write(channel, 'error', message, fields);
    },
  };

  loggerCache.set(channel, logger);
  return logger;
}
