import { createHash } from 'node:crypto';
import type { ToolContext, ToolResult } from '../tools/types.js';
import type {
  WorkProvenance,
  WorkRiskLevel,
  WorkToolDefinition,
  WorkToolPoint,
  WorkToolPreview,
  WorkToolPreviewContext,
  WorkToolResult,
} from './types.js';

export const REMOTE_TOOL_NAMES = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_wait',
  'computer_zoom',
  'computer_shell',
  'computer_files',
] as const;

export type RemoteComputerToolName = (typeof REMOTE_TOOL_NAMES)[number];

export interface ComputerShotData {
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
  /**
   * A cheap fingerprint of the frame (the provider's sha256 of the JPEG).
   * Settling compares it between captures; absent, the bytes are compared.
   */
  hash?: string;
}

export interface ComputerExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface ComputerFileEntryItem {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'other';
  size?: number;
}

/** A step's screenshot as the platform stored it. */
export interface ComputerStoredFrame {
  ref: string;
  width: number;
  height: number;
  /** Where an approval card can load it from, when the host knows. */
  src?: string;
}

/**
 * What sits under a point (or has focus) in the browser in front, in words:
 * the role, the name a person would read, and the site. Page content, so it
 * is untrusted, and only ever used in sentences shown to the person.
 */
export interface ComputerPointTarget {
  role: string;
  name: string;
  host: string;
}

export interface ComputerZoomRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerToolsDeps {
  isHealthy(): boolean;
  /**
   * Why the computer may not be used right now, or null when it may. The
   * server answers "the person has control" while a takeover is active: every
   * tool refuses before touching the screen, the keyboard, the shell or the
   * files, and a screenshot captured as a takeover began is thrown away rather
   * than shown to the model. Optional so a caller without takeovers (tests, a
   * provider that has none) keeps working.
   */
  blockedReason?(): Promise<string | null> | string | null;
  /**
   * How many takeovers have ever started on this computer. Read before and
   * after every call: a changed value means a takeover overlapped the call
   * (even one that began and ended inside it) and the result is discarded.
   */
  takeoverEpoch?(): Promise<number | null> | number | null;
  pageTakesPayment(): boolean;
  currentUrl(): string;
  screenEpoch(): number;
  screenshot(): Promise<ComputerShotData>;
  click(opts: { x: number; y: number; button?: 'left' | 'right' | 'double' }): Promise<ComputerShotData>;
  type(text: string): Promise<ComputerShotData>;
  key(keys: string): Promise<ComputerShotData>;
  scroll(opts: { x: number; y: number; direction: 'up' | 'down'; amount: number }): Promise<ComputerShotData>;
  /** Press at (x1, y1), move to (x2, y2), release. Absent: `computer_drag` says so. */
  drag?(opts: { x1: number; y1: number; x2: number; y2: number }): Promise<ComputerShotData>;
  /** A region of a fresh screenshot, cropped and enlarged. Absent: `computer_zoom` says so. */
  zoom?(region: ComputerZoomRegion): Promise<ComputerShotData>;
  /**
   * Runs a command. `callId` is the provider's id for this call, so the host
   * can stream the output to the person's terminal pane under it (S5.1); the
   * outcome is the same whether it does or not.
   */
  exec(command: string, opts: { timeoutSeconds: number; cwd?: string; callId?: string }): Promise<ComputerExecOutcome>;
  listFiles(path: string): Promise<ComputerFileEntryItem[]>;
  /**
   * At most `maxBytes` of a file, as its bytes (S5.2). A string is read as
   * UTF-8 text already decoded (an older host).
   */
  readFile(path: string, maxBytes: number): Promise<Uint8Array | string>;
  /** Writes these bytes, exactly. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** A file's size, for the sentence about a binary file. Optional. */
  fileSize?(path: string): Promise<number | null>;
  /**
   * Hands a file on the computer to the person as a deliverable of this run
   * (`computer_files` publish, S5.3). Absent: publishing says it is not
   * available here.
   */
  publish?(request: { path: string; title?: string }): Promise<{ ok: true; detail: string } | { ok: false; message: string }>;
  /**
   * Keeps one step's screenshot for the filmstrip and the approval card, or
   * returns null when it was not kept (no storage, or the run's cap). Only
   * ever called with a frame the takeover fence has already passed.
   */
  storeFrame?(ref: string, shot: ComputerShotData): Promise<ComputerStoredFrame | null>;
  /** The element under a screen point when Chromium is in front, else null. */
  describePoint?(x: number, y: number): Promise<ComputerPointTarget | null>;
  /** The focused element when Chromium is in front, else null. */
  describeFocus?(): Promise<ComputerPointTarget | null>;
  /**
   * Waiting for the screen to stop changing after an action. `false` turns it
   * off; the defaults are `SETTLE_TIMEOUT_MS` and `SETTLE_INTERVAL_MS`.
   */
  settle?: false | { timeoutMs?: number; intervalMs?: number };
  /** Injected clock and pause, for tests. */
  now?(): number;
  pause?(ms: number, signal?: AbortSignal): Promise<void>;
}

const MAX_SHELL_OUTPUT_CHARS = 20_000;
const MAX_FILE_READ_BYTES = 200 * 1024;
/** The most `computer_files` writes in one call, after decoding. */
const MAX_FILE_WRITE_BYTES = 25 * 1024 * 1024;
const SCREEN_WIDTH = 1280;
const SCREEN_HEIGHT = 800;

/** How long a step waits, at most, for the screen to stop changing. */
export const SETTLE_TIMEOUT_MS = 500;
/** The gap between two settling captures. */
export const SETTLE_INTERVAL_MS = 100;
/** `computer_wait`'s ceiling. */
export const MAX_WAIT_SECONDS = 10;
/** How long a semantic description may take before the sentence falls back to coordinates. */
const DESCRIBE_TIMEOUT_MS = 800;

function siteHostname(rawUrl: string): string {
  if (!rawUrl) return "the agent's desktop";
  try {
    const u = new URL(rawUrl);
    return u.hostname || "the agent's desktop";
  } catch {
    return "the agent's desktop";
  }
}

function boundSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

