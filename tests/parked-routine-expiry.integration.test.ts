/**
 * Unattended routine runs parked for an answer end after 24 hours
 * (src/lib/work/store.ts expireParkedRoutineRuns). Opt-in, like the other DB tests:
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_test \
 *     NODE_OPTIONS=--conditions=react-server npx tsx --test tests/parked-routine-expiry.integration.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;

test("a routine run parked for 24 hours is ended; attended and recent ones are kept", { skip: !url }, async () => {
  assert.match(url!, /\/[a-z_]*test$/, "only a throwaway *test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "parked-routine-expiry-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  const store = await import("../src/lib/work/store");

  const owner = `parked-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    const session = await store.createWorkSession({ userId: owner, title: "Inbox triage", goal: "Triage", requestedTarget: "cloud" });
    const schedule = await db.workSchedule.create({ data: { userId: owner, sessionId: session.id, name: "Morning triage", instructions: "Triage" } });
    const run = async (label: string, attended: boolean, status: string, hoursAgo: number, pauseReason: string | null = "waiting") => {
      const created = await store.createRun({
        sessionId: session.id, userId: owner, origin: "schedule", scheduleId: schedule.id, requestedTarget: "cloud", effectiveTarget: "cloud",
        effectiveModel: "test-model", permissionPolicy: { policy: "balanced", attended },
        budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false, idempotencyKey: `${label}:${randomUUID()}`,
      });
      await db.workRun.update({ where: { id: created.run.id }, data: { status, pauseReason } });
      await db.$executeRaw`UPDATE "WorkRun" SET "updatedAt" = ${new Date(Date.now() - hoursAgo * 3_600_000)} WHERE "id" = ${created.run.id}`;
      return created.run.id;
    };
    const stale = await run("stale", false, "paused", 30);
    const byHand = await run("by-hand", true, "paused", 30);
    const recent = await run("recent", false, "paused", 2);
    const running = await run("running", false, "running", 30);
    const deliberatelyPaused = await run("deliberate", false, "paused", 30, "user");
    const legacy = await run("legacy", false, "paused", 30, null);

    const expired = await store.expireParkedRoutineRuns({ now: new Date() });
    assert.ok(expired.includes(stale), "the stale unattended run is ended");
    for (const kept of [byHand, recent, running, deliberatelyPaused, legacy]) assert.ok(!expired.includes(kept), `${kept} is left alone`);

    const ended = await db.workRun.findUniqueOrThrow({ where: { id: stale } });
    assert.equal(ended.status, "interrupted");
    assert.equal(ended.terminalReason, "interrupted");
    assert.equal(ended.terminalDetail, store.PARKED_ROUTINE_RUN_EXPIRED_DETAIL);
    for (const kept of [byHand, recent, deliberatelyPaused, legacy]) assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: kept } })).status, "paused");
    // Run again: nothing left to expire.
    assert.deepEqual((await store.expireParkedRoutineRuns({ now: new Date() })).filter((id) => [stale, byHand, recent, running, deliberatelyPaused, legacy].includes(id)), []);

    // An expired wait read by the sweep may be resumed or deliberately paused
    // before its conditional terminal write reaches the database.
    for (const [status, pauseReason] of [["queued", null], ["paused", "user"]] as const) {
      const raced = await run("raced", false, status, 30, pauseReason);
      const result = await store.finishRun({ runId: raced, userId: owner, reason: "interrupted", parkedBefore: new Date(Date.now() - store.PARKED_ROUTINE_RUN_TTL_MS) });
      assert.equal(result.finished, false, "the expiry predicate is rechecked at the write");
    }

    for (const pauseReason of [null, "user"] as const) {
      const id = await run("parking", false, "running", 0, pauseReason);
      await db.workRun.update({ where: { id }, data: { claimedBy: "test-worker" } });
      assert.equal(await store.parkRun({ runId: id, userId: owner, executorId: "test-worker" }), true);
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id } })).pauseReason, pauseReason ?? "waiting");
    }
  } finally {
    await db.user.delete({ where: { id: owner } }).catch(() => undefined);
    await db.$disconnect();
  }
});
