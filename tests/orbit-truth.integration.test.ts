/**
 * Orbit truth and controls (package O2), against a real Postgres:
 *
 *   - hiring is refused on a plan without agents, with an upgrade answer and
 *     nothing created; agents kept from before a downgrade stay listed and
 *     readable;
 *   - a note a task saves follows the agent's "What it may remember" setting
 *     (pending until kept, kept at once under "full"), is encrypted at rest,
 *     never holds a secret, reaches no turn or task until it is kept, and is
 *     bounded per run;
 *   - a goal is met only when its final step's run checked the success
 *     criteria and the check passed; a NOT MET, or no check at all, leaves it
 *     `unverified`, and the person is told either way.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_orbit_truth_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test tests/orbit-truth.integration.test.ts
 *
 * No provider is called: the criteria check is a fake standing in for
 * `checkGoalCriteria` (runner/agent-core/src/work/judge.ts, tested on its own
 * in runner/agent-core/src/test/work-judge.test.ts).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const url = process.env.ORBIT_TEST_DATABASE_URL;

async function setup() {
  assert.match(url!, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.AUTH_SECRET ??= "orbit-truth-isolated-integration-test-key";
  const { prismaUnguarded: db } = await import("../src/lib/prisma");
  return db;
}

test("hiring needs a plan with agents; a downgraded account keeps and reads its agents", { skip: !url }, async () => {
  const db = await setup();
  const agents = await import("../src/lib/agents/store");
  const { createAgentSchema } = await import("../src/lib/agents/domain");
  const owner = `o2-plan-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    const user = { id: owner };
    const input = () => createAgentSchema.parse({ name: "Wren", creationKey: randomUUID(), starterMessage: "Watch flights to Tokyo" });

    // Free: refused up front, with the plan that includes agents, and nothing made.
    const refused = await agents.createAgentForUser(user, input());
    assert.equal(refused.status, 402);
    assert.equal(refused.body.error, "plan_locked");
    assert.equal(refused.body.upgradePlan, "PRO");
    assert.match(String(refused.body.message), /included from Pro/);
    assert.match(String(refused.body.message), /no agent was created/);
    assert.equal(await db.agent.count({ where: { userId: owner } }), 0);
    assert.equal(await db.conversation.count({ where: { userId: owner } }), 0);

    // Lite is a paid plan without agents: still refused.
    await db.subscription.create({ data: { userId: owner, plan: "LITE", status: "ACTIVE" } });
    assert.equal((await agents.createAgentForUser(user, input())).status, 402);

    // Pro: hired.
    await db.subscription.update({ where: { userId: owner }, data: { plan: "PRO" } });
    const hired = await agents.createAgentForUser(user, input());
    assert.equal(hired.status, 201);
    const agentId = (hired.body.agent as { id: string }).id;

    // Downgraded (the subscription lapsed): kept, listed, readable; never deleted.
    await db.subscription.update({ where: { userId: owner }, data: { status: "CANCELED" } });
    const roster = await agents.listAgentsForUser(owner);
    assert.deepEqual(roster.map((a) => a.id), [agentId]);
    const detail = await agents.loadAgentDetail(owner, agentId);
    assert.equal(detail?.agent.name, "Wren");
    // A copy is a hire, so it is refused too, and nothing is made.
    const copy = await agents.duplicateAgentForUser(user, agentId);
    assert.equal(copy.status, 402);
    assert.equal(await db.agent.count({ where: { userId: owner, deletedAt: null } }), 1);
  } finally {
    await db.user.deleteMany({ where: { id: owner } }).catch(() => {});
  }
});

test("a note a task saves follows the agent's memory setting, keeps no secret, and reaches nothing until kept", { skip: !url }, async () => {
  const db = await setup();
  const agents = await import("../src/lib/agents/store");
  const { saveRunNote, runAgentNoteDeps } = await import("../src/lib/agents/run-notes");
  const { loadAgentRunPersona } = await import("../src/lib/agents/run-context");
  const { MAX_RUN_NOTES_PER_RUN } = await import("../src/lib/agents/note-review");
  const owner = `o2-notes-${randomUUID()}`;
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    const user = { id: owner };
    const mira = await db.agent.create({ data: { userId: owner, name: "Mira", role: "Finance" } }); // memoryAccess: profile (default)
    const otto = await db.agent.create({ data: { userId: owner, name: "Otto", role: "Ops", memoryAccess: "full" } });
    const session = await db.workSession.create({ data: { userId: owner, agentId: mira.id, title: "Pay the invoices", goal: "Pay them" } });
    const run = await db.workRun.create({ data: { userId: owner, sessionId: session.id } });
    const save = (agentId: string, text: string, runId = run.id) => saveRunNote({ userId: owner, agentId, runId, sessionId: session.id, text });

    // "Your profile" (the default) asks for review: the note waits.
    const pending = await save(mira.id, "Invoices go to billing@acme.test on the 3rd of each month.");
    assert.equal(pending.ok, true);
    assert.equal(pending.ok && pending.pending, true);
    assert.match(pending.ok ? pending.detail : "", /only after they keep it/);
    const row = await db.agentNote.findFirstOrThrow({ where: { userId: owner, agentId: mira.id } });
    assert.equal(row.status, "pending");
    assert.equal(row.source, "agent");
    assert.match(row.content, /^enc:/, "encrypted at rest like every note");

    // Nothing reads it yet: not its notes, not its tasks; the profile lists it apart.
    assert.deepEqual(await agents.listAgentNotes(user, mira), []);
    assert.equal((await loadAgentRunPersona({ userId: owner, agentId: mira.id }))?.notes, null);
    let detail = await agents.loadAgentDetail(owner, mira.id);
    assert.deepEqual(detail?.notes, []);
    assert.deepEqual(detail?.pendingNotes?.map((n) => n.content), ["Invoices go to billing@acme.test on the 3rd of each month."]);
    // The log says that it learned something, never what.
    const learned = await db.agentEvent.findFirstOrThrow({ where: { userId: owner, agentId: mira.id, kind: "note_learned" } });
    assert.doesNotMatch(JSON.stringify(learned), /billing@acme/);

    // Kept by the person: now every reader has it.
    const kept = await agents.keepAgentNote(user, mira, row.id);
    assert.equal(kept.status, 200);
    assert.equal((await db.agentNote.findFirstOrThrow({ where: { id: row.id } })).status, "kept");
    assert.match(String((await loadAgentRunPersona({ userId: owner, agentId: mira.id }))?.notes?.body), /billing@acme\.test/);
    assert.equal((await agents.listAgentNotes(user, mira)).length, 1);
    detail = await agents.loadAgentDetail(owner, mira.id);
    assert.equal(detail?.notes.length, 1);
    assert.deepEqual(detail?.pendingNotes, []);
    // Keeping again is a replay, not an error or a second event.
    assert.equal((await agents.keepAgentNote(user, mira, row.id)).body.replay, true);

    // "Everything you share with chats": kept at once. A sensitive topic still waits.
    const full = await save(otto.id, "Ships orders from the Lyon warehouse on weekdays.");
    assert.equal(full.ok && full.pending, false);
    const sensitive = await save(otto.id, "Has a therapy appointment for depression every Tuesday.");
    assert.equal(sensitive.ok && sensitive.pending, true);

    // Never a secret: refused with nothing stored, or masked when it is a key in a sentence.
    const before = await db.agentNote.count({ where: { userId: owner } });
    const secret = await save(otto.id, "The portal password: hunter2");
    assert.equal(secret.ok, false);
    assert.match(secret.ok ? "" : secret.message, /never keep secrets/);
    assert.equal(await db.agentNote.count({ where: { userId: owner } }), before);
    const masked = await save(otto.id, "The deploy bot uses the key sk-ant-abcdefghijklmnopqrstuvwxyz0123 from the vault.");
    assert.equal(masked.ok, true);
    const maskedRow = await db.agentNote.findFirstOrThrow({ where: { id: masked.ok ? masked.noteId : "" } });
    const { decryptField } = await import("../src/lib/field-crypto");
    assert.doesNotMatch(decryptField(maskedRow.content), /sk-ant-/);
    // The person's own note is screened too.
    const typed = await agents.createAgentNote(user, mira, "My PIN for the door is 4821");
    assert.equal(typed.status, 422);

    // The same fact twice is one note (from a later run: this one has used its three).
    const later = await db.workRun.create({ data: { userId: owner, sessionId: session.id, attempt: 3 } });
    assert.equal((await save(otto.id, "Anything else from this run.")).ok, false, "three notes per run, counted per run");
    const again = await save(otto.id, "Ships orders from the Lyon warehouse on weekdays.", later.id);
    assert.equal(again.ok && again.noteId, "");
    assert.equal(await db.agentNote.count({ where: { userId: owner, agentId: otto.id, deletedAt: null } }), 3);

    // Bounded per run, counted from the log so a resumed run keeps the same budget.
    const run2 = await db.workRun.create({ data: { userId: owner, sessionId: session.id, attempt: 4 } });
    for (let i = 0; i < MAX_RUN_NOTES_PER_RUN; i++) {
      assert.equal((await save(mira.id, `Fact number ${i + 1} about the supplier list.`, run2.id)).ok, true);
    }
    const over = await save(mira.id, "One fact too many about the supplier list.", run2.id);
    assert.equal(over.ok, false);

    // The runner's deps: named for the agent, and absent for an agent that is gone.
    const deps = await runAgentNoteDeps({ userId: owner, agentId: mira.id, runId: run.id, sessionId: session.id });
    assert.equal(deps?.agentName, "Mira");
    assert.equal(await runAgentNoteDeps({ userId: owner, agentId: "gone", runId: run.id, sessionId: session.id }), null);
  } finally {
    await db.workSession.deleteMany({ where: { userId: owner } }).catch(() => {});
    await db.user.deleteMany({ where: { id: owner } }).catch(() => {});
  }
});

test("a goal is met only when its final step's run checked its criteria and the check passed", { skip: !url }, async () => {
  const db = await setup();
  const store = await import("../src/lib/work/store");
  const runner = await import("../src/lib/agents/goal-runner");
  const criteria = await import("../src/lib/agents/goal-criteria");
  type Notified = Parameters<NonNullable<import("../src/lib/agents/goal-runner").GoalRunnerDeps["notifyOutcome"]>>[0];
  const owner = `o2-goals-${randomUUID()}`;
  const notified: Notified[] = [];
  const deps: import("../src/lib/agents/goal-runner").GoalRunnerDeps = {
    async startStep({ user, agent, title, prompt, idempotencyKey }) {
      const existing = await db.workRun.findFirst({ where: { userId: user.id, idempotencyKey } });
      if (existing) return { ok: true, sessionId: existing.sessionId };
      const session = await store.createWorkSession({ userId: user.id, title, goal: prompt, agentId: agent.id, requestedTarget: "cloud" });
      await store.createRun({ sessionId: session.id, userId: user.id, requestedTarget: "cloud", idempotencyKey, spendReservation: false });
      await db.workSession.updateMany({ where: { id: session.id, userId: user.id }, data: { status: "queued" } });
      return { ok: true, sessionId: session.id };
    },
    async retryStep() {
      return { ok: false, message: "not used here" };
    },
    async notifyOutcome(input) {
      notified.push(input);
    },
  };
  const user = { id: owner };
  const now = new Date("2026-10-28T09:00:00Z");
  const sessionOf = async (goalId: string, stepKey: string) => db.workSession.findFirstOrThrow({ where: { userId: owner, goalId, goalStepKey: stepKey } });
  const latestRun = (sessionId: string) => db.workRun.findFirstOrThrow({ where: { sessionId }, orderBy: { attempt: "desc" } });
  /** Runs a step the way the cloud executor does: validation (with the criteria check), then the finish. */
  async function runStep(goalId: string, stepKey: string, answer: string, check: criteria.GoalCriteriaChecker, executorId: string) {
    const session = await sessionOf(goalId, stepKey);
    const run = await latestRun(session.id);
    await store.claimRun({ runId: run.id, userId: owner, executorId, now });
    const validate = criteria.goalCriteriaCheckFor(async () => ({ satisfied: true }), {
      userId: owner,
      runId: run.id,
      session: { id: session.id, goalId: session.goalId, goalStepKey: session.goalStepKey, agentId: session.agentId },
      check,
    });
    await validate({ answer, artifacts: [{ title: `${stepKey}.docx` }] });
    await store.appendEvents({ runId: run.id, userId: owner, events: [{ kind: "run_finished", payload: { reason: "completed", report: { answer } } }] });
    await store.finishRun({ runId: run.id, userId: owner, reason: "completed", executorId, now });
  }
  async function twoStepGoal(title: string) {
    const agent = await db.agent.findFirstOrThrow({ where: { userId: owner } });
    return db.agentGoal.create({
      data: {
        userId: owner,
        agentId: agent.id,
        title,
        detail: "Write the October post and put it on the blog.",
        milestones: [{ id: "draft", title: "Draft the post" }, { id: "publish", title: "Publish it" }],
        successCriteria: ["The post is live on the blog", "It links the release notes"],
        maxRuns: 4,
      },
    });
  }
  try {
    await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
    await db.agent.create({ data: { userId: owner, name: "Quill", role: "Writer" } });
    const never: criteria.GoalCriteriaChecker = async () => {
      throw new Error("a step that is not the last never checks the goal");
    };

    // 1. A pass: met, and said as met.
    const met = await twoStepGoal("October post");
    await runner.advanceGoal({ user, goalId: met.id, now, deps });
    await runStep(met.id, "draft", "Drafted the October post (1,200 words).", never, "executor-A");
    await runner.advanceGoal({ user, goalId: met.id, now, deps });
    const seen: string[] = [];
    await runStep(
      met.id,
      "publish",
      "Published at blog.example.test/october with a link to the release notes.",
      async (input) => {
        seen.push(input.deliverables, input.criteria.join(" | "), input.goal);
        return { met: true, why: "The post is live and links the release notes." };
      },
      "executor-B"
    );
    assert.match(seen[0]!, /Drafted the October post/, "the check reads every step's result");
    assert.match(seen[0]!, /Published at blog\.example\.test/);
    assert.match(seen[0]!, /publish\.docx/);
    assert.equal(seen[1], "The post is live on the blog | It links the release notes");
    const done = await runner.advanceGoal({ user, goalId: met.id, now, deps });
    assert.deepEqual(done.kind === "advanced" && done.steps, ["complete_step", "achieved"]);
    const metGoal = await db.agentGoal.findFirstOrThrow({ where: { id: met.id } });
    assert.equal(metGoal.status, "achieved");
    assert.equal(metGoal.progress, 100);
    assert.match(String(metGoal.nextAction), /criteria were checked/);
    assert.equal(await db.agentEvent.count({ where: { userId: owner, kind: "goal_achieved" } }), 1);
    assert.equal(await db.agentEvent.count({ where: { userId: owner, kind: "goal_checked" } }), 1);
    assert.equal(notified.at(-1)?.status, "achieved");

    // 2. NOT MET: every step ran, the goal says so and names the gap.
    const gap = await twoStepGoal("November post");
    await runner.advanceGoal({ user, goalId: gap.id, now, deps });
    await runStep(gap.id, "draft", "Drafted the November post.", never, "executor-C");
    await runner.advanceGoal({ user, goalId: gap.id, now, deps });
    await runStep(gap.id, "publish", "Saved the post as a draft.", async () => ({ met: false, why: "Nothing shows the post is live." }), "executor-D");
    await runner.advanceGoal({ user, goalId: gap.id, now, deps });
    const gapGoal = await db.agentGoal.findFirstOrThrow({ where: { id: gap.id } });
    assert.equal(gapGoal.status, "unverified");
    assert.match(String(gapGoal.nextAction), /^Every step ran\. Check the result\./);
    assert.match(String(gapGoal.nextAction), /Nothing shows the post is live/);
    assert.equal(notified.at(-1)?.status, "unverified");

    // 3. No check at all (the step ran where none could be made, or it timed out): unverified, never met.
    const silent = await twoStepGoal("December post");
    await runner.advanceGoal({ user, goalId: silent.id, now, deps });
    await runStep(silent.id, "draft", "Drafted.", never, "executor-E");
    await runner.advanceGoal({ user, goalId: silent.id, now, deps });
    await runStep(silent.id, "publish", "Published.", async () => null, "executor-F");
    await runner.advanceGoal({ user, goalId: silent.id, now, deps });
    const silentGoal = await db.agentGoal.findFirstOrThrow({ where: { id: silent.id } });
    assert.equal(silentGoal.status, "unverified");
    assert.match(String(silentGoal.nextAction), /could not be checked/);
    const check = await db.agentEvent.findFirstOrThrow({ where: { userId: owner, kind: "goal_checked", detail: { path: ["goalId"], equals: silent.id } } });
    assert.equal((check.detail as { verdict: string }).verdict, "unchecked");

    // A checker that throws is recorded as unchecked, and the step's own result is untouched.
    const thrown = await twoStepGoal("January post");
    await runner.advanceGoal({ user, goalId: thrown.id, now, deps });
    await runStep(thrown.id, "draft", "Drafted.", never, "executor-G");
    await runner.advanceGoal({ user, goalId: thrown.id, now, deps });
    await runStep(thrown.id, "publish", "Published.", async () => { throw new Error("provider down"); }, "executor-H");
    await runner.advanceGoal({ user, goalId: thrown.id, now, deps });
    assert.equal((await db.agentGoal.findFirstOrThrow({ where: { id: thrown.id } })).status, "unverified");

    // An unverified goal is never driven again on its own.
    const sweptBefore = await db.workSession.count({ where: { userId: owner } });
    await runner.sweepGoals(new Date(now.getTime() + 60 * 60_000), deps);
    assert.equal(await db.workSession.count({ where: { userId: owner } }), sweptBefore);
  } finally {
    await db.workSession.deleteMany({ where: { userId: owner } }).catch(() => {});
    await db.user.deleteMany({ where: { id: owner } }).catch(() => {});
  }
});