function sanitizeCommandPreview(raw: string): string {
  // Strip any http(s) URLs with query strings or tokens from approval summaries, leaving hostname only
  return raw
    .replace(/https?:\/\/[^\s"'`]+/gi, (match) => {
      try {
        const u = new URL(match);
        return u.hostname || '[url]';
      } catch {
        return '[url]';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How many bytes at the end are the start of a UTF-8 character the read cut
 * off (0 when the last character is whole), so a cut never reads as binary.
 */
function cutCharacterBytes(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** The text in these bytes, or null when they are not text (not valid UTF-8, or a NUL in them). */
export function decodeTextFile(bytes: Uint8Array, cut: boolean): string | null {
  const body = cut ? bytes.subarray(0, bytes.length - cutCharacterBytes(bytes)) : bytes;
  if (body.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

/** "512 bytes", "88 KB", "1.4 MB". */
export function formatFileBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Base64 as the model wrote it, checked strictly (whitespace allowed), or null. */
function decodeBase64(raw: string): Uint8Array | null {
  const clean = raw.replace(/\s+/g, '');
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

function capShellStream(label: string, value: string): string {
  if (value.length <= MAX_SHELL_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n[${label} cut off at ${MAX_SHELL_OUTPUT_CHARS} characters]`;
}

/**
 * The name a frame is stored under: the call id, made safe for a storage key
 * and a URL segment (letters, digits, `_` and `-`), with an optional suffix.
 * Null when nothing usable is left.
 */
export function computerFrameRef(callId: string, suffix?: 'pre'): string | null {
  const base = callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  if (!/[A-Za-z0-9]/.test(base)) return null;
  return suffix ? `${base}-${suffix}` : base;
}

function shotFingerprint(shot: ComputerShotData): string {
  return shot.hash ?? shot.data;
}

/** FNV-1a over a string, as 8 hex digits: a short stand-in for a frame with no hash. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function defaultPause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export interface SettledShot {
  shot: ComputerShotData;
  /** From the first frame to the one returned: pauses and polling captures. */
  settleMs: number;
  /** How long the last polling capture took (0 when none ran). */
  captureMs: number;
  /** Whether two captures agreed before the cap. */
  stable: boolean;
}

/**
 * The frame after the screen has stopped changing: two consecutive captures
 * that agree, or whatever the screen shows when the cap runs out
 * (ScreenControlService.settledCapture does the same on the Mac).
 *
 * The first frame is the one the action already returned, so a screen that
 * was still at the first look costs one extra capture and one pause. The cap
 * is what keeps an animated page (a spinner, a video) from holding the step.
 */
export async function settleScreen(
  first: ComputerShotData,
  opts: {
    capture: () => Promise<ComputerShotData>;
    now?: () => number;
    pause?: (ms: number, signal?: AbortSignal) => Promise<void>;
    timeoutMs?: number;
    intervalMs?: number;
    signal?: AbortSignal;
  },
): Promise<SettledShot> {
  const now = opts.now ?? Date.now;
  const pause = opts.pause ?? defaultPause;
  const timeoutMs = Math.max(0, opts.timeoutMs ?? SETTLE_TIMEOUT_MS);
  const intervalMs = Math.max(1, opts.intervalMs ?? SETTLE_INTERVAL_MS);
  const started = now();
  const deadline = started + timeoutMs;
  let previous = first;
  let captureMs = 0;
  while (now() < deadline) {
    if (opts.signal?.aborted) break;
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())), opts.signal);
    const before = now();
    let next: ComputerShotData;
    try {
      next = await opts.capture();
    } catch {
      // The action has already happened and returned a frame. A settling
      // capture that fails must not turn the step into an error: the model
      // would read "Tool crashed", assume the click never landed and press
      // the same button again. The last good frame stands.
      break;
    }
    captureMs = now() - before;
    if (shotFingerprint(next) === shotFingerprint(previous)) {
      return { shot: next, settleMs: now() - started, captureMs, stable: true };
    }
    previous = next;
  }
  return { shot: previous, settleMs: now() - started, captureMs, stable: false };
}

/**
 * Keys `computer_key` presses without the approval a typing tool needs: the
 * ones that move around or confirm and produce no text. Anything else (a
 * letter, a digit, a paste shortcut, `ctrl+alt+t` for a terminal) can type
 * text one key at a time, which is `computer_type` by another name, so it
 * takes `computer_type`'s risk: it asks every time.
 */
const NAVIGATION_KEYS = new Set(
  [
    // Return, Enter and Space are deliberately absent: they press the focused
    // button or send the focused form, which is how a pixel agent would get
    // past the browser tool's submit rule (security audit, computer gap 6).
    'tab', 'shift+tab', 'escape', 'esc',
    'up', 'down', 'left', 'right',
    'page_up', 'page_down', 'prior', 'next', 'pageup', 'pagedown',
    'home', 'end', 'backspace', 'delete',
    'f5', 'ctrl+l', 'ctrl+r', 'alt+left', 'alt+right',
  ].map((key) => key.toLowerCase())
);

/** Whether a `computer_key` press is navigation only (see `NAVIGATION_KEYS`). */
export function isNavigationKeypress(raw: string): boolean {
  const keys = raw
    .split(/\s+/)
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean);
  return keys.length > 0 && keys.every((key) => NAVIGATION_KEYS.has(key));
}

/**
 * Where `computer_files` may write without it being a way to run code: under
 * /home/agent/work, and never into a dot-directory or a dotfile. Writing
 * `~/.bashrc`, `~/.config/autostart/*.desktop` or `~/.profile` would run
 * whatever the model wrote the next time a shell or the desktop starts, with
 * no approval; those writes are refused outright.
 */
export function isSafeComputerWritePath(raw: string): boolean {
  const path = raw.trim();
  if (!path || /[\0\r\n]/.test(path)) return false;
  const absolute = path.startsWith('/') ? path : `/home/agent/work/${path}`;
  const parts = absolute.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) return false;
  if (parts.length < 4 || parts[0] !== 'home' || parts[1] !== 'agent' || parts[2] !== 'work') return false;
  return !parts.slice(3).some((part) => part.startsWith('.'));
}

/**
 * The risk of a tool that can run arbitrary code or type into pages
 * (`computer_shell`, `computer_type`, a text-producing `computer_key`).
 *
 * `sensitive`, never `command`. A shell has no action labels, so a
 * `curl -X POST` that sends mail or pays is `work.computer.shell`, never
 * `work.connector.send_message`: the always-confirm floor, which is enforced on
 * labels, cannot see it. `sensitive` asks under every approval mode, Skip
 * included, and can never be covered by "Always allow"
 * (`mayBeCoveredByStandingAllowance` stops at `command`, and the session only
 * remembers `allowed_always` below `sensitive`). So each call is put to the
 * person, every time.
 */
export const ARBITRARY_CODE_RISK: WorkRiskLevel = 'sensitive';

/** Mirrors TAKEOVER_OVERLAP_REFUSAL in src/lib/computer/takeover.ts. */
export const TAKEOVER_OVERLAP_TEXT =
  'The person took control of this computer while that was running, so its result was discarded. Look at the screen again before carrying on.';

/** Said when the element an approval named is no longer the one under the point. */
export const TARGET_CHANGED_TEXT =
  'The screen changed after this was approved, so the target is no longer the one the person agreed to. Nothing was done. Look at the screen again and ask again if it is still needed.';

const ROLE_NOUNS: Record<string, string> = {
  button: 'button',
  link: 'link',
  textbox: 'field',
  searchbox: 'search field',
  combobox: 'menu',
  listbox: 'list',
  option: 'option',
  checkbox: 'checkbox',
  radio: 'option',
  switch: 'switch',
  tab: 'tab',
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  slider: 'slider',
  heading: 'heading',
  img: 'image',
  image: 'image',
  password: 'password field',
};

/** A page-supplied name made safe to quote in one sentence. */
function cleanTargetName(raw: string): string {
  const clean = raw
    // Control and bidi-override characters never reach a sentence.
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/[“”"]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > 60 ? `${clean.slice(0, 57).trimEnd()}...` : clean;
}

function cleanHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.') ? host : null;
}

/** "the “Sign in” button", "the search field", or null when there is nothing to name. */
function targetPhrase(target: ComputerPointTarget): string | null {
  const name = cleanTargetName(target.name ?? '');
  const noun = ROLE_NOUNS[(target.role ?? '').toLowerCase()];
  if (name && noun) return `the “${name}” ${noun}`;
  if (name) return `“${name}”`;
  if (noun === 'password field') return 'the password field';
  return null;
}

/** "Click the “Sign in” button on example.com", or null to fall back. */
export function describeClickTarget(
  button: 'left' | 'right' | 'double',
  target: ComputerPointTarget | null,
): string | null {
  if (!target) return null;
  const phrase = targetPhrase(target);
  const host = cleanHost(target.host ?? '');
  if (!phrase || !host) return null;
  const verb = button === 'double' ? 'Double-click' : button === 'right' ? 'Right-click' : 'Click';
  return boundSummary(`${verb} ${phrase} on ${host}`);
}

/**
 * What typed text's line breaks will do, said before the target so a long
 * sentence can never cut it off. `xdotool type` presses Return for each one,
 * which sends the form or runs the line in a terminal; the approval card's
 * body shows the text, but a trailing line break is invisible there.
 */
export function typedReturnsPhrase(text: string): string {
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  if (breaks === 0) return '';
  if (breaks === 1) return /(?:\r\n|\r|\n)$/.test(text) ? ', ending with Return,' : ', including a Return,';
  return `, including ${breaks} Returns,`;
}

function typedCount(length: number, text: string): string {
  return `${length} ${length === 1 ? 'character' : 'characters'}${typedReturnsPhrase(text)}`;
}

/** "Type 12 characters into the “Search” field on example.com", or null. */
export function describeTypeTarget(length: number, target: ComputerPointTarget | null, text = ''): string | null {
  if (!target) return null;
  const phrase = targetPhrase(target);
  const host = cleanHost(target.host ?? '');
  if (!phrase || !host) return null;
  return boundSummary(`Type ${typedCount(length, text)} into ${phrase} on ${host}`);
}

function targetKey(target: ComputerPointTarget | null): string | null {
  if (!target) return null;
  return `${(target.role ?? '').toLowerCase()}|${cleanTargetName(target.name ?? '')}|${cleanHost(target.host ?? '') ?? ''}`;
}

function clampX(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(SCREEN_WIDTH, Math.round(Number(value ?? fallback)) || 0));
}

function clampY(value: unknown, fallback = 0): number {
  return Math.max(0, Math.min(SCREEN_HEIGHT, Math.round(Number(value ?? fallback)) || 0));
}

function clickButton(raw: unknown): 'left' | 'right' | 'double' {
  const value = String(raw ?? 'left');
  return value === 'right' || value === 'double' ? value : 'left';
}

/** An inner tool's result, with the frame it saw for the fence to keep. */
type InnerResult = WorkToolResult & { shot?: ComputerShotData };

export function computerTools(deps: ComputerToolsDeps): WorkToolDefinition[] {
  const now = () => (deps.now ? deps.now() : Date.now());
  const pause = (ms: number, signal?: AbortSignal) => (deps.pause ?? defaultPause)(ms, signal);

  const blockedText = async (): Promise<string | null> =>
    deps.blockedReason ? await deps.blockedReason() : null;
  const blocked = async (): Promise<ToolResult | null> => {
    const reason = await blockedText();
    return reason ? { output: reason, isError: true } : null;
  };
  const epoch = async (): Promise<number | null> => (deps.takeoverEpoch ? await deps.takeoverEpoch() : null);
  const overlapped = (before: number | null, after: number | null) =>
    before !== null && after !== null && before !== after;

  /** Swallows a failed store: a frame is a record of the step, never a reason to fail it. */
  const keepFrame = async (ref: string | null, shot: ComputerShotData) => {
    if (!ref || !deps.storeFrame) return null;
    try {
      return await deps.storeFrame(ref, shot);
    } catch {
      return null;
    }
  };

  // Every tool: refuse before acting while blocked, and refuse after acting
  // if a takeover began mid-call, so what the screen showed at the moment the
  // person took over never reaches the model — or storage. The frame is kept
  // only after both checks pass, which is the same fence: a frame captured
  // while the person held control is discarded with the result it came with.
  // Part of each tool's own implementation, not a dispatch site: the session's
  // `executeToolCall` still gates every call before it reaches this execute.
  const guarded = (definition: WorkToolDefinition): WorkToolDefinition => ({
    ...definition,
    async execute(input, ctx): Promise<WorkToolResult> {
      const before = await blocked();
      if (before) return before;
      const epochBefore = await epoch();
      const { shot, ...result } = (await definition.execute(input, ctx)) as InnerResult;
      const after = await blocked();
      if (after) return after;
      const epochAfter = await epoch();
      if (overlapped(epochBefore, epochAfter)) {
        return { output: TAKEOVER_OVERLAP_TEXT, isError: true };
      }
      if (shot && !result.isError && ctx.callId) {
        const frame = await keepFrame(computerFrameRef(ctx.callId), shot);
        if (frame) result.frame = { ref: frame.ref, width: frame.width, height: frame.height };
      }
      return result;
    },
  });

  /** After an action: the settled frame, as the model's image and the step's frame. */
  const settled = async (first: ComputerShotData, ctx: ToolContext) => {
    if (deps.settle === false) return { shot: first, settleMs: 0, captureMs: 0, stable: false };
    return settleScreen(first, {
      capture: () => deps.screenshot(),
      now,
      pause,
      ...(deps.settle?.timeoutMs !== undefined ? { timeoutMs: deps.settle.timeoutMs } : {}),
      ...(deps.settle?.intervalMs !== undefined ? { intervalMs: deps.settle.intervalMs } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  };

  const visual = (output: string, step: SettledShot): InnerResult => ({
    output,
    images: [{ mediaType: step.shot.mediaType, data: step.shot.data }],
    shot: seen(step.shot),
    settleMs: step.settleMs,
    captureMs: step.captureMs,
  });

  /** A description that took too long or failed is no description. */
  const describe = async (
    run: (() => Promise<ComputerPointTarget | null>) | undefined,
  ): Promise<ComputerPointTarget | null> => {
    if (!run) return null;
    if (await blockedText()) return null; // never look while the person has it
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run().catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * The screen as it is before an approved action, kept for the approval card.
   * Fenced like a step: nothing captured while the person holds control.
   */
  const preActionFrame = async (callId: string): Promise<Record<string, unknown> | null> => {
    if (!deps.storeFrame) return null;
    try {
      if (await blockedText()) return null;
      const epochBefore = await epoch();
      const shot = await deps.screenshot();
      if (await blockedText()) return null;
      if (overlapped(epochBefore, await epoch())) return null;
      const frame = await keepFrame(computerFrameRef(callId, 'pre'), shot);
      if (!frame) return null;
      return {
        ref: frame.ref,
        width: frame.width,
        height: frame.height,
        epoch: deps.screenEpoch(),
        ...(frame.src ? { src: frame.src } : {}),
      };
    } catch {
      return null;
    }
  };

  /**
   * The element an approval named, per call. An approved click or typing step
   * checks it is still the same element before acting: the approval is about
   * the thing the person was shown, not about a pixel that has since moved.
   */
  const approvedTargets = new Map<string, string>();

  const confirmTarget = async (
    ctx: ToolContext,
    look: () => Promise<ComputerPointTarget | null>,
  ): Promise<ToolResult | null> => {
    const callId = ctx.callId;
    if (!callId || !approvedTargets.has(callId)) return null;
    const expected = approvedTargets.get(callId);
    approvedTargets.delete(callId);
    const current = targetKey(await describe(look));
    return current === expected ? null : { output: TARGET_CHANGED_TEXT, isError: true };
  };

  const approvalFor = async (
    ctx: WorkToolPreviewContext,
    detail: Record<string, unknown>,
    point: WorkToolPoint | null,
  ): Promise<Record<string, unknown>> => {
    if (!ctx.forApproval) return detail;
    const frame = await preActionFrame(ctx.callId);
    return { ...detail, ...(point ? { point } : {}), ...(frame ? { frame } : {}) };
  };

  const withEpoch = (input: Record<string, unknown>) => ({
    ...input,
    screen: deps.screenEpoch(),
  });

  /*
   * The last frame any tool saw. Waiting changes nothing, so the stall
   * detector would read the fourth identical "wait 5 seconds" as a loop even
   * while a download bar was visibly moving; with the frame in the signature,
   * a wait that found the screen changed is not a repeat, and one that found
   * it exactly as before still is.
   *
   * Only `computer_wait` uses it. A bare look keeps the screen epoch alone: a
   * page with anything animated (a clock, a carousel, a video) changes every
   * frame, so a frame-aware look would never repeat and a model looking in a
   * loop instead of acting would run to the step cap. Waiting on a changing
   * screen has its own tool, with a pause built in.
   */
  let lastFrame = '';
  const seen = (shot: ComputerShotData) => {
    lastFrame = shot.hash ?? shortHash(shot.data);
    return shot;
  };
  const withFrame = (input: Record<string, unknown>) => ({ ...withEpoch(input), frame: lastFrame });

  const pixelActionFor = (defaultAction: string) => (): string =>
    deps.pageTakesPayment() ? 'work.browser.purchase' : defaultAction;

  const pixelRiskFor = (): WorkRiskLevel =>
    deps.pageTakesPayment() ? 'irreversible' : 'command';

  const pixelProvenance = (action: string): WorkProvenance => ({
    source: "the agent's computer",
    sourceKind: 'web',
    action: deps.pageTakesPayment() ? 'work.browser.purchase' : action,
    trust: 'untrusted',
  });

  const localAppProvenance = (action: string): WorkProvenance => ({
    source: "the agent's computer",
    sourceKind: 'local_app',
    action,
    trust: 'untrusted',
  });

  const screenshotTool: WorkToolDefinition = {
    kind: 'read',
    tier: 'visual',
    intents: ['screen.look'],
    intentFor: () => 'screen.look',
    actionFor: () => 'work.computer.screenshot',
    riskFor: () => 'safe',
    provenanceFor: () => pixelProvenance('work.computer.screenshot'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_screenshot',
      description:
        "Take a 1280x800 screenshot of the agent's desktop. Every click, type, key, scroll and drag already returns a fresh screenshot once the screen has settled, so only call this when you need to look before acting.",
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why you need to inspect the screen right now.',
          },
        },
        required: ['reason'],
      },
    },
    summarize: () => boundSummary(`Look at ${siteHostname(deps.currentUrl())}`),
    async execute(): Promise<InnerResult> {
      const started = now();
      const shot = seen(await deps.screenshot());
      return {
        output: `Captured 1280x800 screenshot on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
        shot,
        settleMs: 0,
        captureMs: now() - started,
      };
    },
  };

  const clickPoint = (input: Record<string, unknown>): WorkToolPoint => ({
    x: clampX(input.x),
    y: clampY(input.y),
  });

  const clickTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'visual',
    intents: ['screen.click'],
    intentFor: () => 'screen.click',
    actionFor: pixelActionFor('work.computer.click'),
    riskFor: pixelRiskFor,
    provenanceFor: () => pixelProvenance('work.computer.click'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    pointFor: clickPoint,
    spec: {
      name: 'computer_click',
      description:
        'Click at pixel coordinates (x, y) on the 1280x800 desktop and return a fresh screenshot. Prefer the DOM `browser` tool for web page links and buttons whenever possible.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Horizontal coordinate (0..1280).' },
          y: { type: 'number', description: 'Vertical coordinate (0..800).' },
          button: {
            type: 'string',
            enum: ['left', 'right', 'double'],
            description: 'Mouse button action. Defaults to left.',
          },
        },
        required: ['x', 'y'],
      },
    },
    summarize: (input) => {
      const { x, y } = clickPoint(input);
      return boundSummary(`Click at (${x}, ${y}) on ${siteHostname(deps.currentUrl())}`);
    },
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      const point = clickPoint(input);
      const target = await describe(deps.describePoint && (() => deps.describePoint!(point.x, point.y)));
      const summary = describeClickTarget(clickButton(input.button), target);
      const key = targetKey(target);
      if (ctx.forApproval && summary && key) approvedTargets.set(ctx.callId, key);
      return {
        ...(summary ? { summary } : {}),
        detail: await approvalFor(ctx, {}, point),
      };
    },
    async execute(input, ctx): Promise<InnerResult> {
      const { x, y } = clickPoint(input);
      const button = clickButton(input.button);
      const changed = await confirmTarget(ctx, () => deps.describePoint!(x, y));
      if (changed) return changed;
      const step = await settled(await deps.click({ x, y, button }), ctx);
      return visual(`Clicked (${x}, ${y}) (${button}) on ${siteHostname(deps.currentUrl())}.`, step);
    },
  };

  const typeTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'visual',
    intents: ['screen.type'],
    intentFor: () => 'screen.type',
    actionFor: pixelActionFor('work.computer.type'),
    // Typing reaches whatever has focus, the desktop's terminal included, so
    // it can run code: it asks every time (`ARBITRARY_CODE_RISK`).
    riskFor: () => (deps.pageTakesPayment() ? 'irreversible' : ARBITRARY_CODE_RISK),
    provenanceFor: () => pixelProvenance('work.computer.type'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_type',
      description:
        'Type text into the focused window on the desktop (max 2000 characters) and return a fresh screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The text to type (at most 2000 characters).',
          },
        },
        required: ['text'],
      },
    },
    summarize: (input) => {
      const raw = String(input.text ?? '');
      return boundSummary(`Type ${typedCount(raw.length, raw)} on ${siteHostname(deps.currentUrl())}`);
    },
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      const text = String(input.text ?? '');
      const target = await describe(deps.describeFocus && (() => deps.describeFocus!()));
      const summary = describeTypeTarget(text.length, target, text);
      const key = targetKey(target);
      if (ctx.forApproval && summary && key) approvedTargets.set(ctx.callId, key);
      // The text itself is what the person is deciding about, so the card
      // shows it as the body rather than a count.
      return {
        ...(summary ? { summary } : {}),
        detail: await approvalFor(ctx, { text }, null),
      };
    },
    async execute(input, ctx): Promise<InnerResult> {
      const text = String(input.text ?? '');
      if (!text) return { output: 'Text is required.', isError: true };
      if (text.length > 2000) {
        return { output: 'Text exceeds the 2000-character limit.', isError: true };
      }
      const changed = await confirmTarget(ctx, () => deps.describeFocus!());
      if (changed) return changed;
      const step = await settled(await deps.type(text), ctx);
      return visual(`Typed ${text.length} characters on ${siteHostname(deps.currentUrl())}.`, step);
    },
  };

  const keyTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'visual',
    intents: ['screen.key'],
    intentFor: () => 'screen.key',
    actionFor: pixelActionFor('work.computer.key'),
    // Navigation keys keep the pixel tools' risk; a key that produces text
    // (or a shortcut that pastes or opens a terminal) is typing, and asks.
    riskFor: (input) =>
      deps.pageTakesPayment()
        ? 'irreversible'
        : isNavigationKeypress(String(input.keys ?? ''))
          ? 'command'
          : ARBITRARY_CODE_RISK,
    provenanceFor: () => pixelProvenance('work.computer.key'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_key',
      description:
        'Press a key or shortcut on the desktop (e.g. "Return", "Tab", "ctrl+l", "Escape") and return a fresh screenshot. Separate several presses with spaces ("ctrl+l Return").',
      inputSchema: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'Key name or combination (e.g. "Return", "ctrl+l", "Tab"), or several separated by spaces.',
          },
        },
        required: ['keys'],
      },
    },
    summarize: (input) =>
      boundSummary(`Press ${String(input.keys ?? '').slice(0, 40)} on ${siteHostname(deps.currentUrl())}`),
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      if (!ctx.forApproval) return null;
      const keys = String(input.keys ?? '').trim().slice(0, 200);
      return { detail: await approvalFor(ctx, { keys }, null) };
    },
    async execute(input, ctx): Promise<InnerResult> {
      const keys = String(input.keys ?? '').trim();
      if (!keys) return { output: 'keys is required.', isError: true };
      const step = await settled(await deps.key(keys), ctx);
      return visual(`Pressed ${keys} on ${siteHostname(deps.currentUrl())}.`, step);
    },
  };

  const scrollTool: WorkToolDefinition = {
    kind: 'read',
    tier: 'visual',
    intents: ['screen.scroll'],
    intentFor: () => 'screen.scroll',
    actionFor: () => 'work.computer.scroll',
    riskFor: () => 'safe',
    provenanceFor: () => pixelProvenance('work.computer.scroll'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    pointFor: (input) => ({ x: clampX(input.x, 640), y: clampY(input.y, 400) }),
    spec: {
      name: 'computer_scroll',
      description: 'Scroll the desktop at (x, y) up or down and return a fresh screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Horizontal coordinate (0..1280).' },
          y: { type: 'number', description: 'Vertical coordinate (0..800).' },
          direction: {
            type: 'string',
            enum: ['up', 'down'],
            description: 'Scroll direction.',
          },
          amount: {
            type: 'number',
            description: 'Scroll ticks (1..10, default 3).',
          },
        },
        required: ['x', 'y', 'direction'],
      },
    },
    summarize: (input) =>
      boundSummary(
        `Scroll ${String(input.direction ?? 'down')} on ${siteHostname(deps.currentUrl())}`,
      ),
    async execute(input, ctx): Promise<InnerResult> {
      const x = clampX(input.x, 640);
      const y = clampY(input.y, 400);
      const direction: 'up' | 'down' = input.direction === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(10, Math.round(Number(input.amount ?? 3)) || 3));
      const step = await settled(await deps.scroll({ x, y, direction, amount }), ctx);
      return visual(`Scrolled ${direction} (${amount}) at (${x}, ${y}).`, step);
    },
  };

  const dragPoints = (input: Record<string, unknown>) => ({
    x1: clampX(input.x1),
    y1: clampY(input.y1),
    x2: clampX(input.x2),
    y2: clampY(input.y2),
  });

  const dragTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'visual',
    intents: ['screen.drag'],
    intentFor: () => 'screen.drag',
    actionFor: pixelActionFor('work.computer.drag'),
    // A drag is a press, a move and a release: a click's risk, and a purchase
    // on a page that takes payment, exactly as a click is.
    riskFor: pixelRiskFor,
    provenanceFor: () => pixelProvenance('work.computer.drag'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    pointFor: (input) => {
      const { x1, y1 } = dragPoints(input);
      return { x: x1, y: y1 };
    },
    spec: {
      name: 'computer_drag',
      description:
        'Press the left mouse button at (x1, y1), move to (x2, y2) and release, then return a fresh screenshot. For sliders, selecting text and moving things.',
      inputSchema: {
        type: 'object',
        properties: {
          x1: { type: 'number', description: 'Start, horizontal (0..1280).' },
          y1: { type: 'number', description: 'Start, vertical (0..800).' },
          x2: { type: 'number', description: 'End, horizontal (0..1280).' },
          y2: { type: 'number', description: 'End, vertical (0..800).' },
        },
        required: ['x1', 'y1', 'x2', 'y2'],
      },
    },
    summarize: (input) => {
      const { x1, y1, x2, y2 } = dragPoints(input);
      return boundSummary(`Drag from (${x1}, ${y1}) to (${x2}, ${y2}) on ${siteHostname(deps.currentUrl())}`);
    },
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      if (!ctx.forApproval) return null;
      const { x1, y1 } = dragPoints(input);
      return { detail: await approvalFor(ctx, {}, { x: x1, y: y1 }) };
    },
    async execute(input, ctx): Promise<InnerResult> {
      if (!deps.drag) return { output: 'Dragging is not available on this computer.', isError: true };
      const points = dragPoints(input);
      const step = await settled(await deps.drag(points), ctx);
      return visual(
        `Dragged from (${points.x1}, ${points.y1}) to (${points.x2}, ${points.y2}) on ${siteHostname(deps.currentUrl())}.`,
        step,
      );
    },
  };

  const waitSeconds = (input: Record<string, unknown>) => {
    const raw = Number(input.seconds ?? 2);
    return Math.max(0.5, Math.min(MAX_WAIT_SECONDS, Number.isFinite(raw) ? raw : 2));
  };

  const waitTool: WorkToolDefinition = {
    kind: 'read',
    tier: 'visual',
    intents: ['screen.wait'],
    intentFor: () => 'screen.wait',
    actionFor: () => 'work.computer.wait',
    riskFor: () => 'safe',
    provenanceFor: () => pixelProvenance('work.computer.wait'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withFrame,
    spec: {
      name: 'computer_wait',
      description:
        `Wait for something on the desktop to finish (a page loading, a download, an animation), up to ${MAX_WAIT_SECONDS} seconds, then return a fresh screenshot. Cheaper than taking screenshots in a loop.`,
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: `How long to wait (0.5..${MAX_WAIT_SECONDS}, default 2).`,
          },
        },
      },
    },
    summarize: (input) => {
      const seconds = waitSeconds(input);
      return boundSummary(`Wait ${seconds} ${seconds === 1 ? 'second' : 'seconds'} on ${siteHostname(deps.currentUrl())}`);
    },
    async execute(input, ctx): Promise<InnerResult> {
      const seconds = waitSeconds(input);
      await pause(Math.round(seconds * 1000), ctx.signal);
      const started = now();
      const shot = seen(await deps.screenshot());
      return {
        output: `Waited ${seconds}s on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
        shot,
        settleMs: 0,
        captureMs: now() - started,
      };
    },
  };

  const zoomRegion = (input: Record<string, unknown>): ComputerZoomRegion => {
    const x = clampX(input.x);
    const y = clampY(input.y);
    const width = Math.max(16, Math.min(SCREEN_WIDTH - x, Math.round(Number(input.width ?? 320)) || 320));
    const height = Math.max(16, Math.min(SCREEN_HEIGHT - y, Math.round(Number(input.height ?? 200)) || 200));
    return {
      x: Math.min(x, SCREEN_WIDTH - 16),
      y: Math.min(y, SCREEN_HEIGHT - 16),
      width,
      height,
    };
  };

  const zoomTool: WorkToolDefinition = {
    kind: 'read',
    tier: 'visual',
    intents: ['screen.zoom'],
    intentFor: () => 'screen.zoom',
    actionFor: () => 'work.computer.zoom',
    riskFor: () => 'safe',
    provenanceFor: () => pixelProvenance('work.computer.zoom'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    pointFor: (input) => {
      const region = zoomRegion(input);
      return { x: Math.round(region.x + region.width / 2), y: Math.round(region.y + region.height / 2) };
    },
    spec: {
      name: 'computer_zoom',
      description:
        'Look closely at part of the desktop: crop the region (x, y, width, height) of a fresh screenshot and return it enlarged. For small text and dense controls. Changes nothing on screen.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Left edge of the region (0..1280).' },
          y: { type: 'number', description: 'Top edge of the region (0..800).' },
          width: { type: 'number', description: 'Region width in pixels (16..1280, default 320).' },
          height: { type: 'number', description: 'Region height in pixels (16..800, default 200).' },
        },
        required: ['x', 'y', 'width', 'height'],
      },
    },
    summarize: (input) => {
      const region = zoomRegion(input);
      return boundSummary(
        `Zoom into ${region.width}x${region.height} at (${region.x}, ${region.y}) on ${siteHostname(deps.currentUrl())}`,
      );
    },
    async execute(input): Promise<InnerResult> {
      if (!deps.zoom) return { output: 'Zooming is not available on this computer.', isError: true };
      const region = zoomRegion(input);
      const started = now();
      const zoomed = await deps.zoom(region);
      // No frame of its own: the screen did not change, and the filmstrip
      // shows the step on the frame before it, with the ring on the region.
      return {
        output: `Zoomed into the ${region.width}x${region.height} region at (${region.x}, ${region.y}); the image is ${zoomed.width}x${zoomed.height}.`,
        images: [{ mediaType: zoomed.mediaType, data: zoomed.data }],
        captureMs: now() - started,
      };
    },
  };

  const shellTool: WorkToolDefinition = {
    kind: 'command',
    tier: 'shell',
    intents: ['shell.run'],
    intentFor: () => 'shell.run',
    actionFor: () => 'work.computer.shell',
    // Asks every time, under every mode, and is never covered by "Always
    // allow": a shell can send, publish or pay without any label the
    // always-confirm floor could recognise (see `ARBITRARY_CODE_RISK`).
    riskFor: () => ARBITRARY_CODE_RISK,
    provenanceFor: () => localAppProvenance('work.computer.shell'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_shell',
      description:
        "Run a bash command inside the agent's isolated Linux computer (/home/agent/work). Output is capped at 20,000 characters per stream.",
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Bash command to run inside the container (max 4000 characters).',
          },
          timeoutSeconds: {
            type: 'number',
            description: 'Timeout in seconds (1..300, default 60).',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory under /home/agent (defaults to /home/agent/work).',
          },
        },
        required: ['command'],
      },
    },
    summarize: (input) => {
      const cmd = sanitizeCommandPreview(String(input.command ?? '')).slice(0, 120);
      const cwd = String(input.cwd ?? '/home/agent/work').trim() || '/home/agent/work';
      return boundSummary(`Run: ${cmd} (in ${cwd})`);
    },
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      if (!ctx.forApproval) return null;
      // The whole command, as it will run: the card's body is the thing being
      // approved, and the summary above it is shortened and scrubbed.
      const command = String(input.command ?? '').trim().slice(0, 4000);
      const cwd = String(input.cwd ?? '').trim() || '/home/agent/work';
      return { detail: { command, cwd } };
    },
    async execute(input, ctx): Promise<ToolResult> {
      const command = String(input.command ?? '').trim();
      if (!command) return { output: 'A command is required.', isError: true };
      if (command.length > 4000) {
        return { output: 'Command exceeds the 4000-character limit.', isError: true };
      }
      const timeoutSeconds = Math.max(
        1,
        Math.min(300, Math.round(Number(input.timeoutSeconds ?? 60))),
      );
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined;
      const res = await deps.exec(command, {
        timeoutSeconds,
        ...(cwd ? { cwd } : {}),
        // The person's terminal pane shows this call's output under its id as it runs.
        ...(ctx.callId ? { callId: ctx.callId } : {}),
      });
      const stdout = capShellStream('stdout', res.stdout);
      const stderr = capShellStream('stderr', res.stderr);
      const parts: string[] = [];
      if (stdout) parts.push(stdout);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      if (res.timedOut) parts.push(`(Timed out after ${timeoutSeconds}s)`);
      if (parts.length === 0) parts.push(`(exit ${res.exitCode}, no output)`);
      return {
        output: parts.join('\n'),
        isError: res.exitCode !== 0 || res.timedOut,
        exitCode: res.exitCode,
      };
    },
  };

  /** The `computer_files` action a call asks for; unknown values read as the harmless `list`. */
  const fileAction = (input: Record<string, unknown>): 'list' | 'read' | 'write' | 'publish' => {
    const raw = String(input.action ?? 'list');
    return raw === 'read' || raw === 'write' || raw === 'publish' ? raw : 'list';
  };

  const filesTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'shell',
    intents: ['files.read', 'files.write', 'files.publish'],
    intentFor: (input) => {
      const action = fileAction(input);
      return action === 'write' ? 'files.write' : action === 'publish' ? 'files.publish' : 'files.read';
    },
    // Publishing is a deliverable like `create_deliverable`'s: the same action
    // and risk, so it is approved (or not) the way making one is.
    actionFor: (input) => (fileAction(input) === 'publish' ? 'work.deliverable.create' : 'work.computer.files'),
    riskFor: (input) => {
      const action = fileAction(input);
      return action === 'write' || action === 'publish' ? 'edit' : 'safe';
    },
    provenanceFor: () => localAppProvenance('work.computer.files'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_files',
      description:
        "List, read, write or publish files in the agent's persistent home directory (/home/agent). Keep working files under /home/agent/work; files the person adds arrive in /home/agent/work/inbox. Reads and writes are text (utf8) unless encoding is base64, which carries any bytes exactly. Publish hands one file (up to 25 MB) to the person as a deliverable of this task, unchanged, as a download.",
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'write', 'publish'],
            description:
              'list a directory, read a file (up to 200 KB), write a file, or publish a file to the person as a deliverable.',
          },
          path: {
            type: 'string',
            description: 'Path under /home/agent (e.g. "/home/agent/work/report.csv").',
          },
          content: {
            type: 'string',
            description: 'What to write when action is "write": text, or base64 when encoding is "base64".',
          },
          encoding: {
            type: 'string',
            enum: ['utf8', 'base64'],
            description:
              'For read and write: "utf8" (the default) for text, "base64" for any other bytes (images, PDFs, archives).',
          },
          title: {
            type: 'string',
            description: 'For publish: the name the person sees (defaults to the file name).',
          },
        },
        required: ['action', 'path'],
      },
    },
    summarize: (input) => {
      const act = fileAction(input);
      const p = sanitizeCommandPreview(String(input.path ?? '/home/agent/work')).slice(0, 120);
      if (act === 'write') return boundSummary(`Write file ${p}`);
      if (act === 'read') return boundSummary(`Read file ${p}`);
      if (act === 'publish') return boundSummary(`Publish ${p} to the person as a deliverable`);
      return boundSummary(`List files in ${p}`);
    },
    async execute(input): Promise<ToolResult> {
      const raw = String(input.action ?? 'list');
      const action = fileAction(input);
      if (raw !== action) return { output: `Unknown action: ${raw}`, isError: true };
      const targetPath = String(input.path ?? '/home/agent/work').trim() || '/home/agent/work';
      const encoding = input.encoding === undefined || input.encoding === null || input.encoding === '' ? 'utf8' : String(input.encoding);
      if (encoding !== 'utf8' && encoding !== 'base64') {
        return { output: 'encoding must be "utf8" or "base64".', isError: true };
      }

      if (action === 'list') {
        const items = await deps.listFiles(targetPath);
        if (items.length === 0) {
          return { output: `Directory ${targetPath} is empty.` };
        }
        return {
          output: items
            .map((e) => `${e.type}\t${e.size ?? 0}\t${e.path}`)
            .join('\n'),
        };
      }

      if (action === 'read') {
        // One byte past the limit, so a cut is known rather than guessed.
        const read = await deps.readFile(targetPath, MAX_FILE_READ_BYTES + 1);
        if (typeof read === 'string') {
          // An older host decoded it already: text, as before.
          return read.length >= MAX_FILE_READ_BYTES
            ? { output: `${read.slice(0, MAX_FILE_READ_BYTES)}\n[File truncated at 200 KB]` }
            : { output: read };
        }
        const cut = read.byteLength > MAX_FILE_READ_BYTES;
        const bytes = cut ? read.subarray(0, MAX_FILE_READ_BYTES) : read;
        if (encoding === 'base64') {
          const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
          return { output: cut ? `${encoded}\n[File truncated at 200 KB: this is its first 200 KB, in base64]` : encoded };
        }
        const text = decodeTextFile(bytes, cut);
        if (text === null) {
          const size = cut ? (deps.fileSize ? await deps.fileSize(targetPath).catch(() => null) : null) : bytes.byteLength;
          const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
          const sizeText =
            typeof size === 'number' ? formatFileBytes(size) : `more than ${formatFileBytes(MAX_FILE_READ_BYTES)}`;
          return {
            output: `${targetPath} is a binary file (${sizeText}, sha256 ${cut ? 'of its first 200 KB ' : ''}${digest}). Read it with encoding base64, or publish it.`,
          };
        }
        return cut ? { output: `${text}\n[File truncated at 200 KB]` } : { output: text };
      }

      if (action === 'write') {
        if (typeof input.content !== 'string') {
          return { output: 'content is required when action is "write".', isError: true };
        }
        if (!isSafeComputerWritePath(targetPath)) {
          return {
            output:
              'Files can only be written under /home/agent/work, and never into a dotfile or dot-folder. Nothing was written.',
            isError: true,
          };
        }
        const bytes = encoding === 'base64' ? decodeBase64(input.content) : new TextEncoder().encode(input.content);
        if (bytes === null) {
          return { output: 'content is not valid base64. Nothing was written.', isError: true };
        }
        if (bytes.byteLength > MAX_FILE_WRITE_BYTES) {
          return { output: `That is more than ${formatFileBytes(MAX_FILE_WRITE_BYTES)}. Nothing was written.`, isError: true };
        }
        await deps.writeFile(targetPath, bytes);
        return {
          output:
            encoding === 'base64'
              ? `Wrote ${bytes.byteLength} bytes to ${targetPath}.`
              : `Wrote ${input.content.length} characters (${bytes.byteLength} bytes) to ${targetPath}.`,
        };
      }

      // publish
      if (!deps.publish) {
        return { output: 'Publishing files is not available for this computer. Nothing was published.', isError: true };
      }
      const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : undefined;
      const outcome = await deps.publish({ path: targetPath, ...(title ? { title } : {}) });
      return outcome.ok ? { output: outcome.detail } : { output: outcome.message, isError: true };
    },
  };

  return [
    screenshotTool,
    clickTool,
    typeTool,
    keyTool,
    scrollTool,
    dragTool,
    waitTool,
    zoomTool,
    shellTool,
    filesTool,
  ].map(guarded);
}

