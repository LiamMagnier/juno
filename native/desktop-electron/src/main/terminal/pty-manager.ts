/**
 * Real pseudoterminals, owned by main.
 *
 * This module holds every pty the application has ever spawned and is the only
 * thing that may spawn one. It is written to be unit-testable without Electron
 * and without a native module: it imports `zod`, `node:path`, `node:fs` and
 * `node:crypto`, and reaches `node-pty` through a lazy dynamic import that a
 * test can replace with an injected spawner. Nothing here touches `ipcMain`,
 * `BrowserWindow` or the shared IPC contract; events leave through an injected
 * sink. That is deliberate — a pty manager that can only be exercised inside a
 * running Electron app is a pty manager whose orphan handling is never tested.
 *
 * Four things this file is responsible for, in rough order of how badly they go
 * wrong when they are absent:
 *
 * ## 1. Process ownership
 *
 * Every pty is tracked from before it produces output until after it is reaped.
 * On shutdown the manager signals the child's **process group** (`kill(-pid)`),
 * not just the child, SIGTERM first and SIGKILL after a grace period. See
 * `shutdown()` for the sequence and for an honest account of what still
 * survives (a deliberately detached process, which it should).
 *
 * ## 2. Environment scrubbing
 *
 * The child must not inherit Juno's secrets. `scrubEnvironment` is pure and
 * subtractive; `buildTerminalEnvironment` composes it with the small set of
 * variables a terminal genuinely needs. No provider credential is ever injected.
 *
 * ## 3. Backpressure
 *
 * Output is batched on a ~16ms interval, capped per event, and the pty is
 * paused when a producer outruns the interval. Forwarding every `onData` chunk
 * straight to the renderer is the classic way an Electron terminal dies, and it
 * dies specifically under `yes` — which is why the flow control below is real
 * (`pty.pause()`, which stops draining the master fd and eventually blocks the
 * writer in the kernel) rather than a `setTimeout` that only defers the work.
 *
 * ## 4. Placement, not jailing
 *
 * A terminal is opened *inside* a trusted workspace root, verified through
 * `realpath` so a symlink cannot be used to place one somewhere else. It is not
 * a sandbox: the user can `cd /` afterwards, because that is what a terminal
 * is. Claiming otherwise would be worse than not claiming it.
 */

import { randomUUID } from 'node:crypto';
import { stat, realpath as fsRealpath } from 'node:fs/promises';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';
import {
  TERMINAL_LIMITS,
  TerminalError,
  TerminalInputSchema,
  type TerminalCreateRequest,
  type TerminalId,
  type TerminalInputInit,
  type TerminalInputRecord,
  type TerminalKillRequest,
  type TerminalListRequest,
  type TerminalOrigin,
  type TerminalOutboundEvent,
  type TerminalResizeRequest,
  type TerminalRestartRequest,
  type TerminalSignal,
  type TerminalStatus,
  type TerminalSummary,
} from './contract.js';

/* ========================================================================== */
/* Tunables                                                                    */
/* ========================================================================== */

/**
 * Per-terminal replay history, in UTF-16 code units (~2 bytes each in V8's
 * worst case, so ~500KB of RSS per terminal at the cap, ~6MB across the 12
 * terminals `TERMINAL_LIMITS.maxTerminals` allows).
 *
 * 256,000 units is roughly 2,500 lines of 100 columns — comfortably more
 * scrollback than the renderer needs to redraw a pane after a window reload,
 * and far short of "keep everything", which is a memory leak with a long fuse:
 * a build log left running overnight is unbounded output into a process the
 * user cannot see the size of.
 *
 * The renderer keeps its own, larger scrollback in xterm. This buffer exists
 * only so a re-attaching pane is not blank in front of a live shell.
 */
export const HISTORY_LIMIT_CHARS = 256_000;

/**
 * How long output is allowed to accumulate before it is pushed.
 *
 * One frame at 60Hz. The renderer cannot display more often than this, so
 * emitting more often than this is pure overhead — and each emission costs a
 * structured clone, an IPC hop and a React render.
 */
export const FLUSH_INTERVAL_MS = 16;

/**
 * The most output one event may carry, in UTF-16 code units.
 *
 * 128KiB per 16ms frame is ~8MB/s of terminal output — well past anything a
 * human reads and past what xterm can parse in real time. Beyond it the manager
 * keeps the **tail** and reports what it dropped, because the tail is what the
 * user would have seen anyway once the scroll settled.
 */
export const MAX_FLUSH_CHARS = 131_072;

/**
 * Pending output at which the pty is paused.
 *
 * `pause()` stops node-pty reading the master fd. The kernel's tty buffer
 * fills, and the child's next `write(2)` blocks. That is the only backpressure
 * that actually reaches the producer — everything else just moves the unbounded
 * buffer to a different process.
 */
export const PAUSE_HIGH_WATER_CHARS = 262_144;

/** How long a process gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 2_000;

/**
 * Prefix prepended to a truncated batch.
 *
 * ST (ESC \). If the cut landed inside an OSC or DCS string the parser is
 * waiting for a terminator and would swallow the rest of the batch; ST ends it.
 * A partial CSI is aborted by the leading ESC on its own. Cheap insurance
 * against one dropped frame corrupting every frame after it.
 */
const TRUNCATION_RESYNC = '\u001b\\';

/* ========================================================================== */
/* Environment scrubbing — pure                                                */
/* ========================================================================== */

/**
 * Key segments that mark a variable as credential-shaped.
 *
 * Matched against `_`-separated **segments**, not as substrings. Substring
 * matching on `KEY` strips `KEYBOARD_LAYOUT` and keeps `MYKEYS`; segment
 * matching gets both right and is easier to argue about, which matters for a
 * list that decides what a user's shell can see.
 */
