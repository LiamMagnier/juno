/**
 * The Chat surface's door to main.
 *
 * Everything here goes through `window.juno`. No `fetch`, no `electron`, no
 * Node — `tsconfig.web.json` omits @types/node so the last two are compile
 * errors, and the first would be refused twice anyway: the CSP is
 * `connect-src 'self'`, and the Juno backend answers a cross-origin mutating
 * request with a 403 because it sends no CORS headers at all. Network belongs
 * to main. This module is how the renderer asks main to do it.
 *
 * ── The cast, and when it goes away ──────────────────────────────────────────
 * `JunoBridge.invoke` is typed against `InvokeChannel`, the union in
 * `src/shared/channels.ts`, and the chat channels are not in it yet — this
 * surface does not own that file. So the two calls below go through one narrow
 * structural cast, in one place, with the public signatures above them typed
 * exactly against `../contract.ts`.
 *
 * That means every call site is already fully type-checked against the real
 * schemas; merging the channels into `src/shared/` deletes `UnlistedBridge` and
 * changes nothing else. It also means preload's allowlist will reject these
 * channels until the merge happens, which is the correct failure: a legible
 * `Unknown IPC channel` rejection surfaced as an error state, not a silent
 * no-op.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  ChatEventChannel,
  ChatEventPayload,
  ChatInvokeChannel,
  ChatInvokeRequest,
  ChatInvokeResponse,
} from '../contract.js';

/** Erased at runtime; see the header. Delete this once the channels are merged. */
interface UnlistedBridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): () => void;
}

function readBridge(): UnlistedBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as unknown as { juno?: UnlistedBridge }).juno;
  return candidate ?? null;
}

export function isBridgeAvailable(): boolean {
  return readBridge() !== null;
}

export class BridgeUnavailableError extends Error {
  override readonly name = 'BridgeUnavailableError';

  constructor(channel: string) {
    super(`Not connected to the Juno host process, so "${channel}" cannot be reached.`);
  }
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Call a channel, with the failure moved into the return value.
 *
 * A result union rather than a rejection, for the reason `renderer/lib/bridge.ts`
 * gives: an unhandled rejection inside a React event handler is invisible, and
 * every one of these calls drives a piece of UI that has to say something when
 * it fails. `{ ok: false }` is a branch a reviewer can see is rendered.
 */
export async function chatInvoke<C extends ChatInvokeChannel>(
  channel: C,
  ...args: ChatInvokeRequest<C> extends void ? [] : [ChatInvokeRequest<C>]
): Promise<Result<ChatInvokeResponse<C>>> {
  const bridge = readBridge();
  if (!bridge) return { ok: false, error: new BridgeUnavailableError(channel).message };
  try {
    const value = (await bridge.invoke(channel, (args as readonly unknown[])[0])) as ChatInvokeResponse<C>;
    return { ok: true, value };
  } catch (error: unknown) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Subscribe to a push channel. Always returns an unsubscribe function — even
 * with no bridge — so an effect can return it without a null check.
 */
export function chatSubscribe<C extends ChatEventChannel>(
  channel: C,
  listener: (payload: ChatEventPayload<C>) => void,
): () => void {
  const bridge = readBridge();
  if (!bridge) return () => undefined;
  return bridge.on(channel, (payload) => {
    listener(payload as ChatEventPayload<C>);
  });
}

/**
 * A string safe to render.
 *
 * Main deliberately replaces internal error text with generic messages before
 * it crosses the boundary, so what arrives is something to show and nothing to
 * branch on. Anything that is not an Error is summarised rather than
 * stringified — `String(someObject)` yields "[object Object]", and that has
 * been shipped to users in a dialog by every application ever written.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Something went wrong, and the details did not survive the process boundary.';
}

/**
 * Copy text to the clipboard.
 *
 * Lives here beside the IPC helpers because callers think of it as "the same
 * kind of thing", but it deliberately does NOT use IPC: `navigator.clipboard`
 * is a DOM API, needs no capability from main, and adding a channel for it
 * would widen the bridge for no gain.
 *
 * The `execCommand` fallback is not superstition. `navigator.clipboard`
 * requires a secure context, and a packaged Electron app served from `file://`
 * is not one — the dev server on http://localhost is. So the modern path is
 * correct in development and can be absent in the shipped build, which is the
 * worst way round for a bug to be found.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through — a rejected clipboard write is a permission answer, not a
       reason to give up on the operation. */
  }

  try {
    const staging = document.createElement('textarea');
    staging.value = text;
    /* Off-screen rather than `display: none`: a hidden element cannot be
       selected, and an unselectable element cannot be copied. */
    staging.setAttribute('readonly', '');
    staging.style.position = 'fixed';
    staging.style.top = '-1000px';
    staging.style.opacity = '0';
    document.body.appendChild(staging);
    staging.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(staging);
    return copied;
  } catch {
    return false;
  }
}

/**
 * Open a URL in the user's browser.
 *
 * The renderer must never navigate. A top-level navigation in the app window
 * replaces the application with a web page and there is no way back to it —
 * no address bar, no back button, no chrome of any kind. Every link in a
 * transcript therefore goes through main, which re-checks the scheme.
 */
export async function openExternal(url: string): Promise<Result<{ ok: true }>> {
  return chatInvoke('chat:open-external', { url });
}
