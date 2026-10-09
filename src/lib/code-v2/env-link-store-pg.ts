/**
 * The device-link hub on Postgres (docs/code-v2/DEVICE-LINK.md "Deployment
 * note"): the same rules as the in-memory `DeviceLink`, with its state in
 * tables so any backend process can serve the browser and any other the Mac.
 *
 *   CodeLinkHost      heartbeat (lastPullAt), app version, global renumbering
 *   CodeLinkCommand   commands waiting for the Mac (claimed with SKIP LOCKED)
 *   CodeLinkResponse  the Mac's answers, keyed by relay id, read once
 *   CodeLinkEvent     the event rings (per session, and the global stream)
 *   CodeLinkSession   per-session replay bookkeeping (floor, last replay)
 *
 * Waiting is a short poll of the tables (250 ms by default) plus an in-process
 * wake, so a backend that runs as one process answers at once and several
 * processes answer within a poll. Nothing here needs LISTEN/NOTIFY.
 *
 * Only `$queryRawUnsafe` / `$executeRawUnsafe` are used (always with bound
 * parameters), so this works with any Prisma client, including tests pointed
 * at a throwaway database.
 */
import { randomUUID } from "node:crypto";
import {
  CODE_V2_PROTOCOL,
  type ClientCommand,
  type ServerEventEnvelope,
  type ServerResponse,
} from "./contracts";
import {
  LINK_LIMITS,
  LINK_REFUSED_COMMANDS,
  LINK_RELAYED_COMMANDS,
  type LinkEndpoint,
  type LinkHostPullReply,
  type LinkHub,
  type LinkReply,
} from "./env-link-hub";

