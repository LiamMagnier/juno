/** Real PostgreSQL interleavings; every instrumented SQL operation reaches the database. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import { PrismaClient } from "@prisma/client";

import { PgLinkHub, type LinkSql } from "@/lib/code-v2/env-link-store-pg";
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
      `SELECT pg_terminate_backend($1) AS "stopped"`, f.aPid,
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
