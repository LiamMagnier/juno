/**
 * The env server's line to the Mac app for computer use (SPEC §3.12).
 *
 * Screen Recording and Accessibility belong to the Alevr app, so the app is
 * what captures and clicks; the env server only forwards. One JSON line per
 * `ComputerBridgeRequest` on a Unix socket the app listens on
 * (`ComputerBridgeServer.swift`), one `ComputerBridgeResponse` line back.
 * The socket and the token file sit in a 0700 directory, and every request
 * carries the token, so another user on the Mac cannot drive it.
 */
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { ComputerBridgeRequest, ComputerBridgeResponse } from "../contracts/code-v2.js";
import { DEFAULT_COMPUTER_USE_DIR } from "./desktop-lock.js";

export const DEFAULT_BRIDGE_SOCKET_PATH = join(DEFAULT_COMPUTER_USE_DIR, "bridge.sock");
export const DEFAULT_BRIDGE_TOKEN_PATH = join(DEFAULT_COMPUTER_USE_DIR, "bridge.token");

/** What the tools need from the Mac; a fake in tests. */
export interface ComputerBridge {
  send(request: Omit<ComputerBridgeRequest, "id" | "token">, options?: { signal?: AbortSignal }): Promise<ComputerBridgeResponse>;
}

export class ComputerBridgeUnavailable extends Error {
  constructor(message = "Computer use needs the Alevr app open on this Mac, with Let Alevr use apps turned on.") {
    super(message);
    this.name = "ComputerBridgeUnavailable";
  }
}

export interface UnixSocketBridgeOptions {
  socketPath?: string;
  tokenPath?: string;
  /** Read once per request so a restarted app's new token is picked up. */
  readToken?: () => string;
  /** A screen action can wait on an approval card; the app's own limit is 10 minutes. */
  timeoutMs?: number;
}

let sequence = 0;
const nextId = () => `cb_${process.pid}_${++sequence}`;

export function createUnixSocketBridge(options: UnixSocketBridgeOptions = {}): ComputerBridge {
  const socketPath = options.socketPath ?? DEFAULT_BRIDGE_SOCKET_PATH;
  const tokenPath = options.tokenPath ?? DEFAULT_BRIDGE_TOKEN_PATH;
  const readToken = options.readToken ?? (() => readFileSync(tokenPath, "utf8").trim());
  const timeoutMs = options.timeoutMs ?? 11 * 60_000;

  return {
    send(partial, { signal } = {}) {
      let token: string;
      try {
        token = readToken();
      } catch {
        return Promise.reject(new ComputerBridgeUnavailable());
      }
      const request: ComputerBridgeRequest = { ...partial, id: nextId(), token };
      return new Promise<ComputerBridgeResponse>((resolve, reject) => {
        const socket = createConnection({ path: socketPath });
        let buffer = "";
        let settled = false;
        const finish = (error: Error | null, response?: ComputerBridgeResponse) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          socket.destroy();
          if (error) reject(error);
          else resolve(response!);
        };
        const timer = setTimeout(() => finish(new Error("The Alevr app did not answer the screen action in time.")), timeoutMs);
        timer.unref?.();
        const onAbort = () => finish(new Error("Stopped."));
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line) continue;
            try {
              const response = JSON.parse(line) as ComputerBridgeResponse;
              if (response.id === request.id) return finish(null, response);
            } catch {
              return finish(new Error("The Alevr app sent an unreadable answer."));
            }
          }
        });
        socket.on("error", (error: NodeJS.ErrnoException) => {
          const missing = error.code === "ENOENT" || error.code === "ECONNREFUSED";
          finish(missing ? new ComputerBridgeUnavailable() : error);
        });
        socket.on("close", () => finish(new ComputerBridgeUnavailable("The Alevr app closed the connection before answering.")));
      });
    },
  };
}