const SECRET_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'cred',
  'credential',
  'credentials',
  'creds',
  'jwt',
  'key',
  'keys',
  'mnemonic',
  'nonce',
  'otp',
  'pass',
  'passphrase',
  'passwd',
  'password',
  'passwords',
  'pat',
  'pin',
  'priv',
  'private',
  'privkey',
  'salt',
  'secret',
  'secrets',
  'session',
  'sig',
  'signature',
  'token',
  'tokens',
]);

/**
 * Prefixes stripped wholesale.
 *
 * `JUNO_` is the app's own configuration and none of it is the shell's
 * business. `ELECTRON_` matters more than it looks: `ELECTRON_RUN_AS_NODE=1` in
 * a user's shell silently changes what every Electron binary they launch does.
 * `npm_` is here because npm injects registry auth into lifecycle-script
 * environments (`npm_config__auth`, `npm_config_//registry…:_authToken`), so if
 * the app was ever started through an npm script the whole set is sitting in
 * `process.env`.
 */
const SECRET_KEY_PREFIXES: readonly string[] = ['JUNO_', 'ELECTRON_', 'NPM_', 'NPM_CONFIG_'];

/**
 * Exact names removed regardless of shape.
 *
 * These are not secrets; they are *injection vectors*. A shell that inherits
 * `NODE_OPTIONS=--require /tmp/x.js` runs `/tmp/x.js` inside every Node process
 * the user starts from it, and `DYLD_INSERT_LIBRARIES` does the same for native
 * binaries. Inheriting them from an Electron app into an interactive shell is
 * privilege laundering even when the value is benign, so they do not travel.
 */
const DENIED_EXACT_KEYS: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  /* Stale geometry. The pty sets the real size; an inherited one lies. */
  'COLUMNS',
  'LINES',
  /* The user's shell should start at depth 1, not at Juno's depth. */
  'SHLVL',
  'OLDPWD',
]);

/**
 * Names that survive the segment test on purpose.
 *
 * `SSH_AUTH_SOCK` contains the segment `AUTH` and is a credential *agent*
 * socket — but it is the **user's** agent, present in their own Terminal.app,
 * and the socket is theirs, not Juno's. Removing it breaks `git push` in the
 * terminal Juno just opened, and the workaround users reach for when that
 * happens (an unencrypted key, a token pasted into the shell) is materially
 * worse than the thing being avoided. The rule this list encodes: strip what
 * belongs to Juno, keep what belongs to the user's login session.
 */
const PRESERVED_KEYS: ReadonlySet<string> = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_TTY',
]);

/**
 * Value shapes that are credentials no matter what they are called.
 *
 * All anchored. An unanchored token-prefix match would strip `PATH` the moment
 * a directory happened to contain the substring. This is the belt to the key
 * test's braces: it catches `MY_THING=ghp_…`, which no naming rule can.
 */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI / Anthropic style
  /^sk-ant-[A-Za-z0-9_-]{16,}$/,
  /^gh[pousr]_[A-Za-z0-9]{16,}$/, // GitHub PAT / OAuth / server / refresh
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^xox[abposr]-[A-Za-z0-9-]{10,}$/, // Slack
  /^(?:AKIA|ASIA)[0-9A-Z]{16}$/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{30,}$/, // Google API key
  /^ya29\.[0-9A-Za-z._-]{20,}$/, // Google OAuth
  /^glpat-[0-9A-Za-z_-]{16,}$/, // GitLab
  /^npm_[0-9A-Za-z]{30,}$/,
  /^dop_v1_[0-9a-f]{32,}$/, // DigitalOcean
  /^sk_live_[0-9A-Za-z]{16,}$/, // Stripe
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/, // JWT
];

/** PEM material, wherever it appears in the value. */
const PEM_MARKER = '-----BEGIN ';

/**
 * Whether a variable name looks like it holds a credential.
 *
 * Pure. Exported for unit tests, which are the only reason this is a function
 * and not an inline condition — the cost of getting this wrong is silent, and
 * silent security regressions need a test that names each case.
 */
export function isSecretLikeKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (PRESERVED_KEYS.has(upper)) return false;
  if (DENIED_EXACT_KEYS.has(upper)) return true;
  for (const prefix of SECRET_KEY_PREFIXES) {
    if (upper.startsWith(prefix)) return true;
  }

  /* Segmented on the ORIGINAL casing, then lowercased — splitting an
     already-uppercased name on camelCase boundaries finds none, which silently
     lets `myServicePassword` through. The uppercase form is only used for the
     exact-name and prefix tests above. */
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment.length > 0);

  return segments.some((segment) => SECRET_KEY_SEGMENTS.has(segment.toLowerCase()));
}

