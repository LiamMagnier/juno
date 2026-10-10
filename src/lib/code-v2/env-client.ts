/**
 * Client for the env-server wire protocol (contracts.ts "Env-server wire
 * protocol"; SPEC §3.1). One client per connection; it correlates commands
 * with responses, keeps one `SessionView` per opened session using the
 * snapshot + cursor rules, re-opens with `afterSequence` on a gap or after a
 * reconnect, and coalesces bursts of deltas into ≤ 50 ms renders.
 *
 * Transports:
 * - `WebSocketTransport`: direct, for a reachable env server (the Mac app's
 *   web view, a local dev server, a future relay socket).
 * - `DeviceLinkTransport`: the hosted web reaching the user's Mac through the
 *   device command relay (`/api/code/v2/link/[deviceId]`), long-polling events
 *   by cursor instead of the old 1.2 s task poll.
 *
 * No React here; `useEnvSession` (components/code/v2) wraps it.
 */
import {
  CODE_V2_PROTOCOL,
  type ClientCommand,
  type ClientCommandParams,
  type ClientCommandResults,
  type ClientCommandType,
  type ProviderAuthAction,
  type ProviderAuthState,
  type ProviderInstallAction,
  type ProviderInstallState,
  type ProviderInstance,
  type ScheduledResume,
  type ServerEventEnvelope,
  type ServerMessage,
  type ServerResponse,
  type UserInput,
} from "@/lib/code-v2/contracts";
import { applyCoalesced, emptySessionView, type SessionView } from "@/lib/code-v2/session-store";

export type TransportStatus = "connecting" | "open" | "closed";

export interface EnvTransport {
  send(command: ClientCommand): void;
  onMessage(listener: (message: ServerMessage) => void): () => void;
  onStatus(listener: (status: TransportStatus) => void): () => void;
  /** Tell a polling transport which cursors to poll from (no-op for sockets). */
  setCursors?(cursors: Record<string, number>): void;
  close(): void;
}

export class EnvRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EnvRequestError";
  }
}

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface EnvClientOptions {
  timeoutMs?: number;
  /** Delta coalescing window (SPEC §3.1: 50 ms). 0 = flush synchronously (tests). */
  coalesceMs?: number;
  scheduler?: Scheduler;
  idFactory?: () => string;
}

