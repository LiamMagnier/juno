import type { ToolResult } from '../tools/types.js';
import type { WorkProvenance, WorkRiskLevel, WorkToolDefinition } from './types.js';

export const REMOTE_TOOL_NAMES = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_shell',
  'computer_files',
] as const;

export type RemoteComputerToolName = (typeof REMOTE_TOOL_NAMES)[number];

export interface ComputerShotData {
  mediaType: 'image/jpeg' | 'image/png';
  data: string;
  width: number;
  height: number;
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
  exec(command: string, opts: { timeoutSeconds: number; cwd?: string }): Promise<ComputerExecOutcome>;
  listFiles(path: string): Promise<ComputerFileEntryItem[]>;
  readFile(path: string, maxBytes: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

const MAX_SHELL_OUTPUT_CHARS = 20_000;
const MAX_FILE_READ_BYTES = 200 * 1024;

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

export function computerTools(deps: ComputerToolsDeps): WorkToolDefinition[] {
  const blocked = async (): Promise<ToolResult | null> => {
    const reason = deps.blockedReason ? await deps.blockedReason() : null;
    return reason ? { output: reason, isError: true } : null;
  };
  // Every tool: refuse before acting while blocked, and refuse after acting
  // if a takeover began mid-call, so what the screen showed at the moment the
  // person took over never reaches the model.
  // Part of each tool's own implementation, not a dispatch site: the session's
  // `executeToolCall` still gates every call before it reaches this execute.
  const epoch = async (): Promise<number | null> => (deps.takeoverEpoch ? await deps.takeoverEpoch() : null);
  const guarded = (definition: WorkToolDefinition): WorkToolDefinition => ({
    ...definition,
    async execute(input, ctx) {
      const before = await blocked();
      if (before) return before;
      const epochBefore = await epoch();
      const result = await definition.execute(input, ctx);
      const after = await blocked();
      if (after) return after;
      const epochAfter = await epoch();
      if (epochBefore !== null && epochAfter !== null && epochBefore !== epochAfter) {
        return { output: TAKEOVER_OVERLAP_TEXT, isError: true };
      }
      return result;
    },
  });

  const withEpoch = (input: Record<string, unknown>) => ({
    ...input,
    screen: deps.screenEpoch(),
  });

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
        "Take a 1280x800 screenshot of the agent's desktop. Every click, type, key and scroll already returns a fresh screenshot, so only call this when you need to look before acting.",
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
    async execute(): Promise<ToolResult> {
      const shot = await deps.screenshot();
      return {
        output: `Captured 1280x800 screenshot on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
      };
    },
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
      const x = Math.round(Number(input.x ?? 0));
      const y = Math.round(Number(input.y ?? 0));
      return boundSummary(`Click at (${x}, ${y}) on ${siteHostname(deps.currentUrl())}`);
    },
    async execute(input): Promise<ToolResult> {
      const x = Math.max(0, Math.min(1280, Math.round(Number(input.x ?? 0))));
      const y = Math.max(0, Math.min(800, Math.round(Number(input.y ?? 0))));
      const rawBtn = String(input.button ?? 'left');
      const button: 'left' | 'right' | 'double' =
        rawBtn === 'right' || rawBtn === 'double' ? rawBtn : 'left';
      const shot = await deps.click({ x, y, button });
      return {
        output: `Clicked (${x}, ${y}) (${button}) on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
      };
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
      return boundSummary(`Type ${raw.length} characters on ${siteHostname(deps.currentUrl())}`);
    },
    async execute(input): Promise<ToolResult> {
      const text = String(input.text ?? '');
      if (!text) return { output: 'Text is required.', isError: true };
      if (text.length > 2000) {
        return { output: 'Text exceeds the 2000-character limit.', isError: true };
      }
      const shot = await deps.type(text);
      return {
        output: `Typed ${text.length} characters on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
      };
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
        'Press a key or shortcut on the desktop (e.g. "Return", "Tab", "ctrl+l", "Escape") and return a fresh screenshot.',
      inputSchema: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: 'Key name or combination (e.g. "Return", "ctrl+l", "Tab").',
          },
        },
        required: ['keys'],
      },
    },
    summarize: (input) =>
      boundSummary(`Press ${String(input.keys ?? '').slice(0, 40)} on ${siteHostname(deps.currentUrl())}`),
    async execute(input): Promise<ToolResult> {
      const keys = String(input.keys ?? '').trim();
      if (!keys) return { output: 'keys is required.', isError: true };
      const shot = await deps.key(keys);
      return {
        output: `Pressed ${keys} on ${siteHostname(deps.currentUrl())}.`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
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
    async execute(input): Promise<ToolResult> {
      const x = Math.max(0, Math.min(1280, Math.round(Number(input.x ?? 640))));
      const y = Math.max(0, Math.min(800, Math.round(Number(input.y ?? 400))));
      const direction: 'up' | 'down' = input.direction === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(10, Math.round(Number(input.amount ?? 3))));
      const shot = await deps.scroll({ x, y, direction, amount });
      return {
        output: `Scrolled ${direction} (${amount}) at (${x}, ${y}).`,
        images: [{ mediaType: shot.mediaType, data: shot.data }],
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
    shellTool,
    filesTool,
  ].map(guarded);
}