// ---------------------------------------------------------------------------
// Starting the computer from a run (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.5)
// ---------------------------------------------------------------------------

/**
 * Where a run stands with its agent's computer.
 *
 * - `ready`: started in this run; every call is the tool's own.
 * - `needs_start` (policy `allowed`, or a start the person already approved):
 *   the first call starts it, then does what it asked.
 * - `needs_approval` (policy `ask`, no start card in this run): the call is
 *   put to the person as "Start {name}'s computer", and only starts it.
 * - `start_pending`: a start card of this run is still waiting.
 * - `declined`: this run's start card was denied or expired.
 * - `refused`: the policy is off, or access, the allowance or the cap said no.
 */
export type StartState = 'ready' | 'needs_start' | 'needs_approval' | 'start_pending' | 'declined' | 'refused';

export interface ComputerStartGate {
  /** Re-read the policy and the run's start approval. Awaited by the wrapper's preview. */
  refresh(): Promise<void>;
  state(): StartState;
  agentName: string;
  /** null when started, else the sentence. Re-checks the policy itself. */
  start(how: { approvedStart: boolean }): Promise<string | null>;
  /**
   * A start card this run raised ended without being approved: the session
   * never ran the call (denied, expired). Lets the next call answer
   * `declined` without a database read, so it is never asked twice.
   */
  noteStartUnanswered?(): void;
  /** Told when a start card is about to be put to the person (the audit's `start_requested`). */
  onStartRequested?(): void;
}

