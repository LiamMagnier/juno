import "server-only";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import sharp from "sharp";
import { env } from "@/lib/env";
import { COMPUTER_SAFETY_CHECK_FAILED } from "./docker";
import {
  COMPUTER_NOT_RESPONDING,
  COMPUTER_PATH_REFUSED,
  COMPUTER_UNREACHABLE,
  ComputerError,
  scrubComputerText,
} from "./errors";
import type {
  ComputerFileEntry,
  ComputerHandle,
  ComputerProvider,
  EndpointPurpose,
  Endpoints,
  ExecOptions,
  ExecResult,
  Shot,
} from "./types";
import { afterFreeze, holdingLaunches } from "./freeze-gate";

/*
 * Agent computers on a separate computer host (COMPUTERS_2026-10.md S3,
 * deploy/computer-host/). The web VM, which holds the database URL, the
 * provider keys and AUTH_SECRET, runs no desktop: every ComputerProvider call
 * is one request to the host's narrow API, authenticated with a bearer token
 * scoped to one environment's namespace, over HTTPS (http only to loopback
 * outside production). CDP and VNC reach the computer through the host's
 * WebSocket tunnels, each opened with a single-use 60 s ticket the host mints
 * for one container and one port.
 *
 * What the host says is never shown to anyone: a failure is a ComputerError
 * with one of the computer layer's own sentences and a scrubbed detail for
 * the log. `state()` answers `missing` only for the host's 404
 * `no_such_container`; a timeout, a refused connection or any other answer
 * throws COMPUTER_UNREACHABLE, so a host outage never sends the store into a
 * recreate (fact 23).
 */

/** The token formats deploy/computer-host/setup.sh generates (32 random bytes): 64 lowercase hex, or 43+ base64url. */
const TOKEN_FORMAT = /^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43,512})$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export const HOST_PREFLIGHT_SENTENCES: Record<string, string> = {
  image_missing: "The protected browser image is not set up on the computer host.",
  memory: "The server doesn't have enough free memory to start another computer right now.",
  disk: "The server doesn't have enough free disk space to start another computer right now.",
  capacity: "The computer host is running as many computers as it can right now. Try again in a few minutes.",
};
const HOST_UNANSWERED = "The computer host can't be reached right now.";
/** The same sentence the Docker provider gives (docker.ts writeFile), so the tools read alike. */
const WRITE_REFUSED = "Files can only be written under /home/agent/work, and never into a dotfile or dot-folder.";

export type RemoteHostConfig = { ok: true; origin: string; token: string } | { ok: false; reason: string };

/**
 * Whether the configured host may be used, and its origin. `https:` always;
 * `http:` only to 127.0.0.1, ::1 or localhost and never in production. A
 * token in any other format than the generator's keeps the provider off: its
 * format is checked here, its randomness cannot be (the README says to use only
 * a generated token). The reason never contains the token.
 */
export function remoteHostConfig(input: { url: string; token: string; nodeEnv?: string }): RemoteHostConfig {
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV;
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return { ok: false, reason: "COMPUTER_HOST_URL is not a URL" };
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, reason: "COMPUTER_HOST_URL must be an origin, with no path, query or credentials" };
  }
  if (url.protocol === "http:") {
    if (nodeEnv === "production") return { ok: false, reason: "COMPUTER_HOST_URL must be https in production" };
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return { ok: false, reason: "COMPUTER_HOST_URL may be http only to 127.0.0.1, ::1 or localhost" };
    }
  } else if (url.protocol !== "https:") {
    return { ok: false, reason: "COMPUTER_HOST_URL must be https" };
  }
  if (!TOKEN_FORMAT.test(input.token)) {
    return { ok: false, reason: "COMPUTER_HOST_TOKEN is not in the format deploy/computer-host/setup.sh generates" };
  }
  return { ok: true, origin: url.origin, token: input.token };
}

