import type { ToolContext, ToolResult } from '../tools/types.js';
import type {
  WorkProvenance,
  WorkRiskLevel,
  WorkScreenAction,
  WorkScreenDescription,
  WorkToolDefinition,
  WorkToolFrame,
} from './types.js';

export const REMOTE_TOOL_NAMES = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_hover',
  'computer_zoom',
  'computer_wait',
  'computer_shell',
  'computer_files',
] as const;

export type RemoteComputerToolName = (typeof REMOTE_TOOL_NAMES)[number];

export interface ComputerShotData {
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
  /** How long the capture took, in ms. */
  captureMs?: number;
  /** How long a settled capture waited for the screen to stop changing, in ms. */
  settleMs?: number;
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

/** The element under a point of the desktop, as the remote page names it. */
export interface ComputerTarget {
  /** An ARIA role, explicit or implied by the tag ("button", "link", "textbox"). */
  role: string;
  /** Its accessible name, as the page wrote it. Untrusted page text. */
  name: string;
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
  /** Press at one point, move to another, release. Offered only when present. */
  drag?(opts: { x1: number; y1: number; x2: number; y2: number }): Promise<ComputerShotData>;
  /** Move the pointer and dwell, so hover menus and tooltips open. Offered only when present. */
  hover?(opts: { x: number; y: number }): Promise<ComputerShotData>;
  /** A region of the last frame, scaled up. Offered only when present. */
  zoom?(region: { x: number; y: number; width: number; height: number }): Promise<ComputerShotData>;
  /**
   * The element under a desktop point, or null when the point is outside the
   * page or nothing could be read. Bounded by the tools (it never holds a call
   * up for long) and never asked while the person has control.
   */
  describeTarget?(x: number, y: number): Promise<ComputerTarget | null>;
  /** The wait `computer_wait` uses; injectable so tests need no real clock. */
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  exec(command: string, opts: { timeoutSeconds: number; cwd?: string }): Promise<ComputerExecOutcome>;
  listFiles(path: string): Promise<ComputerFileEntryItem[]>;
  readFile(path: string, maxBytes: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

const MAX_SHELL_OUTPUT_CHARS = 20_000;
const MAX_FILE_READ_BYTES = 200 * 1024;
const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 800;
/** The longest `computer_wait` the model may ask for, in seconds. */
export const COMPUTER_WAIT_MAX_SECONDS = 10;
/** How long naming the element under the pointer may take before the call goes on without it. */
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

function capShellStream(label: string, value: string): string {
  if (value.length <= MAX_SHELL_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_SHELL_OUTPUT_CHARS)}\n[${label} cut off at ${MAX_SHELL_OUTPUT_CHARS} characters]`;
}

const clampX = (value: unknown, fallback = 0) =>
  Math.max(0, Math.min(DESKTOP_WIDTH, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback)));
const clampY = (value: unknown, fallback = 0) =>
  Math.max(0, Math.min(DESKTOP_HEIGHT, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback)));

/**
 * A `computer_key` string as the separate keys it names: "ctrl+l Return" is
 * two presses. The provider hands each to xdotool as its own argument; passed
 * whole, xdotool looked for one key called "ctrl+l Return" and failed.
 */
export function splitComputerKeys(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((key) => key.trim())
    .filter(Boolean)
    .slice(0, 32);
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
  const keys = splitComputerKeys(raw).map((key) => key.toLowerCase());
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

/** What an element's role is called in a sentence. */
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
  slider: 'slider',
  tab: 'tab',
  menuitem: 'menu item',
  menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item',
  heading: 'heading',
  img: 'image',
  image: 'image',
  cell: 'cell',
  gridcell: 'cell',
  row: 'row',
  dialog: 'dialog',
  treeitem: 'item',
  spinbutton: 'field',
};

/**
 * The element as words: `the “Sign in” button`, `the “Email” field`, or null
 * when the page gave nothing to name it by.
 *
 * The name is the page's own text and so untrusted: it is cut to 60
 * characters, its quotes and control characters are removed, and it only
 * ever appears inside quotation marks, never as the sentence around them.
 */
export function describeTargetWords(target: ComputerTarget | null | undefined): string | null {
  if (!target) return null;
  const noun = ROLE_NOUNS[String(target.role ?? '').toLowerCase()] ?? null;
  const name = String(target.name ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/["\u201c\u201d\u00ab\u00bb]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const short = name.length > 60 ? `${name.slice(0, 57).trimEnd()}…` : name;
  if (short && noun) return `the “${short}” ${noun}`;
  if (short) return `“${short}”`;
  if (noun) return `the ${noun}`;
  return null;
}

const PRESS_WORDS: Record<'left' | 'right' | 'double', { verb: string; action: WorkScreenAction['action'] }> = {
  left: { verb: 'Click', action: 'click' },
  right: { verb: 'Right-click', action: 'right_click' },
  double: { verb: 'Double-click', action: 'double_click' },
};

function buttonOf(input: Record<string, unknown>): 'left' | 'right' | 'double' {
  const raw = String(input.button ?? 'left');
  return raw === 'right' || raw === 'double' ? raw : 'left';
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Stopped.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function computerTools(deps: ComputerToolsDeps): WorkToolDefinition[] {
  const blockedText = async (): Promise<string | null> => (deps.blockedReason ? await deps.blockedReason() : null);
  const blocked = async (): Promise<ToolResult | null> => {
    const reason = await blockedText();
    return reason ? { output: reason, isError: true } : null;
  };
  const epoch = async (): Promise<number | null> => (deps.takeoverEpoch ? await deps.takeoverEpoch() : null);

  /*
   * The step record. Each screen action leaves the frame it returned here,
   * keyed by the provider's call id; the session takes it once the call is
   * over (`takeFrame`). The guard below drops it on every path that discards
   * a result, so a frame captured as the person took over is never stored.
   */
  const pendingFrames = new Map<string, WorkToolFrame>();
  const keepFrame = (ctx: ToolContext, shot: ComputerShotData, point?: { x: number; y: number }) => {
    if (!ctx.callId) return;
    pendingFrames.set(ctx.callId, {
      mediaType: shot.mediaType,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      ...(point ? { point } : {}),
      ...(typeof shot.captureMs === 'number' ? { captureMs: shot.captureMs } : {}),
      ...(typeof shot.settleMs === 'number' ? { settleMs: shot.settleMs } : {}),
    });
  };
  const dropFrame = (ctx: ToolContext) => {
    if (ctx.callId) pendingFrames.delete(ctx.callId);
  };

  /** Where the pointer last landed: where typing and keys most likely go. */
  let lastPoint: { x: number; y: number } | null = null;

  /**
   * The element under a point, in words, or null. Never asked while the
   * person has control (the page is theirs then), and never allowed to hold
   * a call up: a slow page is described by its coordinates instead.
   */
  const targetAt = async (point: { x: number; y: number } | null | undefined): Promise<string | null> => {
    if (!point || !deps.describeTarget) return null;
    if (await blockedText()) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const target = await Promise.race([
        deps.describeTarget(point.x, point.y),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), DESCRIBE_TIMEOUT_MS);
        }),
      ]);
      return describeTargetWords(target);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * The last description per tool and input, so the result the model reads
   * names the same element the person was shown, without asking twice.
   */
  const described = new Map<string, string | null>();
  const describedKey = (tool: string, input: Record<string, unknown>) => `${tool}:${JSON.stringify(input)}`;
  const remember = (tool: string, input: Record<string, unknown>, target: string | null) => {
    if (described.size > 32) described.clear();
    described.set(describedKey(tool, input), target);
  };
  const recalled = (tool: string, input: Record<string, unknown>): string | null =>
    described.get(describedKey(tool, input)) ?? null;

  // Every tool: refuse before acting while blocked, and refuse after acting
  // if a takeover began mid-call, so what the screen showed at the moment the
  // person took over never reaches the model.
  // Part of each tool's own implementation, not a dispatch site: the session's
  // `executeToolCall` still gates every call before it reaches this execute.
  const guarded = (definition: WorkToolDefinition): WorkToolDefinition => ({
    ...definition,
    async execute(input, ctx) {
      const before = await blocked();
      if (before) return before;
      const epochBefore = await epoch();
      let result: ToolResult;
      try {
        result = await definition.execute(input, ctx);
      } catch (error) {
        dropFrame(ctx);
        throw error;
      }
      const after = await blocked();
      if (after) {
        dropFrame(ctx);
        return after;
      }
      const epochAfter = await epoch();
      if (epochBefore !== null && epochAfter !== null && epochBefore !== epochAfter) {
        dropFrame(ctx);
        return { output: TAKEOVER_OVERLAP_TEXT, isError: true };
      }
      if (result.isError) dropFrame(ctx);
      return result;
    },
    takeFrame(callId) {
      const frame = pendingFrames.get(callId) ?? null;
      pendingFrames.delete(callId);
      return frame;
    },
  });

  /**
   * A fresh frame for an approval card, under the same rules as a screenshot
   * the model takes: none while the person has control, and none if a
   * takeover started while it was being captured.
   */
  const previewFrame = async (
    _input: Record<string, unknown>,
    screen: WorkScreenAction | null,
  ): Promise<WorkToolFrame | null> => {
    if (await blockedText()) return null;
    const epochBefore = await epoch();
    const shot = await deps.screenshot();
    if (await blockedText()) return null;
    const epochAfter = await epoch();
    if (epochBefore !== null && epochAfter !== null && epochBefore !== epochAfter) return null;
    return {
      mediaType: shot.mediaType,
      data: shot.data,
      width: shot.width,
      height: shot.height,
      ...(screen?.point ? { point: screen.point } : {}),
    };
  };

  const withEpoch = (input: Record<string, unknown>) => ({
    ...input,
    screen: deps.screenEpoch(),
  });

  const host = () => siteHostname(deps.currentUrl());

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

  const imageOf = (shot: ComputerShotData) => [{ mediaType: shot.mediaType, data: shot.data }];

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
        "Take a 1280x800 screenshot of the agent's desktop. Every click, type, key, scroll, drag and hover already returns a fresh screenshot once the screen has settled, so only call this when you need to look before acting.",
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
    summarize: () => boundSummary(`Look at ${host()}`),
    async describeScreen(): Promise<WorkScreenDescription> {
      return { screen: { action: 'screenshot' }, summary: boundSummary(`Look at ${host()}`) };
    },
    async execute(_input, ctx): Promise<ToolResult> {
      const shot = await deps.screenshot();
      keepFrame(ctx, shot);
      return {
        output: `Captured 1280x800 screenshot on ${host()}.`,
        images: imageOf(shot),
      };
    },
  };

  const clickSummary = (input: Record<string, unknown>, target: string | null) => {
    const words = PRESS_WORDS[buttonOf(input)];
    if (target) return boundSummary(`${words.verb} ${target} on ${host()}`);
    return boundSummary(`${words.verb} at (${clampX(input.x)}, ${clampY(input.y)}) on ${host()}`);
  };

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
    spec: {
      name: 'computer_click',
      description:
        'Click at pixel coordinates (x, y) on the 1280x800 desktop and return a fresh screenshot once the screen settles. Prefer the DOM `browser` tool for web page links and buttons whenever possible.',
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
    summarize: (input) => clickSummary(input, null),
    async describeScreen(input): Promise<WorkScreenDescription> {
      const point = { x: clampX(input.x), y: clampY(input.y) };
      const target = await targetAt(point);
      remember('computer_click', input, target);
      return {
        screen: { action: PRESS_WORDS[buttonOf(input)].action, point, ...(target ? { target } : {}) },
        summary: clickSummary(input, target),
      };
    },
    previewFrame,
    async execute(input, ctx): Promise<ToolResult> {
      const x = clampX(input.x);
      const y = clampY(input.y);
      const button = buttonOf(input);
      const target = recalled('computer_click', input);
      const shot = await deps.click({ x, y, button });
      lastPoint = { x, y };
      keepFrame(ctx, shot, { x, y });
      return {
        output: target
          ? `Clicked ${target} at (${x}, ${y}) (${button}) on ${host()}.`
          : `Clicked (${x}, ${y}) (${button}) on ${host()}.`,
        images: imageOf(shot),
      };
    },
  };

  const typeSummary = (input: Record<string, unknown>, target: string | null) => {
    const count = String(input.text ?? '').length;
    return boundSummary(
      target ? `Type ${count} characters into ${target} on ${host()}` : `Type ${count} characters on ${host()}`,
    );
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
        'Type text into the focused window on the desktop (max 2000 characters) and return a fresh screenshot once the screen settles.',
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
    summarize: (input) => typeSummary(input, null),
    async describeScreen(input): Promise<WorkScreenDescription> {
      // Typing lands where the pointer last clicked; that is the point the
      // approval marks and the element it names.
      const point = lastPoint ?? undefined;
      const target = await targetAt(point);
      return {
        screen: { action: 'type', ...(point ? { point } : {}), ...(target ? { target } : {}) },
        summary: typeSummary(input, target),
      };
    },
    previewFrame,
    async execute(input, ctx): Promise<ToolResult> {
      const text = String(input.text ?? '');
      if (!text) return { output: 'Text is required.', isError: true };
      if (text.length > 2000) {
        return { output: 'Text exceeds the 2000-character limit.', isError: true };
      }
      const shot = await deps.type(text);
      keepFrame(ctx, shot, lastPoint ?? undefined);
      return {
        output: `Typed ${text.length} characters on ${host()}.`,
        images: imageOf(shot),
      };
    },
  };

  const keySummary = (input: Record<string, unknown>, target: string | null) => {
    const keys = splitComputerKeys(String(input.keys ?? '')).join(' ').slice(0, 40);
    return boundSummary(target ? `Press ${keys} in ${target} on ${host()}` : `Press ${keys} on ${host()}`);
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
        'Press a key or shortcut on the desktop (e.g. "Return", "Tab", "ctrl+l", "Escape"), or several in order separated by spaces ("ctrl+l Return"), and return a fresh screenshot once the screen settles.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'Key name or combination (e.g. "Return", "ctrl+l", "Tab"); several separated by spaces are pressed in order.',
          },
        },
        required: ['keys'],
      },
    },
    summarize: (input) => keySummary(input, null),
    async describeScreen(input): Promise<WorkScreenDescription> {
      const point = lastPoint ?? undefined;
      const target = await targetAt(point);
      return {
        screen: { action: 'key', ...(point ? { point } : {}), ...(target ? { target } : {}) },
        summary: keySummary(input, target),
      };
    },
    previewFrame,
    async execute(input, ctx): Promise<ToolResult> {
      const keys = splitComputerKeys(String(input.keys ?? '')).join(' ');
      if (!keys) return { output: 'keys is required.', isError: true };
      const shot = await deps.key(keys);
      keepFrame(ctx, shot, lastPoint ?? undefined);
      return {
        output: `Pressed ${keys} on ${host()}.`,
        images: imageOf(shot),
      };
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
    spec: {
      name: 'computer_scroll',
      description: 'Scroll the desktop at (x, y) up or down and return a fresh screenshot once the screen settles.',
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
      boundSummary(`Scroll ${input.direction === 'up' ? 'up' : 'down'} on ${host()}`),
    async describeScreen(input): Promise<WorkScreenDescription> {
      return {
        screen: { action: 'scroll', point: { x: clampX(input.x, 640), y: clampY(input.y, 400) } },
        summary: boundSummary(`Scroll ${input.direction === 'up' ? 'up' : 'down'} on ${host()}`),
      };
    },
    async execute(input, ctx): Promise<ToolResult> {
      const x = clampX(input.x, 640);
      const y = clampY(input.y, 400);
      const direction: 'up' | 'down' = input.direction === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(10, Math.round(Number(input.amount ?? 3)) || 3));
      const shot = await deps.scroll({ x, y, direction, amount });
      lastPoint = { x, y };
      keepFrame(ctx, shot, { x, y });
      return {
        output: `Scrolled ${direction} (${amount}) at (${x}, ${y}).`,
        images: imageOf(shot),
      };
    },
  };

  const dragPoints = (input: Record<string, unknown>) => ({
    x1: clampX(input.fromX),
    y1: clampY(input.fromY),
    x2: clampX(input.toX),
    y2: clampY(input.toY),
  });

  const dragSummary = (input: Record<string, unknown>, target: string | null) => {
    const { x1, y1, x2, y2 } = dragPoints(input);
    return boundSummary(
      target
        ? `Drag ${target} to (${x2}, ${y2}) on ${host()}`
        : `Drag from (${x1}, ${y1}) to (${x2}, ${y2}) on ${host()}`,
    );
  };

  /*
   * A drag is a click for the risk ladder: the same `command` risk, the same
   * escalation to a purchase on a page that takes payment. It can move a file
   * into a folder or a slider to a value, which is as consequential as the
   * click that would do the same.
   */
  const dragTool: WorkToolDefinition | null = deps.drag
    ? {
        kind: 'edit',
        tier: 'visual',
        intents: ['screen.drag'],
        intentFor: () => 'screen.drag',
        actionFor: pixelActionFor('work.computer.drag'),
        riskFor: pixelRiskFor,
        provenanceFor: () => pixelProvenance('work.computer.drag'),
        isHealthy: () => deps.isHealthy(),
        signatureInput: withEpoch,
        spec: {
          name: 'computer_drag',
          description:
            'Press at (fromX, fromY), move to (toX, toY) and release, on the 1280x800 desktop, and return a fresh screenshot once the screen settles. For sliders, reordering and moving things between lists.',
          inputSchema: {
            type: 'object',
            properties: {
              fromX: { type: 'number', description: 'Where to press, horizontally (0..1280).' },
              fromY: { type: 'number', description: 'Where to press, vertically (0..800).' },
              toX: { type: 'number', description: 'Where to release, horizontally (0..1280).' },
              toY: { type: 'number', description: 'Where to release, vertically (0..800).' },
            },
            required: ['fromX', 'fromY', 'toX', 'toY'],
          },
        },
        summarize: (input) => dragSummary(input, null),
        async describeScreen(input): Promise<WorkScreenDescription> {
          const { x1, y1 } = dragPoints(input);
          const point = { x: x1, y: y1 };
          const target = await targetAt(point);
          remember('computer_drag', input, target);
          return {
            screen: { action: 'drag', point, ...(target ? { target } : {}) },
            summary: dragSummary(input, target),
          };
        },
        previewFrame,
        async execute(input, ctx): Promise<ToolResult> {
          const points = dragPoints(input);
          const target = recalled('computer_drag', input);
          const shot = await deps.drag!(points);
          lastPoint = { x: points.x2, y: points.y2 };
          keepFrame(ctx, shot, lastPoint);
          return {
            output: `Dragged ${target ? `${target} ` : ''}from (${points.x1}, ${points.y1}) to (${points.x2}, ${points.y2}) on ${host()}.`,
            images: imageOf(shot),
          };
        },
      }
    : null;

  const hoverSummary = (input: Record<string, unknown>, target: string | null) =>
    boundSummary(
      target
        ? `Point at ${target} on ${host()}`
        : `Point at (${clampX(input.x)}, ${clampY(input.y)}) on ${host()}`,
    );

  const hoverTool: WorkToolDefinition | null = deps.hover
    ? {
        kind: 'read',
        tier: 'visual',
        intents: ['screen.hover'],
        intentFor: () => 'screen.hover',
        actionFor: () => 'work.computer.hover',
        // Moving the pointer presses nothing, like scrolling.
        riskFor: () => 'safe',
        provenanceFor: () => pixelProvenance('work.computer.hover'),
        isHealthy: () => deps.isHealthy(),
        signatureInput: withEpoch,
        spec: {
          name: 'computer_hover',
          description:
            'Move the pointer to (x, y) without clicking, wait briefly so hover menus and tooltips open, and return a fresh screenshot.',
          inputSchema: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Horizontal coordinate (0..1280).' },
              y: { type: 'number', description: 'Vertical coordinate (0..800).' },
            },
            required: ['x', 'y'],
          },
        },
        summarize: (input) => hoverSummary(input, null),
        async describeScreen(input): Promise<WorkScreenDescription> {
          const point = { x: clampX(input.x), y: clampY(input.y) };
          const target = await targetAt(point);
          return {
            screen: { action: 'hover', point, ...(target ? { target } : {}) },
            summary: hoverSummary(input, target),
          };
        },
        async execute(input, ctx): Promise<ToolResult> {
          const x = clampX(input.x);
          const y = clampY(input.y);
          const shot = await deps.hover!({ x, y });
          lastPoint = { x, y };
          keepFrame(ctx, shot, { x, y });
          return {
            output: `Pointed at (${x}, ${y}) on ${host()}.`,
            images: imageOf(shot),
          };
        },
      }
    : null;

  const zoomRegion = (input: Record<string, unknown>) => {
    const width = Math.max(16, Math.min(DESKTOP_WIDTH, Math.round(Number(input.width) || 320)));
    const height = Math.max(16, Math.min(DESKTOP_HEIGHT, Math.round(Number(input.height) || 200)));
    const x = Math.max(0, Math.min(DESKTOP_WIDTH - width, clampX(input.x)));
    const y = Math.max(0, Math.min(DESKTOP_HEIGHT - height, clampY(input.y)));
    return { x, y, width, height };
  };

  const zoomTool: WorkToolDefinition | null = deps.zoom
    ? {
        kind: 'read',
        tier: 'visual',
        intents: ['screen.zoom'],
        intentFor: () => 'screen.zoom',
        actionFor: () => 'work.computer.zoom',
        riskFor: () => 'safe',
        provenanceFor: () => pixelProvenance('work.computer.zoom'),
        isHealthy: () => deps.isHealthy(),
        signatureInput: withEpoch,
        spec: {
          name: 'computer_zoom',
          description:
            'Look closely at a region of the latest screenshot: (x, y) is its top-left corner, width and height its size, all in desktop pixels. The region comes back scaled up so small text is legible. Nothing on the screen changes.',
          inputSchema: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Left edge (0..1280).' },
              y: { type: 'number', description: 'Top edge (0..800).' },
              width: { type: 'number', description: 'Width in pixels (16..1280, default 320).' },
              height: { type: 'number', description: 'Height in pixels (16..800, default 200).' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
        },
        summarize: () => boundSummary(`Look closely at part of ${host()}`),
        async describeScreen(input): Promise<WorkScreenDescription> {
          const region = zoomRegion(input);
          return {
            screen: {
              action: 'zoom',
              point: { x: Math.round(region.x + region.width / 2), y: Math.round(region.y + region.height / 2) },
            },
            summary: boundSummary(`Look closely at part of ${host()}`),
          };
        },
        async execute(input, ctx): Promise<ToolResult> {
          const region = zoomRegion(input);
          const shot = await deps.zoom!(region);
          keepFrame(ctx, shot);
          return {
            output: `Zoomed into ${region.width}x${region.height} at (${region.x}, ${region.y}) on ${host()}, shown at ${shot.width}x${shot.height}.`,
            images: imageOf(shot),
          };
        },
      }
    : null;

  const waitSeconds = (input: Record<string, unknown>) => {
    const raw = Number(input.seconds ?? 1);
    const seconds = Number.isFinite(raw) ? raw : 1;
    return Math.max(0.1, Math.min(COMPUTER_WAIT_MAX_SECONDS, seconds));
  };
  const secondsWords = (seconds: number) =>
    `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} ${seconds === 1 ? 'second' : 'seconds'}`;

  const waitTool: WorkToolDefinition = {
    kind: 'read',
    tier: 'visual',
    intents: ['screen.wait'],
    intentFor: () => 'screen.wait',
    actionFor: () => 'work.computer.wait',
    riskFor: () => 'safe',
    provenanceFor: () => pixelProvenance('work.computer.wait'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_wait',
      description: `Wait for a page or app to finish loading (up to ${COMPUTER_WAIT_MAX_SECONDS} seconds), then return a fresh screenshot. Use it instead of taking screenshots in a loop.`,
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            description: `How long to wait (0.1..${COMPUTER_WAIT_MAX_SECONDS}, default 1).`,
          },
        },
        required: ['seconds'],
      },
    },
    summarize: (input) => boundSummary(`Wait ${secondsWords(waitSeconds(input))} on ${host()}`),
    async describeScreen(input): Promise<WorkScreenDescription> {
      return {
        screen: { action: 'wait' },
        summary: boundSummary(`Wait ${secondsWords(waitSeconds(input))} on ${host()}`),
      };
    },
    async execute(input, ctx): Promise<ToolResult> {
      const seconds = waitSeconds(input);
      await (deps.sleep ?? sleepFor)(Math.round(seconds * 1000), ctx.signal);
      // The person may have taken over during the wait: look only if not.
      const stopped = await blocked();
      if (stopped) return stopped;
      const shot = await deps.screenshot();
      keepFrame(ctx, shot);
      return {
        output: `Waited ${secondsWords(seconds)} on ${host()}.`,
        images: imageOf(shot),
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
    async execute(input): Promise<ToolResult> {
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

  const filesTool: WorkToolDefinition = {
    kind: 'edit',
    tier: 'shell',
    intents: ['files.read', 'files.write'],
    intentFor: (input) => (input.action === 'write' ? 'files.write' : 'files.read'),
    actionFor: () => 'work.computer.files',
    riskFor: (input) => (input.action === 'write' ? 'edit' : 'safe'),
    provenanceFor: () => localAppProvenance('work.computer.files'),
    isHealthy: () => deps.isHealthy(),
    signatureInput: withEpoch,
    spec: {
      name: 'computer_files',
      description:
        "List, read or write files in the agent's persistent home directory (/home/agent). Keep working files under /home/agent/work.",
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'read', 'write'],
            description: 'File operation: list directory, read file (up to 200 KB), or write file.',
          },
          path: {
            type: 'string',
            description: 'Path under /home/agent (e.g. "/home/agent/work/report.csv").',
          },
          content: {
            type: 'string',
            description: 'Text content to write when action is "write".',
          },
        },
        required: ['action', 'path'],
      },
    },
    summarize: (input) => {
      const act = String(input.action ?? 'list');
      const p = sanitizeCommandPreview(String(input.path ?? '/home/agent/work')).slice(0, 120);
      if (act === 'write') return boundSummary(`Write file ${p}`);
      if (act === 'read') return boundSummary(`Read file ${p}`);
      return boundSummary(`List files in ${p}`);
    },
    async execute(input): Promise<ToolResult> {
      const action = String(input.action ?? 'list');
      const targetPath = String(input.path ?? '/home/agent/work').trim() || '/home/agent/work';

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
        const text = await deps.readFile(targetPath, MAX_FILE_READ_BYTES);
        if (text.length >= MAX_FILE_READ_BYTES) {
          return {
            output: `${text.slice(0, MAX_FILE_READ_BYTES)}\n[File truncated at 200 KB]`,
          };
        }
        return { output: text };
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
        await deps.writeFile(targetPath, input.content);
        return { output: `Wrote ${input.content.length} characters to ${targetPath}.` };
      }

      return { output: `Unknown action: ${action}`, isError: true };
    },
  };

  return [
    screenshotTool,
    clickTool,
    typeTool,
    keyTool,
    scrollTool,
    dragTool,
    hoverTool,
    zoomTool,
    waitTool,
    shellTool,
    filesTool,
  ]
    .filter((tool): tool is WorkToolDefinition => tool !== null)
    .map(guarded);
}