/** The approval card's summary for a start. Mirrors startApprovalSummary in src/lib/computer/access-copy.ts. */
export function computerStartSummary(agentName: string): string {
  return `Start ${agentName}’s computer`;
}

/** The start card's detail line. Mirrors startApprovalDetail in src/lib/computer/access-copy.ts. */
export function computerStartDetailLine(callSummary: string): string {
  return `What it wants to do next (asked separately): ${callSummary}`;
}

/** Mirrors the tool results in src/lib/computer/access-copy.ts. */
export function computerStartedText(toolName: string): string {
  return `Started your computer. Nothing else was done: call ${toolName} again to do what you asked.`;
}
export const COMPUTER_START_PENDING_TEXT =
  'Waiting for the person to start your computer. This call did not run; call it again once the computer has started.';
export const COMPUTER_START_DECLINED_TEXT =
  'The person did not start your computer for this task. Carry on without it, or ask them with ask_user.';

/** The action a start card is recorded under. Sensitive: asks under every mode, never standing. */
export const COMPUTER_START_ACTION = 'work.computer.start';

/** Per gate, across every tool it wraps: the last start card raised and whether its call ran. */
const startCards = new WeakMap<ComputerStartGate, { callId: string | null; ran: boolean; decided: Map<string, StartState> }>();

