import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";

/*
 * store.ts against a real database.
 *
 * Every concurrency claim in src/lib/work/store.ts is an argument about what
 * Postgres does under READ COMMITTED: that putting the condition inside an
 * UPDATE's WHERE makes exactly one caller win, that the run's row lock
 * serialises concurrent event appends, and that a terminal reason can only be
 * written once. Arguments of that shape are exactly the ones that are wrong in
 * a way no amount of reading catches — the two callers have to actually race.
 *
 * Skipped unless WORK_TEST_DATABASE_URL names a throwaway database, because the
 * default test job has no Postgres and a suite that silently connects to
 * whatever DATABASE_URL happens to be set is a suite that one day truncates
 * something real. Run it with:
 *
 *   createdb worktest && DATABASE_URL=… npx prisma migrate deploy
 *   WORK_TEST_DATABASE_URL=postgresql://…/worktest npx tsx --test tests/work-store-db.test.ts
 */

const URL = process.env.WORK_TEST_DATABASE_URL;

if (!URL) {
  test("store.ts database suite is skipped without WORK_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  // Imported lazily and with the URL forced, so the module's own PrismaClient
  // cannot pick up an ambient DATABASE_URL pointing somewhere that matters.
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;

  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });

  // Imported inside the first test rather than at module scope: tsx compiles
  // this file to CJS, where a top-level await is a syntax error.
  type Store = typeof import("@/lib/work/store");
  let store!: Store;

  let userId = "";
  let sessionId = "";

  test("set up a throwaway account and session", async () => {
    store = await import("@/lib/work/store");
    await prisma.workEvent.deleteMany({});
    await prisma.workRun.deleteMany({});
    await prisma.workSession.deleteMany({});
    await prisma.user.deleteMany({ where: { email: "work-store-test@example.invalid" } });

    const user = await prisma.user.create({
      data: { email: "work-store-test@example.invalid", name: "Work store test" },
    });
    userId = user.id;

    const session = await store.createWorkSession({
      userId,
      title: "Organise Downloads",
      goal: "Sort every PDF in Downloads into folders by year.",
    });
    sessionId = session.id;

    assert.equal(session.status, "draft", "a new session costs nothing and holds no executor");
    assert.equal(session.needsAttention, false);
  });

  test("a caller-supplied id makes creation idempotent", async () => {
    const id = "wsi_deadbeefdeadbeefdeadbeefdeadbeef";
    const first = await store.createWorkSession({
      id, userId, title: "Retried", goal: "The same tap, twice.",
    });
    assert.equal(first.id, id);

    await assert.rejects(
      () => store.createWorkSession({ id, userId, title: "Retried", goal: "The same tap, twice." }),
      (error: unknown) => (error as { code?: string }).code === "P2002",
      "the primary key is what a retry collides on, and the route recovers from exactly this"
    );
  });

  test("only one of two racing executors claims a run", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    await prisma.workRun.updateMany({ where: { id: run.id }, data: { status: "queued" } });

    // Genuinely concurrent: both promises are in flight before either resolves.
    const [a, b] = await Promise.all([
      store.claimRun({ runId: run.id, userId, executorId: "worker-a" }),
      store.claimRun({ runId: run.id, userId, executorId: "worker-b" }),
    ]);

    const winners = [a, b].filter((result) => result.claimed);
    assert.equal(
      winners.length, 1,
      "two executors both believing they own a run means two sandboxes, two sets of file writes, " +
        "and one user watching the same step happen twice"
    );

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.ok(["worker-a", "worker-b"].includes(stored.claimedBy ?? ""));
    assert.equal(stored.status, "preparing");
    assert.ok(stored.leaseExpiresAt && stored.leaseExpiresAt > new Date());
  });

  test("concurrent appends produce a dense sequence with no holes and no collisions", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });

    const batches = Array.from({ length: 8 }, (_, batch) =>
      store.appendEvents({
        runId: run.id,
        userId,
        events: Array.from({ length: 5 }, (_, index) => ({
          kind: "assistant_message" as const,
          payload: { batch, index },
          key: `k:${batch}:${index}`,
        })),
      })
    );
    await Promise.all(batches);

    const events = await prisma.workEvent.findMany({
      where: { runId: run.id },
      orderBy: { seq: "asc" },
      select: { seq: true },
    });

    assert.equal(events.length, 40);
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: 40 }, (_, i) => i + 1),
      "a hole in the sequence is indistinguishable from an event that has not arrived yet, so the " +
        "SSE cursor waits for one that is never coming and the transcript stops updating for good"
    );

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(stored.lastSeq, 40, "lastSeq and the rows are the same fact and must agree");
  });

  test("a replayed batch is dropped rather than appended twice", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    const events = [
      { kind: "run_started" as const, payload: {}, key: "replay:1" },
      { kind: "assistant_message" as const, payload: { text: "hello" }, key: "replay:2" },
    ];

    await store.appendEvents({ runId: run.id, userId, events });
    await store.appendEvents({ runId: run.id, userId, events });

    const rows = await prisma.workEvent.findMany({ where: { runId: run.id }, orderBy: { seq: "asc" } });
    assert.equal(rows.length, 2, "the executor retried a POST whose response was lost, not its work");
    assert.deepEqual(rows.map((r) => r.seq), [1, 2], "and the retry left no hole behind it");

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(stored.lastSeq, 2, "lastSeq must not count the events that were dropped");
  });

  test("a terminal reason is written once and cannot be overwritten", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    await prisma.workRun.updateMany({ where: { id: run.id }, data: { status: "running" } });

    const first = await store.finishRun({ runId: run.id, userId, reason: "completed" });
    assert.equal(first.finished, true);

    const second = await store.finishRun({ runId: run.id, userId, reason: "failed", detail: "late" });
    assert.equal(
      second.finished, false,
      "a late writer must not revive or relabel a run that already ended"
    );

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(stored.terminalReason, "completed");
    assert.equal(stored.status, "completed");
  });

  test("an expired lease on a live run is swept to interrupted, not re-queued", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    await prisma.workRun.updateMany({
      where: { id: run.id },
      data: {
        status: "running",
        claimedBy: "worker-that-died",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const swept = await store.reclaimStalledRuns({ userId });
    assert.ok(swept.reclaimed.includes(run.id));

    const stored = await prisma.workRun.findFirstOrThrow({ where: { id: run.id } });
    assert.equal(
      stored.status, "interrupted",
      "nobody decided this one: not the run, which would be failed, and not a person, which would be cancelled"
    );
    assert.equal(stored.terminalReason, "interrupted");
    assert.notEqual(
      stored.status, "queued",
      "re-queueing would repeat whichever files it had already moved before its executor died"
    );
  });

  test("a healthy lease is left alone by the sweep", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    await prisma.workRun.updateMany({
      where: { id: run.id },
      data: { status: "running", leaseExpiresAt: new Date(Date.now() + 60_000) },
    });

    const swept = await store.reclaimStalledRuns({ userId });
    assert.ok(!swept.reclaimed.includes(run.id), "a worker that is still reporting owns its run");
  });

  test("the session mirrors the current run's terminal state and attention", async () => {
    const { run } = await store.createRun({ sessionId, userId, requestedTarget: "cloud", spendReservation: false });
    await prisma.workRun.updateMany({ where: { id: run.id }, data: { status: "running" } });
    await store.finishRun({ runId: run.id, userId, reason: "host_offline" });

    const session = await prisma.workSession.findFirstOrThrow({ where: { id: sessionId } });
    assert.equal(session.status, "host_offline");
    assert.equal(
      session.needsAttention, true,
      "the run is over, but waking the Mac or moving to cloud is the user's decision and it is " +
        "never made if it is filed under failed"
    );
  });

  test("tear down", async () => {
    await prisma.workEvent.deleteMany({});
    await prisma.workRun.deleteMany({});
    await prisma.workSession.deleteMany({});
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });
}