/** Whether a value looks like a credential regardless of its name. Pure. */
export function isSecretLikeValue(value: string): boolean {
  if (value.includes(PEM_MARKER)) return true;
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Remove everything credential-shaped from an environment. Pure and subtractive.
 *
 * Takes and returns a plain record so it can be tested with a literal; it never
 * reads `process.env` itself. Values that are `undefined` (which `process.env`
 * produces for names that were never set but were read) are dropped, so the
 * result is a `Record<string, string>` that node-pty can hand to `execve`
 * without any of them becoming the literal string `"undefined"`.
 */
export function scrubEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    /* A name containing `=` or NUL cannot be represented in an environment
       block; some libc implementations truncate rather than reject. */
    if (key.length === 0 || key.includes('=') || key.includes('\0')) continue;
    if (value.includes('\0')) continue;
    if (isSecretLikeKey(key)) continue;
    if (isSecretLikeValue(value)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

/**
 * The environment a terminal child actually gets. Pure.
 *
 * Scrub first, then add the handful of variables a terminal needs to render
 * correctly. Nothing here is a credential and nothing here is provider
 * configuration — a shell that inherits `ANTHROPIC_API_KEY` from its parent is
 * a shell that leaks it into every `env`, every crash report and every
 * screen-share, and there is no version of "convenient" that is worth that.
 */
export function buildTerminalEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  options: { cwd: string; appVersion: string },
): Record<string, string> {
  const env = scrubEnvironment(source);

  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['TERM_PROGRAM'] = 'Juno';
  env['TERM_PROGRAM_VERSION'] = options.appVersion;
  env['PWD'] = options.cwd;

  /* Only as a fallback. A user who has set `LANG` has almost certainly set it
     for a reason, and overriding it breaks their locale-sensitive tooling. */
  if (env['LANG'] === undefined && env['LC_ALL'] === undefined) {
    env['LANG'] = 'en_US.UTF-8';
  }

  return env;
}

/* ========================================================================== */
/* Shell resolution — pure                                                     */
/* ========================================================================== */

export interface ResolvedShell {
  /** Absolute path to the shell binary. */
  file: string;
  /** argv **array**. Never a command string — see the note below. */
  args: string[];
}

/**
 * Shells that are known to accept `-l`, and the fallback order for each
 * platform. Ordered by what macOS actually ships and defaults to: zsh has been
 * the default login shell since Catalina, bash is still present as 3.2, and
 * `/bin/sh` exists on every POSIX system that will ever run this.
 */
const POSIX_SHELL_FALLBACKS: readonly string[] = ['/bin/zsh', '/bin/bash', '/bin/sh'];

/**
 * Pick the user's real login shell.
 *
 * `process.env.SHELL` is the right source on macOS: it is set by
 * `loginwindow`/`login` from the Directory Services record, so it reflects
 * `chsh` rather than whatever compiled-in default a library would guess. The
 * candidate is still validated — it is an absolute path from an environment
 * variable, and an environment variable is not a trusted source just because it
 * usually holds the right answer.
 *
 * Spawned as a **login shell** (`-l`) so `.zprofile` / `.bash_profile` run and
 * the user's real `PATH` applies. Without it, a terminal opened from a GUI app
 * gets the bare `launchd` PATH and nothing the user installed is on it, which
 * users experience as "Juno's terminal is broken".
 *
 * The return is a file and an **argv array**. There is no code path in this
 * module that builds a command string; `node-pty` execs `file` with `args`
 * directly, so there is no shell metacharacter to escape and no injection to
 * get wrong.
 *
 * Pure: the filesystem check is injected.
 */
export function resolveLoginShell(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  isUsableShell: (candidate: string) => boolean,
): ResolvedShell {
  if (platform === 'win32') {
    /* Not a supported target — Juno Desktop is macOS — but a manager that
       throws on Windows is a manager that cannot be exercised on a contributor's
       machine. `-l` is meaningless here and is deliberately absent. */
    const comspec = env['ComSpec'] ?? env['COMSPEC'];
    return { file: comspec && comspec.length > 0 ? comspec : 'powershell.exe', args: [] };
  }

  const candidates: string[] = [];
  const fromEnv = env['SHELL'];
  if (fromEnv !== undefined && isPlausibleShellPath(fromEnv)) candidates.push(fromEnv);
  candidates.push(...POSIX_SHELL_FALLBACKS);

  for (const candidate of candidates) {
    if (isUsableShell(candidate)) return { file: candidate, args: ['-l'] };
  }

  /* Every candidate failed, which on a POSIX system means something is very
     wrong with the machine. `/bin/sh` is the last thing to give up on. */
  throw new TerminalError('invalid-shell', 'No usable login shell was found on this system.');
}

/**
 * Cheap syntactic rejection before touching the filesystem.
 *
 * Absolute, no NUL, no newline. A relative `SHELL` would be resolved against
 * the *child's* cwd, which is attacker-influenced in the general case (a
 * repository containing a file called `zsh`).
 */
function isPlausibleShellPath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 4096) return false;
  if (!candidate.startsWith('/')) return false;
  if (candidate.includes('\0') || candidate.includes('\n')) return false;
  return true;
}

/** The default `isUsableShell`: exists, is a regular file, is executable. */
export function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* ========================================================================== */
/* Working directory containment                                               */
/* ========================================================================== */

export interface PathResolverDeps {
  realpath: (candidate: string) => Promise<string>;
  isDirectory: (candidate: string) => Promise<boolean>;
}

/**
 * Resolve where a terminal may be opened, and refuse everywhere else.
 *
 * **Both** sides go through `realpath` before they are compared. Checking a
 * lexical prefix first and resolving afterwards — or resolving only the
 * candidate — is the bug this function exists to not have: a symlink inside the
 * workspace pointing at `/` passes a `startsWith` test on the unresolved path
 * and lands the shell at the root of the disk.
 *
 * After resolution the comparison is `equal to the root, or under the root plus
 * a separator`. The trailing separator matters: without it `/Users/x/work-old`
 * is "inside" `/Users/x/work`.
 *
 * On the case-insensitivity of macOS's default volume: both operands come from
 * `realpath`, which returns the canonical on-disk casing, so a case-variant
 * path cannot produce a prefix mismatch on a genuine descendant.
 *
 * This is placement, not confinement. Once the shell is running the user may
 * `cd` anywhere they have permission to — the point is that *Juno* never puts
 * one somewhere the user did not trust.
 */
