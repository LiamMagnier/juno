/**
 * The renderer's only door out of the sandbox.
 *
 * Everything here goes through `window.juno`, the preload bridge. There is no
 * Node, no `electron` import and no filesystem — `tsconfig.web.json` omits
 * @types/node so a violation is a compile error rather than a review finding.
 *
 * `window.juno` is declared globally in `src/preload/index.ts`, but preload
 * lives in the *node* project graph and the renderer graph never sees that
 * declaration. Rather than re-declaring `Window.juno` here — which would
 * collide with whatever the app shell declares — this module reads the property
 * through one narrow cast and exposes a typed surface built from the shared
 * contract types.
 *
 * The bridge can legitimately be absent: unit tests, Storybook-style harnesses,
 * and the split second before preload has run. Callers get a typed failure
 * instead of a `TypeError`, which is what lets the UI render an honest
 * "disconnected" state instead of a white screen.
 */

import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  JunoBridge,
} from '@shared/ipc.js';

export class BridgeUnavailableError extends Error {
  constructor() {
    super('The Juno IPC bridge is not available in this window.');
    this.name = 'BridgeUnavailableError';
  }
}

function readBridge(): JunoBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { juno?: JunoBridge }).juno;
  return candidate ?? null;
}

export function isBridgeAvailable(): boolean {
  return readBridge() !== null;
}

/**
 * Typed `invoke`. The argument tuple mirrors `JunoBridge` exactly so a channel
 * declared with `request: z.void()` takes no argument at the call site.
 *
 * The single cast is on the forwarding call: TypeScript cannot prove that a
 * conditional tuple spread lines up with the same conditional tuple in the
 * target signature, even though it does by construction. The cast is confined
 * to this one line and the public signature above it stays exact.
 */
export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C> extends void ? [] : [InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  const bridge = readBridge();
  if (!bridge) return Promise.reject(new BridgeUnavailableError());
  const forward = bridge.invoke as (c: C, payload?: unknown) => Promise<InvokeResponse<C>>;
  return forward(channel, args[0]);
}

/** Typed `on`. Returns an unsubscribe function; a no-op when the bridge is absent. */
export function on<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): () => void {
  const bridge = readBridge();
  if (!bridge) return () => undefined;
  return bridge.on(channel, listener);
}

/** Human-readable text for an unknown rejection value, for surfacing in the UI. */
export function describeError(error: unknown): string {
  if (error instanceof BridgeUnavailableError) {
    return 'Not connected to the Juno host process.';
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error.';
}
