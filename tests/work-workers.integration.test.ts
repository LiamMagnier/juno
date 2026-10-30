/** Production worker entry points, real Postgres, no model or connector I/O.
 * WORKER_TEST_DATABASE_URL=…/juno_worker_test NODE_OPTIONS=--conditions=react-server
 * npx tsx --test --experimental-test-module-mocks tests/work-workers.integration.test.ts
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.WORKER_TEST_DATABASE_URL;
if (!url) {
  test("worker harness requires a throwaway database", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_]*test$/);
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "worker-harness-test-key";
  globalThis.fetch = async () => { throw new Error("worker harness attempted network I/O"); };

  test("scheduler and poller handle budget refusals, every trigger, deleted tasks and parked expiry", async () => {
    const store = await import("../src/lib/work/store");
    let refuseReservation = false;
    mock.module("@/lib/work/store", { namedExports: { ...store,
      createRun: async (input: Parameters<typeof store.createRun>[0]) => {
        if (refuseReservation && input.spendReservation !== false) throw new store.WorkSpendAdmissionError({ allowed: false, refusedBy: "period" } as ConstructorParameters<typeof store.WorkSpendAdmissionError>[0]);
        return store.createRun(input);
      },
    } });
    const scheduler = await import("../scripts/work-scheduler");
    const poller = await import("../scripts/work-trigger-poller");
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    // A cloud worker is alive, as in production: the scheduler asks that
    // before it reserves spend, and with none it skips as executor_unavailable.
    const { recordExecutorHeartbeat } = await import("../src/lib/work/executor-heartbeat");
    await recordExecutorHeartbeat();
    const userId = `workers_${randomUUID()}`;
    const now = new Date("2026-10-19T08:00:10Z");
    try {
      await db.user.create({ data: { id: userId, email: `${userId}@example.invalid` } });
      const schedule = async (name: string, deleted = false, runKind = "work") => {
        const session = await db.workSession.create({ data: { userId, title: name, goal: "Test", deletedAt: deleted ? new Date() : null } });
        return db.workSchedule.create({ data: { userId, sessionId: session.id, name, instructions: "Test", target: "cloud", runKind, timezone: "UTC", nextRunAt: new Date("2026-10-19T08:00:00Z"), triggers: { create: [
          { userId, kind: "daily", config: { hour: 8, minute: 0 } },
          { userId, kind: "weekly", config: { weekday: 1, hour: 17, minute: 0 } },
        ] } }, include: { session: true } });
      };
      const limits = (remainingMicroUsd: number) => new Map([[userId, { plan: "PRO" as const, remainingMicroUsd, windowRemainingMicroUsd: remainingMicroUsd, weekly: { startMs: now.getTime() - 86_400_000, resetsAtMs: now.getTime() + 86_400_000 } }]]);
      const reserved = await schedule("Reservation refusal");
      refuseReservation = true;
      await scheduler.dispatchSchedule(reserved, now, limits(100));
      refuseReservation = false;
      let saved = await db.workSchedule.findUniqueOrThrow({ where: { id: reserved.id } });
      assert.equal(saved.nextRunAt?.toISOString(), "2026-10-19T17:00:00.000Z", "the second trigger is still owed today");
      assert.equal(saved.lockedUntil, null);
      const marker = await db.workRun.findFirstOrThrow({ where: { scheduleId: reserved.id } });
      assert.equal(marker.terminalReason, "budget_exceeded");

      const blocked = await schedule("Window refusal");
      await scheduler.dispatchSchedule(blocked, now, limits(0));
      assert.equal((await db.workSchedule.findUniqueOrThrow({ where: { id: blocked.id } })).nextRunAt?.toISOString(), "2026-10-19T17:00:00.000Z");
      assert.equal((await db.workRun.findFirstOrThrow({ where: { scheduleId: blocked.id } })).terminalReason, "budget_exceeded");

      // A routine switched back on while its agent is paused: skipped without
      // a run, recorded, advanced, released.
      const scout = await db.agent.create({ data: { userId, name: "Scout", status: "paused" } });
      const owned = await schedule("Paused agent");
      await db.workSession.update({ where: { id: owned.sessionId }, data: { agentId: scout.id } });
      await scheduler.dispatchSchedule(await db.workSchedule.findUniqueOrThrow({ where: { id: owned.id }, include: { session: true } }), now, limits(100));
      saved = await db.workSchedule.findUniqueOrThrow({ where: { id: owned.id } });
      assert.equal(saved.nextRunAt?.toISOString(), "2026-10-19T17:00:00.000Z");
      assert.equal(saved.lockedUntil, null);
      assert.equal(saved.lastRunAt, null, "a skipped fire is not a run");
      const skippedRuns = await db.workRun.findMany({ where: { scheduleId: owned.id } });
      assert.equal(skippedRuns.length, 1, "only the marker");
      assert.equal(skippedRuns[0]!.terminalReason, "superseded");
      assert.equal(skippedRuns[0]!.effectiveTarget, null, "nothing ran anywhere");
      assert.match(skippedRuns[0]!.terminalDetail ?? "", /^Scout is paused\./);

      const deleted = await schedule("Deleted task", true);
      assert.ok(!(await scheduler.findDueSchedules(now, 100)).some((row) => row.id === deleted.id));
      assert.equal(await poller.loadTriggerSchedule(deleted.id, userId), null);

      const code = await schedule("Code routine", false, "code");
      const trigger = await db.workTrigger.create({ data: { userId, scheduleId: code.id, kind: "topic_monitor", config: {} } });
      assert.equal(await poller.offerTriggerEvent(trigger, code, { kind: "topic_monitor", eventKey: "event", occurredAt: now, matchedTerms: ["test"], sourceCount: 1 }, { now, recent: [], budgets: limits(1000) }), "settled");
      assert.equal(await db.workRun.count({ where: { scheduleId: code.id } }), 0, "the poller never turns a Code routine into Work");

      const parked = await schedule("Parked");
      await db.workSchedule.update({ where: { id: parked.id }, data: { enabled: false, nextRunAt: null } });
      const run = await store.createRun({ userId, sessionId: parked.sessionId, scheduleId: parked.id, requestedTarget: "cloud", spendReservation: false, permissionPolicy: { attended: false } });
      await db.workRun.update({ where: { id: run.run.id }, data: { status: "paused", pauseReason: "waiting", updatedAt: new Date(Date.now() - 30 * 3_600_000) } });
      await scheduler.schedulerTick();
      assert.equal((await db.workRun.findUniqueOrThrow({ where: { id: run.run.id } })).terminalReason, "interrupted", "the production tick invokes parked-run expiry");
      saved = await db.workSchedule.findUniqueOrThrow({ where: { id: deleted.id } });
      assert.equal(saved.lastRunAt, null);
    } finally {
      await db.user.delete({ where: { id: userId } }).catch(() => undefined);
      await db.$disconnect();
    }
  });
}
