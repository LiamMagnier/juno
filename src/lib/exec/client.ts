/**
 * HTTP client for juno-exec's v1 API (deploy/exec-host/juno-exec.py).
 *
 * Every request carries the bearer token and a bounded timeout combined with
 * the caller's signal. Inputs and skill bundles go up one file at a time as
 * raw bodies (no base64 JSON in the web process); produced files come down one
 * at a time and are checked against the digest the host recorded.
 *
 * Failures are typed so the runtime can tell "nothing ran" from "unknown":
 * `ExecUnavailableError` (network, 5xx, busy), `ExecRefusedError` (4xx with a
 * stable code), and a 404 as `ExecRefusedError` with status 404.
 */
import { createHash } from "node:crypto";
import type { ExecEndpoint } from "@/lib/exec/config";
import type { ExecLanguage, HostRunStatus } from "@/lib/exec/types";

export class ExecUnavailableError extends Error {
  override readonly name = "ExecUnavailableError";
  constructor(
    message: string,
    /** True when the request may have reached the host (a timeout or reset mid-request). */
    readonly ambiguous = false,
  ) {
    super(message);
  }
}

export class ExecRefusedError extends Error {
  override readonly name = "ExecRefusedError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HostStreamSlice {
  head: string;
  tail: string;
  bytes: number;
  storedBytes: number;
}

export interface HostFileEntry {
  path: string;
  bytes: number;
  sha256: string;
  mime: string;
}

export interface HostRunSnapshot {
  id: string;
  session: string;
  status: HostRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  timeoutMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  files: HostFileEntry[];
  skippedFiles: Array<{ path: string; bytes: number; reason: string }>;
  error: string | null;
  context: "hosted_sandbox";
  network: "none";
  stdout?: HostStreamSlice;
  stderr?: HostStreamSlice;
  replayed?: boolean;
}

export interface HostManifest {
  runtimes?: { python?: string | null; javascript?: string | null; bash?: string | null };
  pythonPackages?: Array<{ name: string; version: string }>;
  network?: string;
  error?: string;
}

export interface StartRunBody {
  session: string;
  account: string;
  language: ExecLanguage;
  code: string;
  timeoutMs: number;
  skills?: string[];
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Failures that happen before a request is sent: nothing reached the host.
 * Everything else (a timeout, a reset, a socket closed mid-response, an error
 * this list does not know) MAY have reached it, and for a start that means a
 * run may exist. Saying "nothing was run" about a run that ran is the worse
 * mistake, so the list names what is certain and the rest is ambiguous.
 */
const NOT_SENT = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_INVALID_URL",
]);
const TRANSFER_TIMEOUT_MS = 120_000;

