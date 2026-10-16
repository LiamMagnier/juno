import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

/*
 * ROUTINES FROM CHAT AND THEIR HEALTH, THROUGH THE REAL ROUTES AGAINST POSTGRES
 * (G07, G13, G42).
 *
 * What runs for real: POST/GET /api/work/schedules (the body a chat proposal
 * card sends, built by `routineScheduleBody`), the proposal-key replay and its
 * unique index, the health each listed routine carries, and the Continue
 * refusal on POST /api/work/sessions/[id]/runs. Stand-in: the signed-in
 * session.
 *
 * Skipped unless ROUTINES_TEST_DATABASE_URL names a throwaway, migrated database:
 *   ROUTINES_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_routines_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/work-routine-proposal.integration.test.ts
 */

const DB_URL = process.env.ROUTINES_TEST_DATABASE_URL;

if (!DB_URL) {
  test("routines-from-chat suite is skipped without ROUTINES_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /\/[a-z0-9_]*test$/, "only a throwaway *test database");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.AUTH_SECRET ??= "routines-from-chat-test-secret";

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  const tag = randomUUID().slice(0, 8);
  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://juno.test${url}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("a proposal is scheduled once, however often Schedule is pressed, and lists with its health", async () => {
    const { prismaUnguarded: db } = await import("@/lib/prisma");
    const { admitRoutineProposal, routineScheduleBody, routineProposalKey } = await import("@/lib/work/routine-proposal");
    const route = await import("@/app/api/work/schedules/route");

    const owner = await db.user.create({ data: { email: `owner-${tag}@routines.test`, name: "owner" } });
    const other = await db.user.create({ data: { email: `other-${tag}@routines.test`, name: "other" } });
    try {
      const admitted = admitRoutineProposal(
        { name: "Morning inbox summary", instructions: "Summarise the new mail in my inbox.", schedule: "every weekday at 8am" },
        { key: routineProposalKey(`msg-${tag}`, 0), now: new Date(), defaultTimezone: "Europe/Paris", connectors: [], untrusted: false }
      );
      assert.equal(admitted.ok, true);
      if (!admitted.ok) return;
      const body = routineScheduleBody(admitted.proposal);

      signedIn = { id: owner.id, email: owner.email!, name: "owner" };
      const first = await route.POST(json("/api/work/schedules", "POST", body));
      assert.equal(first.status, 201);
      const created = (await first.json()).schedule;
      assert.equal(created.name, "Morning inbox summary");
      assert.equal(created.timezone, "Europe/Paris");
      assert.equal(created.target, "cloud");
      assert.equal(created.budget.maxCostMicroUsd > 0, true, "a drafted routine carries its own ceiling");
      assert.deepEqual(
        created.triggers.map((t: { kind: string; config: unknown }) => [t.kind, t.config]),
        [["weekdays", { hour: 8, minute: 0 }]]
      );

      // A second press, a press after a reload, two presses racing: one routine.
      const again = await route.POST(json("/api/work/schedules", "POST", body));
      assert.equal(again.status, 200);
      const replay = await again.json();
      assert.equal(replay.replay, true);
      assert.equal(replay.schedule.id, created.id);
      const raced = await Promise.all([1, 2].map(() => route.POST(json("/api/work/schedules", "POST", body))));
      for (const res of raced) assert.equal((await res.json()).schedule.id, created.id);
      assert.equal(await db.workSchedule.count({ where: { userId: owner.id } }), 1);

      // The card reads whether it was scheduled by key, with the routine's health.
      const found = await route.GET(json(`/api/work/schedules?proposalKey=${encodeURIComponent(admitted.proposal.key)}`, "GET"));
      const listed = (await found.json()).schedules;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, created.id);
      assert.equal(listed[0].health.state, "never_run");

      // Another account's press of the same key is its own routine, never this one.
      signedIn = { id: other.id, email: other.email!, name: "other" };
      const theirs = await route.GET(json(`/api/work/schedules?proposalKey=${encodeURIComponent(admitted.proposal.key)}`, "GET"));
      assert.deepEqual((await theirs.json()).schedules, []);
    } finally {
      signedIn = null;
      await db.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
    }
  });

  test("health reads the scheduler's skipped fires, a parked run and a broken trigger from real rows", async () => {
    const { prismaUnguarded: db } = await import("@/lib/prisma");
    const store = await import("@/lib/work/store");
    const { loadScheduleHealth } = await import("@/lib/work/schedule-health-store");

    const owner = await db.user.create({ data: { email: `health-${tag}@routines.test`, name: "health" } });
    try {
      const session = await store.createWorkSession({ userId: owner.id, title: "Digest", goal: "Digest", requestedTarget: "cloud" });
      const schedule = await db.workSchedule.create({
        data: {
          userId: owner.id,
          sessionId: session.id,
          name: "Digest",
          instructions: "Digest",
          triggers: { create: { userId: owner.id, kind: "daily", config: { hour: 8, minute: 0 } } },
        },
        include: { triggers: true },
      });
      const read = async () => (await loadScheduleHealth(owner.id, [schedule])).get(schedule.id);
      const run = async (label: string) =>
        (
          await store.createRun({
            sessionId: session.id, userId: owner.id, origin: "schedule", scheduleId: schedule.id, requestedTarget: "cloud",
            effectiveTarget: null, permissionPolicy: { policy: "balanced", attended: false },
            budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
            idempotencyKey: `${label}:${randomUUID()}`,
          })
        ).run.id;

      // The scheduler's record of a fire skipped for budget: never claimed.
      const skipped = await run("skipped");
      await store.finishRun({
        runId: skipped, userId: owner.id, reason: "budget_exceeded",
        detail: "This run was skipped because the account has used up the budget available to it.",
      });
      const spent = await read();
      assert.equal(spent?.state, "skipped");
      assert.equal(spent?.action?.kind, "usage");

      // Then a run parked on an approval: waiting, with when it is given up on.
      const parked = await run("parked");
      await db.workRun.update({ where: { id: parked }, data: { status: "paused", pauseReason: "waiting", startedAt: new Date() } });
      const waiting = await read();
      assert.equal(waiting?.state, "waiting");
      assert.ok(waiting?.waitingExpiresAt, "an unattended parked run says when it is stopped");

      // A trigger that cannot read its source outranks everything else.
      await db.workTrigger.updateMany({
        where: { scheduleId: schedule.id, userId: owner.id },
        data: { kind: "email_filter", config: {}, lastPollError: "Couldn't sign in to iCloud mail.", lastPolledAt: new Date() },
      });
      const rows = await db.workSchedule.findUniqueOrThrow({ where: { id: schedule.id }, include: { triggers: true } });
      const broken = (await loadScheduleHealth(owner.id, [rows])).get(schedule.id);
      assert.equal(broken?.state, "source_error");
      assert.equal(broken?.action?.kind, "reconnect");
    } finally {
      await db.user.deleteMany({ where: { id: owner.id } });
    }
  });

  test("a Continue from an attempt that finished cleanly is refused before anything starts", async () => {
    const { prismaUnguarded: db } = await import("@/lib/prisma");
    const store = await import("@/lib/work/store");
    const route = await import("@/app/api/work/sessions/[id]/runs/route");

    const owner = await db.user.create({ data: { email: `continue-${tag}@routines.test`, name: "continue" } });
    try {
      const session = await store.createWorkSession({ userId: owner.id, title: "Report", goal: "Report", requestedTarget: "cloud" });
      const created = await store.createRun({
        sessionId: session.id, userId: owner.id, origin: "manual", requestedTarget: "cloud", effectiveTarget: "cloud",
        permissionPolicy: { policy: "balanced", attended: true }, budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
        spendReservation: false, idempotencyKey: `done:${randomUUID()}`,
      });
      await store.finishRun({ runId: created.run.id, userId: owner.id, reason: "completed" });

      signedIn = { id: owner.id, email: owner.email!, name: "continue" };
      const params = { params: Promise.resolve({ id: session.id }) };
      const refused = await route.POST(
        json(`/api/work/sessions/${session.id}/runs`, "POST", {
          origin: "resume", continueFromRunId: created.run.id, continuation: "Finished: everything.",
        }),
        params
      );
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error, "not_continuable");
      // Half a Continue is malformed.
      const half = await route.POST(json(`/api/work/sessions/${session.id}/runs`, "POST", { origin: "resume", continuation: "x" }), params);
      assert.equal(half.status, 400);
      assert.equal(await db.workRun.count({ where: { sessionId: session.id } }), 1, "nothing was started");
    } finally {
      signedIn = null;
      await db.user.deleteMany({ where: { id: owner.id } });
    }
  });
}
