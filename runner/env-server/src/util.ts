import { randomBytes, randomUUID } from "node:crypto";

export const nowIso = (): string => new Date().toISOString();

/** Short, sortable-enough, URL-safe id with a readable prefix ("s_", "t_", "cp_"). */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export { randomUUID };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Logs to stderr (stdout carries the sidecar handshake line). */
export function stderrLogger(level: "debug" | "info" | "warn" | "error" = "info"): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const at = order[level];
  const write = (l: keyof typeof order, message: string) => {
    if (order[l] >= at) process.stderr.write(`[alevr-env] ${l}: ${message}\n`);
  };
  return {
    debug: (m) => write("debug", m),
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** A value that resolves once, from outside. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const d = {
    settled: false,
  } as Deferred<T>;
  d.promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  d.resolve = (v) => {
    if (d.settled) return;
    d.settled = true;
    resolve(v);
  };
  d.reject = (e) => {
    if (d.settled) return;
    d.settled = true;
    reject(e);
  };
  return d;
}

/** Async queue usable as an AsyncIterable; `end()` finishes the iteration. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((r: IteratorResult<T>) => void)[] = [];
  #ended = false;

  push(item: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  get ended(): boolean {
    return this.#ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n… ${text.length - max} characters omitted …\n${text.slice(-tail)}`;
}
