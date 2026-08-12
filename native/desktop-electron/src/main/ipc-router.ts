/**
 * Validated IPC dispatch.
 *
 * Three checks run before any handler sees a message, in this order:
 *
 *   1. **Is the channel in the contract?** Unregistered channels never reach a
 *      handler. `ipcMain.handle` is only ever called from this module, so there
 *      is no path that registers a channel without going through the table.
 *   2. **Did it come from a frame we trust?** `contextIsolation` protects the
 *      preload boundary but says nothing about *which* frame is calling. A
 *      subframe — or a renderer that has been navigated somewhere unexpected —
 *      must not be able to drive main.
 *   3. **Is the payload the right shape?** Parsed with the channel's Zod schema.
 *      The renderer is treated as untrusted input even though we wrote it,
 *      because a renderer compromise is exactly the scenario this boundary
 *      exists for.
 *
 * Responses are validated too, on the way out. That catches our own bugs rather
 * than an attacker's: a handler that returns the wrong shape produces a loud
 * error here instead of a confusing `undefined` in a React component.
 */

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from '../shared/ipc.js';
import { isInternalUrl } from './security.js';

/** One handler per invoke channel. Exhaustive — a missing channel is a type error. */
export type InvokeHandlers = {
  [C in InvokeChannel]: (
    request: InvokeRequest<C>,
    context: RequestContext,
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>;
};

export interface RequestContext {
  /** The WebContents that made the call, already validated as trusted. */
  sender: WebContents;
}

/**
 * An error whose message is safe to show the user.
 *
 * Anything else is replaced with a generic string before it crosses back to the
 * renderer. Internal error messages routinely contain absolute paths, and paths
 * contain usernames; leaking those into a renderer (and from there into a
 * console log or a bug report) is a small but entirely avoidable disclosure.
 */
export class PublicError extends Error {
  override readonly name = 'PublicError';
}

const trustedContents = new WeakSet<WebContents>();

/**
 * Marks a window's WebContents as an origin main will accept IPC from.
 *
 * A `WeakSet` of the actual objects, not a list of ids: ids are integers that
 * get reused after a WebContents is destroyed, and an identity check cannot be
 * spoofed by a message that merely claims an id.
 */
export function trustWindow(window: BrowserWindow): void {
  trustedContents.add(window.webContents);
}

/**
 * Whether a message may be acted on.
 *
 * The frame's URL is checked in addition to the WebContents identity, because a
 * trusted window that has somehow been navigated off our origin is no longer
 * speaking for us — and because subframes get their own origin.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!trustedContents.has(event.sender)) return false;

  const frame = event.senderFrame;
  /* A null frame means it was destroyed mid-flight; there is nothing left to
     reply to and nothing to trust. */
  if (!frame) return false;
  return isInternalUrl(frame.url);
}

/**
 * Register every invoke handler. Call once, after the main window exists.
 */
export function registerInvokeHandlers(handlers: InvokeHandlers): void {
  for (const channel of Object.keys(INVOKE_CHANNELS) as InvokeChannel[]) {
    const spec = INVOKE_CHANNELS[channel];
    const handler = handlers[channel];

    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      if (!isTrustedSender(event)) {
        /* Deliberately terse, and logged rather than returned in detail: an
           untrusted caller learns only that it was refused. */
        console.error(`[ipc] refused ${channel} from untrusted sender`);
        throw new Error('Refused.');
      }

      const parsed = spec.request.safeParse(rawRequest);
      if (!parsed.success) {
        console.error(`[ipc] invalid request on ${channel}: ${z.prettifyError(parsed.error)}`);
        throw new Error(`Invalid request for ${channel}.`);
      }

      let result: unknown;
      try {
        result = await (handler as (r: unknown, c: RequestContext) => unknown)(parsed.data, {
          sender: event.sender,
        });
      } catch (error) {
        if (error instanceof PublicError) throw new Error(error.message);
        console.error(`[ipc] handler failed on ${channel}:`, error);
        throw new Error('Something went wrong.');
      }

      const validated = spec.response.safeParse(result);
      if (!validated.success) {
        /* Our bug, not theirs — loud in the log, generic on the wire. */
        console.error(
          `[ipc] handler for ${channel} returned an invalid response: ${z.prettifyError(validated.error)}`,
        );
        throw new Error('Something went wrong.');
      }
      return validated.data;
    });
  }
}

/**
 * Push an event to a window, validating the payload first.
 *
 * Validating outbound events is not paranoia about the renderer — it is a guard
 * against main streaming a malformed agent event into the transcript reducer,
 * where the failure would surface much later and much less legibly.
 */
export function emitTo<C extends EventChannel>(
  window: BrowserWindow,
  channel: C,
  payload: EventPayload<C>,
): void {
  if (window.isDestroyed()) return;

  const validated = EVENT_CHANNELS[channel].safeParse(payload);
  if (!validated.success) {
    console.error(
      `[ipc] refused to emit malformed ${channel}: ${z.prettifyError(validated.error)}`,
    );
    return;
  }
  window.webContents.send(channel, validated.data);
}

/** Removes every handler. Used on shutdown and in tests. */
export function disposeInvokeHandlers(): void {
  for (const channel of Object.keys(INVOKE_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }
}