function combine(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class JunoExecClient {
  constructor(private readonly endpoint: ExecEndpoint) {}

  private async request(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.endpoint.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.endpoint.token}`, ...(init.headers ?? {}) },
        body: init.body,
        signal: combine(init.signal, init.timeoutMs ?? REQUEST_TIMEOUT_MS),
        cache: "no-store",
        // The host never redirects; a redirect is a misconfiguration (or worse),
        // and following it would send the bearer token on.
        redirect: "error",
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const name = error instanceof Error ? error.name : "";
      // A timeout or a reset after the request was sent may have reached the
      // host; a refused connection did not. The runtime keeps the two apart.
      const cause = (error as { cause?: { code?: string } })?.cause?.code ?? "";
      const ambiguous = !NOT_SENT.has(cause);
      throw new ExecUnavailableError(`The execution host could not be reached (${cause || name || "network"}).`, ambiguous);
    }
    if (response.status >= 500) {
      const code = await response.json().then((body: { error?: string }) => body.error ?? "", () => "");
      throw new ExecUnavailableError(`The execution host answered ${response.status}${code ? ` (${code})` : ""}.`);
    }
    if (response.status >= 400) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new ExecRefusedError(response.status, body.error ?? "refused", body.message ?? `HTTP ${response.status}`);
    }
    return response;
  }

  private async json<T>(method: string, path: string, init?: Parameters<JunoExecClient["request"]>[2]): Promise<T> {
    const response = await this.request(method, path, init);
    return (await response.json()) as T;
  }

  health(signal?: AbortSignal): Promise<{ ok: boolean; egress: string; runsStarted?: number; image?: string }> {
    return this.json("GET", "/v1/health", { signal, timeoutMs: 5_000 });
  }

  manifest(signal?: AbortSignal): Promise<HostManifest> {
    return this.json("GET", "/v1/manifest", { signal, timeoutMs: 90_000 });
  }

  async putInput(session: string, name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ sha256: string }> {
    return this.json("PUT", `/v1/sessions/${session}/inputs/${encodeURIComponent(name)}`, {
      body: bytes as unknown as BodyInit,
      headers: { "Content-Type": "application/octet-stream" },
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
  }

  async putSkill(session: string, slug: string, tar: Uint8Array, signal?: AbortSignal): Promise<{ sha256: string; reused: boolean }> {
    const digest = createHash("sha256").update(tar).digest("hex");
    return this.json("PUT", `/v1/sessions/${session}/skills/${encodeURIComponent(slug)}`, {
      body: tar as unknown as BodyInit,
      headers: { "Content-Type": "application/x-tar", "X-Bundle-Digest": digest },
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
  }

  async startRun(body: StartRunBody, idempotencyKey: string, signal?: AbortSignal): Promise<HostRunSnapshot> {
    const response = await this.request("POST", "/v1/runs", {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      signal,
    });
    // The host answered 2xx: it has the run. Losing the body now (a reset, a
    // timeout mid-read) must not read as "nothing was run".
    let snapshot: HostRunSnapshot;
    try {
      snapshot = (await response.json()) as HostRunSnapshot;
    } catch {
      throw new ExecUnavailableError("The execution host accepted the run but its answer was lost.", true);
    }
    if (!snapshot || typeof snapshot.id !== "string" || !/^r_[0-9a-f]{24}$/.test(snapshot.id)) {
      throw new ExecUnavailableError("The execution host accepted the run but its answer was unreadable.", true);
    }
    return snapshot;
  }

  getRun(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<HostRunSnapshot> {
    const wait = Math.max(0, Math.min(25, Math.floor(waitSeconds)));
    return this.json("GET", `/v1/runs/${encodeURIComponent(id)}?wait=${wait}`, { signal, timeoutMs: (wait + 15) * 1000 });
  }

  /**
   * The run's live stdout/stderr as server-sent events, from `after` on, until
   * the run ends. Each chunk is `{ seq, stream, text }`; the last item is the
   * end with the final status. Resumable: pass the last `seq` seen.
   */
  async *events(
    id: string,
    after = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<{ seq: number; stream: "stdout" | "stderr" | "notice"; text: string } | { end: true; status: HostRunStatus; exitCode: number | null }> {
    const response = await this.request("GET", `/v1/runs/${encodeURIComponent(id)}/events?after=${Math.max(0, after)}`, {
      signal,
      timeoutMs: 31 * 60_000,
    });
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        const event = /^event: (\w+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!event || !data) continue;
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (event === "chunk") yield parsed as { seq: number; stream: "stdout" | "stderr" | "notice"; text: string };
        if (event === "end") {
          yield { end: true, status: parsed.status as HostRunStatus, exitCode: (parsed.exitCode as number | null) ?? null };
          return;
        }
      }
    }
  }

  cancel(id: string, signal?: AbortSignal): Promise<HostRunSnapshot> {
    return this.json("POST", `/v1/runs/${encodeURIComponent(id)}/cancel`, { signal, timeoutMs: 15_000 });
  }

  async output(
    id: string,
    stream: "stdout" | "stderr",
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; totalBytes: number; truncated: boolean }> {
    const response = await this.request(
      "GET",
      `/v1/runs/${encodeURIComponent(id)}/output?stream=${stream}&offset=${Math.max(0, offset)}&limit=${Math.max(1, limit)}`,
      { signal, timeoutMs: TRANSFER_TIMEOUT_MS },
    );
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      totalBytes: Number(response.headers.get("x-total-bytes") ?? 0),
      truncated: response.headers.get("x-truncated") === "1",
    };
  }

  files(id: string, signal?: AbortSignal): Promise<{ files: HostFileEntry[]; skipped: HostRunSnapshot["skippedFiles"] }> {
    return this.json("GET", `/v1/runs/${encodeURIComponent(id)}/files`, { signal });
  }

  /** One produced file, verified against the host's digest. */
  async downloadFile(id: string, entry: HostFileEntry, signal?: AbortSignal): Promise<Uint8Array> {
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    const response = await this.request("GET", `/v1/runs/${encodeURIComponent(id)}/files/${path}`, {
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== entry.sha256 || bytes.byteLength !== entry.bytes) {
      throw new ExecRefusedError(409, "file_changed", `${entry.path} changed after the run finished.`);
    }
    return bytes;
  }

  async deleteSession(session: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/v1/sessions/${session}`, { signal }).catch((error: unknown) => {
      if (error instanceof ExecRefusedError && error.status === 404) return;
      throw error;
    });
  }
}
