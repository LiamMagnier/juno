/**
 * Minimal JSON-RPC 2.0 peer over a child process's stdio, newline-delimited
 * (codex app-server). Framing, bounded lines, no shell, ordered writes and
 * "every pending request fails when the process exits" — the same hygiene as
 * the ACP client (providers/acp/client.ts), without ACP's schema layer.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { describeError, type Logger } from "../util.js";

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export interface JsonRpcHandlers {
  onNotification(method: string, params: unknown): void;
  /** A request from the peer (approvals). Must resolve with the result or throw a JsonRpcError. */
  onRequest(method: string, params: unknown, id: number | string): Promise<unknown>;
  onExit?(info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }): void;
}

export interface JsonRpcStdioOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  handlers: JsonRpcHandlers;
  logger: Logger;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  /** Send `"jsonrpc":"2.0"` on outbound frames (codex accepts either; tests can check). */
  jsonrpcField?: boolean;
}

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: NodeJS.Timeout;
}

const LIVE = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const child of LIVE) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  });
}

export class JsonRpcStdio {
  #child: ChildProcessWithoutNullStreams | undefined;
  #pending = new Map<number | string, Pending>();
  #nextId = 1;
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #stderr = "";
  #closed = false;
  #exited: Promise<void> = Promise.resolve();
  readonly #o: JsonRpcStdioOptions;

  constructor(options: JsonRpcStdioOptions) {
    this.#o = options;
  }

  get running(): boolean {
    return !!this.#child && !this.#closed;
  }

  stderrTail(): string {
    return this.#stderr.slice(-4000);
  }

  start(): void {
    installExitHook();
    const child = spawn(this.#o.command, this.#o.args, {
      cwd: this.#o.cwd,
      env: this.#o.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    this.#child = child;
    LIVE.add(child);
    this.#exited = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        LIVE.delete(child);
        this.#closed = true;
        const reason = signal ? `killed by ${signal}` : `exited with code ${code ?? "unknown"}`;
        for (const [id, p] of this.#pending) {
          if (p.timer) clearTimeout(p.timer);
          p.reject(new JsonRpcError(`${this.#o.command} ${reason} before answering ${p.method}${this.#stderr ? `: ${this.stderrTail().trim().split("\n").slice(-3).join(" ")}` : ""}`));
          this.#pending.delete(id);
        }
        this.#o.handlers.onExit?.({ code, signal, stderr: this.stderrTail() });
        resolve();
      });
    });
    child.once("error", (error) => {
      this.#closed = true;
      for (const [id, p] of this.#pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new JsonRpcError(`could not run ${this.#o.command}: ${describeError(error)}`));
        this.#pending.delete(id);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.stdin.on("error", (error) => this.#o.logger.debug(`stdin: ${describeError(error)}`));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs: number | null = this.#o.requestTimeoutMs ?? 60_000): Promise<T> {
    if (!this.#child || this.#closed) return Promise.reject(new JsonRpcError(`${this.#o.command} is not running`));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new JsonRpcError(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.#pending.set(id, pending);
      this.#write({ ...(this.#o.jsonrpcField === false ? {} : { jsonrpc: "2.0" }), id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.#child || this.#closed) return;
    this.#write({ ...(this.#o.jsonrpcField === false ? {} : { jsonrpc: "2.0" }), method, ...(params === undefined ? {} : { params }) });
  }

  async stop(graceMs = 2000): Promise<void> {
    const child = this.#child;
    if (!child || this.#closed) return;
    try {
      child.stdin.end();
    } catch {
      /* closed */
    }
    const exited = this.#exited;
    const timeout = (ms: number) => new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.());
    if (await Promise.race([exited.then(() => true), timeout(graceMs / 2)])) return;
    child.kill("SIGTERM");
    if (await Promise.race([exited.then(() => true), timeout(graceMs)])) return;
    child.kill("SIGKILL");
    await exited;
  }

  #write(frame: unknown): void {
    const child = this.#child;
    if (!child || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  #onData(chunk: Buffer): void {
    this.#buffer += this.#decoder.write(chunk);
    const max = this.#o.maxLineBytes ?? 16 * 1024 * 1024;
    let newline: number;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#dispatch(line);
    }
    if (this.#buffer.length > max) {
      this.#o.logger.error(`${this.#o.command} sent a line over ${max} bytes; stopping it`);
      this.#buffer = "";
      this.#child?.kill("SIGKILL");
    }
  }

  #dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.#o.logger.debug(`non-JSON line from ${this.#o.command}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === "string") {
      const id = msg.id as number | string;
      this.#o.handlers
        .onRequest(msg.method, msg.params, id)
        .then((result) => this.#write({ ...(this.#o.jsonrpcField === false ? {} : { jsonrpc: "2.0" }), id, result: result ?? {} }))
        .catch((error: unknown) => {
          const e = error instanceof JsonRpcError ? error : new JsonRpcError(describeError(error), -32603);
          this.#write({ ...(this.#o.jsonrpcField === false ? {} : { jsonrpc: "2.0" }), id, error: { code: e.code ?? -32603, message: e.message } });
        });
      return;
    }
    if (hasId) {
      const pending = this.#pending.get(msg.id as number | string);
      if (!pending) return;
      this.#pending.delete(msg.id as number | string);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error && typeof msg.error === "object") {
        const err = msg.error as { message?: string; code?: number; data?: unknown };
        pending.reject(new JsonRpcError(err.message ?? `${pending.method} failed`, err.code, err.data));
      } else pending.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      try {
        this.#o.handlers.onNotification(msg.method, msg.params);
      } catch (error) {
        this.#o.logger.warn(`notification ${msg.method}: ${describeError(error)}`);
      }
    }
  }
}
