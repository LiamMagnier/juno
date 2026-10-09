/**
 * Device link relay for Alevr Code v2 (SPEC §2: "The hosted web reaches it
 * through the user's Mac (device link)").
 *
 * The hosted web cannot open a socket to the env server on the user's Mac
 * (it listens on 127.0.0.1 behind a per-launch token). Instead both sides talk
 * to this hub over plain HTTPS, authenticated as the same Alevr user:
 *
 *   browser ──POST /api/code/v2/link/<device> {kind:"rpc"|"poll"}──▶ hub
 *   Mac     ──POST /api/code/v2/link/<device>/host {kind:"pull"|"push"}──▶ hub
 *
 * The Mac forwards the wire commands it pulls to its own env server over a
 * dedicated WebSocket and pushes back the responses and event envelopes it
 * receives. The env server's bearer token, BYOK keys and vendor credentials
 * never leave the Mac; only alevr-code-v2 wire messages cross the relay.
 *
 * What the hub keeps (in memory, per user + device):
 *  - commands waiting for the Mac (bounded; ids rewritten so two browser tabs
 *    can never collide, mapped back on the response);
 *  - a bounded ring of recent event envelopes per session and one for the
 *    global stream, so a browser that polls with its cursor gets exactly the
 *    events after it. When the ring does not reach back to a cursor, the hub
 *    asks the Mac to replay from the env server's own append-only log
 *    (`session.open` with `afterSequence`), which is the source of truth.
 *
 * Because the env server's log is authoritative, losing the hub (a backend
 * restart) loses nothing: the next poll triggers a replay. The backend runs as
 * one Node process (deploy/ecosystem.config.js, fork mode); running several
 * would need a shared store behind the same `EnvLinkHub` surface.
 *
 * Security: the relay is a remote control for the user's Mac, so it carries a
 * strict allow-list. Terminals (a shell) and env.configure (secrets) are never
 * relayed; the Mac also refuses them on its side and only serves the relay
 * when the user turned "Use this Mac from Alevr on the web" on.
 *
 * No Next.js imports: the routes are thin wrappers and this is unit-tested.
 */
import {
  CODE_V2_PROTOCOL,
  type ClientCommand,
  type ClientCommandType,
  type ServerEventEnvelope,
  type ServerResponse,
} from "./contracts";

/** Commands the hosted web may send to a Mac. Everything else is refused at the hub. */
export const LINK_RELAYED_COMMANDS: ReadonlySet<ClientCommandType> = new Set<ClientCommandType>([
  "session.open",
  "session.list",
  "session.close",
  "turn.start",
  "turn.steer",
  "turn.queue",
  "turn.interrupt",
  "approval.respond",
  "checkpoint.diff",
  "checkpoint.rollback",
  "provider.list",
  "provider.probe",
  "provider.setup",
]);

/**
 * A shell on the user's Mac. Relayed only while the Mac's latest pull says the
 * user shared its terminal with other devices (`{kind:"pull", terminal:true}`);
 * the Mac enforces the same switch again before running one.
 */
export const LINK_TERMINAL_COMMANDS: ReadonlySet<ClientCommandType> = new Set<ClientCommandType>([
  "terminal.open",
  "terminal.write",
  "terminal.resize",
  "terminal.close",
]);

/** Never relayed: secrets (the Mac supplies its own). */
export const LINK_REFUSED_COMMANDS: ReadonlySet<ClientCommandType> = new Set<ClientCommandType>(["env.configure"]);