export interface SessionSubscription {
  readonly sessionId: string;
  view(): SessionView;
  close(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: unknown;
}

interface OpenSession {
  id: string;
  cwd: string;
  view: SessionView;
  listeners: Set<(view: SessionView) => void>;
  buffer: ServerEventEnvelope[];
  flushTimer: unknown;
  reopening: boolean;
}

let counter = 0;
const defaultId = () => `c${Date.now().toString(36)}${(counter++).toString(36)}`;

export class EnvClient {
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, OpenSession>();
  /** Events for a session whose `session.open` response has not landed yet. */
  private readonly early = new Map<string, ServerEventEnvelope[]>();
  private readonly globalListeners = new Set<(envelope: ServerEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private status: TransportStatus = "connecting";
  private readonly timeoutMs: number;
  private readonly coalesceMs: number;
  private readonly scheduler: Scheduler;
  private readonly nextId: () => string;

  constructor(
    private readonly transport: EnvTransport,
    options: EnvClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.coalesceMs = options.coalesceMs ?? 50;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.nextId = options.idFactory ?? defaultId;
    this.unsubscribe.push(transport.onMessage((m) => this.handle(m)));
    this.unsubscribe.push(
      transport.onStatus((s) => {
        const wasOpen = this.status === "open";
        this.status = s;
        for (const l of this.statusListeners) l(s);
        if (s === "open" && !wasOpen) this.reopenAll();
        if (s === "closed") this.failPending("Connection closed.");
      }),
    );
  }

  get connectionStatus(): TransportStatus {
    return this.status;
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Global stream: provider updates and terminal output. */
  onGlobal(listener: (envelope: ServerEventEnvelope) => void): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  request<T extends ClientCommandType>(type: T, params: ClientCommandParams[T]): Promise<ClientCommandResults[T]> {
    const id = this.nextId();
    const command = { id, type, params } as ClientCommand;
    return new Promise<ClientCommandResults[T]>((resolve, reject) => {
      const timer = this.scheduler.setTimeout(() => {
        this.pending.delete(id);
        reject(new EnvRequestError("timeout", "Your Mac did not answer in time."));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.transport.send(command);
      } catch (err) {
        this.scheduler.clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Open (or resume) a session and follow it. `listener` gets every new view. */
  async openSession(
    params: ClientCommandParams["session.open"],
    listener: (view: SessionView) => void,
  ): Promise<SessionSubscription> {
    const result = await this.request("session.open", params);
    const sessionId = result.sessionId;
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        cwd: params.cwd,
        view: emptySessionView(sessionId, params.selection ?? { instanceId: "alevr", model: "" }, params.cwd),
        listeners: new Set(),
        buffer: [],
        flushTimer: null,
        reopening: false,
      };
      this.sessions.set(sessionId, s);
    }
    s.listeners.add(listener);
    const session = s;
    const early = this.early.get(sessionId);
    if (early) {
      this.early.delete(sessionId);
      session.buffer.push(...early);
      this.flush(session);
    }
    this.syncCursors();
    return {
      sessionId,
      view: () => session.view,
      close: () => {
        session.listeners.delete(listener);
        if (session.listeners.size === 0) {
          if (session.flushTimer) this.scheduler.clearTimeout(session.flushTimer);
          this.sessions.delete(sessionId);
          this.syncCursors();
        }
      },
    };
  }

  close(): void {
    for (const u of this.unsubscribe) u();
    this.failPending("Client closed.");
    for (const s of this.sessions.values()) if (s.flushTimer) this.scheduler.clearTimeout(s.flushTimer);
    this.sessions.clear();
    this.transport.close();
  }

  // Convenience wrappers.
  listProviders(): Promise<ProviderInstance[]> {
    return this.request("provider.list", {}).then((r) => r.instances);
  }

  /**
   * Reverts rejected hunks on the Mac: `patch` is `rejectedPatch(file, decisions)`
   * from diff.ts (already the reverse), applied all or nothing in the session's
   * folder. `checkOnly` asks whether it still applies without writing.
   */
  applyPatch(sessionId: string, patch: string, options: { reverse?: boolean; checkOnly?: boolean } = {}): Promise<ClientCommandResults["checkpoint.applyPatch"]> {
    return this.request("checkpoint.applyPatch", { sessionId, patch, ...(options.reverse ? { reverse: true } : {}), ...(options.checkOnly ? { checkOnly: true } : {}) });
  }

  /** Resume a limited session by itself at `at` (default: its own reset time). */
  scheduleResume(sessionId: string, options: { at?: string; input?: UserInput } = {}): Promise<ScheduledResume> {
    return this.request("turn.schedule", { sessionId, ...options }).then((r) => r.schedule);
  }

  cancelScheduledResume(sessionId: string, scheduleId?: string): Promise<boolean> {
    return this.request("turn.unschedule", { sessionId, ...(scheduleId ? { scheduleId } : {}) }).then((r) => r.cancelled);
  }

  /** Managed runtimes (Antigravity): download Google's runtime, cancel it, or remove it. */
  providerInstall(instanceId: string, action: ProviderInstallAction, operationId?: string): Promise<ProviderInstallState> {
    return this.request("provider.install", { instanceId, action, ...(operationId ? { operationId } : {}) }).then((r) => r.install);
  }

  /**
   * Google sign-in for a managed runtime. `start` returns at once; the
   * authorization URL arrives on the instance (`provider.updated`, `auth.phase
   * === "waiting"`). From a device other than the Mac, `complete` sends the
   * address Google's page ended on.
   */
  providerAuth(instanceId: string, action: ProviderAuthAction, options: { flowId?: string; callbackUrl?: string } = {}): Promise<ProviderAuthState> {
    return this.request("provider.auth", { instanceId, action, ...options }).then((r) => r.auth);
  }

  private failPending(message: string) {
    for (const [id, p] of this.pending) {
      this.scheduler.clearTimeout(p.timer);
      p.reject(new EnvRequestError("closed", message));
      this.pending.delete(id);
    }
  }

  private handle(message: ServerMessage) {
    if (message.type === "response") return this.handleResponse(message);
    if (message.type !== "event") return;
    if (message.stream === "global") {
      for (const l of this.globalListeners) l(message);
      return;
    }
    const sessionId = message.sessionId ?? (message.event.type === "session.snapshot" ? message.event.session.id : undefined);
    if (!sessionId) return;
    const s = this.sessions.get(sessionId);
    if (!s) {
      const list = this.early.get(sessionId) ?? [];
      if (list.length < 2_000) list.push(message);
      this.early.set(sessionId, list);
      return;
    }
    s.buffer.push(message);
    if (this.coalesceMs <= 0) return this.flush(s);
    if (!s.flushTimer) s.flushTimer = this.scheduler.setTimeout(() => this.flush(s), this.coalesceMs);
  }

  private handleResponse(response: ServerResponse) {
    const p = this.pending.get(response.id);
    if (!p) return;
    this.pending.delete(response.id);
    this.scheduler.clearTimeout(p.timer);
    if (response.ok) p.resolve(response.result ?? {});
    else p.reject(new EnvRequestError(response.error.code, response.error.message));
  }

  /** Apply buffered envelopes; a gap triggers one re-open from the cursor. */
  flush(s: OpenSession) {
    s.flushTimer = null;
    if (s.buffer.length === 0) return;
    const batch = s.buffer.splice(0).sort((a, b) => a.sequence - b.sequence);
    const before = s.view;
    const { view, disposition } = applyCoalesced(s.view, batch);
    s.view = view;
    if (view !== before) for (const l of s.listeners) l(view);
    this.syncCursors();
    if (disposition === "gap" || view.needsResync) this.reopen(s);
  }

  private reopen(s: OpenSession) {
    if (s.reopening || this.status === "closed") return;
    s.reopening = true;
    this.request("session.open", {
      sessionId: s.id,
      cwd: s.cwd,
      ...(s.view.cursor !== null ? { afterSequence: s.view.cursor } : {}),
    })
      .catch(() => undefined)
      .finally(() => {
        s.reopening = false;
      });
  }

  private reopenAll() {
    for (const s of this.sessions.values()) this.reopen(s);
  }

  private syncCursors() {
    if (!this.transport.setCursors) return;
    const cursors: Record<string, number> = {};
    for (const s of this.sessions.values()) cursors[s.id] = s.view.cursor ?? -1;
    this.transport.setCursors(cursors);
  }
}

// ── Transports ──────────────────────────────────────────────────────────────

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();
  on(l: Listener<T>) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  emit(v: T) {
    for (const l of this.listeners) l(v);
  }
}

/** Parse one wire frame; anything malformed or from another protocol major is dropped. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (m.type === "response" && typeof m.id === "string" && typeof m.ok === "boolean") return m as unknown as ServerMessage;
  if (m.type === "event" && typeof m.sequence === "number" && m.event && typeof m.event === "object") return m as unknown as ServerMessage;
  if (m.type === "hello" && typeof m.major === "number" && m.major !== CODE_V2_PROTOCOL.major) return null;
  return null;
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Direct socket with capped exponential reconnect. Commands sent while down are queued. */
export class WebSocketTransport implements EnvTransport {
  private socket: WebSocketLike | null = null;
  private readonly messages = new Emitter<ServerMessage>();
  private readonly statuses = new Emitter<TransportStatus>();
  private readonly outbox: string[] = [];
  private attempts = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly create: (url: string) => WebSocketLike = (u) => new WebSocket(u) as unknown as WebSocketLike,
  ) {
    this.connect();
  }

  private connect() {
    if (this.closed) return;
    this.statuses.emit("connecting");
    const ws = this.create(this.url);
    this.socket = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.statuses.emit("open");
      while (this.outbox.length) ws.send(this.outbox.shift()!);
    };
    ws.onmessage = (ev) => {
      const m = parseServerMessage(ev.data);
      if (m) this.messages.emit(m);
    };
    ws.onclose = () => {
      this.statuses.emit("closed");
      if (this.closed) return;
      const delay = Math.min(10_000, 250 * 2 ** this.attempts++);
      this.retry = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => undefined;
  }

  send(command: ClientCommand): void {
    const data = JSON.stringify(command);
    if (this.socket && this.socket.readyState === 1) this.socket.send(data);
    else this.outbox.push(data);
  }

  onMessage(l: Listener<ServerMessage>) {
    return this.messages.on(l);
  }
  onStatus(l: Listener<TransportStatus>) {
    return this.statuses.on(l);
  }
  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close();
  }
}

/** What the link route answers: responses to commands and any events newer than the cursors. */
export interface LinkReply {
  responses?: ServerResponse[];
  events?: ServerEventEnvelope[];
  /** The device's env server is not reachable (offline / older app). */
  offline?: boolean;
  message?: string;
}

export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The hosted web → device relay. Commands are POSTed; events are long-polled
 * from the cursors the client holds (`setCursors`), so a session resumes from
 * exactly where it left off and nothing is applied twice.
 */
export class DeviceLinkTransport implements EnvTransport {
  private readonly messages = new Emitter<ServerMessage>();
  private readonly statuses = new Emitter<TransportStatus>();
  private cursors: Record<string, number> = {};
  private globalCursor = -1;
  private closed = false;
  private polling = false;
  private global = false;
  private abort: AbortController | null = null;
  private failures = 0;
  /**
   * The server's words when this browser holds no remote-control pair with
   * the Mac (403 not_paired, docs/code-v2/REMOTE-CONTROL.md); null otherwise.
   */
  pairingRequired: string | null = null;

  constructor(
    private readonly deviceId: string,
    private readonly fetcher: FetchLike = (i, init) => fetch(i, init),
    private readonly base = "/api/code/v2/link",
  ) {
    queueMicrotask(() => this.statuses.emit("open"));
  }

  private get url() {
    return `${this.base}/${encodeURIComponent(this.deviceId)}`;
  }

  private deliver(reply: LinkReply) {
    if (reply.offline) {
      this.statuses.emit("closed");
      return;
    }
    for (const r of reply.responses ?? []) this.messages.emit(r);
    for (const e of reply.events ?? []) {
      if (e.stream === "global") this.globalCursor = Math.max(this.globalCursor, e.sequence);
      this.messages.emit(e);
    }
  }

  send(command: ClientCommand): void {
    this.fetcher(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "rpc", command }),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as LinkReply;
        if (!res.ok && !body.responses) {
          // 403 not_paired (docs/code-v2/REMOTE-CONTROL.md): this browser holds no
          // pair with the Mac; the server's message says where to pair it.
          const code = res.status === 404 ? "not_found" : res.status === 403 ? "unsupported" : "not_ready";
          if (res.status === 403) this.pairingRequired = body.message ?? "Pair this browser with your Mac first.";
          this.messages.emit({ type: "response", id: command.id, ok: false, error: { code, message: body.message ?? "Your Mac could not be reached." } });
          return;
        }
        this.deliver(body);
      })
      .catch(() => {
        this.messages.emit({ type: "response", id: command.id, ok: false, error: { code: "not_ready", message: "Your Mac could not be reached." } });
      });
  }

