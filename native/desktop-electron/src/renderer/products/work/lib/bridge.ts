/**
 * The Work surface's only door out of the sandbox.
 *
 * Everything goes through `window.juno`, the preload bridge. There is no Node,
 * no `electron` import, no `fetch` — the renderer's CSP is `connect-src 'self'`
 * and the backend sends no CORS headers, so a request from here would fail twice
 * over even if the type system allowed it. Main holds the Keychain credential
 * and is the only process that talks to `/api/work/*`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CASTS
 *
 * `src/shared/ipc.ts` does not yet declare the Work channels — they are staged
 * in `../contract.ts` for merge. Until that merge lands, `JunoBridge`'s generic
 * parameters are constrained to the *declared* channel names, so a Work channel
 * is not assignable to them and this module cannot be written without one cast.
 *
 * The cast is confined to `readBridge`, and it casts to the narrowest possible
 * shape: a bare `invoke`/`on` pair over `string`. The public functions below are
 * exact, typed off `WORK_INVOKE_CHANNELS` / `WORK_EVENT_CHANNELS`, so every call
 * site is checked even though the seam is not. After the merge, `readBridge` is
 * deleted and these three functions forward to `renderer/lib/bridge.ts` with no
 * change to any caller.
 *
 * Main re-validates every payload on arrival regardless of what this file
 * believes. That is the actual boundary; this is convenience over it.
 */

import type {
  WorkEventChannel,
  WorkEventPayload,
  WorkInvokeChannel,
  WorkInvokeRequest,
  WorkInvokeResponse,
} from '../contract.js';

export class WorkBridgeUnavailableError extends Error {
  constructor() {
    super('The Juno IPC bridge is not available in this window.');
    this.name = 'WorkBridgeUnavailableError';
  }
}

/** The bridge as this module needs to see it, pending the contract merge. */
interface UntypedBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

function readBridge(): UntypedBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { juno?: UntypedBridge }).juno;
  return candidate ?? null;
}

/**
 * Whether the bridge is there at all.
 *
 * It can legitimately be absent — unit tests, a preview harness, the split
 * second before preload has run. Callers get a typed failure rather than a
 * `TypeError`, which is what lets the surface render an honest disconnected
 * state instead of a white screen.
 */
export function isWorkBridgeAvailable(): boolean {
  return readBridge() !== null;
}

export function workInvoke<C extends WorkInvokeChannel>(
  channel: C,
  ...args: WorkInvokeRequest<C> extends void ? [] : [WorkInvokeRequest<C>]
): Promise<WorkInvokeResponse<C>> {
  const bridge = readBridge();
  if (bridge === null) return Promise.reject(new WorkBridgeUnavailableError());
  return bridge.invoke(channel, args[0]) as Promise<WorkInvokeResponse<C>>;
}

/** Subscribe to a push channel. Returns an unsubscribe; a no-op with no bridge. */
export function workOn<C extends WorkEventChannel>(
  channel: C,
  listener: (payload: WorkEventPayload<C>) => void,
): () => void {
  const bridge = readBridge();
  if (bridge === null) return () => undefined;
  return bridge.on(channel, (payload) => {
    listener(payload as WorkEventPayload<C>);
  });
}

/** Human-readable text for an unknown rejection value, for surfacing in the UI. */
export function describeWorkError(error: unknown): string {
  if (error instanceof WorkBridgeUnavailableError) {
    return 'Not connected to the Juno host process.';
  }
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error.';
}