/** What the host's owner label holds instead of a user id: never the id itself. */
export function hostUserRef(userId: string): string {
  return `u_${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

/**
 * The computer a host call acts on, when it is one a freeze of that computer
 * holds (freeze-gate.ts): every per-computer call but the freeze and thaw.
 */
export function heldComputer(path: string): string | null {
  const match = /^\/v1\/computers\/([^/]+)(?:\/([^/?]+))?/.exec(path);
  if (!match) return null;
  if (match[2] === "freeze" || match[2] === "thaw") return null;
  return decodeURIComponent(match[1]!);
}

/** The host's tunnel URL for an origin: wss for https, ws for (loopback) http. */
export function tunnelUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/tunnel";
  return url.toString();
}

/**
 * The most a host answer may hold. The largest real ones are a 26 MiB file
 * read (its own limit, below) and a screenshot; an exec answer is at most two
 * 1 MiB streams in base64 (EXEC_OUTPUT_BYTES on the host). Read as it arrives
 * and refused past the limit, so a host that misbehaves cannot make the web
 * server or the Work runner hold hundreds of megabytes.
 */
const MAX_ANSWER_BYTES = 32 * 1024 * 1024;
const MAX_EXEC_ANSWER_BYTES = 4 * 1024 * 1024;
/** The host's answer when a computer (or the whole host) already runs as many commands as it allows. */
export const COMPUTER_TOO_MANY_COMMANDS =
  "The agent's computer is already running as many commands as it can at once. Try again when one finishes.";
export const HOST_TOO_MANY_COMMANDS =
  "The computer host is running as many commands as it can right now. Try again in a moment.";

async function readAnswer(res: Response, maxBytes: number, method: string): Promise<Buffer> {
  const tooLarge = (size: string) =>
    new ComputerError(COMPUTER_UNREACHABLE, `computer host ${method} answered ${res.status} with ${size} bytes, over ${maxBytes}`);
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(String(declared));
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(`more than ${maxBytes}`);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, total);
}

/** The most of each stream a command's result keeps (the host's EXEC_OUTPUT_BYTES). */
const EXEC_RESULT_BYTES = 1024 * 1024;
/**
 * The most a streamed exec answer may carry in all: two streams of at most
 * 4 MiB each (EXEC_STREAM_BYTES on the host) in base64, with the JSON around
 * each line. Read as it arrives and refused past it, like every answer.
 */
const MAX_STREAMED_EXEC_BYTES = 12 * 1024 * 1024;
/** One NDJSON line: a 64 KiB piece in base64 is about 87 KiB. */
const MAX_STREAMED_LINE_CHARS = 256 * 1024;

/** One stream of the host's exec answer: base64 bytes, decoded as UTF-8 like a same-host `docker exec`. */
function execStream(result: Record<string, unknown>, name: "stdout" | "stderr"): string {
  const encoded = result[`${name}Base64`];
  if (typeof encoded === "string") return Buffer.from(encoded, "base64").toString("utf8");
  const text = result[name];
  return typeof text === "string" ? text : "";
}

interface HostAnswer {
  status: number;
  bytes: Buffer;
  /** The host's stable error code (`no_such_container`, `path_refused`, …), or null. */
  code: string | null;
  json<T>(): T;
}

let loggedTokenRefused = false;

/** A whole host answer, with its stable error code (never its body) when it is not a 2xx. */
function hostAnswer(status: number, bytes: Buffer, method: string): HostAnswer {
  let code: string | null = null;
  if (status < 200 || status >= 300) {
    try {
      const parsed = JSON.parse(bytes.toString("utf8")) as { error?: unknown };
      code = typeof parsed.error === "string" && /^[a-z_]{1,40}$/.test(parsed.error) ? parsed.error : null;
    } catch {
      code = null;
    }
    if (status === 401 && !loggedTokenRefused) {
      loggedTokenRefused = true;
      console.error("[agent-computer] the computer host refused this server's token (COMPUTER_HOST_TOKEN)");
    }
  }
  return {
    status,
    bytes,
    code,
    json<T>() {
      try {
        return JSON.parse(bytes.toString("utf8")) as T;
      } catch {
        // Something that is not the host answered (a proxy's error page).
        throw new ComputerError(COMPUTER_UNREACHABLE, `computer host ${method} answered ${status} with no JSON`);
      }
    },
  };
}

export class RemoteComputerProvider implements ComputerProvider {
  readonly name = "remote" as const;
  private readonly origin: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { origin: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {
    this.origin = opts.origin;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? env.agentComputer.hostTimeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * One request to the host. A transport failure (refused, reset, DNS, TLS) or
   * a timeout throws COMPUTER_UNREACHABLE with a scrubbed detail; an idempotent
   * GET is retried once on a transport failure first. Every HTTP answer is
   * returned for the caller to map.
   */
  private async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, string>; json?: unknown; body?: Buffer; timeoutMs?: number; maxBytes?: number } = {}
  ): Promise<HostAnswer> {
    await afterFreeze(heldComputer(path));
    const url = new URL(path, this.origin);
    for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      body = new Uint8Array(opts.body);
    } else if (method !== "GET") {
      body = "";
    }
    const attempts = method === "GET" ? 2 : 1;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
          redirect: "error",
          cache: "no-store",
        });
        const bytes = await readAnswer(res, opts.maxBytes ?? MAX_ANSWER_BYTES, method);
        return hostAnswer(res.status, bytes, method);
      } catch (error) {
        // An answer over its size limit is already this layer's error: never retried.
        if (error instanceof ComputerError) throw error;
        lastError = error;
        const name = (error as { name?: string } | null)?.name;
        if (name === "TimeoutError" || name === "AbortError") break;
      }
    }
    const detail = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
    throw new ComputerError(COMPUTER_UNREACHABLE, `computer host ${method} failed: ${scrubComputerText(detail)}`);
  }

  /** Throws COMPUTER_UNREACHABLE for anything but a 2xx, with the host's code (never its body) in the detail. */
  private ok(answer: HostAnswer, what: string): HostAnswer {
    if (answer.status >= 200 && answer.status < 300) return answer;
    throw this.failure(answer, what, COMPUTER_UNREACHABLE);
  }

  private failure(answer: HostAnswer, what: string, sentence: string): ComputerError {
    const detail = `computer host ${what} answered ${answer.status}${answer.code ? ` ${answer.code}` : ""}`;
    console.warn("[agent-computer] computer host call failed", { detail });
    return new ComputerError(sentence, detail);
  }

  private computer(handle: ComputerHandle, action = ""): string {
    return `/v1/computers/${encodeURIComponent(handle.name)}${action ? `/${action}` : ""}`;
  }

  private preflightError(answer: HostAnswer): ComputerError | null {
    if (answer.status !== 409 || answer.code !== "preflight") return null;
    let reason = "";
    try {
      reason = String(answer.json<{ reason?: unknown }>().reason ?? "");
    } catch {
      reason = "";
    }
    return new ComputerError(
      HOST_PREFLIGHT_SENTENCES[reason] ?? "The server cannot start another computer right now.",
      `computer host preflight: ${reason}`
    );
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const answer = await this.request("GET", "/v1/available", { timeoutMs: Math.min(this.timeoutMs, 8_000) });
      if (answer.status !== 200) return { ok: false, reason: HOST_UNANSWERED };
      const result = answer.json<{ ok?: unknown; reason?: unknown }>();
      if (result.ok === true) return { ok: true };
      return { ok: false, reason: HOST_PREFLIGHT_SENTENCES[String(result.reason)] ?? HOST_UNANSWERED };
    } catch {
      return { ok: false, reason: HOST_UNANSWERED };
    }
  }

  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    const answer = this.ok(await this.request("GET", "/v1/preflight"), "preflight");
    const result = answer.json<{ ok?: unknown; reason?: unknown }>();
    if (result.ok === true) return { ok: true };
    return { ok: false, reason: HOST_PREFLIGHT_SENTENCES[String(result.reason)] ?? "The server cannot start another computer right now." };
  }

  async create(opts: { agentId: string; userId: string; cdpToken: string }): Promise<ComputerHandle> {
    const answer = await this.request("POST", "/v1/computers", {
      json: { agentId: opts.agentId, userRef: hostUserRef(opts.userId) },
      timeoutMs: Math.max(this.timeoutMs, 90_000),
    });
    const preflight = this.preflightError(answer);
    if (preflight) throw preflight;
    if (answer.status === 409 && answer.code === "name_conflict") {
      // Another environment on the same host has a computer of this name (a
      // restored staging copy shares agent ids). Never its computer: a refusal.
      throw this.failure(answer, "create", COMPUTER_NOT_RESPONDING);
    }
    const created = this.ok(answer, "create").json<{ name?: unknown; volume?: unknown }>();
    const name = `juno-agent-${opts.agentId}`;
    if (created.name !== name || created.volume !== name) {
      throw new ComputerError(COMPUTER_NOT_RESPONDING, "computer host create answered another name");
    }
    return { name, volume: name };
  }

  async start(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "start"), { timeoutMs: Math.max(this.timeoutMs, 90_000) });
    const preflight = this.preflightError(answer);
    if (preflight) throw preflight;
    if (answer.status === 404) throw this.failure(answer, "start", COMPUTER_NOT_RESPONDING);
    this.ok(answer, "start");
  }

  async pause(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "pause"));
    if (answer.status === 404) throw this.failure(answer, "pause", COMPUTER_NOT_RESPONDING);
    this.ok(answer, "pause");
  }

  async unpause(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "unpause"));
    const preflight = this.preflightError(answer);
    if (preflight) throw preflight;
    if (answer.status === 404) throw this.failure(answer, "unpause", COMPUTER_NOT_RESPONDING);
    this.ok(answer, "unpause");
  }

  /**
   * Resolves only when the computer is not running. Docker's provider ignores
   * `docker stop`'s exit status, never a failure to reach Docker; on a remote
   * host the equivalent of that failure is any answer but the host's own: a
   * 5xx (nginx while the service restarts, the broker refusing or timing out),
   * a 401, or a body that is not the host's JSON. Each throws the unreachable
   * sentence, so the store holds the sleep for the host instead of recording a
   * computer asleep that is still running. The host's 200 `{ok: false}` (a
   * nonzero `docker stop`) is checked against state(); a container that does
   * not exist is stopped.
   */
  async stop(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "stop"), { timeoutMs: Math.max(this.timeoutMs, 45_000) });
    if (answer.status === 404 && answer.code === "no_such_container") return;
    const result = this.ok(answer, "stop").json<{ ok?: unknown } | null>();
    if (result?.ok === true) return;
    const after = await this.state(handle);
    if (after === "running" || after === "paused") {
      throw new ComputerError(COMPUTER_UNREACHABLE, "computer host stop left the computer running");
    }
  }

  async destroy(handle: ComputerHandle, opts?: { removeVolume?: boolean }): Promise<void> {
    if (handle.volume !== handle.name) {
      throw new ComputerError(COMPUTER_NOT_RESPONDING, "computer host handles name their volume after the container");
    }
    const answer = await this.request("DELETE", this.computer(handle), {
      query: opts?.removeVolume ? { volumes: "1" } : {},
      timeoutMs: Math.max(this.timeoutMs, 90_000),
    });
    if (answer.status === 404) return;
    this.ok(answer, "destroy");
  }

  async state(handle: ComputerHandle): Promise<"running" | "paused" | "exited" | "missing"> {
    const answer = await this.request("GET", this.computer(handle, "state"));
    // Missing only when the host says the container does not exist. Any other
    // answer (5xx, a name another environment holds, a timeout) is the host
    // failing, never a deleted computer that should be recreated.
    if (answer.status === 404 && answer.code === "no_such_container") return "missing";
    const { state } = this.ok(answer, "state").json<{ state?: unknown }>();
    return state === "running" || state === "paused" ? state : "exited";
  }

  async endpoints(handle: ComputerHandle, opts?: { purpose?: EndpointPurpose }): Promise<Endpoints> {
    const purpose = opts?.purpose;
    const ticket = async (port: 9222 | 5900): Promise<string> => {
      const answer = this.ok(await this.request("POST", this.computer(handle, "tickets"), { json: { port } }), "ticket");
      const { ticket: value } = answer.json<{ ticket?: unknown }>();
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
        throw new ComputerError(COMPUTER_UNREACHABLE, "computer host ticket was malformed");
      }
      return value;
    };
    const endpoints: Endpoints = { cdpUrl: "", vncHost: "", vncPort: 5900 };
    if (purpose !== "vnc") {
      endpoints.cdpUrl = tunnelUrl(this.origin);
      endpoints.cdpHeaders = { "X-Juno-Tunnel-Ticket": await ticket(9222) };
    }
    if (purpose !== "cdp") {
      endpoints.vncTunnel = { origin: this.origin, ticket: await ticket(5900) };
    }
    return endpoints;
  }

  async screenshot(handle: ComputerHandle): Promise<Shot> {
    const answer = await this.request("GET", this.computer(handle, "screenshot"));
    if (answer.status !== 200 || answer.bytes.byteLength === 0) throw this.failure(answer, "screenshot", COMPUTER_NOT_RESPONDING);
    const jpeg = await sharp(answer.bytes).jpeg({ quality: 70 }).toBuffer();
    return { jpeg, width: 1280, height: 800, sha256: createHash("sha256").update(jpeg).digest("hex") };
  }

  private async input(handle: ComputerHandle, body: Record<string, unknown>): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "input"), { json: body, timeoutMs: Math.max(this.timeoutMs, 70_000) });
    if (answer.status === 409 || answer.status === 404 || answer.status === 400) {
      throw this.failure(answer, "input", COMPUTER_NOT_RESPONDING);
    }
    this.ok(answer, "input");
  }

  async click(handle: ComputerHandle, opts: { x: number; y: number; button?: "left" | "right" | "double" }): Promise<void> {
    await this.input(handle, { kind: "click", x: opts.x, y: opts.y, ...(opts.button ? { button: opts.button } : {}) });
  }

  async type(handle: ComputerHandle, text: string): Promise<void> {
    await this.input(handle, { kind: "type", text });
  }

  async key(handle: ComputerHandle, keys: string): Promise<void> {
    if (!keys.trim()) throw new ComputerError("Say which key to press.");
    await this.input(handle, { kind: "key", keys });
  }

  async scroll(handle: ComputerHandle, opts: { x: number; y: number; dx?: number; dy?: number }): Promise<void> {
    await this.input(handle, { kind: "scroll", x: opts.x, y: opts.y, dx: opts.dx ?? null, dy: opts.dy ?? null });
  }

  async drag(handle: ComputerHandle, opts: { x1: number; y1: number; x2: number; y2: number }): Promise<void> {
    await this.input(handle, { kind: "drag", ...opts });
  }

  async exec(handle: ComputerHandle, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const seconds = Math.max(1, Math.min(300, Math.round(opts?.timeoutSeconds ?? 30)));
    const body = { command, timeoutSeconds: seconds, ...(opts?.cwd ? { cwd: opts.cwd } : {}) };
    if (opts?.onOutput) return this.execStreamed(handle, body, seconds, opts.onOutput);
    const answer = await this.request("POST", this.computer(handle, "exec"), {
      json: body,
      timeoutMs: (seconds + 20) * 1000,
      maxBytes: MAX_EXEC_ANSWER_BYTES,
    });
    return this.execResult(answer);
  }

  /** A whole (buffered) exec answer, or a refusal before the command ran, as the provider's result or error. */
  private execResult(answer: HostAnswer): ExecResult {
    if (answer.status === 422) throw this.failure(answer, "exec", COMPUTER_PATH_REFUSED);
    if (answer.status === 429 && answer.code === "too_many_commands") {
      let scope = "";
      try {
        scope = String(answer.json<{ scope?: unknown }>().scope ?? "");
      } catch {
        scope = "";
      }
      throw this.failure(answer, "exec", scope === "host" ? HOST_TOO_MANY_COMMANDS : COMPUTER_TOO_MANY_COMMANDS);
    }
    // stdoutBase64 / stderrBase64: each stream's first 1 MiB, the bytes as the command wrote them.
    const result = this.ok(answer, "exec").json<Partial<ExecResult> & Record<string, unknown>>();
    return {
      stdout: execStream(result, "stdout"),
      stderr: execStream(result, "stderr"),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      timedOut: result.timedOut === true,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
    };
  }

  /**
   * A watched command (S5.1): `Accept: application/x-ndjson`, and the host
   * answers one line per piece of output as the command writes it, then a
   * last line with the exit status. Each piece goes to `onOutput` as it
   * arrives (decoded as UTF-8 across pieces); the result keeps the first MiB
   * of each stream, exactly as a buffered answer does. A refusal before the
   * command ran is an ordinary answer and is mapped as one; a host that does
   * not stream answers whole, and its output is handed over at the end.
   */
  private async execStreamed(
    handle: ComputerHandle,
    body: Record<string, unknown>,
    seconds: number,
    onOutput: NonNullable<ExecOptions["onOutput"]>
  ): Promise<ExecResult> {
    const unreachable = (detail: string) =>
      new ComputerError(COMPUTER_UNREACHABLE, `computer host exec ${scrubComputerText(detail)}`);
    const deliver = (stream: "stdout" | "stderr", text: string) => {
      if (!text) return;
      try {
        onOutput({ stream, text });
      } catch {
        // Watching a command never fails it.
      }
    };
    await afterFreeze(handle.name);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(this.computer(handle, "exec"), this.origin), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout((seconds + 20) * 1000),
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      throw unreachable(`failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.includes("application/x-ndjson") || !res.body) {
      const result = this.execResult(hostAnswer(res.status, await readAnswer(res, MAX_EXEC_ANSWER_BYTES, "POST"), "POST"));
      deliver("stdout", result.stdout);
      deliver("stderr", result.stderr);
      return result;
    }

    const kept = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const keptSize = { stdout: 0, stderr: 0 };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let last: Record<string, unknown> | null = null;
    const takeLine = (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw unreachable("answered a line that is not JSON");
      }
      if (value.stream === "stdout" || value.stream === "stderr") {
        if (typeof value.data_b64 !== "string") return;
        const bytes = Buffer.from(value.data_b64, "base64");
        const stream = value.stream;
        const room = EXEC_RESULT_BYTES - keptSize[stream];
        if (room > 0) {
          const piece = bytes.byteLength > room ? bytes.subarray(0, room) : bytes;
          kept[stream].push(piece);
          keptSize[stream] += piece.byteLength;
        }
        deliver(stream, decoders[stream].write(bytes));
        return;
      }
      if (typeof value.error === "string") {
        const code = /^[a-z_]{1,40}$/.test(value.error) ? value.error : "unknown";
        console.warn("[agent-computer] computer host call failed", { detail: `computer host exec failed mid-answer: ${code}` });
        throw new ComputerError(COMPUTER_UNREACHABLE, `computer host exec failed mid-answer: ${code}`);
      }
      if ("exit" in value) last = value;
    };

    const reader = res.body.getReader();
    const text = new TextDecoder("utf-8");
    let buffered = "";
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_STREAMED_EXEC_BYTES) throw unreachable(`answered more than ${MAX_STREAMED_EXEC_BYTES} bytes`);
        buffered += text.decode(value, { stream: true });
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          takeLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
        if (buffered.length > MAX_STREAMED_LINE_CHARS) throw unreachable("answered a line that is too long");
      }
      takeLine(buffered + text.decode());
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof ComputerError) throw error;
      throw unreachable(`failed while answering: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
    const final = last as Record<string, unknown> | null;
    if (!final) throw unreachable("answer ended before the command did");
    deliver("stdout", decoders.stdout.end());
    deliver("stderr", decoders.stderr.end());
    return {
      stdout: Buffer.concat(kept.stdout, keptSize.stdout).toString("utf8"),
      stderr: Buffer.concat(kept.stderr, keptSize.stderr).toString("utf8"),
      exitCode: typeof final.exit === "number" ? final.exit : 1,
      timedOut: final.timedOut === true,
      durationMs: typeof final.durationMs === "number" ? final.durationMs : 0,
    };
  }

  async listFiles(handle: ComputerHandle, dir = "/home/agent/work"): Promise<ComputerFileEntry[]> {
    const answer = await this.request("GET", this.computer(handle, "files"), { query: { path: dir } });
    if (answer.status === 422) throw this.failure(answer, "list", COMPUTER_PATH_REFUSED);
    const entries = this.ok(answer, "list").json<unknown>();
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((raw): ComputerFileEntry[] => {
      const entry = raw as Partial<ComputerFileEntry>;
      if (typeof entry.name !== "string" || typeof entry.path !== "string") return [];
      const type = entry.type === "dir" || entry.type === "file" ? entry.type : "other";
      return [{
        name: entry.name,
        path: entry.path,
        type,
        size: typeof entry.size === "number" ? entry.size : 0,
        ...(typeof entry.modifiedAt === "string" ? { modifiedAt: entry.modifiedAt } : {}),
      }];
    });
  }

  async readFile(handle: ComputerHandle, path: string, opts?: { maxBytes?: number }): Promise<Buffer> {
    const maxBytes = opts?.maxBytes ?? 5 * 1024 * 1024;
    const answer = await this.request("GET", this.computer(handle, "files/content"), {
      query: { path, maxBytes: String(maxBytes) },
      timeoutMs: Math.max(this.timeoutMs, 70_000),
      maxBytes: maxBytes + 64 * 1024,
    });
    if (answer.status === 422 && answer.code === "path_refused") throw this.failure(answer, "read", COMPUTER_PATH_REFUSED);
    if (answer.status === 422) throw this.failure(answer, "read", "That file could not be read.");
    const bytes = this.ok(answer, "read").bytes;
    return bytes.byteLength > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
  }

  async writeFile(
    handle: ComputerHandle,
    path: string,
    content: Buffer | string,
    opts?: { by?: "agent" | "person" }
  ): Promise<void> {
    const body = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const answer = await this.request("PUT", this.computer(handle, "files/content"), {
      query: { path, by: opts?.by === "person" ? "person" : "agent" },
      body,
      timeoutMs: Math.max(this.timeoutMs, 70_000),
    });
    if (answer.status === 422 && answer.code === "write_refused") throw new Error(WRITE_REFUSED);
    if (answer.status === 422) throw this.failure(answer, "write", COMPUTER_PATH_REFUSED);
    if (answer.status === 409) throw this.failure(answer, "write", COMPUTER_NOT_RESPONDING);
    this.ok(answer, "write");
  }

  async diskUsageMb(handle: ComputerHandle): Promise<number> {
    const { mb } = this.ok(await this.request("GET", this.computer(handle, "disk"), { timeoutMs: Math.max(this.timeoutMs, 70_000) }), "disk")
      .json<{ mb?: unknown }>();
    return typeof mb === "number" && Number.isFinite(mb) ? mb : 0;
  }

  async fileInfo(handle: ComputerHandle, path: string): Promise<{ type: "file" | "dir" | "other"; size: number; path: string } | null> {
    const answer = await this.request("GET", this.computer(handle, "files/info"), { query: { path } });
    if (answer.status === 422) throw this.failure(answer, "info", COMPUTER_PATH_REFUSED);
    const info = this.ok(answer, "info").json<{ type?: unknown; size?: unknown; path?: unknown } | null>();
    if (!info || typeof info.path !== "string") return null;
    return {
      path: info.path,
      size: typeof info.size === "number" ? info.size : 0,
      type: info.type === "file" || info.type === "dir" ? info.type : "other",
    };
  }

  async provisionCdpToken(handle: ComputerHandle, token: string): Promise<void> {
    // The host waits (up to 30 s) until the gate has taken the token, so the
    // first browser connection after a wake is not refused.
    this.ok(
      await this.request("PUT", this.computer(handle, "cdp-token"), {
        body: Buffer.from(token, "utf8"),
        timeoutMs: Math.max(this.timeoutMs, 45_000),
      }),
      "token"
    );
  }

  async isVncRunning(handle: ComputerHandle): Promise<boolean> {
    const { running } = this.ok(await this.request("GET", this.computer(handle, "vnc")), "vnc").json<{ running?: unknown }>();
    return running === true;
  }

  async listOwned(): Promise<{
    containers: Array<{ name: string; agentId: string | null; userId: string | null; state: "running" | "paused" | "exited" }>;
    volumes: string[];
  }> {
    const owned = this.ok(await this.request("GET", "/v1/owned"), "owned").json<{ containers?: unknown; volumes?: unknown }>();
    const containers = (Array.isArray(owned.containers) ? owned.containers : []).flatMap((raw) => {
      const c = raw as { name?: unknown; agentId?: unknown; userId?: unknown; state?: unknown };
      if (typeof c.name !== "string" || !c.name.startsWith("juno-agent-")) return [];
      return [{
        name: c.name,
        agentId: typeof c.agentId === "string" ? c.agentId : null,
        userId: typeof c.userId === "string" ? c.userId : null,
        state: c.state === "running" ? ("running" as const) : c.state === "paused" ? ("paused" as const) : ("exited" as const),
      }];
    });
    const volumes = (Array.isArray(owned.volumes) ? owned.volumes : []).filter(
      (name): name is string => typeof name === "string" && name.startsWith("juno-agent-")
    );
    return { containers, volumes };
  }

  async startVnc(handle: ComputerHandle, opts: { controlPassword: string; viewPassword: string }): Promise<void> {
    this.ok(
      await this.request("PUT", this.computer(handle, "vnc"), {
        json: { controlPassword: opts.controlPassword, viewPassword: opts.viewPassword },
        timeoutMs: Math.max(this.timeoutMs, 60_000),
      }),
      "vnc start"
    );
  }

  /**
   * Like Docker's, `pkill`'s exit status is ignored (the host answers 200
   * whatever it was), and a container that does not exist has no session. Any
   * other answer (the broker refused or timed out, nginx with no service
   * behind it) throws the unreachable sentence: ending the person's session is
   * what a take over's release counts on before it thaws the agent, so a stop
   * that may not have happened is never reported as done.
   */
  async stopVnc(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("DELETE", this.computer(handle, "vnc"));
    if (answer.status === 404 && answer.code === "no_such_container") return;
    this.ok(answer, "vnc stop").json<unknown>();
  }

  async freezeAgent(handle: ComputerHandle): Promise<void> {
    return holdingLaunches(handle.name, () => this.freezeNow(handle));
  }

  private async freezeNow(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "freeze"), { timeoutMs: Math.max(this.timeoutMs, 90_000) });
    if (answer.status !== 200) throw this.failure(answer, "freeze", answer.status >= 500 && answer.code !== "freeze_failed" ? COMPUTER_UNREACHABLE : COMPUTER_NOT_RESPONDING);
  }

  async thawAgent(handle: ComputerHandle): Promise<void> {
    const answer = await this.request("POST", this.computer(handle, "thaw"), { timeoutMs: Math.max(this.timeoutMs, 60_000) });
    if (answer.status !== 200) throw this.failure(answer, "thaw", COMPUTER_NOT_RESPONDING);
  }

  async browserSandbox(handle: ComputerHandle): Promise<"on" | "off" | "unknown"> {
    const answer = await this.request("GET", this.computer(handle, "browser-sandbox"), { timeoutMs: Math.max(this.timeoutMs, 45_000) });
    if (answer.status === 409 && answer.code === "sandbox_check_failed") {
      throw new ComputerError(COMPUTER_SAFETY_CHECK_FAILED, "the agent's uid created a user namespace");
    }
    const { state } = this.ok(answer, "browser sandbox").json<{ state?: unknown }>();
    return state === "on" || state === "off" ? state : "unknown";
  }

  async isOutdated(handle: ComputerHandle): Promise<boolean> {
    const { outdated } = this.ok(await this.request("GET", this.computer(handle, "outdated")), "outdated").json<{ outdated?: unknown }>();
    return outdated === true;
  }

  async imageInfo(): Promise<{ id: string; label: string; createdAt: string }> {
    const image = this.ok(await this.request("GET", "/v1/image"), "image").json<{ id?: unknown; label?: unknown; createdAt?: unknown }>();
    return {
      id: typeof image.id === "string" ? image.id : "",
      label: typeof image.label === "string" ? image.label : "",
      createdAt: typeof image.createdAt === "string" ? image.createdAt : "",
    };
  }
}

let memo: { key: string; provider: RemoteComputerProvider | null } | null = null;
const loggedRefusals = new Set<string>();

/**
 * The remote provider for COMPUTER_PROVIDER=remote, or null (logged once per
 * reason) when the host URL or token cannot be used. Rebuilt when the
 * configuration changes.
 */
export function remoteComputerProvider(): RemoteComputerProvider | null {
  const url = env.agentComputer.hostUrl;
  const token = env.agentComputer.hostToken;
  const timeoutMs = env.agentComputer.hostTimeoutMs;
  const key = createHash("sha256").update([url, token, String(timeoutMs), process.env.NODE_ENV ?? ""].join("\n")).digest("hex");
  if (memo?.key === key) return memo.provider;
  const config = remoteHostConfig({ url, token });
  if (!config.ok) {
    if (!loggedRefusals.has(config.reason)) {
      loggedRefusals.add(config.reason);
      console.error(`[agent-computer] COMPUTER_PROVIDER=remote is off: ${config.reason}`);
    }
    memo = { key, provider: null };
    return null;
  }
  memo = { key, provider: new RemoteComputerProvider({ origin: config.origin, token: config.token, timeoutMs }) };
  return memo.provider;
}

/** Test seam: forget the memoized provider and the logged refusals. */
export function resetRemoteComputerProviderForTest(): void {
  memo = null;
  loggedRefusals.clear();
  loggedTokenRefused = false;
}
