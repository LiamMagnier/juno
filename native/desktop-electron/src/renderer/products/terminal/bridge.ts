/**
 * The renderer's typed view of the terminal IPC channels.
 *
 * Every cast in this file is in one place on purpose. `window.juno.invoke` is
 * generic over `InvokeChannel`, and the terminal channels are not in that union
 * yet — so calling them requires widening the bridge exactly once, here, rather
 * than sprinkling `as any` through the components. When the channels are merged
 * into `src/shared/ipc.ts` this file becomes a thin re-export and the widening
 * disappears; nothing in the rest of the directory changes.
 *
 * The widening is a type-level fiction, not a security hole: preload still
 * refuses any channel that is not in its allowlist, and main still validates
 * every payload with the channel's Zod schema before a handler sees it. Until
 * the merge, calling these rejects with `Unknown IPC channel` — which
 * `isChannelMissingError` turns into a legible message instead of a blank pane.
 */

import {
  TERMINAL_EVENT,
  TERMINAL_INVOKE,
  type TerminalCreateRequest,
  type TerminalExitEvent,
  type TerminalKillRequest,
  type TerminalOutputEvent,
  type TerminalResizeRequest,
  type TerminalSummary,
  type TerminalWriteRequest,
} from './protocol.js';

/** The shape of `window.juno` with its channel union erased. See above. */
interface WidenedBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

function raw(): WidenedBridge {
  const bridge = window.juno as unknown as WidenedBridge | undefined;
  if (!bridge) throw new Error('The Juno bridge is unavailable in this window.');
  return bridge;
}

/**
 * Whether a rejection means "these channels have not been merged yet".
 *
 * Worth distinguishing from a real failure: during the window in which the
 * subsystem exists but the shared contract has not caught up, every terminal
 * call fails identically, and a pane that says "Terminals are not wired up in
 * this build" is a great deal more useful than one that says "Refused."
 */
export function isChannelMissingError(error: unknown): boolean {
  return error instanceof Error && /unknown ipc channel/i.test(error.message);
}

export const terminalBridge = {
  async create(request: TerminalCreateRequest): Promise<TerminalSummary> {
    const response = (await raw().invoke(TERMINAL_INVOKE.create, request)) as {
      terminal: TerminalSummary;
    };
    return response.terminal;
  },

  async write(request: TerminalWriteRequest): Promise<void> {
    await raw().invoke(TERMINAL_INVOKE.write, request);
  },

  async resize(request: TerminalResizeRequest): Promise<void> {
    await raw().invoke(TERMINAL_INVOKE.resize, request);
  },

  async kill(request: TerminalKillRequest): Promise<void> {
    await raw().invoke(TERMINAL_INVOKE.kill, request);
  },

  async restart(terminalId: string): Promise<TerminalSummary> {
    const response = (await raw().invoke(TERMINAL_INVOKE.restart, { terminalId })) as {
      terminal: TerminalSummary;
    };
    return response.terminal;
  },

  async list(includeHistory: boolean): Promise<TerminalSummary[]> {
    return (await raw().invoke(TERMINAL_INVOKE.list, { includeHistory })) as TerminalSummary[];
  },

  onOutput(listener: (event: TerminalOutputEvent) => void): () => void {
    return raw().on(TERMINAL_EVENT.output, (payload) => {
      listener(payload as TerminalOutputEvent);
    });
  },

  onExit(listener: (event: TerminalExitEvent) => void): () => void {
    return raw().on(TERMINAL_EVENT.exit, (payload) => {
      listener(payload as TerminalExitEvent);
    });
  },

  /**
   * Recompute-on-appearance-change, using a channel that already exists.
   *
   * The terminal palette is read from CSS custom properties, so it has to be
   * re-read whenever the theme moves. `app:appearance-changed` is main's
   * authoritative signal (it carries macOS "Reduce Transparency" and
   * "Increase Contrast", which no media query exposes), and it is already in
   * the shared contract — so this one subscription needs no merge.
   */
  onAppearanceChanged(listener: () => void): () => void {
    try {
      /* Read once into a local: the global is declared optional so that a test
         renderer without a preload type-checks, and a guarded local is clearer
         than a non-null assertion about a value we genuinely cannot promise. */
      const bridge = window.juno;
      if (!bridge) return () => {};
      return bridge.on('app:appearance-changed', () => {
        listener();
      });
    } catch {
      /* The channel is guaranteed by the contract, but a pane that throws
         during mount because a bridge was stubbed in a test is worse than one
         that simply misses a repaint. */
      return () => {};
    }
  },
};

export type TerminalBridge = typeof terminalBridge;