export async function resolveContainedCwd(
  workspaceRootPath: string,
  requested: string | undefined,
  deps: PathResolverDeps,
): Promise<string> {
  let realRoot: string;
  try {
    realRoot = await deps.realpath(workspaceRootPath);
  } catch {
    throw new TerminalError('workspace-not-found', 'That workspace folder is no longer available.');
  }
  if (!(await deps.isDirectory(realRoot))) {
    throw new TerminalError('workspace-not-found', 'That workspace folder is no longer available.');
  }

  if (requested === undefined) return realRoot;
  if (requested.includes('\0')) {
    throw new TerminalError('cwd-outside-workspace', 'That folder is not inside the workspace.');
  }

  const target = path.resolve(realRoot, requested);
  let realTarget: string;
  try {
    realTarget = await deps.realpath(target);
  } catch {
    throw new TerminalError('cwd-outside-workspace', 'That folder could not be opened.');
  }
  if (!(await deps.isDirectory(realTarget))) {
    throw new TerminalError('cwd-outside-workspace', 'That folder could not be opened.');
  }

  const contained = realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
  if (!contained) {
    throw new TerminalError('cwd-outside-workspace', 'That folder is not inside the workspace.');
  }
  return realTarget;
}

/* ========================================================================== */
/* Bounded history                                                             */
/* ========================================================================== */

/**
 * A byte-capped (strictly, UTF-16-code-unit-capped) ring of output chunks.
 *
 * Trims from the front, slicing the oldest chunk rather than discarding it
 * whole so the cap is exact rather than approximate. Surrogate pairs are not
 * split — the trim point is advanced by one when it would land on a low
 * surrogate, which is the difference between "the top line is clipped" and "the
 * top line contains a replacement character forever".
 *
 * **Documented cost:** trimming can still cut an ANSI escape sequence in half.
 * xterm's parser discards an incomplete sequence, so the visible damage is
 * confined to the very first cells of replayed scrollback. Paying that is
 * cheaper than the alternatives (parsing escape sequences in main to find a
 * safe boundary, or keeping everything).
 */
export class RingBuffer {
  readonly limit: number;
  #chunks: string[] = [];
  #length = 0;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError('RingBuffer limit must be a positive integer');
    }
    this.limit = limit;
  }

  /** Current size, in UTF-16 code units. */
  get length(): number {
    return this.#length;
  }

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    this.#trim();
  }

  read(): string {
    if (this.#chunks.length > 1) {
      /* Collapse on read. Reads are rare (a re-attaching pane); pushes are
         constant. Doing the join here keeps the hot path a single array push. */
      const joined = this.#chunks.join('');
      this.#chunks = [joined];
      return joined;
    }
    return this.#chunks[0] ?? '';
  }

  clear(): void {
    this.#chunks = [];
    this.#length = 0;
  }

  #trim(): void {
    while (this.#length > this.limit) {
      const head = this.#chunks[0];
      if (head === undefined) {
        this.#length = 0;
        return;
      }
      const excess = this.#length - this.limit;
      if (head.length <= excess) {
        this.#chunks.shift();
        this.#length -= head.length;
        continue;
      }
      let cut = excess;
      if (isLowSurrogate(head.charCodeAt(cut))) cut += 1;
      if (cut >= head.length) {
        this.#chunks.shift();
        this.#length -= head.length;
        continue;
      }
      this.#chunks[0] = head.slice(cut);
      this.#length -= cut;
    }
  }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/* ========================================================================== */
/* node-pty seam                                                               */
/* ========================================================================== */

export interface PtyDisposable {
  dispose(): void;
}

/**
 * The subset of `node-pty`'s `IPty` this module uses.
 *
 * Declared structurally rather than imported so a unit test can supply a fake
 * without loading a native module, and so a `node-pty` API change surfaces here
 * as one type error rather than as a runtime failure inside a shutdown path
 * that only runs when the user quits.
 */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): PtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): PtyDisposable;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
  encoding: 'utf8';
  handleFlowControl: boolean;
}

export type PtySpawner = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

let cachedSpawner: PtySpawner | null = null;

/**
 * Load `node-pty` on first spawn rather than at import time.
 *
 * `node-pty` is a native addon. Importing it at module scope makes every test
 * of the pure functions above depend on a working native build for the exact
 * Electron ABI in use, and makes a rebuild failure surface as "the whole main
 * process failed to start" instead of "terminals are unavailable".
 */
async function defaultSpawner(): Promise<PtySpawner> {
  if (cachedSpawner) return cachedSpawner;
  const nodePty = await import('node-pty');
  cachedSpawner = nodePty.spawn as unknown as PtySpawner;
  return cachedSpawner;
}

/* ========================================================================== */
/* Manager                                                                     */
/* ========================================================================== */

/** What the manager needs to know about a workspace to open a terminal in it. */
export interface WorkspaceRoot {
  id: string;
  path: string;
  trusted: boolean;
}

export interface TerminalCreateOptions extends TerminalCreateRequest {
  /**
   * Who asked for this terminal. See the agent seam on `TerminalInputSchema`.
   * Reachable only from main; the IPC create schema has no such field.
   */
  origin?: TerminalOrigin | undefined;
  correlationId?: string | undefined;
}

export interface PtyManagerOptions {
  /**
   * Turn a workspace id into a root. Returning `null` — or a root with
   * `trusted: false` — refuses the terminal. The manager deliberately owns no
   * workspace state of its own; trust lives in one place.
   */
  resolveWorkspace: (
    workspaceId: string,
  ) => WorkspaceRoot | null | Promise<WorkspaceRoot | null>;
  /** Where output and exit events go. Typically `emitTo(window, …)`. */
  emit: (event: TerminalOutboundEvent) => void;

