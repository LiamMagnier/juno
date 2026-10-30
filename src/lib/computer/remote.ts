import "server-only";
import { createHash } from "node:crypto";
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
  ExecResult,
  Shot,
} from "./types";

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

/** The host's tunnel URL for an origin: wss for https, ws for (loopback) http. */
export function tunnelUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/tunnel";
  return url.toString();
}

interface HostAnswer {
  status: number;
  bytes: Buffer;
  /** The host's stable error code (`no_such_container`, `path_refused`, …), or null. */
  code: string | null;
  json<T>(): T;
}

let loggedTokenRefused = false;

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
    opts: { query?: Record<string, string>; json?: unknown; body?: Buffer; timeoutMs?: number } = {}
  ): Promise<HostAnswer> {
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
        const bytes = Buffer.from(await res.arrayBuffer());
        let code: string | null = null;
        if (!res.ok) {
          try {
            const parsed = JSON.parse(bytes.toString("utf8")) as { error?: unknown };
            code = typeof parsed.error === "string" && /^[a-z_]{1,40}$/.test(parsed.error) ? parsed.error : null;
          } catch {
            code = null;
          }
          if (res.status === 401 && !loggedTokenRefused) {
            loggedTokenRefused = true;
            console.error("[agent-computer] the computer host refused this server's token (COMPUTER_HOST_TOKEN)");
          }
        }
        return {
          status: res.status,
          bytes,
          code,
          json<T>() {
            return JSON.parse(bytes.toString("utf8")) as T;
          },
        };
      } catch (error) {
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

  /** Like Docker's (which ignores the exit status): only a host that cannot be reached at all throws. */
  async stop(handle: ComputerHandle): Promise<void> {
    await this.request("POST", this.computer(handle, "stop"), { timeoutMs: Math.max(this.timeoutMs, 45_000) });
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

  async exec(handle: ComputerHandle, command: string, opts?: { timeoutSeconds?: number; cwd?: string }): Promise<ExecResult> {
    const seconds = Math.max(1, Math.min(300, Math.round(opts?.timeoutSeconds ?? 30)));
    const answer = await this.request("POST", this.computer(handle, "exec"), {
      json: { command, timeoutSeconds: seconds, ...(opts?.cwd ? { cwd: opts.cwd } : {}) },
      timeoutMs: (seconds + 20) * 1000,
    });
    if (answer.status === 422) throw this.failure(answer, "exec", COMPUTER_PATH_REFUSED);
    const result = this.ok(answer, "exec").json<Partial<ExecResult>>();
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: typeof result.exitCode === "number" ? result.exitCode : 1,
      timedOut: result.timedOut === true,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
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
    this.ok(await this.request("PUT", this.computer(handle, "cdp-token"), { body: Buffer.from(token, "utf8") }), "token");
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

  /** Like Docker's (which ignores the exit status): only a host that cannot be reached at all throws. */
  async stopVnc(handle: ComputerHandle): Promise<void> {
    await this.request("DELETE", this.computer(handle, "vnc"));
  }

  async freezeAgent(handle: ComputerHandle): Promise<void> {
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