export const LINK_LIMITS = {
  /** A Mac that has not pulled for this long is offline. */
  hostOnlineMs: 40_000,
  /** Longest a host pull waits for work. */
  hostPullWaitMs: 25_000,
  /** Longest a browser poll waits for events. */
  clientPollWaitMs: 20_000,
  /** Longest a browser RPC waits for the Mac's answer. */
  rpcTimeoutMs: 30_000,
  /** Commands waiting for the Mac. */
  maxQueuedCommands: 200,
  /** Events kept per session and for the global stream. */
  ringPerSession: 2_000,
  ringGlobal: 500,
  /** Sessions with a ring per device. */
  maxSessions: 200,
  /** Events / responses accepted in one host push. */
  maxPushItems: 1_000,
  /** Commands handed to the host in one pull. */
  maxPullItems: 100,
  /** Don't ask the Mac to replay the same session more often than this. */
  replayCooldownMs: 5_000,
} as const;

/** The browser-facing reply (matches `LinkReply` in env-client.ts on the web lane). */
export interface LinkReply {
  responses?: ServerResponse[];
  events?: ServerEventEnvelope[];
  offline?: boolean;
  message?: string;
}

export type LinkClientRequest =
  | { kind: "rpc"; command: ClientCommand }
  | { kind: "poll"; cursors: Record<string, number>; globalCursor?: number };

export type LinkHostRequest =
  | { kind: "pull"; protocol?: string; appVersion?: string; waitMs?: number; terminal?: boolean }
  | { kind: "push"; responses?: ServerResponse[]; events?: ServerEventEnvelope[] };

export interface LinkHostPullReply {
  protocol: typeof CODE_V2_PROTOCOL;
  /** Wire commands for the Mac to send to its env server, in order. */
  commands: ClientCommand[];
}

type Clock = () => number;

interface PendingRpc {
  clientId: string;
  resolve(response: ServerResponse): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Ring {
  events: ServerEventEnvelope[];
  lastSequence: number;
  lastReplayAt: number;
  /** The ring holds every event after this sequence (known once a replay from it finished). */
  floor?: number;
}

class Waiters {
  #list = new Set<() => void>();
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#list.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#list.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  wake(): void {
    for (const w of [...this.#list]) w();
  }
}

/** One user's link to one device. */
export class DeviceLink {
  #queue: ClientCommand[] = [];
  #pending = new Map<string, PendingRpc>();
  /** Replay opens in flight: relay id → the session and cursor they replay from. */
  #replays = new Map<string, { sessionId: string; cursor: number }>();
  #rings = new Map<string, Ring>();
  #global: ServerEventEnvelope[] = [];
  #globalSeq = 0;
  #nextId = 1;
  #lastPullAt = -Infinity;
  #hostWaiters = new Waiters();
  #clientWaiters = new Waiters();
  appVersion: string | undefined;
  /** Whether the Mac's latest pull said its terminal is shared with other devices. */
  terminalShared = false;

  constructor(private readonly clock: Clock = Date.now) {}

  get online(): boolean {
    return this.clock() - this.#lastPullAt <= LINK_LIMITS.hostOnlineMs;
  }

  // ── Browser side ──────────────────────────────────────────────────────