  appVersion?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;

  /* Injection seams. All optional; all defaulted to the real thing. */
  spawner?: PtySpawner;
  now?: () => Date;
  createId?: () => TerminalId;
  paths?: PathResolverDeps;
  isUsableShell?: (candidate: string) => boolean;
  killProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;

  flushIntervalMs?: number;
  historyLimitChars?: number;
  maxFlushChars?: number;
  pauseHighWaterChars?: number;
  killGraceMs?: number;
  maxTerminals?: number;

  /**
   * Install a `process.on('exit')` guard that SIGKILLs every tracked process
   * group. Defaults to `true`; tests pass `false`. This is the last line of
   * defence, not the first — see `shutdown()`.
   */
  guardProcessExit?: boolean;
}

interface TerminalRecord {
  id: TerminalId;
  workspaceId: string;
  title: string;
  cwd: string;
  shell: string;
  args: string[];
  origin: TerminalOrigin;
  cols: number;
  rows: number;
  createdAt: string;
  pty: PtyProcess | null;
  pid: number | null;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  history: RingBuffer;
  pending: string[];
  pendingChars: number;
  carriedTruncation: number;
  seq: number;
  flushTimer: NodeJS.Timeout | null;
  paused: boolean;
  subscriptions: PtyDisposable[];
  exitWaiters: Array<() => void>;
  /** `true` once a `kill` has claimed this record; the tab is going away. */
  releaseOnExit: boolean;
}

/**
 * Owns every pty in the application.
 *
 * One instance per application. Construct it after the workspace store exists
 * (it needs `resolveWorkspace`) and wire `shutdown()` into `before-quit`:
 *
 * ```ts
 * app.on('before-quit', (event) => {
 *   if (terminals.isShutdown) return;
 *   event.preventDefault();
 *   void terminals.shutdown().then(() => app.quit());
 * });
 * ```
 */
export class PtyManager {
  readonly #terminals = new Map<TerminalId, TerminalRecord>();
  readonly #inputObservers = new Set<(record: TerminalInputRecord) => void>();

  readonly #resolveWorkspace: PtyManagerOptions['resolveWorkspace'];
  readonly #emit: (event: TerminalOutboundEvent) => void;
  readonly #appVersion: string;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #platform: NodeJS.Platform;
  readonly #paths: PathResolverDeps;
  readonly #isUsableShell: (candidate: string) => boolean;
  readonly #killProcessGroup: (pgid: number, signal: NodeJS.Signals) => void;
  readonly #now: () => Date;
  readonly #createId: () => TerminalId;

  readonly #flushIntervalMs: number;
  readonly #historyLimitChars: number;
  readonly #maxFlushChars: number;
  readonly #pauseHighWaterChars: number;
  readonly #killGraceMs: number;
  readonly #maxTerminals: number;