  setCursors(cursors: Record<string, number>): void {
    this.cursors = cursors;
    if (!this.polling && this.wantsEvents()) void this.poll();
  }

  /**
   * Keep polling the global stream (provider updates, terminal output) even
   * with no session followed: a sign-in terminal from Connections has none.
   */
  followGlobal(): void {
    this.global = true;
    if (!this.polling) void this.poll();
  }

  private wantsEvents(): boolean {
    return this.global || Object.keys(this.cursors).length > 0;
  }

  private async poll() {
    this.polling = true;
    while (!this.closed && this.wantsEvents()) {
      this.abort = new AbortController();
      try {
        const res = await this.fetcher(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "poll", cursors: this.cursors, globalCursor: this.globalCursor }),
          signal: this.abort.signal,
        });
        const body = (await res.json().catch(() => ({}))) as LinkReply;
        if (res.status === 403) {
          this.pairingRequired = body.message ?? "Pair this browser with your Mac first.";
          // Not paired (or the pair was removed on the Mac): nothing will
          // change until someone pairs this browser, so check back slowly.
          this.statuses.emit("closed");
          await wait(30_000);
          if (!this.closed) this.statuses.emit("open");
          continue;
        }
        if (!res.ok) throw new Error(String(res.status));
        this.pairingRequired = null;
        this.failures = 0;
        this.deliver(body);
        if (body.offline) await wait(5_000);
      } catch {
        if (this.closed) break;
        this.failures++;
        this.statuses.emit("closed");
        await wait(Math.min(15_000, 1_000 * 2 ** this.failures));
        this.statuses.emit("open");
      }
    }
    this.polling = false;
  }

  onMessage(l: Listener<ServerMessage>) {
    return this.messages.on(l);
  }
  onStatus(l: Listener<TransportStatus>) {
    return this.statuses.on(l);
  }
  close() {
    this.closed = true;
    this.abort?.abort();
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Where to reach an env server from this browser: an explicit socket URL
 * (Mac app web view / local dev) wins; else the device link when a device is
 * online; else nothing (remote CodeTask path only).
 */
export function resolveEnvEndpoint(input: {
  explicitUrl?: string | null;
  deviceId?: string | null;
  deviceOnline?: boolean;
}): { kind: "socket"; url: string } | { kind: "link"; deviceId: string } | { kind: "none" } {
  const url = input.explicitUrl?.trim();
  if (url && /^wss?:\/\//.test(url)) return { kind: "socket", url };
  if (input.deviceId && input.deviceOnline) return { kind: "link", deviceId: input.deviceId };
  return { kind: "none" };
}
