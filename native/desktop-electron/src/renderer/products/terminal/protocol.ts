/**
 * The terminal wire types, as the renderer sees them.
 *
 * ## Why this file exists, and when to delete it
 *
 * `src/shared/ipc.ts` has no terminal channels yet, so `window.juno.invoke`
 * does not type-check against `'terminal:create'` and there is no
 * `EventPayload<'terminal:output'>` to import. Rather than reach across into
 * `src/main/terminal/contract.ts` — which would put a main-process module into
 * the renderer's project graph and quietly undo the split that
 * `tsconfig.web.json` exists to enforce — the renderer keeps its own structural
 * mirror.
 *
 * These are plain types, not Zod schemas, deliberately. The preload bundle
 * keeps Zod out for size and blast-radius reasons and the renderer follows the
 * same rule: main validates every response on the way out (see
 * `registerInvokeHandlers`), so a second copy of the validator here would cost
 * bundle size to re-check something already checked by the process that is
 * authoritative about it.
 *
 * **When the channels land in the shared contract**, this file and `bridge.ts`
 * collapse to a handful of `InvokeRequest<'terminal:…'>` / `EventPayload<…>`
 * aliases. Nothing else in this directory imports the wire types from anywhere
 * else, so that change is local.
 */

export const TERMINAL_INVOKE = {
  create: 'terminal:create',
  write: 'terminal:write',
  resize: 'terminal:resize',
  kill: 'terminal:kill',
  restart: 'terminal:restart',
  list: 'terminal:list',
} as const;

export const TERMINAL_EVENT = {
  output: 'terminal:output',
  exit: 'terminal:exit',
} as const;

export type TerminalStatus = 'running' | 'exited';
export type TerminalSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface TerminalSummary {
  id: string;
  workspaceId: string;
  title: string;
  cwd: string;
  shell: string;
  pid: number | null;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exitCode: number | null;
  signal: number | null;
  createdAt: string;
  historyChars: number;
  /** Only present when `list` was called with `includeHistory: true`. */
  history?: string;
}

export interface TerminalCreateRequest {
  workspaceId: string;
  cols: number;
  rows: number;
  cwd?: string;
  title?: string;
}

export interface TerminalWriteRequest {
  terminalId: string;
  data: string;
}

export interface TerminalResizeRequest {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalKillRequest {
  terminalId: string;
  signal?: TerminalSignal;
}

export interface TerminalOutputEvent {
  terminalId: string;
  seq: number;
  chunk: string;
  /**
   * Output main dropped from the front of this batch to stay under its
   * per-event cap. Non-zero only under a flood; surfaced rather than hidden so
   * the pane can say so instead of silently lying about what ran.
   */
  truncatedChars: number;
}

export interface TerminalExitEvent {
  terminalId: string;
  exitCode: number;
  signal: number | null;
  /** `true` when main has dropped the record — the tab cannot be restarted. */
  released: boolean;
  at: string;
}
