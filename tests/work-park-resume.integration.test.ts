/**
 * "Needs you" after a run parks, against a real Postgres: the answer and
 * decision routes record AND requeue, a stale or second answer is refused,
 * a recorded decision is reused only for the same digest and before its
 * expiry, parked runs leave the live cap for a bound of their own, and a goal
 * step that parks says so and, after the routine expiry, ends honestly.
 *
 * The second test drives the real cloud executor (scripts/work-runner.ts) as a
 * child process against a local stand-in for Anthropic's streaming API, so the
 * whole loop is exercised: ask, park, answer, requeue, resume, finish — and the
 * same for an approval. No model is called; the "model" is a script.
 *
 *   ORBIT_TEST_DATABASE_URL=postgresql://…/juno_park_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/work-park-resume.integration.test.ts
 *
 * The executor test also needs runner/agent-core/dist (npm run test:prepare).
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.ORBIT_TEST_DATABASE_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "anthropic:claude-sonnet-5-5";

if (!url) {
  test("park-and-resume suite is skipped without ORBIT_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(url, /\/juno_[a-z_]*test$/, "only a throwaway *_test database");
  process.env.DATABASE_URL = url;
  process.env.DIRECT_URL = url;
  process.env.AUTH_SECRET ??= "work-park-resume-integration-test-key";
  process.env.DATA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  // Intake is open in this process (the routes ask before requeueing); the
  // executor test below also has a real runner writing its heartbeat.
  process.env.WORK_CLOUD_AVAILABLE = "1";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-local-only";

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const post = (body: unknown): Request =>
    new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("answers and decisions after a park requeue once; stale ones are refused; caps and goals follow", async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/work/store");
    const park = await import("../src/lib/work/park-resume");
    const { actionDigest, policyDigest } = await import("../src/lib/work/digests");
    const answerRoute = await import("../src/app/api/work/sessions/[id]/answer/route");
    const decisionRoute = await import("../src/app/api/work/approvals/[id]/decision/route");
    const dispatch = await import("../src/lib/work/dispatch");
    const protocol = await import("../src/app/api/work/protocol");
    const goalRunner = await import("../src/lib/agents/goal-runner");
    const { GOAL_WAITING_FOR_ANSWER } = await import("../src/lib/agents/goals");

    const owner = `park-${randomUUID()}`;
    const POLICY = { policy: "balanced" };
    const answer = async (sessionId: string, body: Record<string, unknown>) => {
      const response = await answerRoute.POST(post(body), { params: Promise.resolve({ id: sessionId }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const decide = async (approvalId: string, body: Record<string, unknown>) => {
      const response = await decisionRoute.POST(post(body), { params: Promise.resolve({ id: approvalId }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const runOf = (id: string) => db.workRun.findUniqueOrThrow({ where: { id } });
    const sessionOf = (id: string) => db.workSession.findUniqueOrThrow({ where: { id } });
    const events = (runId: string, kind: string) => db.workEvent.findMany({ where: { runId, kind }, orderBy: { seq: "asc" } });

    /** A cloud run the executor claimed, started, and parked on a question after its attended wait. */
    async function parkedOnQuestion(label: string, agentSession?: { goalId: string; stepKey: string; agentId: string }) {
      const session = await store.createWorkSession({ userId: owner, title: label, goal: label, requestedTarget: "cloud", agentId: agentSession?.agentId ?? null });
      if (agentSession) await db.workSession.update({ where: { id: session.id }, data: { goalId: agentSession.goalId, goalStepKey: agentSession.stepKey } });
      const created = await store.createRun({
        sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
        permissionPolicy: POLICY, budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
        idempotencyKey: `${label}:${randomUUID()}`,
      });
      const runId = created.run.id;
      const questionId = `toolu_${randomBytes(6).toString("hex")}`;
      assert.equal((await store.claimRun({ runId, userId: owner, executorId: "test-executor" })).claimed, true);
      await store.appendEvents({ runId, userId: owner, events: [
        { kind: "run_started", payload: { executor: "cloud" } },
        { kind: "question_asked", payload: { kind: "question_asked", question: { id: questionId, question: "Which Invoices folder?", why: "Two are called Invoices." } } },
      ] });
      await db.workRun.update({ where: { id: runId }, data: { status: "waiting_input" } });
      assert.equal(await store.parkRun({ runId, userId: owner, executorId: "test-executor" }), true);
      return { sessionId: session.id, runId, questionId };
    }

    /** A cloud run parked on an approval, with the row exactly as the executor writes it. */
    async function parkedOnApproval(label: string, input: Record<string, unknown>, expiresAt = new Date(Date.now() + 15 * 60_000)) {
      const session = await store.createWorkSession({ userId: owner, title: label, goal: label, requestedTarget: "cloud" });
      const created = await store.createRun({
        sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
        permissionPolicy: POLICY, budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
        idempotencyKey: `${label}:${randomUUID()}`,
      });
      const runId = created.run.id;
      assert.equal((await store.claimRun({ runId, userId: owner, executorId: "test-executor" })).claimed, true);
      const action = "work.cloud_file.write";
      const detail = { action, tool: "cloud_files", input };
      const approval = await db.workApproval.create({ data: {
        runId, userId: owner, action, risk: "edit", summary: "Write the cloud file notes.txt", detail,
        actionDigest: actionDigest(action, detail), policyDigest: policyDigest(POLICY), expiresAt,
      } });
      await store.appendEvents({ runId, userId: owner, events: [
        { kind: "run_started", payload: { executor: "cloud" } },
        { kind: "approval_requested", payload: { kind: "approval_requested", approvalId: approval.id, request: { id: `${runId}:call_1`, approvalId: approval.id, action, actionDigest: approval.actionDigest } } },
      ] });
      await db.workRun.update({ where: { id: runId }, data: { status: "waiting_approval" } });
      assert.equal(await store.parkRun({ runId, userId: owner, executorId: "test-executor" }), true);
      return { sessionId: session.id, runId, approval, call: { id: "call_1", name: "cloud_files", input } };
    }

    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
      signedIn = { id: owner, email: `${owner}@example.invalid`, name: "Park" };

      // --- 1. An answer after the park records it and requeues the run, once. ---
      const q = await parkedOnQuestion("Answer after park");
      assert.equal((await sessionOf(q.sessionId)).needsAttention, true, "parked: in Needs you");
      const answered = await answer(q.sessionId, { questionId: q.questionId, text: "The 2024 one" });
      assert.equal(answered.status, 200, JSON.stringify(answered.body));
      assert.equal(answered.body.resumed, true);
      let row = await runOf(q.runId);
      assert.equal(row.status, "queued");
      assert.equal(row.pauseReason, null);
      assert.equal(row.claimedBy, null);
      let session = await sessionOf(q.sessionId);
      assert.equal(session.status, "queued");
      assert.equal(session.needsAttention, true, "still in Needs you, as resuming, until it is picked up");
      assert.equal((await events(q.runId, "question_answered")).length, 1);
      // Compare-and-set: nothing moves twice.
      assert.equal((await store.requeueParkedRun({ runId: q.runId, userId: owner })).requeued, false);
      // The same answer again is a replay and writes nothing; a different one is refused.
      const again = await answer(q.sessionId, { questionId: q.questionId, text: "The 2024 one" });
      assert.equal(again.status, 200);
      assert.equal(again.body.replay, true);
      assert.equal((await events(q.runId, "question_answered")).length, 1, "no second answer row");
      const other = await answer(q.sessionId, { questionId: q.questionId, text: "The 2023 one" });
      assert.equal(other.status, 409);
      assert.equal(other.body.error, "question_already_answered");
      // Picked up: out of Needs you; and the restored run is handed the answer.
      assert.equal((await store.claimRun({ runId: q.runId, userId: owner, executorId: "test-executor-2" })).claimed, true);
      session = await sessionOf(q.sessionId);
      assert.equal(session.needsAttention, false);
      const loaded = await park.loadParkedDecisions({
        runId: q.runId, userId: owner, askToolName: "ask_user", policy: POLICY, now: new Date(),
        calls: [{ id: q.questionId, name: "ask_user", input: { question: "Which Invoices folder?", why: "Two." } }],
      });
      assert.deepEqual(loaded.resolutions.get(q.questionId), { content: "The 2024 one", isError: false, answer: true });

      // --- 2. A question from an execution that has ended is closed. ---
      const stale = await parkedOnQuestion("Stale question");
      // The person pressed Resume without answering; the next execution asked again and parked.
      await db.workRun.update({ where: { id: stale.runId }, data: { status: "queued", pauseReason: null } });
      assert.equal((await store.claimRun({ runId: stale.runId, userId: owner, executorId: "test-executor" })).claimed, true);
      const reasked = `toolu_${randomBytes(6).toString("hex")}`;
      await store.appendEvents({ runId: stale.runId, userId: owner, events: [
        { kind: "run_started", payload: { executor: "cloud" } },
        { kind: "question_asked", payload: { kind: "question_asked", question: { id: reasked, question: "Which Invoices folder?", why: "Two." } } },
      ] });
      await db.workRun.update({ where: { id: stale.runId }, data: { status: "waiting_input" } });
      assert.equal(await store.parkRun({ runId: stale.runId, userId: owner, executorId: "test-executor" }), true);
      const old = await answer(stale.sessionId, { questionId: stale.questionId, text: "2024" });
      assert.equal(old.status, 409);
      assert.equal(old.body.error, "question_not_open");
      assert.equal((await runOf(stale.runId)).status, "paused", "a refused answer moves nothing");
      const never = await answer(stale.sessionId, { questionId: "toolu_never_asked", text: "2024" });
      assert.equal(never.status, 409);
      assert.equal(never.body.error, "question_not_open");
      const current = await answer(stale.sessionId, { questionId: reasked, text: "2024" });
      assert.equal(current.status, 200);
      assert.equal((await runOf(stale.runId)).status, "queued");

      // --- 3. A run the person paused keeps the answer and stays paused. ---
      const held = await parkedOnQuestion("Paused by the person");
      await db.workRun.update({ where: { id: held.runId }, data: { pauseReason: "user" } });
      const kept = await answer(held.sessionId, { questionId: held.questionId, text: "2024" });
      assert.equal(kept.status, 200);
      assert.equal(kept.body.resumed, false);
      assert.match(String(kept.body.explanation), /paused/);
      assert.equal((await runOf(held.runId)).status, "paused");
      assert.equal((await events(held.runId, "question_answered")).length, 1, "the answer is kept for Resume");

      // --- 4. Approve after park: decided once, requeued once, reused once on resume. ---
      const input = { operation: "write", name: "notes.txt", content: "Paid." };
      const a = await parkedOnApproval("Approve after park", input);
      const decided = await decide(a.approval.id, { decision: "allowed", actionDigest: a.approval.actionDigest });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal(decided.body.resumed, true);
      assert.equal((await db.workApproval.findUniqueOrThrow({ where: { id: a.approval.id } })).decision, "allowed");
      assert.equal((await runOf(a.runId)).status, "queued");
      assert.equal((await sessionOf(a.sessionId)).needsAttention, true, "approving keeps it in Needs you as resuming");
      const replay = await decide(a.approval.id, { decision: "allowed", actionDigest: a.approval.actionDigest });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replay, true);
      assert.equal((await events(a.runId, "approval_resolved")).length, 1, "a replayed decision writes nothing twice");
      const plannedA = await park.loadParkedDecisions({ runId: a.runId, userId: owner, askToolName: "ask_user", policy: POLICY, now: new Date(), calls: [a.call] });
      assert.equal(plannedA.resolutions.get("call_1")?.content, park.APPROVED_WHILE_PARKED);
      const request = { action: "work.cloud_file.write", tool: "cloud_files", digestInput: JSON.stringify({ action: "work.cloud_file.write", tool: "cloud_files", input }) };
      assert.deepEqual(plannedA.decisions.takeApproval(request, POLICY, new Date()), { approvalId: a.approval.id, use: true, decision: "allowed" });
      assert.equal(plannedA.decisions.takeApproval(request, POLICY, new Date()), null, "once");

      // --- 5. A different action asks again: the digest is the stored one. ---
      const d = await parkedOnApproval("Digest mismatch", { operation: "write", name: "notes.txt", content: "Paid." });
      const wrongDigest = await decide(d.approval.id, { decision: "allowed", actionDigest: "0".repeat(64) });
      assert.equal(wrongDigest.status, 409);
      assert.equal(wrongDigest.body.error, "digest_mismatch");
      assert.equal((await runOf(d.runId)).status, "paused", "a refused decision requeues nothing");
      assert.equal((await decide(d.approval.id, { decision: "allowed", actionDigest: d.approval.actionDigest })).status, 200);
      const changed = await park.loadParkedDecisions({
        runId: d.runId, userId: owner, askToolName: "ask_user", policy: POLICY, now: new Date(),
        calls: [{ id: "call_1", name: "cloud_files", input: { operation: "write", name: "notes.txt", content: "Paid twice." } }],
      });
      assert.equal(changed.resolutions.size, 0, "the parked call is not the approved one");
      const plannedD = await park.loadParkedDecisions({ runId: d.runId, userId: owner, askToolName: "ask_user", policy: POLICY, now: new Date(), calls: [d.call] });
      const renamed = { ...request, action: "work.cloud_file.delete" };
      assert.deepEqual(plannedD.decisions.takeApproval(renamed, POLICY, new Date()), { approvalId: d.approval.id, use: false, reason: "digest_mismatch" });

      // --- 6. An expired approval asks again; its stored expiry is never extended. ---
      const e = await parkedOnApproval("Expired approval", input, new Date(Date.now() - 1_000));
      const late = await decide(e.approval.id, { decision: "allowed", actionDigest: e.approval.actionDigest });
      assert.equal(late.status, 409);
      assert.equal(late.body.error, "expired");
      assert.equal((await runOf(e.runId)).status, "paused");
      // Decided in time, used after its expiry: asks again.
      const f = await parkedOnApproval("Decided then expired", input, new Date(Date.now() + 60_000));
      assert.equal((await decide(f.approval.id, { decision: "allowed", actionDigest: f.approval.actionDigest })).status, 200);
      const afterExpiry = new Date(Date.now() + 120_000);
      const plannedF = await park.loadParkedDecisions({ runId: f.runId, userId: owner, askToolName: "ask_user", policy: POLICY, now: afterExpiry, calls: [f.call] });
      assert.equal(plannedF.resolutions.size, 0);
      assert.equal(plannedF.decisions.takeApproval(request, POLICY, afterExpiry), null);
      assert.equal(
        (await db.workApproval.findUniqueOrThrow({ where: { id: f.approval.id } })).expiresAt.getTime(),
        f.approval.expiresAt.getTime(),
        "the expiry is the one stored when the person was asked"
      );

      // --- 7. Parked runs leave the live cap and have a bound of their own. ---
      // Three parked at least (the person's pause, the expired approval, and one more):
      // under the old rule, exactly enough to refuse every new task.
      await parkedOnQuestion("One more parked");
      const parkedCount = await db.workRun.count({ where: { userId: owner, status: "paused" } });
      assert.ok(parkedCount >= 3, `${parkedCount} parked runs`);
      // Everything still queued above is not executing: put it away so the live count is ours to set.
      await db.workRun.updateMany({ where: { userId: owner, status: { in: ["queued", "preparing"] } }, data: { status: "cancelled", terminalReason: "cancelled" } });
      const fresh = await store.createWorkSession({ userId: owner, title: "Fresh task", goal: "Summarise the invoices", requestedTarget: "cloud", requestedModel: MODEL });
      const body = protocol.startRunSchema.parse({ origin: "manual", requestedTarget: "cloud", model: MODEL });
      const user = { id: owner, email: `${owner}@example.invalid` };
      const allowed = await dispatch.startWorkRunForUser(user, fresh, body, { preflightOnly: true });
      assert.notEqual(allowed.body.error, "run_cap_exceeded", `parked runs do not hold the live cap: ${JSON.stringify(allowed.body)}`);
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      const running: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const s = await store.createWorkSession({ userId: owner, title: `Busy ${i}`, goal: "Busy", requestedTarget: "cloud" });
        const r = await store.createRun({ sessionId: s.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL, spendReservation: false, idempotencyKey: `busy:${randomUUID()}` });
        await db.workRun.update({ where: { id: r.run.id }, data: { status: "running" } });
        running.push(r.run.id);
      }
      const capped = await dispatch.startWorkRunForUser(user, fresh, body, { preflightOnly: true });
      assert.equal(capped.status, 429);
      assert.equal(capped.body.error, "run_cap_exceeded");
      await db.workRun.updateMany({ where: { id: { in: running } }, data: { status: "completed", terminalReason: "completed" } });
      process.env.WORK_MAX_PARKED_RUNS_PER_ACCOUNT = String(parkedCount);
      try {
        const bounded = await dispatch.startWorkRunForUser(user, fresh, body, { preflightOnly: true });
        assert.equal(bounded.status, 429);
        assert.equal(bounded.body.error, "parked_cap_exceeded");
        assert.match(String(bounded.body.message), new RegExp(`${parkedCount} tasks waiting for you`));
      } finally {
        delete process.env.WORK_MAX_PARKED_RUNS_PER_ACCOUNT;
      }

      // --- 8. A goal step that parks says so; past the expiry it ends and the goal asks. ---
      await db.workRun.updateMany({ where: { userId: owner, status: "paused" }, data: { status: "cancelled", terminalReason: "cancelled" } });
      const agent = await db.agent.create({ data: { userId: owner, name: "Ledger", role: "Bookkeeper" } });
      const goal = await db.agentGoal.create({ data: {
        userId: owner, agentId: agent.id, title: "Close October", milestones: [{ id: "pay", title: "Pay the invoices" }],
        maxRuns: 4, maxAttemptsPerStep: 2, runsUsed: 1,
      } });
      const step = await parkedOnQuestion("Goal step", { goalId: goal.id, stepKey: "pay", agentId: agent.id });
      const retried: string[] = [];
      const deps: import("../src/lib/agents/goal-runner").GoalRunnerDeps = {
        startStep: async () => { throw new Error("no new step should start while one is parked"); },
        retryStep: async ({ sessionId }) => { retried.push(sessionId); return { ok: true }; },
      };
      let advanced = await goalRunner.advanceGoal({ user: { id: owner }, goalId: goal.id, now: new Date(), deps });
      assert.equal(advanced.kind, "advanced");
      assert.equal(advanced.kind === "advanced" && advanced.goal.nextAction, GOAL_WAITING_FOR_ANSWER);
      await db.$executeRaw`UPDATE "WorkRun" SET "updatedAt" = ${new Date(Date.now() - 30 * 3_600_000)} WHERE "id" = ${step.runId}`;
      const expired = await store.expireParkedRoutineRuns({ now: new Date() });
      assert.ok(expired.includes(step.runId), "the parked goal step is ended");
      row = await runOf(step.runId);
      assert.equal(row.status, "interrupted");
      assert.equal(row.terminalDetail, store.PARKED_GOAL_STEP_EXPIRED_DETAIL);
      advanced = await goalRunner.advanceGoal({ user: { id: owner }, goalId: goal.id, now: new Date(), deps });
      assert.equal(advanced.kind, "advanced");
      if (advanced.kind === "advanced") {
        const blockers = advanced.goal.blockers as Array<{ kind: string; text: string }>;
        assert.equal(blockers[0]?.kind, "needs_decision");
        assert.match(blockers[0]?.text ?? "", /waited 24 hours for your answer/);
      }
      assert.deepEqual(retried, [], "a step that waited out its answer is not retried on its own");
      // The ending is notified (handed off); give the hand-off a moment before the pool closes.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } finally {
      signedIn = null;
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
      await db.$disconnect();
    }
  });

  // -------------------------------------------------------------------------
  // The real executor, end to end
  // -------------------------------------------------------------------------

  const distReady = existsSync(path.join(ROOT, "runner/agent-core/dist/work/index.js"));

  test("the cloud executor parks, is requeued by the answer and the approval, and resumes once with them", { skip: distReady ? false : "runner/agent-core/dist is not built (npm run test:prepare)", timeout: 240_000 }, async () => {
    const { prismaUnguarded: db } = await import("../src/lib/prisma");
    const store = await import("../src/lib/work/store");
    const answerRoute = await import("../src/app/api/work/sessions/[id]/answer/route");
    const decisionRoute = await import("../src/app/api/work/approvals/[id]/decision/route");
    const { APPROVED_WHILE_PARKED } = await import("../src/lib/work/park-resume");

    type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string; id?: string; name?: string; input?: unknown };
    const requests: Array<{ scenario: string; results: Array<{ id: string; text: string }> }> = [];
    const flat = (value: unknown): string =>
      typeof value === "string" ? value : Array.isArray(value) ? value.map((part) => flat((part as Block).text ?? (part as Block).content ?? "")).join("") : "";

    /** Anthropic's streaming wire format, scripted by what the run has seen so far. */
    function reply(body: Record<string, unknown>): { text: string } | { tool: { name: string; input: Record<string, unknown> } } {
      const system = flat(body.system);
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      const results: Array<{ id: string; text: string }> = [];
      for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content as Block[]) {
          if (block.type === "tool_result") results.push({ id: String(block.tool_use_id), text: flat(block.content) });
        }
      }
      const scenario = system.includes("[scenario:question]") ? "question" : system.includes("[scenario:approval]") ? "approval" : "other";
      requests.push({ scenario, results });
      if (scenario === "question") {
        if (results.length === 0) return { tool: { name: "ask_user", input: { question: "Which Invoices folder should I pay from?", why: "Two folders are called Invoices." } } };
        return { text: `Paying from ${results[results.length - 1]!.text}.` };
      }
      if (scenario === "approval") {
        const writeInput = { operation: "write", name: "park-e2e.txt", content: "Paid." };
        const last = results[results.length - 1];
        if (!last || last.text === APPROVED_WHILE_PARKED) return { tool: { name: "cloud_files", input: writeInput } };
        return { text: "Saved the note." };
      }
      return { text: "The deliverable answers the goal." };
    }

    function sse(res: ServerResponse, out: ReturnType<typeof reply>) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } } });
      if ("tool" in out) {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: out.tool.name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(out.tool.input) } });
      } else {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: out.text } });
      }
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "tool" in out ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    }

    async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
    }

    const lab: Server = createServer((req, res) => {
      void readBody(req).then((body) => sse(res, reply(body)), () => { res.writeHead(400); res.end(); });
    });
    await new Promise<void>((resolve) => lab.listen(0, "127.0.0.1", resolve));
    const port = (lab.address() as AddressInfo).port;

    const logDir = process.env.PARK_E2E_LOG_DIR ?? path.join(tmpdir(), "park-e2e-logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, `runner-${Date.now()}.log`);
    const out = openSync(logFile, "a");
    let runner: ChildProcess | null = null;

    const owner = `park-e2e-${randomUUID()}`;
    const waitUntil = async <T,>(what: string, probe: () => Promise<T | null>, ms = 90_000): Promise<T> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        const value = await probe();
        if (value !== null) return value;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`timed out waiting for ${what} (runner log: ${logFile})`);
    };
    const statusIs = (runId: string, statuses: string[]) => async () => {
      const row = await db.workRun.findUnique({ where: { id: runId } });
      return row && statuses.includes(row.status) ? row : null;
    };
    const startRun = async (scenario: string, policy: Record<string, unknown>) => {
      const session = await store.createWorkSession({ userId: owner, title: scenario, goal: `[scenario:${scenario}] Pay the right invoices.`, requestedTarget: "cloud" });
      const created = await store.createRun({
        sessionId: session.id, userId: owner, requestedTarget: "cloud", effectiveTarget: "cloud", effectiveModel: MODEL,
        permissionPolicy: policy as never, budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }, spendReservation: false,
        idempotencyKey: `e2e:${scenario}:${randomUUID()}`,
      });
      await db.workSession.update({ where: { id: session.id }, data: { status: "queued" } });
      return { sessionId: session.id, runId: created.run.id };
    };

    try {
      await db.user.create({ data: { id: owner, email: `${owner}@example.invalid` } });
      await db.subscription.create({ data: { userId: owner, plan: "MAX", status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
      signedIn = { id: owner, email: `${owner}@example.invalid`, name: "Park e2e" };

      const question = await startRun("question", { policy: "balanced" });
      // `attended: false` keeps the plan review out of the way, so the approval
      // is the only thing the run stops for; conservative asks before a write.
      const approval = await startRun("approval", { policy: "conservative", attended: false });

      runner = spawn(process.execPath, ["--import", "tsx", "scripts/work-runner.ts"], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/tmp",
          NODE_OPTIONS: "--conditions=react-server",
          DATABASE_URL: url,
          DIRECT_URL: url,
          AUTH_SECRET: process.env.AUTH_SECRET,
          DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
          ANTHROPIC_API_KEY: "sk-ant-test-local-only",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          WORK_ATTENDED_WAIT_MS: "1500",
          HOSTNAME: "park-e2e",
        },
        stdio: ["ignore", out, out],
      });

      // Ask, wait 1.5 s, park — with no error row.
      for (const run of [question, approval]) {
        const parked = await waitUntil(`${run.runId} to park`, statusIs(run.runId, ["paused"]));
        assert.equal(parked.pauseReason, "waiting");
        assert.equal(parked.claimedBy, null, "a parked run holds no executor");
        assert.deepEqual((await db.workEvent.findMany({ where: { runId: run.runId, kind: "error" } })).map((e) => e.payload), [], "an ordinary park writes no error row");
      }

      // The question: answered on the web after the park.
      const asked = await db.workEvent.findFirstOrThrow({ where: { runId: question.runId, kind: "question_asked" } });
      const questionId = String(((asked.payload as { question?: { id?: string } }).question ?? {}).id);
      const answered = await answerRoute.POST(post({ questionId, text: "Invoices 2024" }), { params: Promise.resolve({ id: question.sessionId }) });
      assert.equal(answered.status, 200);
      assert.equal(((await answered.json()) as { resumed?: boolean }).resumed, true);

      // The approval: the card the web draws now carries the row's id and digest,
      // and deciding it from that card is what the decision route accepts.
      const card = await db.workEvent.findFirstOrThrow({ where: { runId: approval.runId, kind: "approval_requested" } });
      const lifted = card.payload as { approvalId?: string; request?: { approvalId?: string; actionDigest?: string } };
      assert.ok(lifted.approvalId && lifted.request?.approvalId === lifted.approvalId, "the request event names its row");
      const stored = await db.workApproval.findUniqueOrThrow({ where: { id: lifted.approvalId } });
      assert.equal(lifted.request?.actionDigest, stored.actionDigest, "and the digest the route checks");
      const decided = await decisionRoute.POST(post({ decision: "allowed", actionDigest: lifted.request?.actionDigest }), { params: Promise.resolve({ id: stored.id }) });
      assert.equal(decided.status, 200);
      assert.equal(((await decided.json()) as { resumed?: boolean }).resumed, true);

      for (const run of [question, approval]) {
        const ended = await waitUntil(`${run.runId} to finish`, statusIs(run.runId, ["completed", "failed", "interrupted", "cancelled", "budget_exceeded", "timed_out"]), 120_000);
        const starts = (await db.workEvent.findMany({ where: { runId: run.runId, kind: "run_started" } })).filter((e) => (e.payload as { executor?: string }).executor === "cloud");
        assert.equal(starts.length, 2, `${run.runId} resumed exactly once (ended ${ended.status}: ${ended.terminalDetail})`);
        assert.deepEqual((await db.workEvent.findMany({ where: { runId: run.runId, kind: "error" } })).map((e) => e.payload), []);
      }

      // The question was asked once and its answer reached the model as the call's result.
      assert.equal(await db.workEvent.count({ where: { runId: question.runId, kind: "question_asked" } }), 1, "the person was asked once");
      const sawAnswer = requests.filter((r) => r.scenario === "question").some((r) => r.results.some((result) => result.text === "Invoices 2024"));
      assert.ok(sawAnswer, "the model read the answer as the question's result");
      assert.ok(!requests.filter((r) => r.scenario === "question").some((r) => r.results.some((result) => result.text === "Stopped before this finished.")), "never the stopped placeholder");

      // The approval was asked once and the write ran once, on the recorded decision.
      assert.equal(await db.workApproval.count({ where: { runId: approval.runId } }), 1, "the person approved once");
      const writes = await db.workEvent.findMany({ where: { runId: approval.runId, kind: "tool_finished" } });
      assert.equal(writes.filter((e) => (e.payload as { tool?: string }).tool === "cloud_files").length, 1, "the write ran once");
      const resolved = await db.workEvent.findMany({ where: { runId: approval.runId, kind: "approval_resolved" } });
      assert.ok(resolved.every((e) => (e.payload as { approvalId?: string }).approvalId === stored.id), "every resolution names the row the card was drawn from");
      const audit = await db.workAuditEvent.findMany({ where: { runId: approval.runId, kind: "approval_decided" } });
      assert.ok(audit.some((row) => (row.detail as { outcome?: string }).outcome === "applied_after_park"), "the reuse is audited");
    } finally {
      runner?.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (runner && runner.exitCode === null) runner.kill("SIGKILL");
      await new Promise<void>((resolve) => lab.close(() => resolve()));
      signedIn = null;
      await db.user.delete({ where: { id: owner } }).catch(() => undefined);
      rmSync(path.join(ROOT, ".uploads", "work", owner), { recursive: true, force: true });
      await db.$disconnect();
      console.log(`[park-e2e] runner log: ${logFile}`);
    }
  });
}