  #injectedSpawner: PtySpawner | null;
  #exitGuard: (() => void) | null = null;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: PtyManagerOptions) {
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#emit = options.emit;
    this.#appVersion = options.appVersion ?? '0.0.0';
    this.#env = options.env ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#paths = options.paths ?? {
      realpath: (candidate) => fsRealpath(candidate),
      isDirectory: async (candidate) => {
        try {
          return (await stat(candidate)).isDirectory();
        } catch {
          return false;
        }
      },
    };
    this.#isUsableShell = options.isUsableShell ?? isExecutableFile;
    this.#killProcessGroup = options.killProcessGroup ?? killProcessGroupDefault;
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? (() => `term_${randomUUID()}` as TerminalId);
    this.#injectedSpawner = options.spawner ?? null;

    this.#flushIntervalMs = options.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.#historyLimitChars = options.historyLimitChars ?? HISTORY_LIMIT_CHARS;
    this.#maxFlushChars = options.maxFlushChars ?? MAX_FLUSH_CHARS;
    this.#pauseHighWaterChars = options.pauseHighWaterChars ?? PAUSE_HIGH_WATER_CHARS;
    this.#killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.#maxTerminals = options.maxTerminals ?? TERMINAL_LIMITS.maxTerminals;

    if (options.guardProcessExit ?? true) this.#installExitGuard();
  }

  get isShutdown(): boolean {
    return this.#shutdownPromise !== null;
  }

  /** Live and exited terminals currently held. */
  get size(): number {
    return this.#terminals.size;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async create(options: TerminalCreateOptions): Promise<TerminalSummary> {
    if (this.isShutdown) {
      throw new TerminalError('shutting-down', 'Juno is shutting down.');
    }
    if (this.#liveCount() >= this.#maxTerminals) {
      throw new TerminalError(
        'too-many-terminals',
        `You can have ${this.#maxTerminals} terminals open at once. Close one first.`,
      );
    }

    const workspace = await this.#resolveWorkspace(options.workspaceId);
    if (!workspace) {
      throw new TerminalError('workspace-not-found', 'That workspace could not be found.');
    }
    if (!workspace.trusted) {
      throw new TerminalError(
        'workspace-untrusted',
        'Trust this workspace before opening a terminal in it.',
      );
    }

    const cwd = await resolveContainedCwd(workspace.path, options.cwd, this.#paths);
    const shell = resolveLoginShell(this.#env, this.#platform, this.#isUsableShell);
    const env = buildTerminalEnvironment(this.#env, { cwd, appVersion: this.#appVersion });

    const id = this.#createId();
    const record: TerminalRecord = {
      id,
      workspaceId: workspace.id,
      title: options.title ?? path.basename(cwd),
      cwd,
      shell: shell.file,
      args: shell.args,
      origin: options.origin ?? 'user',
      cols: options.cols,
      rows: options.rows,
      createdAt: this.#now().toISOString(),
      pty: null,
      pid: null,
      status: 'running',
      exitCode: null,
      signal: null,
      history: new RingBuffer(this.#historyLimitChars),
      pending: [],
      pendingChars: 0,
      carriedTruncation: 0,
      seq: 0,
      flushTimer: null,
      paused: false,
      subscriptions: [],
      exitWaiters: [],
      releaseOnExit: false,
    };

    await this.#spawnInto(record, env);
    this.#terminals.set(id, record);
    return this.#summarise(record, false);
  }

  /**
   * Replace the shell behind an existing tab, keeping its id.
   *
   * The workspace is re-resolved rather than reused: trust can be revoked while
   * a terminal is open, and a restart is a new `execve` — it must not be an
   * easier way to get a shell than `create` was.
   */
  async restart(request: TerminalRestartRequest): Promise<TerminalSummary> {
    if (this.isShutdown) throw new TerminalError('shutting-down', 'Juno is shutting down.');

    const record = this.#require(request.terminalId);
    if (record.status === 'running') {
      await this.#terminate(record, 'SIGHUP');
    }

    const workspace = await this.#resolveWorkspace(record.workspaceId);
    if (!workspace) {
      throw new TerminalError('workspace-not-found', 'That workspace could not be found.');
    }
    if (!workspace.trusted) {
      throw new TerminalError(
        'workspace-untrusted',
        'Trust this workspace before opening a terminal in it.',
      );
    }
    const cwd = await resolveContainedCwd(workspace.path, record.cwd, this.#paths);
    const shell = resolveLoginShell(this.#env, this.#platform, this.#isUsableShell);
    const env = buildTerminalEnvironment(this.#env, { cwd, appVersion: this.#appVersion });

    /* Drop the dead process's listeners and buffers before the new one is
       attached. Without this, `#spawnInto` overwrites `subscriptions` and the
       old disposables are never called — one leaked emitter per restart. */
    this.#cleanup(record);

    record.cwd = cwd;
    record.shell = shell.file;
    record.args = shell.args;
    record.status = 'running';
    record.exitCode = null;
    record.signal = null;
    record.releaseOnExit = false;
    record.createdAt = this.#now().toISOString();
    record.carriedTruncation = 0;
    record.paused = false;
    /* `seq` is deliberately NOT reset. It is monotonic for the lifetime of the
       id, so a renderer that uses it to detect a gap cannot be fooled by a
       restart into reading a fresh sequence as a rewind. */

    await this.#spawnInto(record, env);
    /* Re-inserted rather than assumed present: a concurrent `kill` may have
       released it while the old process was being reaped. */
    this.#terminals.set(record.id, record);
    return this.#summarise(record, false);
  }

  /**
   * Terminate a terminal and release its record.
   *
   * Idempotent. On an already-exited terminal this is just the release, which
   * is how a tab for a shell the user exited manually is finally dropped.
   */
  async kill(request: TerminalKillRequest): Promise<void> {
    const record = this.#terminals.get(request.terminalId);
    if (!record) return;

    record.releaseOnExit = true;
    if (record.status === 'exited') {
      this.#cleanup(record);
      this.#terminals.delete(record.id);
      return;
    }
    await this.#terminate(record, request.signal);
  }

  /* ---------------------------------------------------------------------- */
  /* I/O                                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * Write to a terminal's stdin.
   *
   * Validated with `TerminalInputSchema` even though the caller is in-process:
   * agent tool arguments originate in a separate OS process and are untrusted
   * regardless of what the type system believes at this call site.
   *
   * `origin`/`correlationId` are attribution only — see the agent seam note on
   * `TerminalInputSchema`. Permission checks belong *before* this call.
   */
  write(input: TerminalInputInit): void {
    const parsed = TerminalInputSchema.parse(input);
    const record = this.#require(parsed.terminalId);
    if (record.status !== 'running' || !record.pty) {
      throw new TerminalError('terminal-exited', 'That terminal is no longer running.');
    }

    record.pty.write(parsed.data);

    const observed: TerminalInputRecord = {
      terminalId: parsed.terminalId,
      data: parsed.data,
      origin: parsed.origin,
      correlationId: parsed.correlationId,
      at: this.#now().toISOString(),
    };
    for (const observer of this.#inputObservers) {
      try {
        observer(observed);
      } catch (error) {
        console.error('[terminal] input observer threw:', error);
      }
    }
  }

  resize(request: TerminalResizeRequest): void {
    const record = this.#require(request.terminalId);
    record.cols = request.cols;
    record.rows = request.rows;
    if (record.status !== 'running' || !record.pty) return;
    try {
      record.pty.resize(request.cols, request.rows);
    } catch (error) {
      /* A resize racing an exit throws `EBADF`. Not worth surfacing: the exit
         event is already on its way and the grid is about to be irrelevant. */
      console.warn('[terminal] resize failed:', error);
    }
  }

  list(request: TerminalListRequest = { includeHistory: false }): TerminalSummary[] {
    return [...this.#terminals.values()].map((record) =>
      this.#summarise(record, request.includeHistory),
    );
  }

  /**
   * Observe every write, with attribution.
   *
   * This is the seam the activity system consumes: it receives `origin`,
   * `correlationId` and the bytes, and decides what to record. Returns an
   * unsubscribe function.
   */
  onInput(observer: (record: TerminalInputRecord) => void): () => void {
    this.#inputObservers.add(observer);
    return () => {
      this.#inputObservers.delete(observer);
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Shutdown                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Kill everything, politely and then not.
   *
   * SIGHUP+SIGTERM to each child's **process group**, then SIGKILL to any group
   * still alive after the grace period. The group, not the pid: `node-pty`
   * calls `setsid()` in the child, so the shell is a session and process-group
   * leader and `kill(-pid)` reaches it and anything sharing its group. An
   * interactive shell receiving SIGHUP also hangs up its own jobs, and closing
   * the pty master makes the kernel send SIGHUP to the foreground group — three
   * overlapping mechanisms, which is what it takes for "no orphan shells" to be
   * true rather than aspirational.
   *
   * **What still survives, by design:** a process the user explicitly detached
   * (`nohup`, `disown`, anything that called `setsid` for itself) is in another
   * session and is not reachable from the shell's group. Killing it would be
   * overriding an explicit instruction from the user, so the manager does not
   * try. That is the only category, and it is stated here rather than papered
   * over.
   *
   * Idempotent, and safe to await from `before-quit`.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;

    this.#shutdownPromise = (async () => {
      const records = [...this.#terminals.values()];
      for (const record of records) {
        record.releaseOnExit = true;
        this.#flush(record);
        /* SIGHUP *and* SIGTERM, not SIGTERM alone.
         *
         * An interactive shell ignores SIGTERM — measured against `/bin/zsh -l`
         * on a pty: SIGTERM to the process group produced no exit at all after
         * 2.5s, while SIGHUP exited immediately and took its background jobs
         * with it. A SIGTERM-only first phase therefore does not shut anything
         * down; it just makes every quit wait out the full grace period before
         * the SIGKILL that was always going to be required, which the user
         * experiences as the app hanging on Cmd-Q.
         *
         * SIGHUP is also the semantically right signal: it is what the kernel
         * sends when a controlling terminal goes away, so a shell responds to
         * it by hanging up its jobs — which is exactly the orphan case. SIGTERM
         * is still sent for anything in the group that is not a shell and does
         * handle it properly. */
        this.#signal(record, 'SIGHUP');
        this.#signal(record, 'SIGTERM');
      }

      await Promise.all(records.map((record) => this.#awaitExit(record, this.#killGraceMs)));

      const survivors = records.filter((record) => record.status === 'running');
      for (const record of survivors) {
        console.warn(`[terminal] ${record.id} ignored SIGHUP/SIGTERM; escalating to SIGKILL`);
        this.#signal(record, 'SIGKILL');
      }
      await Promise.all(survivors.map((record) => this.#awaitExit(record, this.#killGraceMs)));

      /* Anything still marked running never reported an exit. Force the record
         closed so the map is empty and the exit guard has nothing left to do —
         a tracked-but-unreapable pid is exactly the state that produces the
         "Juno is still running" ghost in Activity Monitor. */
      for (const record of records) {
        if (record.status === 'running') this.#forceExited(record, -1, null);
        this.#cleanup(record);
      }
      this.#terminals.clear();
      this.#removeExitGuard();
    })();

    return this.#shutdownPromise;
  }

  /**
   * Synchronous, unconditional SIGKILL of every tracked group.
   *
   * For `process.on('exit')`, where no asynchronous work can run. This is the
   * backstop for a main process that is going away without a clean quit; the
   * clean path is `shutdown()`.
   */
  killAllImmediately(): void {
    for (const record of this.#terminals.values()) {
      if (record.pid === null) continue;
      try {
        this.#killProcessGroup(record.pid, 'SIGKILL');
      } catch {
        /* Nothing useful can be done from inside an exit handler. */
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  async #spawnInto(record: TerminalRecord, env: Record<string, string>): Promise<void> {
    const spawner = this.#injectedSpawner ?? (await defaultSpawner());

    let pty: PtyProcess;
    try {
      pty = spawner(record.shell, record.args, {
        name: 'xterm-256color',
        cols: record.cols,
        rows: record.rows,
        cwd: record.cwd,
        env,
        encoding: 'utf8',
        /* Left off deliberately. node-pty's flow control intercepts XOFF/XON in
           the *write* stream, which would swallow the user's Ctrl+S. Our
           backpressure is `pause()`/`resume()` on the read side instead. */
        handleFlowControl: false,
      });
    } catch (error) {
      console.error('[terminal] spawn failed:', error);
      throw new TerminalError('spawn-failed', 'That terminal could not be started.');
    }

    record.pty = pty;
    record.pid = pty.pid;
    record.subscriptions = [
      pty.onData((data) => {
        this.#ingest(record, data);
      }),
      pty.onExit(({ exitCode, signal }) => {
        this.#handleExit(record, exitCode, signal ?? null);
      }),
    ];
  }

  #ingest(record: TerminalRecord, data: string): void {
    if (data.length === 0) return;
    record.history.push(data);
    record.pending.push(data);
    record.pendingChars += data.length;

    /* Real backpressure. Stop draining the master fd; the tty buffer fills and
       the child blocks in `write(2)`. Resumed by the next flush, which gives a
       flood a bounded duty cycle instead of an unbounded queue. */
    if (!record.paused && record.pendingChars >= this.#pauseHighWaterChars && record.pty) {
      try {
        record.pty.pause();
        record.paused = true;
      } catch {
        /* Exited between the data event and here. */
      }
    }

    if (record.flushTimer === null) {
      record.flushTimer = setTimeout(() => {
        record.flushTimer = null;
        this.#flush(record);
      }, this.#flushIntervalMs);
      record.flushTimer.unref?.();
    }
  }

  #flush(record: TerminalRecord): void {
    if (record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }

    if (record.pending.length === 0) {
      this.#resumeIfPaused(record);
      return;
    }

    let chunk = record.pending.join('');
    record.pending = [];
    record.pendingChars = 0;

    let truncated = record.carriedTruncation;
    record.carriedTruncation = 0;

    if (chunk.length > this.#maxFlushChars) {
      let cut = chunk.length - this.#maxFlushChars;
      if (isLowSurrogate(chunk.charCodeAt(cut))) cut += 1;
      truncated += cut;
      chunk = TRUNCATION_RESYNC + chunk.slice(cut);
    }

    record.seq += 1;
    this.#emit({
      channel: 'terminal:output',
      payload: {
        terminalId: record.id,
        seq: record.seq,
        chunk,
        truncatedChars: truncated,
      },
    });

    this.#resumeIfPaused(record);
  }

  #resumeIfPaused(record: TerminalRecord): void {
    if (!record.paused) return;
    record.paused = false;
    try {
      record.pty?.resume();
    } catch {
      /* Exited while paused; nothing to resume. */
    }
  }

  #handleExit(record: TerminalRecord, exitCode: number, signal: number | null): void {
    if (record.status === 'exited') return;

    /* Deliver whatever the process wrote on its way out *before* announcing the
       exit. A shell's last line is often the only explanation of why it died. */
    this.#flush(record);
    this.#forceExited(record, exitCode, signal);
  }

  #forceExited(record: TerminalRecord, exitCode: number, signal: number | null): void {
    record.status = 'exited';
    record.exitCode = exitCode;
    record.signal = signal;
    record.pty = null;
    record.pid = null;

    const released = record.releaseOnExit;
    if (released) this.#terminals.delete(record.id);

    this.#emit({
      channel: 'terminal:exit',
      payload: {
        terminalId: record.id,
        exitCode,
        signal,
        released,
        at: this.#now().toISOString(),
      },
    });

    /* A released record is never read again, so its history and its listeners
       go now rather than at the next shutdown. An *unreleased* one keeps both:
       the tab is still on screen offering a restart, and the scrollback of the
       run that just died is the whole reason the user is looking at it. */
    if (released) this.#cleanup(record);

    const waiters = record.exitWaiters;
    record.exitWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /** SIGTERM, wait, SIGKILL. Resolves once the process is gone or forced gone. */
  async #terminate(record: TerminalRecord, signal: TerminalSignal): Promise<void> {
    this.#signal(record, signal);
    if (await this.#awaitExit(record, this.#killGraceMs)) return;

    console.warn(`[terminal] ${record.id} ignored ${signal}; escalating to SIGKILL`);
    this.#signal(record, 'SIGKILL');
    if (await this.#awaitExit(record, this.#killGraceMs)) return;

    console.error(`[terminal] ${record.id} survived SIGKILL; releasing the record`);
    this.#forceExited(record, -1, null);
    this.#cleanup(record);
  }

  #signal(record: TerminalRecord, signal: NodeJS.Signals): void {
    const pid = record.pid;
    if (pid === null) return;
    try {
      this.#killProcessGroup(pid, signal);
    } catch (error) {
      console.warn(`[terminal] failed to signal group ${pid}:`, error);
    }
  }

  /** Resolves `true` if the record reached `exited` within `ms`. */
  #awaitExit(record: TerminalRecord, ms: number): Promise<boolean> {
    if (record.status === 'exited') return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, ms);
      timer.unref?.();
      record.exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  #cleanup(record: TerminalRecord): void {
    if (record.flushTimer !== null) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    for (const subscription of record.subscriptions) {
      try {
        subscription.dispose();
      } catch {
        /* Already disposed by node-pty's own teardown. */
      }
    }
    record.subscriptions = [];
    record.history.clear();
    record.pending = [];
    record.pendingChars = 0;
  }

  #require(id: TerminalId): TerminalRecord {
    const record = this.#terminals.get(id);
    if (!record) throw new TerminalError('unknown-terminal', 'That terminal is no longer open.');
    return record;
  }

  #liveCount(): number {
    let count = 0;
    for (const record of this.#terminals.values()) {
      if (record.status === 'running') count += 1;
    }
    return count;
  }

  #summarise(record: TerminalRecord, includeHistory: boolean): TerminalSummary {
    const summary: TerminalSummary = {
      id: record.id,
      workspaceId: record.workspaceId,
      title: record.title,
      cwd: record.cwd,
      shell: record.shell,
      pid: record.pid,
      cols: record.cols,
      rows: record.rows,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      createdAt: record.createdAt,
      historyChars: record.history.length,
    };
    return includeHistory ? { ...summary, history: record.history.read() } : summary;
  }

  #installExitGuard(): void {
    if (this.#exitGuard) return;
    const guard = (): void => {
      this.killAllImmediately();
    };
    this.#exitGuard = guard;
    /* `exit` only. Adding a `SIGTERM`/`SIGINT` listener would *replace* Node's
       default terminate-on-signal behaviour and leave the app unkillable from a
       terminal, which trades one orphan problem for a worse one. */
    process.on('exit', guard);
  }

  #removeExitGuard(): void {
    if (!this.#exitGuard) return;
    process.off('exit', this.#exitGuard);
    this.#exitGuard = null;
  }
}

/**
 * Signal a process **group**.
 *
 * `process.kill(-pid)` is the group form. Falls back to the bare pid, which
 * matters on any platform where the child did not become a group leader — there
 * the negative form is simply not a valid target and silently signalling
 * nothing would be the worst outcome available.
 *
 * `ESRCH` means it is already gone, which is success.
 */
function killProcessGroupDefault(pgid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
    return;
  } catch {
    /* Fall through to the single-process form. */
  }
  try {
    process.kill(pgid, signal);
  } catch {
    /* Gone. */
  }
}