function cardsFor(gate: ComputerStartGate) {
  let cards = startCards.get(gate);
  if (!cards) {
    cards = { callId: null, ran: true, decided: new Map() };
    startCards.set(gate, cards);
  }
  return cards;
}

/**
 * Wraps one computer tool so its first use in a run starts the computer, asking
 * first under `ask` (D4: the approved call only starts it; the model repeats
 * the action, which then goes through its own approval as usual).
 *
 * The session consults `actionFor` and `riskFor` before `preview`
 * (session.ts, `executeToolCall`), so the state they read is the one the last
 * refresh left; `preview` refreshes for `execute`, and `execute` re-checks
 * through `start()`. A policy changed between two calls is therefore seen by
 * the second call's `execute` (which says so) and by the third call's card.
 * Every output of a start, a wait or a refusal is the platform's own text, so
 * those calls carry trusted provenance; a call that reaches the tool keeps the
 * tool's own.
 */
export function withComputerStart(definition: WorkToolDefinition, gate: ComputerStartGate): WorkToolDefinition {
  const cards = cardsFor(gate);
  /** The state a call is decided on: a start card that ended without running its call is a decline. */
  const current = (): StartState => {
    if (cards.callId && !cards.ran) {
      cards.callId = null;
      cards.ran = true;
      gate.noteStartUnanswered?.();
    }
    return gate.state();
  };
  const platform = (state: StartState) =>
    state === 'needs_approval' || state === 'start_pending' || state === 'declined' || state === 'refused';
  const name = definition.spec.name;

  return {
    ...definition,
    // A start card, or the platform's own answer: a call that will only wait,
    // decline or refuse runs nothing the tool does, so it never raises the
    // tool's own card (and a start it might make is one the policy allows).
    actionFor: (input) => (platform(current()) ? COMPUTER_START_ACTION : definition.actionFor(input)),
    riskFor: (input) => {
      const state = current();
      if (state === 'needs_approval') return ARBITRARY_CODE_RISK;
      return platform(state) ? 'safe' : definition.riskFor(input);
    },
    provenanceFor: (input) =>
      platform(current())
        ? { source: "the agent's computer", sourceKind: 'local_app', action: COMPUTER_START_ACTION, trust: 'trusted' }
        : definition.provenanceFor(input),
    summarize: (input) =>
      current() === 'needs_approval' ? computerStartSummary(gate.agentName) : definition.summarize(input),
    async preview(input, ctx): Promise<WorkToolPreview | null> {
      // The state this call's action and risk were taken from, before the refresh.
      const decided = current();
      cards.decided.set(ctx.callId, decided);
      await gate.refresh().catch(() => undefined);
      if (decided === 'needs_approval') {
        if (ctx.forApproval) {
          cards.callId = ctx.callId;
          cards.ran = false;
          gate.onStartRequested?.();
        }
        return {
          summary: computerStartSummary(gate.agentName),
          detail: { start: true, next: computerStartDetailLine(definition.summarize(input)) },
        };
      }
      if (platform(decided)) return null;
      return definition.preview ? definition.preview(input, ctx) : null;
    },
    async execute(input, ctx): Promise<WorkToolResult> {
      const decided = (ctx.callId ? cards.decided.get(ctx.callId) : undefined) ?? current();
      if (ctx.callId) {
        cards.decided.delete(ctx.callId);
        if (cards.callId === ctx.callId) cards.ran = true;
      }
      switch (decided) {
        case 'needs_approval': {
          // Approved (the session runs nothing it was refused): start, and nothing else.
          const refusal = await gate.start({ approvedStart: true });
          return refusal ? { output: refusal, isError: true } : { output: computerStartedText(name) };
        }
        case 'start_pending':
          return { output: COMPUTER_START_PENDING_TEXT, isError: true };
        case 'declined':
          return { output: COMPUTER_START_DECLINED_TEXT, isError: true };
        case 'refused': {
          // The refusal's own sentence. Never the tool's output: this call was
          // decided as platform text (trusted provenance), so even if the
          // computer starts now, the action waits for the next call.
          const refusal = await gate.start({ approvedStart: false });
          return refusal ? { output: refusal, isError: true } : { output: computerStartedText(name) };
        }
        case 'needs_start': {
          const refusal = await gate.start({ approvedStart: false });
          if (refusal) return { output: refusal, isError: true };
          return definition.execute(input, ctx);
        }
        case 'ready': {
          // Consent withdrawn since the call was decided: nothing runs.
          if (gate.state() === 'refused') {
            const refusal = await gate.start({ approvedStart: false });
            if (refusal) return { output: refusal, isError: true };
          }
          return definition.execute(input, ctx);
        }
      }
    },
  };
}