  /** Relays one command and resolves with the Mac's response (or a plain error). */
  async rpc(command: ClientCommand): Promise<LinkReply> {
    const refuse = (code: "unsupported" | "not_ready" | "bad_request", message: string): LinkReply => ({
      responses: [{ type: "response", id: String(command?.id ?? ""), ok: false, error: { code, message } }],
    });
    if (!command || typeof command.id !== "string" || typeof command.type !== "string") return refuse("bad_request", "Malformed command.");
    const terminal = LINK_TERMINAL_COMMANDS.has(command.type);
    if (LINK_REFUSED_COMMANDS.has(command.type) || (!terminal && !LINK_RELAYED_COMMANDS.has(command.type))) {
      return refuse("unsupported", "That action is only available in Alevr on your Mac.");
    }
    if (!this.online) return { offline: true, message: "Your Mac is offline. Open Alevr on it to continue." };
    if (terminal && !this.terminalShared) {
      return refuse("unsupported", "The terminal on your Mac is not shared. Turn on Share terminal in Alevr on your Mac, under Remote hosting.");
    }
    if (this.#queue.length >= LINK_LIMITS.maxQueuedCommands) return refuse("not_ready", "Your Mac is busy. Try again in a moment.");
    const relayId = `link_${this.#nextId++}`;
    const response = await new Promise<ServerResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(relayId);
        this.#queue = this.#queue.filter((c) => c.id !== relayId);
        resolve({ type: "response", id: relayId, ok: false, error: { code: "not_ready", message: "Your Mac did not answer in time." } });
      }, LINK_LIMITS.rpcTimeoutMs);
      this.#pending.set(relayId, { clientId: command.id, resolve, timer });
      this.#queue.push({ ...command, id: relayId } as ClientCommand);
      this.#hostWaiters.wake();
    });
    return { responses: [{ ...response, id: command.id }] };
  }

  /** Events after the given cursors; waits up to `waitMs` for some to arrive. */
  async poll(cursors: Record<string, number>, globalCursor = -1, waitMs: number = LINK_LIMITS.clientPollWaitMs, signal?: AbortSignal): Promise<LinkReply> {
    if (!this.online) return { offline: true, message: "Your Mac is offline. Open Alevr on it to continue." };
    const ids = Object.keys(cursors).slice(0, LINK_LIMITS.maxSessions);
    for (const id of ids) this.#ensureCoverage(id, cursors[id]);
    let events = this.#collect(ids, cursors, globalCursor);
    if (events.length === 0 && waitMs > 0 && !signal?.aborted) {
      await this.#clientWaiters.wait(waitMs, signal);
      events = this.#collect(ids, cursors, globalCursor);
    }
    return { events };
  }

  #collect(ids: string[], cursors: Record<string, number>, globalCursor: number): ServerEventEnvelope[] {
    const out: ServerEventEnvelope[] = [];
    // A hub restart resets its global numbering; a cursor from before it gets everything kept.
    const g = globalCursor > this.#globalSeq ? -1 : globalCursor;
    for (const e of this.#global) if (e.sequence > g) out.push(e);
    for (const id of ids) {
      const ring = this.#rings.get(id);
      if (!ring) continue;
      const cursor = cursors[id];
      const events = ring.events;
      // Start from the newest snapshot at or after the cursor, if the ring holds one: it supersedes what came before.
      let start = events.findIndex((e) => e.sequence > cursor);
      if (start < 0) continue;
      for (let i = events.length - 1; i > start; i--) {
        if (events[i].event.type === "session.snapshot") {
          start = i;
          break;
        }
      }
      out.push(...events.slice(start));
    }
    return out;
  }

  /** Asks the Mac to replay a session from the env server's log when the ring can't serve the cursor. */
  #ensureCoverage(sessionId: string, cursor: number): void {
    if (typeof sessionId !== "string" || !sessionId || !Number.isFinite(cursor)) return;
    const ring = this.#rings.get(sessionId);
    const now = this.clock();
    const covered =
      !!ring &&
      ((ring.floor !== undefined && ring.floor <= cursor) ||
        ring.events.some((e) => e.event.type === "session.snapshot" && e.sequence > cursor) ||
        (ring.events.length > 0 && ring.events[0].sequence <= cursor + 1));
    if (covered) return;
    if (ring && now - ring.lastReplayAt < LINK_LIMITS.replayCooldownMs) return;
    const r = ring ?? this.#ring(sessionId);
    r.lastReplayAt = now;
    if (this.#queue.length >= LINK_LIMITS.maxQueuedCommands) return;
    // A synthetic open: the env server replays events after the cursor to the Mac's relay connection.
    // `cwd` is ignored for an existing session. The response is dropped by `push` (no pending rpc).
    const replayId = `replay_${this.#nextId++}`;
    this.#replays.set(replayId, { sessionId, cursor });
    if (this.#replays.size > LINK_LIMITS.maxQueuedCommands) this.#replays.delete(this.#replays.keys().next().value!);
    this.#queue.push({
      id: replayId,
      type: "session.open",
      // `afterSequence` is always set so the env server never creates a session for an unknown id
      // (-1 falls back to a snapshot).
      params: { sessionId, cwd: "/", afterSequence: Math.max(-1, Math.floor(cursor)) },
    });
    this.#hostWaiters.wake();
  }

  #ring(sessionId: string): Ring {
    let ring = this.#rings.get(sessionId);
    if (!ring) {
      if (this.#rings.size >= LINK_LIMITS.maxSessions) {
        // Drop the least recently replayed/updated ring.
        const oldest = [...this.#rings.entries()].sort((a, b) => a[1].lastReplayAt - b[1].lastReplayAt)[0];
        if (oldest) this.#rings.delete(oldest[0]);
      }
      ring = { events: [], lastSequence: -1, lastReplayAt: -Infinity };
      this.#rings.set(sessionId, ring);
    }
    return ring;
  }

  // ── Mac side ──────────────────────────────────────────────────────────

  /** The Mac's long poll for work. Pulling is also its heartbeat. */
  async pull(waitMs: number = LINK_LIMITS.hostPullWaitMs, signal?: AbortSignal, appVersion?: string, terminal = false): Promise<LinkHostPullReply> {
    this.#lastPullAt = this.clock();
    if (appVersion) this.appVersion = appVersion;
    this.terminalShared = terminal === true;
    if (this.#queue.length === 0 && waitMs > 0 && !signal?.aborted) {
      await this.#hostWaiters.wait(Math.min(waitMs, LINK_LIMITS.hostPullWaitMs), signal);
      this.#lastPullAt = this.clock();
    }
    const commands = this.#queue.splice(0, LINK_LIMITS.maxPullItems);
    return { protocol: CODE_V2_PROTOCOL, commands };
  }

  /** Responses and events the Mac received from its env server. */
  push(input: { responses?: ServerResponse[]; events?: ServerEventEnvelope[] }): { accepted: number } {
    this.#lastPullAt = this.clock();
    let accepted = 0;
    for (const r of (input.responses ?? []).slice(0, LINK_LIMITS.maxPushItems)) {
      if (!r || r.type !== "response" || typeof r.id !== "string") continue;
      const replay = this.#replays.get(r.id);
      if (replay) {
        this.#replays.delete(r.id);
        const ring = this.#rings.get(replay.sessionId);
        // The env server sends the replayed events before it answers the open.
        if (ring && r.ok) ring.floor = Math.min(ring.floor ?? replay.cursor, replay.cursor);
        continue;
      }
      const pending = this.#pending.get(r.id);
      if (!pending) continue; // replay opens and timed-out calls
      this.#pending.delete(r.id);
      clearTimeout(pending.timer);
      pending.resolve(r);
      accepted++;
    }
    let newEvents = false;
    for (const e of (input.events ?? []).slice(0, LINK_LIMITS.maxPushItems)) {
      if (!e || e.type !== "event" || typeof e.sequence !== "number" || !e.event || typeof e.event.type !== "string") continue;
      if (e.stream === "global") {
        this.#global.push({ ...e, sequence: ++this.#globalSeq });
        if (this.#global.length > LINK_LIMITS.ringGlobal) this.#global.splice(0, this.#global.length - LINK_LIMITS.ringGlobal);
        newEvents = true;
        accepted++;
        continue;
      }
      if (e.stream !== "session" || typeof e.sessionId !== "string" || !e.sessionId) continue;
      if (this.#insert(this.#ring(e.sessionId), e)) {
        newEvents = true;
        accepted++;
      }
    }
    if (newEvents) this.#clientWaiters.wake();
    return { accepted };
  }

  /** Keeps the ring ordered by sequence without duplicates; a snapshot older than the ring is ignored. */
  #insert(ring: Ring, e: ServerEventEnvelope): boolean {
    const events = ring.events;
    if (e.sequence > ring.lastSequence) {
      events.push(e);
      ring.lastSequence = e.sequence;
    } else {
      // A replay: insert in order unless already present.
      const at = events.findIndex((x) => x.sequence >= e.sequence);
      if (at >= 0 && events[at].sequence === e.sequence && events[at].event.type === e.event.type) return false;
      if (at < 0) events.push(e);
      else events.splice(at, 0, e);
    }
    if (events.length > LINK_LIMITS.ringPerSession) {
      events.splice(0, events.length - LINK_LIMITS.ringPerSession);
      if (ring.floor !== undefined) ring.floor = Math.max(ring.floor, events[0].sequence - 1);
    }
    return true;
  }

  /** Test/diagnostic view; never sent to clients. */
  stats(): { queued: number; pending: number; sessions: number; online: boolean } {
    return { queued: this.#queue.length, pending: this.#pending.size, sessions: this.#rings.size, online: this.online };
  }
}

