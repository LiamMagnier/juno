/**
 * The renderer's only door to the rest of the application.
 *
 * `window.juno` is already typed by the shared contract, so this module is not
 * here to add types — it is here to add the three things every call site would
 * otherwise reimplement, badly:
 *
 *   1. **A missing bridge is a state, not a crash.** The renderer runs without
 *      preload in unit tests and in a plain browser tab. `window.juno` being
 *      absent must degrade to a legible "disconnected" UI, not a
 *      `TypeError: Cannot read properties of undefined`.
 *   2. **Errors arrive as opaque rejections.** Main deliberately replaces
 *      internal error messages with generic ones (see `PublicError` in
 *      ipc-router.ts), so what the renderer receives is a `string` it should
 *      show and nothing it should branch on. `tryInvoke` turns that into a
 *      result union, because a shell that renders an error state for every
 *      channel needs one shape to render, not fourteen try/catches.
 *   3. **Subscriptions must be cancellable in the same expression.** `on`
 *      already returns its own unsubscribe; `subscribe` preserves that even
 *      when the bridge is missing, so `useEffect` can return it unconditionally.
 *
 * Nothing in this file widens the contract: every channel name and payload is
 * still checked against `INVOKE_CHANNELS`/`EVENT_CHANNELS` at compile time, and
 * re-validated by main at runtime.
 */

import type {
  EventChannel,
  EventPayload,
  InvokeChannel,
  InvokeRequest,
  InvokeResponse,
  JunoBridge,
} from '../../shared/ipc.js';

declare global {
  interface Window {
    /**
     * Declared non-optional, matching preload's own declaration and the
     * contract the app ships under: in a correctly built window, preload has
     * run and `juno` is there.
     *
     * The renderer still does not *trust* that — see `readBridge` below, which
     * re-widens it to `| undefined` at the one place it is read. Declaring it
     * optional here would be the more honest type but a worse boundary: every
     * feature module would then carry its own null check for a condition that
     * only occurs when the build is broken, and the checks would be
     * inconsistent. One module owns the doubt.
     */
    juno: JunoBridge;
  }
}

/** Thrown only by `invoke`. `tryInvoke` converts it into a result instead. */
export class BridgeUnavailableError extends Error {
  override readonly name = 'BridgeUnavailableError';

  constructor(channel: string) {
    super(`The Juno bridge is unavailable, so "${channel}" cannot be reached.`);
  }
}

/**
 * The one place `window.juno` is read, and the one place its absence is typed.
 *
 * `Partial<Window>` re-introduces the `| undefined` the global declaration
 * deliberately omits, without a cast to `any` and without weakening the
 * declaration for every other module. The `typeof` check is not paranoia about
 * types: it also rejects a partially-initialised object, which is what a
 * half-failed preload actually leaves behind.
 */
function readBridge(): JunoBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const candidate = (window as Partial<Window>).juno;
  return typeof candidate?.invoke === 'function' && typeof candidate.on === 'function'
    ? candidate
    : undefined;
}

export function isBridgeAvailable(): boolean {
  return readBridge() !== undefined;
}

function getBridge(): JunoBridge | null {
  return readBridge() ?? null;
}

/**
 * Call a channel. Rejects if the bridge is missing or main returned an error.
 *
 * The rest-tuple signature is copied from `JunoBridge` rather than simplified,
 * so `invoke('app:info')` still takes no second argument and
 * `invoke('code:abort')` still requires one.
 */
export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C> extends void ? [] : [InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  const bridge = getBridge();
  if (!bridge) return Promise.reject(new BridgeUnavailableError(channel));

  /* The conditional rest tuple is unresolvable inside a generic body — the
     compiler cannot know which branch `C` takes — so the forwarding call is
     typed once, here, instead of at every call site. The channel and the
     payload themselves are still exactly what the caller passed. */
  const payload = (args as readonly unknown[])[0];
  const forward = bridge.invoke as (channel: C, payload?: unknown) => Promise<InvokeResponse<C>>;
  return forward(channel, payload);
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * `invoke`, with the failure moved into the return value.
 *
 * Preferred anywhere the outcome drives UI. An unhandled rejection in a React
 * event handler is invisible; an `{ ok: false }` is a branch the reviewer can
 * see is rendered.
 */
export async function tryInvoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C> extends void ? [] : [InvokeRequest<C>]
): Promise<Result<InvokeResponse<C>>> {
  try {
    const forward = invoke as (channel: C, ...rest: readonly unknown[]) => Promise<InvokeResponse<C>>;
    const value = await forward(channel, ...(args as readonly unknown[]));
    return { ok: true, value };
  } catch (error: unknown) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Subscribe to a push channel. Always returns an unsubscribe function, even
 * when there is no bridge, so effects can return it without a null check.
 */
export function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): () => void {
  const bridge = getBridge();
  if (!bridge) {
    warnOnce(`No bridge: "${channel}" will never fire in this context.`);
    return () => {
      /* nothing was subscribed */
    };
  }
  return bridge.on(channel, listener);
}

/**
 * A string safe to render.
 *
 * Main already redacts what it sends, so the message is shown as-is; anything
 * that is not an Error is summarised rather than stringified, because
 * `String(someObject)` produces "[object Object]" and that has been shipped to
 * users in a dialog by every application ever written.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Something went wrong. The details were not passed across the process boundary.';
}

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[bridge] ${message}`);
}
