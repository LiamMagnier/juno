/** Real PostgreSQL interleavings; every instrumented SQL operation reaches the database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { PrismaClient } from "@prisma/client";

import { LINK_LIMITS } from "@/lib/code-v2/env-link-hub";
import { PgLinkHub, type LinkSql } from "@/lib/code-v2/env-link-store-pg";

const LINK_TIMEOUT = LINK_LIMITS.rpcTimeoutMs;
import type { ServerEventEnvelope } from "@/lib/code-v2/contracts";

const url = process.env.CODE_LINK_TEST_DATABASE_URL;
const observer = url ? new PrismaClient({ datasourceUrl: url }) : undefined;
after(async () => { await observer?.$disconnect(); });

type Queries = Pick<LinkSql, "$queryRawUnsafe" | "$executeRawUnsafe">;
type Call = { kind: "query" | "execute"; phase: "before" | "after"; query: string };
type Probe = (call: Call) => Promise<void>;
type TransactionOptions = { isolationLevel?: "ReadCommitted"; maxWait?: number; timeout?: number };

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function instrument(sql: Queries, probe: Probe): Queries {
  return {
    async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
      await probe({ kind: "query", phase: "before", query });
      const result = await sql.$queryRawUnsafe<T>(query, ...values);
      await probe({ kind: "query", phase: "after", query });
      return result;
    },
    async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
      await probe({ kind: "execute", phase: "before", query });
      const result = await sql.$executeRawUnsafe(query, ...values);
      await probe({ kind: "execute", phase: "after", query });
      return result;
    },
  };
}

function instrumentClient(client: PrismaClient, probe: Probe): LinkSql {
  return {
    ...instrument(client, probe),
    $transaction<T>(run: (tx: Queries) => Promise<T>, options?: TransactionOptions): Promise<T> {
      return client.$transaction((tx) => run(instrument(tx, probe)), options);
    },
  } as LinkSql;
}

const globalEvent = (sequence: number, data: string): ServerEventEnvelope => ({
  type: "event", stream: "global", sequence, at: "2026-10-14T12:00:00Z",
  event: { type: "terminal.output", terminalId: "term", data },
});

async function fixture(t: TestContext, probe: Probe = async () => {}) {
  const connectionUrl = new URL(url!);
  connectionUrl.searchParams.set("connection_limit", "1");
  const a = new PrismaClient({ datasourceUrl: connectionUrl.toString() });
  const b = new PrismaClient({ datasourceUrl: connectionUrl.toString() });
  const user = `link_concurrency_${randomUUID()}`;
  const device = "mac";
  const options = { clock: () => 0, pollMs: 5 };
  const fresh = (sql: LinkSql = observer!) => new PgLinkHub(sql, options).link(user, device);
  t.after(async () => {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
    for (const table of ["CodeLinkResponse", "CodeLinkCommand", "CodeLinkEvent", "CodeLinkSession", "CodeLinkHost"]) {
      await observer!.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "userId" = $1`, user);
    }
  });
  const [{ pid: aPid }] = await a.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS "pid"`);
  const [{ pid: bPid }] = await b.$queryRawUnsafe<{ pid: number }[]>(`SELECT pg_backend_pid() AS "pid"`);
  return {
    writerA: fresh(instrumentClient(a, probe)),
    writerB: fresh(b),
    fresh,
    aPid,
    bPid,
    async state() {
      const [host] = await observer!.$queryRawUnsafe<{ globalSeq: number }[]>(
        `SELECT "globalSeq" FROM "CodeLinkHost" WHERE "userId" = $1 AND "deviceId" = $2`, user, device,
      );
      const rows = await observer!.$queryRawUnsafe<{ sequence: number; payload: ServerEventEnvelope }[]>(
        `SELECT "sequence", "payload" FROM "CodeLinkEvent" WHERE "userId" = $1 AND "deviceId" = $2 AND "sessionId" = '' ORDER BY "sequence"`, user, device,
      );
      return { globalSeq: host?.globalSeq ?? 0, rows };
    },
  };
}

async function untilPaused(entered: ReturnType<typeof gate>, work: Promise<unknown>) {
  await Promise.race([
    entered.promise,
    work.then(() => { throw new Error("The writer completed without reaching its SQL barrier."); }),
  ]);
}

/** Wait for a real PostgreSQL lock wait or completion, without a timing-based race. */
async function competingState(pid: number, work: Promise<unknown>): Promise<"completed" | "blocked"> {
  let completed = false;
  void work.then(() => { completed = true; }, () => { completed = true; });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (completed) return "completed";
    const [state] = await observer!.$queryRawUnsafe<{ wait: string | null }[]>(
      `SELECT "wait_event_type" AS "wait" FROM pg_stat_activity WHERE "pid" = $1`, pid,
    );
    if (state?.wait === "Lock") return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("The competing writer neither completed nor waited on its host row lock.");
}

