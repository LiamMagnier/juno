/**
 * The editor side of the Juno Design bridge.
 *
 * This is the *only* thing the hosted editor may use to reach the Mac. It has
 * no network access, no storage access, and no way to ask for a credential — by
 * construction, because the native side (`DesignBridge.swift`) validates every
 * message against a closed set and refuses anything else.
 *
 * The Swift contract is mirrored here deliberately by hand rather than
 * generated: it is fifteen lines, and a mismatch is caught by
 * `DesignBridgeTests` on the native side and by `design-host-bridge.test.ts` on
 * this one, which is stronger than a generator nobody reads.
 */

import type { DesignDocument } from "@/lib/design/types";
import type { DesignTransaction } from "@/lib/design/operations";
import type { DesignTransport } from "@/components/design/use-design-document";

/** Must equal `DesignBridge.protocolVersion` in Swift. */
export const DESIGN_BRIDGE_PROTOCOL_VERSION = 1;
/** Must equal `DesignBridge.messageHandlerName`. */
export const DESIGN_BRIDGE_HANDLER = "junoDesign";

export type HostCommand =
  | { type: "openDocument"; nonce: string; readOnly: boolean; document: DesignDocument }
  | { type: "adoptDocument"; nonce: string; document: DesignDocument }
  | { type: "setSelection"; nonce: string; nodeIds: string[] }
  | { type: "setReadOnly"; nonce: string; readOnly: boolean };

interface WebKitBridge {
  messageHandlers?: Record<string, { postMessage(body: unknown): void }>;
}

/** True when this bundle is running inside the Mac's WKWebView host. */
export function isHosted(): boolean {
  const webkit = (window as unknown as { webkit?: WebKitBridge }).webkit;
  return typeof webkit?.messageHandlers?.[DESIGN_BRIDGE_HANDLER]?.postMessage === "function";
}

function post(body: Record<string, unknown>): void {
  const webkit = (window as unknown as { webkit?: WebKitBridge }).webkit;
  webkit?.messageHandlers?.[DESIGN_BRIDGE_HANDLER]?.postMessage(body);
}

export interface HostSession {
  nonce: string;
  document: DesignDocument;
  readOnly: boolean;
}

/**
 * Wait for the host to open a document.
 *
 * The editor announces itself and then does nothing until the host answers —
 * it never assumes a document, and it never invents a nonce. If the host and
 * the bundle disagree on the protocol version, the host refuses the `ready`
 * and this promise simply never resolves, which surfaces as the pane's own
 * "editor unavailable" state rather than as a half-working canvas.
 */
export function awaitHostSession(): Promise<HostSession> {
  return new Promise((resolve) => {
    const handlers: Record<string, (command: HostCommand) => void> = {};
    let session: HostSession | null = null;

    (window as unknown as { __junoDesignHost?: unknown }).__junoDesignHost = {
      receive(command: HostCommand) {
        if (!command || typeof command !== "object") return;
        switch (command.type) {
          case "openDocument": {
            session = { nonce: command.nonce, document: command.document, readOnly: command.readOnly };
            resolve(session);
            break;
          }
          default: {
            // Commands that arrive before the document is open are dropped:
            // there is nothing coherent to apply them to.
            if (session) handlers[command.type]?.(command);
          }
        }
      },
      /** Registered by the editor once it is mounted. */
      on(type: string, handler: (command: HostCommand) => void) {
        handlers[type] = handler;
      },
    };

    post({
      type: "ready",
      protocolVersion: DESIGN_BRIDGE_PROTOCOL_VERSION,
      editorVersion: __JUNO_DESIGN_EDITOR_VERSION__,
    });
  });
}

export function onHostCommand(type: HostCommand["type"], handler: (command: HostCommand) => void): void {
  const host = (window as unknown as { __junoDesignHost?: { on(type: string, handler: (c: HostCommand) => void): void } })
    .__junoDesignHost;
  host?.on(type, handler);
}

/**
 * The Mac transport.
 *
 * A committed transaction is posted with the revision it was based on and the
 * revision it produced, plus the resulting document. The host re-validates all
 * three before writing anything — this side's word is never taken for it.
 *
 * There is no acknowledgement round trip in this version: the host either
 * accepts the transaction or replaces the document wholesale via
 * `adoptDocument`, which the editor treats as authoritative. That keeps the
 * failure mode honest (the canvas snaps to what was actually stored) without a
 * request/response channel the bridge does not have.
 */
export function bridgeTransport(session: HostSession): DesignTransport {
  return {
    async commit(transaction: DesignTransaction, _origin, document: DesignDocument) {
      post({
        type: "transaction",
        nonce: session.nonce,
        baseRevision: transaction.baseRevision,
        revision: document.revision,
        transactionId: transaction.id,
        summary: transaction.summary,
        document,
      });
      return { ok: true as const };
    },
  };
}

/** Report the selection to the host, so native chrome ("Ask Juno") can act on it. */
export function reportSelection(nonce: string, revision: number, nodeIds: string[]): void {
  post({ type: "selection", nonce, revision, nodeIds });
}

export function reportFailure(nonce: string | null, message: string): void {
  post({ type: "failure", nonce, message });
}

declare const __JUNO_DESIGN_EDITOR_VERSION__: string;
