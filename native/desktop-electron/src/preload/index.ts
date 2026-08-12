/**
 * The capability bridge.
 *
 * This file is the entire attack surface the renderer has against the rest of
 * the application, so it is deliberately small and contains no logic beyond
 * marshalling. It exposes two functions — `invoke` and `on` — and no objects,
 * no `ipcRenderer`, no `require`, and nothing from Node.
 *
 * Notably absent, on purpose:
 *   - `ipcRenderer.send` / `sendSync`. Every renderer-initiated call goes
 *     through `invoke`, which gives main a reply channel to return a validated
 *     error on, and gives us one place to enforce the allowlist.
 *   - Any way to pass a function or a port across. Structured-clone-only
 *     payloads mean the renderer cannot hand main a callback to invoke.
 *   - Any channel not named in the shared contract.
 */

import { contextBridge, ipcRenderer } from 'electron';
/* Names come from the dependency-free module; the *types* come from the schema
   module. Type-only imports are erased, so this keeps Zod out of the preload
   bundle while still type-checking every call against the real contract. */
import {
  EVENT_CHANNEL_NAMES,
  INVOKE_CHANNEL_NAMES,
  type EventChannel,
  type InvokeChannel,
} from '../shared/channels.js';
import type { JunoBridge } from '../shared/ipc.js';

const invokeAllowlist = new Set<string>(INVOKE_CHANNEL_NAMES);
const eventAllowlist = new Set<string>(EVENT_CHANNEL_NAMES);

/**
 * Rejecting an unknown channel here is belt-and-braces: main validates too. It
 * is worth doing anyway because it turns a renderer bug into an immediate,
 * legible error at the call site instead of a rejected promise from another
 * process with less context attached.
 */
const bridge: JunoBridge = {
  invoke(channel, ...args) {
    if (!invokeAllowlist.has(channel)) {
      return Promise.reject(new Error(`Unknown IPC channel: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, args[0]) as never;
  },

  on(channel, listener) {
    if (!eventAllowlist.has(channel)) {
      throw new Error(`Unknown event channel: ${String(channel)}`);
    }
    /* The Electron event object is dropped rather than forwarded. It carries a
       `sender` handle, and handing renderer code a reference to a WebContents
       would undo the isolation this file exists to provide. */
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      listener(payload as never);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('juno', bridge satisfies JunoBridge);

/* Types for the renderer's `window.juno`. Declared here so the bridge shape and
   its declaration cannot drift, even though the renderer never imports this
   module at runtime. */
declare global {
  interface Window {
    juno: JunoBridge;
  }
}

export type { InvokeChannel, EventChannel };