/** All device links of this backend process, keyed by user and device. */
export class EnvLinkHub {
  #links = new Map<string, DeviceLink>();
  constructor(private readonly clock: Clock = Date.now) {}

  link(userId: string, deviceId: string): DeviceLink {
    const key = `${userId}\u0000${deviceId}`;
    let link = this.#links.get(key);
    if (!link) {
      link = new DeviceLink(this.clock);
      this.#links.set(key, link);
    }
    return link;
  }

  /** Whether a link exists and its Mac pulled recently (does not create one). */
  isOnline(userId: string, deviceId: string): boolean {
    return this.#links.get(`${userId}\u0000${deviceId}`)?.online ?? false;
  }
}

const HUB_KEY = Symbol.for("alevr.code-v2.env-link-hub");

/** The process-wide hub (survives Next.js dev hot reloads). */
export function envLinkHub(): EnvLinkHub {
  const g = globalThis as unknown as Record<symbol, EnvLinkHub | undefined>;
  g[HUB_KEY] ??= new EnvLinkHub();
  return g[HUB_KEY]!;
}

// ── Request parsing (shared by the routes and tests) ──────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseClientRequest(body: unknown): LinkClientRequest | null {
  if (!isRecord(body)) return null;
  if (body.kind === "rpc" && isRecord(body.command)) {
    const c = body.command;
    if (typeof c.id !== "string" || c.id.length > 200 || typeof c.type !== "string" || !isRecord(c.params)) return null;
    return { kind: "rpc", command: c as unknown as ClientCommand };
  }
  if (body.kind === "poll" && isRecord(body.cursors)) {
    const cursors: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.cursors).slice(0, LINK_LIMITS.maxSessions)) {
      if (k.length <= 200 && typeof v === "number" && Number.isFinite(v)) cursors[k] = Math.floor(v);
    }
    const globalCursor = typeof body.globalCursor === "number" && Number.isFinite(body.globalCursor) ? Math.floor(body.globalCursor) : -1;
    return { kind: "poll", cursors, globalCursor };
  }
  return null;
}

export function parseHostRequest(body: unknown): LinkHostRequest | null {
  if (!isRecord(body)) return null;
  if (body.kind === "pull") {
    return {
      kind: "pull",
      ...(typeof body.protocol === "string" ? { protocol: body.protocol } : {}),
      ...(typeof body.appVersion === "string" ? { appVersion: body.appVersion.slice(0, 100) } : {}),
      ...(typeof body.waitMs === "number" && Number.isFinite(body.waitMs) ? { waitMs: Math.max(0, body.waitMs) } : {}),
      ...(body.terminal === true ? { terminal: true } : {}),
    };
  }
  if (body.kind === "push") {
    const responses = Array.isArray(body.responses) ? (body.responses as ServerResponse[]) : [];
    const events = Array.isArray(body.events) ? (body.events as ServerEventEnvelope[]) : [];
    if (responses.length + events.length > LINK_LIMITS.maxPushItems * 2) return null;
    return { kind: "push", responses, events };
  }
  return null;
}