const options = { skip: !url, timeout: 10_000 };

test("postgres globals: concurrent retries of one origin publish once across hub instances", options, async (t) => {
  const entered = gate();
  const release = gate();
  let paused = false;
  const f = await fixture(t, async (call) => {
    if (!paused && call.kind === "query" && call.phase === "after" && call.query.includes("'_origin'")) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  const event = globalEvent(100, "one output");
  const first = f.writerA.push({ events: [event] });
  let second: Promise<{ accepted: number }> | undefined;
  try {
    await untilPaused(entered, first);
    second = f.writerB.push({ events: [event] });
    t.diagnostic(`Competing writer: ${await competingState(f.bPid, second)}`);
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  const results = await Promise.all([first, second!]);
  assert.equal(results.reduce((sum, result) => sum + result.accepted, 0), 1);
  const state = await f.state();
  assert.equal(state.globalSeq, 1);
  assert.equal(state.rows.length, 1, "a concurrent retried push must not repeat terminal output");
  assert.equal((await f.fresh().push({ events: [event] })).accepted, 0, "a new hub also sees the durable receipt");
});

test("postgres globals: a later publication cannot make a viewer skip an earlier event", options, async (t) => {
  const entered = gate();
  const release = gate();
  let paused = false;
  const f = await fixture(t, async (call) => {
    if (!paused && call.kind === "execute" && call.phase === "before" && call.query.includes('INSERT INTO "CodeLinkEvent"')) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  const first = f.writerA.push({ events: [globalEvent(100, "first")] });
  let second: Promise<{ accepted: number }> | undefined;
  let observed: ServerEventEnvelope[] = [];
  let cursor = -1;
  try {
    await untilPaused(entered, first);
    second = f.writerB.push({ events: [globalEvent(101, "second")] });
    t.diagnostic(`Competing writer: ${await competingState(f.bPid, second)}`);
    observed = (await f.fresh().poll({}, -1, 0)).events ?? [];
    cursor = Math.max(-1, ...observed.map((event) => event.sequence));
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
  }
  await Promise.all([first, second!]);
  observed.push(...(await f.fresh().poll({}, cursor, 0)).events ?? []);
  assert.deepEqual(observed.map((event) => event.sequence), [1, 2], "every committed sequence remains reachable from the viewer's cursor");
  assert.deepEqual(observed.map((event) => event.event.type === "terminal.output" && event.event.data), ["first", "second"]);
});

test("postgres globals: a failure after insertion rolls back both event and sequence before retry", options, async (t) => {
  const failure = new Error("Injected failure before publication commit");
  let failed = false;
  const f = await fixture(t, async (call) => {
    if (!failed && call.kind === "execute" && call.phase === "after" && call.query.includes('INSERT INTO "CodeLinkEvent"')) {
      failed = true;
      throw failure;
    }
  });
  const event = globalEvent(100, "retry me");
  await assert.rejects(f.writerA.push({ events: [event] }), failure);
  assert.deepEqual(await f.state(), { globalSeq: 0, rows: [] });
  assert.equal((await f.writerB.push({ events: [event] })).accepted, 1);
  assert.deepEqual((await f.fresh().poll({}, -1, 0)).events?.map((item) => item.sequence), [1]);
  assert.equal((await f.fresh().push({ events: [event] })).accepted, 0);
});

test("postgres globals: losing the writer's database connection cannot commit half a publication", options, async (t) => {
  const entered = gate();
  const release = gate();
  let paused = false;
  const f = await fixture(t, async (call) => {
    if (!paused && call.kind === "execute" && call.phase === "after" && call.query.includes('INSERT INTO "CodeLinkEvent"')) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
  });
  const event = globalEvent(100, "survive connection loss");
  const first = f.writerA.push({ events: [event] });
  let visibleBeforeCommit: Awaited<ReturnType<typeof f.state>> | undefined;
  try {
    await untilPaused(entered, first);
    visibleBeforeCommit = await f.state();
    const [{ stopped }] = await observer!.$queryRawUnsafe<{ stopped: boolean }[]>(
      `SELECT pg_terminate_backend($1::int) AS "stopped"`, f.aPid,
    );
    assert.equal(stopped, true);
  } finally {
    release.resolve();
  }
  await assert.rejects(first);
  assert.deepEqual(visibleBeforeCommit, { globalSeq: 0, rows: [] }, "readers see neither uncommitted allocation nor event");
  assert.deepEqual(await f.state(), { globalSeq: 0, rows: [] });
  assert.equal((await f.writerB.push({ events: [event] })).accepted, 1);
  assert.deepEqual((await f.fresh().poll({}, -1, 0)).events?.map((item) => item.sequence), [1]);
});

test("postgres globals: parallel batches and later retries remain ordered and private after new hubs attach", options, async (t) => {
  const f = await fixture(t);
  const events = Array.from({ length: 12 }, (_, i) => globalEvent(100 + i, `output-${i}`));
  const batches = [events.slice(0, 4), events.slice(4, 8), events.slice(8)];
  const replies = await Promise.all(batches.map((batch, i) => (i % 2 ? f.writerA : f.writerB).push({ events: batch })));
  assert.equal(replies.reduce((sum, reply) => sum + reply.accepted, 0), events.length);
  const retry = await Promise.all([f.writerA.push({ events }), f.writerB.push({ events })]);
  assert.deepEqual(retry, [{ accepted: 0 }, { accepted: 0 }]);
  const delivered = (await f.fresh().poll({}, -1, 0)).events ?? [];
  assert.deepEqual(delivered.map((event) => event.sequence), events.map((_, i) => i + 1));
  assert.deepEqual(
    delivered.map((event) => event.event.type === "terminal.output" && event.event.data).sort(),
    events.map((event) => event.event.type === "terminal.output" && event.event.data).sort(),
  );
  assert.ok(delivered.every((event) => !("_origin" in event)), "dedupe keys stay inside the store");
  assert.deepEqual((await f.fresh().poll({}, events.length, 0)).events, []);
});

const sessionEvent = (sessionId: string, sequence: number): ServerEventEnvelope => ({
  type: "event", stream: "session", sessionId, sequence, at: "2026-10-14T12:00:00Z",
  event: { type: "terminal.output", terminalId: "term", data: `${sessionId}:${sequence}` },
} as unknown as ServerEventEnvelope);

async function cleanup(user: string) {
  for (const table of ["CodeLinkResponse", "CodeLinkCommand", "CodeLinkEvent", "CodeLinkSession", "CodeLinkHost"]) {
    await observer!.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "userId" = $1`, user);
  }
}

/** Two "replicas" (separate clients and connection pools) over one database. */
function replicas(t: TestContext, clock: () => number = () => 0) {
  const a = new PrismaClient({ datasourceUrl: url! });
  const b = new PrismaClient({ datasourceUrl: url! });
  const users: string[] = [];
  t.after(async () => {
    await Promise.all([a.$disconnect(), b.$disconnect()]);
    for (const user of users) await cleanup(user);
  });
  const opts = { clock, pollMs: 5 };
  return {
    user() {
      const id = `link_cmd_${randomUUID()}`;
      users.push(id);
      return id;
    },
    hubA: new PgLinkHub(a as unknown as LinkSql, opts),
    hubB: new PgLinkHub(b as unknown as LinkSql, opts),
    fresh: () => new PgLinkHub(observer as unknown as LinkSql, opts),
  };
}

const answer = (id: string, value: string) => ({ type: "response" as const, id, ok: true as const, result: { value } });

test("postgres relay: accounts, devices and sessions publishing at once stay ordered and private", options, async (t) => {
  const r = replicas(t);
  const tenants = [r.user(), r.user()];
  const writers = tenants.flatMap((user) => ["mac", "mini"].map((device) => ({ user, device })));
  await Promise.all(writers.map(({ user, device }) => r.hubA.link(user, device).pull(0)));
  await Promise.all(writers.flatMap(({ user, device }) => [0, 1, 2].map((batch) =>
    (batch % 2 ? r.hubA : r.hubB).link(user, device).push({
      events: [
        globalEvent(batch * 10, `${user}/${device}/g${batch}`),
        ...["s1", "s2"].flatMap((session) => [1, 2].map((n) => sessionEvent(session, batch * 2 + n))),
      ],
    }),
  )));
  for (const { user, device } of writers) {
    const { events = [] } = await r.fresh().link(user, device).poll({ s1: 0, s2: 0 }, -1, 0);
    const globals = events.filter((e) => e.stream === "global");
    assert.deepEqual(globals.map((e) => e.sequence), [1, 2, 3], "each device numbers its own global stream");
    assert.ok(globals.every((e) => e.event.type === "terminal.output" && e.event.data.startsWith(`${user}/${device}/`)), "no other account's or device's globals");
    for (const session of ["s1", "s2"]) {
      const own = events.filter((e) => e.stream === "session" && e.sessionId === session).map((e) => e.sequence);
      assert.deepEqual(own, [1, 2, 3, 4, 5, 6]);
    }
  }
});

test("postgres relay: a pull the Mac hung up on hands its commands to the next pull", options, async (t) => {
  const r = replicas(t, Date.now);
  const user = r.user();
  const gone = new AbortController();
  const client = new PrismaClient({ datasourceUrl: url! });
  t.after(() => client.$disconnect());
  // The connection drops in the worst place: right after the lease was taken, before the reply.
  const host = new PgLinkHub(instrumentClient(client, async (call) => {
    if (call.phase === "after" && call.query.includes('SET "claimedAt" = $4')) gone.abort();
  }), { pollMs: 5 }).link(user, "mac");
  await r.hubA.link(user, "mac").pull(0);
  const rpc = r.hubB.link(user, "mac").rpc({ id: "c1", type: "session.list" } as never);
  const early = new AbortController();
  early.abort();
  assert.deepEqual((await r.hubA.link(user, "mac").pull(1_000, early.signal)).commands, [], "a pull already hung up takes nothing");
  const lost = await host.pull(5_000, gone.signal);
  assert.equal(gone.signal.aborted, true);
  assert.equal(lost.commands.length, 0, "an aborted pull never hands out a command");
  const next = await r.hubB.link(user, "mac").pull(1_000);
  assert.equal(next.commands.length, 1, "the command is leased again only because it was never delivered");
  await r.hubA.link(user, "mac").push({ responses: [answer(next.commands[0].id, "listed")] });
  assert.deepEqual((await rpc).responses?.[0], answer("c1", "listed"));
});

test("postgres relay: concurrent pulls on two replicas never deliver one command twice", options, async (t) => {
  const r = replicas(t, Date.now);
  const user = r.user();
  await r.hubA.link(user, "mac").pull(0);
  const rpcs = Array.from({ length: 8 }, (_, i) => r.hubA.link(user, "mac").rpc({ id: `c${i}`, type: "session.list" } as never));
  const seen: string[] = [];
  while (seen.length < rpcs.length) {
    const pulls = await Promise.all([r.hubA.link(user, "mac").pull(50), r.hubB.link(user, "mac").pull(50)]);
    const ids = pulls.flatMap((p) => p.commands.map((c) => c.id));
    seen.push(...ids);
    await Promise.all(ids.map((id, i) => (i % 2 ? r.hubA : r.hubB).link(user, "mac").push({ responses: [answer(id, id)] })));
  }
  assert.equal(new Set(seen).size, seen.length, "no relay id handed out twice");
  const replies = await Promise.all(rpcs);
  replies.forEach((reply, i) => assert.equal(reply.responses?.[0].id, `c${i}`));
  assert.equal(new Set(replies.map((reply) => (reply.responses?.[0] as { result: { value: string } }).result.value)).size, rpcs.length, "each browser gets its own command's answer");
});

test("postgres relay: a late, repeated or foreign answer never settles another command, across restarts", options, async (t) => {
  let now = 0;
  const r = replicas(t, () => now);
  const user = r.user();
  const intruder = r.user();
  await r.hubA.link(user, "mac").pull(0);
  await r.hubA.link(intruder, "mac").pull(0);
  // An RPC times out after the Mac took its command.
  const first = r.hubA.link(user, "mac").rpc({ id: "c1", type: "session.list" } as never);
  const [old] = (await r.hubB.link(user, "mac").pull(1_000)).commands;
  assert.ok(old);
  now = LINK_TIMEOUT + 1;
  assert.equal((await first).responses?.[0].ok, false);
  now = 0;
  // The backend restarts (fresh hubs); a new command goes out with the same browser id.
  const second = r.fresh().link(user, "mac").rpc({ id: "c1", type: "session.list" } as never);
  const [current] = (await r.fresh().link(user, "mac").pull(1_000)).commands;
  assert.ok(current && current.id !== old.id, "relay ids are never reused");
  // The old answer arrives late, another account tries the new id, and the Mac repeats its push.
  assert.deepEqual(await r.hubA.link(user, "mac").push({ responses: [answer(old.id, "stale")] }), { accepted: 0 });
  assert.deepEqual(await r.hubA.link(intruder, "mac").push({ responses: [answer(current.id, "forged")] }), { accepted: 0 });
  assert.deepEqual(await r.hubB.link(user, "mac").push({ responses: [answer(current.id, "fresh")] }), { accepted: 1 });
  assert.deepEqual(await r.hubA.link(user, "mac").push({ responses: [answer(current.id, "again")] }), { accepted: 0 });
  assert.deepEqual((await second).responses?.[0], answer("c1", "fresh"));
  const [{ n }] = await observer!.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (SELECT count(*) FROM "CodeLinkCommand" WHERE "userId" = ANY($1::text[])) + (SELECT count(*) FROM "CodeLinkResponse" WHERE "userId" = ANY($1::text[]))::int AS n`, [user, intruder],
  );
  assert.equal(Number(n), 0, "nothing pending or unread is left behind");
});

/** A pull from a host that keeps receipts (`{kind:"pull", receipts:true}`), or one that does not. */
const pullAs = (link: ReturnType<PgLinkHub["link"]>, receipts: boolean, waitMs = 0) => link.pull(waitMs, undefined, undefined, false, receipts);

test("postgres relay: an unanswered lease is handed out again only to a host that keeps receipts", options, async (t) => {
  let now = 1_000_000;
  const r = replicas(t, () => now);
  const user = r.user();
  await r.hubA.link(user, "mac").pull(0);
  const rpc = r.hubA.link(user, "mac").rpc({ id: "c1", type: "session.list" } as never);
  const [first] = (await pullAs(r.hubB.link(user, "mac"), true, 1_000)).commands;
  assert.ok(first);
  now += LINK_LIMITS.leaseRedeliverMs - 1;
  assert.deepEqual((await pullAs(r.hubA.link(user, "mac"), true)).commands, [], "a fresh lease is not taken again");
  now += 1;
  assert.deepEqual((await pullAs(r.hubA.link(user, "mac"), false)).commands, [], "a host without receipts stays at-most-once");
  // Two replicas race for the stale lease: exactly one redelivers it.
  const racing = await Promise.all([pullAs(r.hubA.link(user, "mac"), true), pullAs(r.hubB.link(user, "mac"), true)]);
  const again = racing.flatMap((p) => p.commands);
  assert.deepEqual(again.map((c) => c.id), [first.id], "the reply was lost: the same relay id goes out once more");
  assert.deepEqual(await r.hubB.link(user, "mac").push({ responses: [answer(first.id, "listed")] }), { accepted: 1 });
  assert.deepEqual((await rpc).responses?.[0], answer("c1", "listed"));
});

test("postgres relay: redelivery stops at the attempt cap, and a late answer still settles the call once", options, async (t) => {
  let now = 1_000_000;
  const r = replicas(t, () => now);
  const user = r.user();
  await r.hubA.link(user, "mac").pull(0);
  const rpc = r.hubA.link(user, "mac").rpc({ id: "c1", type: "turn.start", params: { sessionId: "s1", input: [] } } as never);
  const deliveries: string[] = [];
  deliveries.push(...(await pullAs(r.hubB.link(user, "mac"), true, 1_000)).commands.map((c) => c.id));
  // One window past the last delivery, still inside the RPC's own timeout.
  assert.ok(LINK_LIMITS.maxDeliveries * LINK_LIMITS.leaseRedeliverMs < LINK_TIMEOUT);
  for (let i = 0; i < LINK_LIMITS.maxDeliveries; i++) {
    now += LINK_LIMITS.leaseRedeliverMs;
    deliveries.push(...(await pullAs((i % 2 ? r.hubA : r.hubB).link(user, "mac"), true)).commands.map((c) => c.id));
  }
  assert.equal(deliveries.length, LINK_LIMITS.maxDeliveries, "never more deliveries than the cap");
  assert.equal(new Set(deliveries).size, 1);
  const [{ attempts }] = await observer!.$queryRawUnsafe<{ attempts: number }[]>(
    `SELECT "attempts" FROM "CodeLinkCommand" WHERE "relayId" = $1`, deliveries[0],
  );
  assert.equal(attempts, LINK_LIMITS.maxDeliveries, "the row waits for its answer after the last delivery");
  // The first delivery's answer arrives late; the Mac then re-sends it from its receipt for a repeat.
  assert.deepEqual(await r.hubA.link(user, "mac").push({ responses: [answer(deliveries[0], "started")] }), { accepted: 1 });
  assert.deepEqual(await r.hubB.link(user, "mac").push({ responses: [answer(deliveries[0], "started")] }), { accepted: 0 });
  assert.deepEqual((await rpc).responses?.[0], answer("c1", "started"));
  now += LINK_LIMITS.leaseRedeliverMs;
  assert.deepEqual((await pullAs(r.hubA.link(user, "mac"), true)).commands, [], "an answered command is gone");
});

test("postgres relay: an aborted redelivery gives its attempt back, and an answer after the RPC gave up is dropped", options, async (t) => {
  let now = 1_000_000;
  const r = replicas(t, () => now);
  const user = r.user();
  await r.hubA.link(user, "mac").pull(0);
  const rpc = r.hubA.link(user, "mac").rpc({ id: "c1", type: "session.list" } as never);
  const [first] = (await pullAs(r.hubB.link(user, "mac"), true, 1_000)).commands;
  assert.ok(first);
  now += LINK_LIMITS.leaseRedeliverMs;
  // The redelivering pull's connection drops right after it took the lease.
  const gone = new AbortController();
  const client = new PrismaClient({ datasourceUrl: url! });
  t.after(() => client.$disconnect());
  const host = new PgLinkHub(instrumentClient(client, async (call) => {
    if (call.phase === "after" && call.query.includes('SET "claimedAt" = $4')) gone.abort();
  }), { pollMs: 5, clock: () => now }).link(user, "mac");
  assert.deepEqual((await host.pull(1_000, gone.signal, undefined, false, true)).commands, []);
  const [{ attempts }] = await observer!.$queryRawUnsafe<{ attempts: number }[]>(
    `SELECT "attempts" FROM "CodeLinkCommand" WHERE "relayId" = $1`, first.id,
  );
  assert.equal(attempts, 1, "a delivery that never reached the Mac does not count");
  // The RPC gives up; the Mac's answer, from either delivery, is no longer kept.
  now += LINK_TIMEOUT;
  assert.equal((await rpc).responses?.[0].ok, false);
  assert.deepEqual(await r.hubA.link(user, "mac").push({ responses: [answer(first.id, "late")] }), { accepted: 0 });
  assert.deepEqual((await pullAs(r.hubB.link(user, "mac"), true)).commands, [], "a command whose RPC gave up is never redelivered");
  const [{ n }] = await observer!.$queryRawUnsafe<{ n: number }[]>(
    `SELECT (SELECT count(*) FROM "CodeLinkCommand" WHERE "userId" = $1) + (SELECT count(*) FROM "CodeLinkResponse" WHERE "userId" = $1)::int AS n`, user,
  );
  assert.equal(Number(n), 0);
});