/** What the store needs from a database client (a PrismaClient satisfies it). */
export interface LinkSql {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export interface PgLinkOptions {
  /** How often a waiting request re-reads the tables (cross-process latency). */
  pollMs?: number;
  clock?: () => number;
}

type Waiter = () => void;
/** In-process wake-ups, so one process never waits a poll for its own writes. */
const wakeups = new Map<string, Set<Waiter>>();
function wake(key: string): void {
  for (const w of [...(wakeups.get(key) ?? [])]) w();
}
function sleep(key: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let set = wakeups.get(key);
    if (!set) wakeups.set(key, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      set!.delete(done);
      if (set!.size === 0) wakeups.delete(key);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    set.add(done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

interface EventRow {
  sessionId: string;
  sequence: number;
  payload: ServerEventEnvelope;
}

export class PgDeviceLink implements LinkEndpoint {
  readonly #k: string;
  readonly #pollMs: number;
  readonly #clock: () => number;

  constructor(
    private readonly sql: LinkSql,
    private readonly userId: string,
    private readonly deviceId: string,
    options: PgLinkOptions = {},
  ) {
    this.#k = `${userId}\u0000${deviceId}`;
    this.#pollMs = options.pollMs ?? 250;
    this.#clock = options.clock ?? Date.now;
  }

  async online(): Promise<boolean> {
    const rows = await this.sql.$queryRawUnsafe<{ lastPullAt: Date }[]>(
      `SELECT "lastPullAt" FROM "CodeLinkHost" WHERE "userId" = $1 AND "deviceId" = $2`,
      this.userId,
      this.deviceId,
    );
    const at = rows[0]?.lastPullAt;
    return !!at && this.#clock() - new Date(at).getTime() <= LINK_LIMITS.hostOnlineMs;
  }

  // ── Browser side ──────────────────────────────────────────────────────

  async rpc(command: ClientCommand): Promise<LinkReply> {
    const refuse = (code: "unsupported" | "not_ready" | "bad_request", message: string): LinkReply => ({
      responses: [{ type: "response", id: String(command?.id ?? ""), ok: false, error: { code, message } }],
    });
    if (!command || typeof command.id !== "string" || typeof command.type !== "string") return refuse("bad_request", "Malformed command.");
    if (LINK_REFUSED_COMMANDS.has(command.type) || !LINK_RELAYED_COMMANDS.has(command.type)) {
      return refuse("unsupported", command.type.startsWith("terminal.") ? "Terminals open on the Mac itself, not from the web." : "That action is only available in Alevr on your Mac.");
    }
    if (!(await this.online())) return { offline: true, message: "Your Mac is offline. Open Alevr on it to continue." };
    const queued = await this.sql.$queryRawUnsafe<{ n: bigint | number }[]>(
      `SELECT count(*)::int AS n FROM "CodeLinkCommand" WHERE "userId" = $1 AND "deviceId" = $2 AND "claimedAt" IS NULL`,
      this.userId,
      this.deviceId,
    );
    if (Number(queued[0]?.n ?? 0) >= LINK_LIMITS.maxQueuedCommands) return refuse("not_ready", "Your Mac is busy. Try again in a moment.");
    const relayId = `link_${randomUUID()}`;
    await this.#enqueue({ ...command, id: relayId } as ClientCommand);
    const deadline = this.#clock() + LINK_LIMITS.rpcTimeoutMs;
    for (;;) {
      const rows = await this.sql.$queryRawUnsafe<{ payload: ServerResponse }[]>(
        `DELETE FROM "CodeLinkResponse" WHERE "relayId" = $1 AND "userId" = $2 AND "deviceId" = $3 RETURNING "payload"`,
        relayId,
        this.userId,
        this.deviceId,
      );
      if (rows[0]) return { responses: [{ ...rows[0].payload, id: command.id }] };
      const left = deadline - this.#clock();
      if (left <= 0) break;
      await sleep(`r:${relayId}`, Math.min(this.#pollMs, left));
    }
    await this.sql.$executeRawUnsafe(`DELETE FROM "CodeLinkCommand" WHERE "relayId" = $1`, relayId);
    return { responses: [{ type: "response", id: command.id, ok: false, error: { code: "not_ready", message: "Your Mac did not answer in time." } }] };
  }

  async poll(cursors: Record<string, number>, globalCursor = -1, waitMs: number = LINK_LIMITS.clientPollWaitMs, signal?: AbortSignal): Promise<LinkReply> {
    if (!(await this.online())) return { offline: true, message: "Your Mac is offline. Open Alevr on it to continue." };
    const ids = Object.keys(cursors).slice(0, LINK_LIMITS.maxSessions);
    for (const id of ids) await this.#ensureCoverage(id, cursors[id]);
    const deadline = this.#clock() + Math.max(0, waitMs);
    let events = await this.#collect(ids, cursors, globalCursor);
    while (events.length === 0 && !signal?.aborted) {
      const left = deadline - this.#clock();
      if (left <= 0) break;
      await sleep(`e:${this.#k}`, Math.min(this.#pollMs, left), signal);
      events = await this.#collect(ids, cursors, globalCursor);
    }
    return { events };
  }

  async #collect(ids: string[], cursors: Record<string, number>, globalCursor: number): Promise<ServerEventEnvelope[]> {
    const out: ServerEventEnvelope[] = [];
    const host = await this.sql.$queryRawUnsafe<{ globalSeq: number }[]>(
      `SELECT "globalSeq" FROM "CodeLinkHost" WHERE "userId" = $1 AND "deviceId" = $2`,
      this.userId,
      this.deviceId,
    );
    const globalSeq = Number(host[0]?.globalSeq ?? 0);
    // A hub reset renumbers the global stream; a cursor from before it gets everything kept.
    const g = globalCursor > globalSeq ? -1 : globalCursor;
    const globals = await this.sql.$queryRawUnsafe<EventRow[]>(
      `SELECT "sessionId", "sequence", "payload" FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = '' AND "sequence" > $3 ORDER BY "sequence"`,
      this.userId,
      this.deviceId,
      g,
    );
    for (const row of globals) out.push({ ...row.payload, sequence: Number(row.sequence) });
    if (ids.length === 0) return out;
    const rows = await this.sql.$queryRawUnsafe<EventRow[]>(
      `SELECT "sessionId", "sequence", "payload" FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = ANY($3::text[]) ORDER BY "sessionId", "sequence", "id"`,
      this.userId,
      this.deviceId,
      ids,
    );
    const bySession = new Map<string, ServerEventEnvelope[]>();
    for (const row of rows) {
      const list = bySession.get(row.sessionId) ?? [];
      list.push(row.payload);
      bySession.set(row.sessionId, list);
    }
    for (const id of ids) {
      const events = bySession.get(id);
      if (!events) continue;
      const cursor = cursors[id];
      let start = events.findIndex((e) => e.sequence > cursor);
      if (start < 0) continue;
      // The newest snapshot after the cursor supersedes everything before it.
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

  async #ensureCoverage(sessionId: string, cursor: number): Promise<void> {
    if (typeof sessionId !== "string" || !sessionId || !Number.isFinite(cursor)) return;
    const [stats] = await this.sql.$queryRawUnsafe<{ min: number | null; n: number; snapshots: number }[]>(
      `SELECT min("sequence") AS "min", count(*)::int AS "n",
              count(*) FILTER (WHERE "payload"->'event'->>'type' = 'session.snapshot' AND "sequence" > $4)::int AS "snapshots"
         FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = $3`,
      this.userId,
      this.deviceId,
      sessionId,
      cursor,
    );
    const [ring] = await this.sql.$queryRawUnsafe<{ floor: number | null; lastReplayAt: Date | null }[]>(
      `SELECT "floor", "lastReplayAt" FROM "CodeLinkSession" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = $3`,
      this.userId,
      this.deviceId,
      sessionId,
    );
    const covered =
      (ring?.floor !== null && ring?.floor !== undefined && Number(ring.floor) <= cursor) ||
      Number(stats?.snapshots ?? 0) > 0 ||
      (Number(stats?.n ?? 0) > 0 && stats?.min !== null && Number(stats?.min) <= cursor + 1);
    if (covered) return;
    const now = this.#clock();
    if (ring?.lastReplayAt && now - new Date(ring.lastReplayAt).getTime() < LINK_LIMITS.replayCooldownMs) return;
    const replayId = `replay_${randomUUID()}`;
    await this.sql.$executeRawUnsafe(
      `INSERT INTO "CodeLinkSession" ("userId", "deviceId", "sessionId", "lastReplayAt", "replayRelayId", "replayCursor")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("userId", "deviceId", "sessionId") DO UPDATE SET "lastReplayAt" = $4, "replayRelayId" = $5, "replayCursor" = $6`,
      this.userId,
      this.deviceId,
      sessionId,
      new Date(now),
      replayId,
      Math.floor(cursor),
    );
    // A synthetic open: `afterSequence` always set, so the env server never creates a session.
    await this.#enqueue({ id: replayId, type: "session.open", params: { sessionId, cwd: "/", afterSequence: Math.max(-1, Math.floor(cursor)) } });
  }

  async #enqueue(command: ClientCommand): Promise<void> {
    await this.sql.$executeRawUnsafe(
      `INSERT INTO "CodeLinkCommand" ("userId", "deviceId", "relayId", "payload") VALUES ($1, $2, $3, $4::jsonb)`,
      this.userId,
      this.deviceId,
      command.id,
      JSON.stringify(command),
    );
    wake(`h:${this.#k}`);
  }

  // ── Mac side ──────────────────────────────────────────────────────────

  async #heartbeat(appVersion?: string): Promise<void> {
    await this.sql.$executeRawUnsafe(
      `INSERT INTO "CodeLinkHost" ("userId", "deviceId", "lastPullAt", "appVersion") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("userId", "deviceId") DO UPDATE SET "lastPullAt" = $3, "appVersion" = COALESCE($4, "CodeLinkHost"."appVersion")`,
      this.userId,
      this.deviceId,
      new Date(this.#clock()),
      appVersion ?? null,
    );
  }

  async pull(waitMs: number = LINK_LIMITS.hostPullWaitMs, signal?: AbortSignal, appVersion?: string): Promise<LinkHostPullReply> {
    await this.#heartbeat(appVersion);
    const deadline = this.#clock() + Math.min(Math.max(0, waitMs), LINK_LIMITS.hostPullWaitMs);
    let commands = await this.#claim();
    while (commands.length === 0 && !signal?.aborted) {
      const left = deadline - this.#clock();
      if (left <= 0) break;
      await sleep(`h:${this.#k}`, Math.min(this.#pollMs, left), signal);
      commands = await this.#claim();
    }
    if (waitMs > 0) await this.#heartbeat();
    return { protocol: CODE_V2_PROTOCOL, commands };
  }

  /** Takes the oldest unclaimed commands; two pulling processes never get the same one. */
  async #claim(): Promise<ClientCommand[]> {
    const rows = await this.sql.$queryRawUnsafe<{ payload: ClientCommand }[]>(
      `DELETE FROM "CodeLinkCommand" WHERE "id" IN (
         SELECT "id" FROM "CodeLinkCommand" WHERE "userId" = $1 AND "deviceId" = $2 AND "claimedAt" IS NULL
         ORDER BY "id" LIMIT $3 FOR UPDATE SKIP LOCKED
       ) RETURNING "id", "payload"`,
      this.userId,
      this.deviceId,
      LINK_LIMITS.maxPullItems,
    );
    return rows
      .map((r) => ({ ...(r as { id: bigint | number; payload: ClientCommand }) }))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((r) => r.payload);
  }

  async push(input: { responses?: ServerResponse[]; events?: ServerEventEnvelope[] }): Promise<{ accepted: number }> {
    await this.#heartbeat();
    let accepted = 0;
    for (const r of (input.responses ?? []).slice(0, LINK_LIMITS.maxPushItems)) {
      if (!r || r.type !== "response" || typeof r.id !== "string") continue;
      if (r.id.startsWith("replay_")) {
        // The env server replays before it answers the open: the ring now holds everything after the cursor.
        if (r.ok) {
          await this.sql.$executeRawUnsafe(
            `UPDATE "CodeLinkSession" SET "floor" = LEAST(COALESCE("floor", "replayCursor"), "replayCursor"), "replayRelayId" = NULL
              WHERE "userId" = $1 AND "deviceId" = $2 AND "replayRelayId" = $3`,
            this.userId,
            this.deviceId,
            r.id,
          );
        }
        continue;
      }
      if (!r.id.startsWith("link_")) continue;
      const n = await this.sql.$executeRawUnsafe(
        `INSERT INTO "CodeLinkResponse" ("relayId", "userId", "deviceId", "payload") VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT ("relayId") DO NOTHING`,
        r.id,
        this.userId,
        this.deviceId,
        JSON.stringify(r),
      );
      if (n > 0) {
        accepted++;
        wake(`r:${r.id}`);
      }
    }
    const touched = new Set<string>();
    let globals = 0;
    for (const e of (input.events ?? []).slice(0, LINK_LIMITS.maxPushItems)) {
      if (!e || e.type !== "event" || typeof e.sequence !== "number" || !e.event || typeof e.event.type !== "string") continue;
      if (e.stream === "global") {
        const [row] = await this.sql.$queryRawUnsafe<{ globalSeq: number }[]>(
          `UPDATE "CodeLinkHost" SET "globalSeq" = "globalSeq" + 1 WHERE "userId" = $1 AND "deviceId" = $2 RETURNING "globalSeq"`,
          this.userId,
          this.deviceId,
        );
        const sequence = Number(row?.globalSeq ?? 0);
        await this.#insertEvent("", sequence, { ...e, sequence });
        globals++;
        accepted++;
        continue;
      }
      if (e.stream !== "session" || typeof e.sessionId !== "string" || !e.sessionId || e.sessionId.length > 200) continue;
      if (await this.#insertEvent(e.sessionId, e.sequence, e)) {
        touched.add(e.sessionId);
        accepted++;
      }
    }
    for (const sessionId of touched) await this.#trim(sessionId, LINK_LIMITS.ringPerSession);
    if (globals) await this.#trim("", LINK_LIMITS.ringGlobal);
    if (touched.size || globals) wake(`e:${this.#k}`);
    return { accepted };
  }

  async #insertEvent(sessionId: string, sequence: number, envelope: ServerEventEnvelope): Promise<boolean> {
    const n = await this.sql.$executeRawUnsafe(
      `INSERT INTO "CodeLinkEvent" ("userId", "deviceId", "sessionId", "sequence", "eventType", "payload")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT ("userId", "deviceId", "sessionId", "sequence", "eventType") DO NOTHING`,
      this.userId,
      this.deviceId,
      sessionId,
      sequence,
      envelope.event.type,
      JSON.stringify(envelope),
    );
    return n > 0;
  }

  /** Keeps the newest `keep` events of a ring; the floor moves up with what was dropped. */
  async #trim(sessionId: string, keep: number): Promise<void> {
    const rows = await this.sql.$queryRawUnsafe<{ cut: number | null }[]>(
      `SELECT "sequence" AS "cut" FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = $3
        ORDER BY "sequence" DESC, "id" DESC OFFSET $4 LIMIT 1`,
      this.userId,
      this.deviceId,
      sessionId,
      keep,
    );
    const cut = rows[0]?.cut;
    if (cut === null || cut === undefined) return;
    await this.sql.$executeRawUnsafe(
      `DELETE FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = $3 AND "sequence" <= $4`,
      this.userId,
      this.deviceId,
      sessionId,
      Number(cut),
    );
    if (sessionId) {
      await this.sql.$executeRawUnsafe(
        `UPDATE "CodeLinkSession" SET "floor" = GREATEST("floor", $4) WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = $3 AND "floor" IS NOT NULL`,
        this.userId,
        this.deviceId,
        sessionId,
        Number(cut),
      );
    }
  }

  /** Drops what nobody will read: answers and commands older than the RPC window. */
  async sweep(olderThanMs = LINK_LIMITS.rpcTimeoutMs * 2): Promise<void> {
    const before = new Date(this.#clock() - olderThanMs);
    await this.sql.$executeRawUnsafe(`DELETE FROM "CodeLinkResponse" WHERE "createdAt" < $1`, before);
    await this.sql.$executeRawUnsafe(`DELETE FROM "CodeLinkCommand" WHERE "createdAt" < $1`, before);
  }
}

/** The Postgres hub: one `PgDeviceLink` per request (they hold no state of their own). */
export class PgLinkHub implements LinkHub {
  #lastSweep = 0;
  constructor(
    private readonly sql: LinkSql,
    private readonly options: PgLinkOptions = {},
  ) {}

  link(userId: string, deviceId: string): PgDeviceLink {
    const link = new PgDeviceLink(this.sql, userId, deviceId, this.options);
    const now = (this.options.clock ?? Date.now)();
    if (now - this.#lastSweep > 60_000) {
      this.#lastSweep = now;
      void link.sweep().catch(() => undefined);
    }
    return link;
  }

  isOnline(userId: string, deviceId: string): Promise<boolean> {
    return new PgDeviceLink(this.sql, userId, deviceId, this.options).online();
  }
}
