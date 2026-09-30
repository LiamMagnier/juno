/**
 * Crew foundations against a real database: transfer, several tasks per
 * conversation, a member's own budget, setup changes with Undo, Move to crew,
 * single-use computer links and research ownership.
 *
 * Opt-in, like every suite that writes: it never connects to a database it was
 * not pointed at. Against a throwaway Postgres with the migrations applied:
 *
 *   JUNO_CREW_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:65526/juno_crew_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/crew-foundations.integration.test.ts
 *
 * The route cases (the conversation's task list, a setup change's digest-bound
 * Apply) stand in the session with `mock.module` and skip without
 * --experimental-test-module-mocks; the store cases run either way.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import * as serverNavigation from "next/dist/client/components/navigation.react-server";

const URL = process.env.JUNO_CREW_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!URL) {
  test("crew foundations database suite is skipped without JUNO_CREW_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(URL, /^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\/juno_crew_test$/, "only a local throwaway database");
  process.env.DATABASE_URL = URL;
  process.env.DIRECT_URL = URL;
  process.env.AUTH_SECRET ??= "juno-crew-isolated-integration-test-key-0123456789";
  process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");

  const db = new PrismaClient({ datasources: { db: { url: URL } } });
  let signedIn: { id: string; email: string } | null = null;


  const owner = `crew-test-${randomUUID()}`;
  const stranger = `crew-test-${randomUUID()}`;

  async function member(name: string, extra: Record<string, unknown> = {}) {
    const conversation = await db.conversation.create({ data: { userId: owner, title: name, kind: "chat" } });
    const agent = await db.agent.create({
      data: { userId: owner, name, conversationId: conversation.id, approvalMode: "balanced", ...extra },
    });
    await db.conversation.update({ where: { id: conversation.id }, data: { agentId: agent.id } });
    return { agent, conversationId: conversation.id };
  }

  async function task(input: { agentId: string | null; conversationId: string | null; status: string; title?: string; createdAt?: Date }) {
    const session = await db.workSession.create({
      data: {
        userId: owner,
        agentId: input.agentId,
        conversationId: input.conversationId,
        title: input.title ?? `Task ${input.status}`,
        goal: "Do the thing.",
        status: input.status,
        permissionPolicy: "permissive",
        ...(input.createdAt ? { createdAt: input.createdAt, lastActivityAt: input.createdAt } : {}),
      },
    });
    const run = await db.workRun.create({
      data: { sessionId: session.id, userId: owner, status: input.status === "draft" ? "queued" : input.status, lastSeq: 3 },
    });
    return { session, run };
  }

  test.before(async () => {
    // Registered before any route is first imported (every import below is
    // dynamic), so the routes see this session and no other.
    if (canMockModules) {
      // Next's react-server navigation, which the bundler swaps in on the server.
      mock.module("next/navigation", { namedExports: { ...serverNavigation } });
      mock.module("@/lib/session", {
        namedExports: {
          getCurrentUser: async () => signedIn,
          getCurrentDeviceSessionId: async () => null,
          getSessionBan: async () => null,
          requireUser: async () => {
            if (!signedIn) throw new Error("signed out");
            return signedIn;
          },
        },
      });
    }
    for (const id of [owner, stranger]) {
      await db.user.create({ data: { id, email: `${id}@example.invalid`, emailVerified: new Date() } });
    }
  });

  test.after(async () => {
    await db.user.deleteMany({ where: { id: { in: [owner, stranger] } } });
    await db.$disconnect();
  });

  test("a transfer at a safe point moves the owner, narrows the task and records who, when and why", async () => {
    const { transferWorkSessionOwner } = await import("@/lib/work/ownership-store");
    const mira = await member("Mira", { connectorIds: ["gmail", "linear"] });
    const otto = await member("Otto", { connectorIds: ["linear"], approvalMode: "conservative" });
    const { session, run } = await task({ agentId: mira.agent.id, conversationId: mira.conversationId, status: "paused" });
    await db.workSessionConnector.createMany({
      data: ["gmail", "linear"].map((connectorId) => ({ sessionId: session.id, userId: owner, connectorId })),
    });

    const moved = await transferWorkSessionOwner({
      userId: owner,
      sessionId: session.id,
      toAgentId: otto.agent.id,
      reason: "Otto owns renewals now.",
      by: { kind: "person" },
    });
    assert.ok(moved.ok, moved.ok ? "" : moved.message);
    const after = await db.workSession.findUniqueOrThrow({ where: { id: session.id }, include: { connectors: true } });
    assert.equal(after.agentId, otto.agent.id);
    assert.ok(after.ownerTransferredAt);
    assert.equal(after.permissionPolicy, "conservative", "the stricter member's mode, never a wider one");
    assert.deepEqual(after.connectors.map((row) => row.connectorId), ["linear"], "only apps the new owner may use");
    const event = await db.workEvent.findFirstOrThrow({ where: { runId: run.id, kind: "owner_transferred" } });
    assert.equal(event.seq, 4, "appended after the run's own events");
    assert.equal(event.visibility, "user");
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.reason, "Otto owns renewals now.");
    assert.match(String(payload.summary), /^You handed this from Mira to Otto: Otto owns renewals now\.$/);
    const logs = await db.agentEvent.findMany({ where: { userId: owner, kind: "task_transferred" } });
    assert.equal(logs.length, 2, "both members' logs say it");

    // Mid-step, and a claimed queue, are refused and change nothing.
    const running = await task({ agentId: mira.agent.id, conversationId: mira.conversationId, status: "running" });
    const refused = await transferWorkSessionOwner({ userId: owner, sessionId: running.session.id, toAgentId: otto.agent.id, reason: "x", by: { kind: "person" } });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "not_at_safe_point");
    const claimed = await task({ agentId: mira.agent.id, conversationId: mira.conversationId, status: "queued" });
    await db.workRun.update({ where: { id: claimed.run.id }, data: { claimedBy: "exec-1", leaseExpiresAt: new Date(Date.now() + 60_000) } });
    const refusedQueued = await transferWorkSessionOwner({ userId: owner, sessionId: claimed.session.id, toAgentId: otto.agent.id, reason: "x", by: { kind: "person" } });
    assert.equal(refusedQueued.ok, false);
    assert.equal((await db.workSession.findUniqueOrThrow({ where: { id: claimed.session.id } })).agentId, mira.agent.id);
    // Another account cannot move it at all.
    const foreign = await transferWorkSessionOwner({ userId: stranger, sessionId: session.id, toAgentId: null, reason: "mine", by: { kind: "person" } });
    assert.equal(foreign.ok, false);
  });

  test("a member's own budget: spent across its tasks in the window, refused with a sentence", async () => {
    const { checkMemberBudget } = await import("@/lib/agents/budget-store");
    const scout = await member("Scout", { budgetMicroUsd: 5_000_000 });
    const a = await task({ agentId: scout.agent.id, conversationId: scout.conversationId, status: "completed" });
    await db.workRun.update({ where: { id: a.run.id }, data: { costMicroUsd: 3_000_000 } });
    const weekly = { startMs: Date.now() - 60_000, resetsAtMs: Date.now() + 86_400_000 };
    const room = await checkMemberBudget({ userId: owner, agentId: scout.agent.id, weekly, stage: "admission" });
    assert.deepEqual(room, { ok: true, remainingMicroUsd: 2_000_000 });
    const b = await task({ agentId: scout.agent.id, conversationId: scout.conversationId, status: "completed" });
    await db.workRun.update({ where: { id: b.run.id }, data: { costMicroUsd: 2_000_000 } });
    const spent = await checkMemberBudget({ userId: owner, agentId: scout.agent.id, weekly, stage: "admission" });
    assert.equal(spent.ok, false);
    if (!spent.ok) assert.match(spent.message, /^Scout has used the \$5\.00 you set for this week, so nothing was started\./);
    // Mid-run, the run's own live cost counts and its stale row does not.
    const live = await checkMemberBudget({ userId: owner, agentId: scout.agent.id, weekly, stage: "running", excludeRunId: b.run.id, pendingMicroUsd: 1_000_000 });
    assert.equal(live.ok, true);
    // Runs before the window are the previous window's.
    const next = await checkMemberBudget({ userId: owner, agentId: scout.agent.id, weekly: { startMs: Date.now() + 1_000, resetsAtMs: Date.now() + 86_400_000 }, stage: "admission" });
    assert.equal(next.ok, true);
  });

  test("setup changes apply, undo, and refuse to overwrite a later decision", async () => {
    const setup = await import("@/lib/agents/setup-changes-store");
    const lena = await member("Lena", { notify: "results" });
    const user = { id: owner };
    const snapshot = await setup.setupSnapshot(owner, lena.agent);
    const planned = setup.planSetupChange("notify", { level: "needs_you" }, snapshot);
    assert.ok(planned.ok);
    if (!planned.ok) return;
    const row = await setup.recordSetupChange({ userId: owner, agentId: lena.agent.id, conversationId: lena.conversationId, userMessageId: "m1", callKey: "k1", plan: planned.plan, status: "proposed" });
    const again = await setup.recordSetupChange({ userId: owner, agentId: lena.agent.id, conversationId: lena.conversationId, userMessageId: "m1", callKey: "k1", plan: planned.plan, status: "proposed" });
    assert.equal(again.id, row.id, "one change per call, whatever retries");
    const applied = await setup.applySetupChange(user, row);
    assert.ok(applied.ok);
    assert.equal((await db.agent.findUniqueOrThrow({ where: { id: lena.agent.id } })).notify, "needs_you");
    const undone = applied.ok ? await setup.undoSetupChange(user, applied.change) : null;
    assert.ok(undone?.ok);
    assert.equal((await db.agent.findUniqueOrThrow({ where: { id: lena.agent.id } })).notify, "results");

    // Applied again, then the person changes it themselves: Undo must not overwrite that.
    const reapplied = await setup.applySetupChange(user, (await setup.findSetupChange(owner, lena.agent.id, row.id))!);
    assert.ok(reapplied.ok);
    await db.agent.update({ where: { id: lena.agent.id }, data: { notify: "all" } });
    const stale = reapplied.ok ? await setup.undoSetupChange(user, reapplied.change) : null;
    assert.equal(stale?.ok, false);
    if (stale && !stale.ok) assert.equal(stale.code, "changed_since");

    // A draft skill is saved switched off, and Undo removes it.
    const draftPlan = setup.planSetupChange("skill_draft", { skillName: "Triage issues", skillInstructions: "1. Read.\n2. Label." }, snapshot);
    assert.ok(draftPlan.ok);
    if (!draftPlan.ok) return;
    const draftRow = await setup.recordSetupChange({ userId: owner, agentId: lena.agent.id, conversationId: null, userMessageId: null, callKey: "k2", plan: draftPlan.plan, status: "proposed" });
    const draft = await setup.applySetupChange(user, draftRow);
    assert.ok(draft.ok);
    const skillId = draft.ok ? ((draft.change.after as { applied?: { skillId?: string } }).applied?.skillId ?? "") : "";
    const skill = await db.workSkill.findUniqueOrThrow({ where: { id: skillId } });
    assert.equal(skill.enabled, false);
    assert.equal(skill.autoSelect, false);
    if (draft.ok) await setup.undoSetupChange(user, draft.change);
    assert.ok((await db.workSkill.findUniqueOrThrow({ where: { id: skillId } })).deletedAt);
  });

  test("Move to crew makes one member, marks the assistant and keeps it readable", async () => {
    const assistants = await import("@/lib/assistants");
    const { moveAssistantToCrew } = await import("@/lib/agents/move-from-assistant-store");
    const created = await assistants.createAssistant(
      { name: "Contract reviewer", description: "Reviews contracts. Carefully.", systemPrompt: "You review contracts.", starterPrompts: ["Review this NDA"] },
      owner
    );
    const [first, second] = await Promise.all([moveAssistantToCrew({ id: owner }, created.id), moveAssistantToCrew({ id: owner }, created.id)]);
    assert.ok([200, 201].includes(first.status) && [200, 201].includes(second.status), JSON.stringify([first.body, second.body]));
    const agentId = (first.value as { id: string }).id;
    assert.equal((second.value as { id: string }).id, agentId, "a double press is one member");
    const agent = await db.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.equal(agent.sourceAssistantId, created.id);
    assert.equal(agent.instructions, "You review contracts.");
    assert.equal(agent.proactive, false);
    assert.equal(await db.agentIdea.count({ where: { agentId, status: "new" } }), 1);
    assert.equal((await assistants.listUserAssistants(owner)).some((item) => item.id === created.id), false);
    const readable = await assistants.getAssistantById(created.id, owner);
    assert.equal(readable?.movedToAgentId, agentId);
    assert.equal((await moveAssistantToCrew({ id: stranger }, created.id)).status, 404);
  });

  test("a computer link opens once, for its own account and live session, and its ticket trades once", async () => {
    const handoff = await import("@/lib/computer/handoff");
    const now = new Date();
    const device = await db.nativeDeviceSession.create({
      data: { userId: owner, installationIdHash: "test-install", name: "Test Mac", platform: "macos", appVersion: "1.9.3" },
    });
    const link = await handoff.createComputerHandoff({ userId: owner, agentId: "ag_x", mode: "control", deviceSessionId: device.id, baseUrl: "https://juno.example" });
    const code = new globalThis.URL(link.url).searchParams.get("c");
    assert.ok(handoff.isHandoffSecretShape(code));
    const stored = await db.agentComputerHandoff.findFirstOrThrow({ where: { userId: owner, agentId: "ag_x" } });
    assert.notEqual(stored.codeHash, code, "only the hash is stored");

    const opened = await handoff.consumeComputerHandoff(code, { viewerUserId: null });
    assert.ok(opened);
    assert.equal(opened?.mode, "control");
    assert.equal(await handoff.consumeComputerHandoff(code, { viewerUserId: null }), null, "a second open finds nothing");
    const traded = await handoff.exchangeComputerHandoffTicket(opened!.ticket);
    assert.equal(traded?.agentId, "ag_x");
    assert.equal(await handoff.exchangeComputerHandoffTicket(opened!.ticket), null, "a ticket trades once");

    // Another signed-in account, an expired link, a revoked device: refused.
    const foreign = await handoff.createComputerHandoff({ userId: owner, agentId: "ag_x", mode: "watch", deviceSessionId: null, baseUrl: "https://juno.example" });
    assert.equal(await handoff.consumeComputerHandoff(new globalThis.URL(foreign.url).searchParams.get("c"), { viewerUserId: stranger }), null);
    const old = await handoff.createComputerHandoff({ userId: owner, agentId: "ag_x", mode: "watch", deviceSessionId: null, baseUrl: "https://juno.example", now: new Date(now.getTime() - 120_000) });
    assert.equal(await handoff.consumeComputerHandoff(new globalThis.URL(old.url).searchParams.get("c"), { viewerUserId: null }), null);
    const bound = await handoff.createComputerHandoff({ userId: owner, agentId: "ag_x", mode: "control", deviceSessionId: device.id, baseUrl: "https://juno.example" });
    await db.nativeDeviceSession.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    assert.equal(await handoff.consumeComputerHandoff(new globalThis.URL(bound.url).searchParams.get("c"), { viewerUserId: null }), null, "a revoked device's link is dead");
  });

  test("research started in a member's thread is that member's", async () => {
    const { createPrismaResearchStore } = await import("@/lib/research/run");
    const sage = await member("Sage");
    const run = await createPrismaResearchStore().createRun({
      userId: owner,
      goal: "Map the market",
      conversationId: sage.conversationId,
      budgetMicroUsd: BigInt(1_000_000),
      plan: { questions: [] } as never,
    } as never);
    const row = await db.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(row.agentId, sage.agent.id);
  });

  const routeTest = canMockModules ? test : test.skip;

  routeTest("the conversation lists every live task and the newest finished one; strangers see nothing", async () => {
    const { GET } = await import("@/app/api/conversations/[id]/tasks/route");
    const ivy = await member("Ivy");
    const base = Date.now() - 3_600_000;
    await task({ agentId: ivy.agent.id, conversationId: ivy.conversationId, status: "completed", title: "Old", createdAt: new Date(base) });
    await task({ agentId: ivy.agent.id, conversationId: ivy.conversationId, status: "running", title: "Routine", createdAt: new Date(base + 60_000) });
    await task({ agentId: ivy.agent.id, conversationId: ivy.conversationId, status: "waiting_input", title: "Yours", createdAt: new Date(base + 120_000) });
    await task({ agentId: ivy.agent.id, conversationId: ivy.conversationId, status: "draft", title: "Draft", createdAt: new Date(base + 180_000) });
    signedIn = { id: owner, email: `${owner}@example.invalid` };
    const res = await GET(new Request("http://x/api"), { params: Promise.resolve({ id: ivy.conversationId }) });
    const body = (await res.json()) as { sessions: Array<{ title: string; agentId: string }>; cap: number };
    assert.deepEqual(body.sessions.map((s) => s.title), ["Old", "Routine", "Yours"]);
    assert.equal(body.sessions[0].agentId, ivy.agent.id);
    assert.equal(body.cap, 4);
    signedIn = { id: stranger, email: `${stranger}@example.invalid` };
    const other = (await (await GET(new Request("http://x/api"), { params: Promise.resolve({ id: ivy.conversationId }) })).json()) as { sessions: unknown[] };
    assert.deepEqual(other.sessions, []);
    signedIn = null;
  });

  routeTest("Apply is refused without the card's digest, and a narrowing Undo works from the route", async () => {
    const { POST, GET } = await import("@/app/api/agents/[id]/setup-changes/[changeId]/route");
    const setup = await import("@/lib/agents/setup-changes-store");
    const nova = await member("Nova", { connectorIds: [] });
    await db.connection.create({ data: { userId: owner, provider: "linear", accessToken: "enc:test", scope: "" } as never }).catch(() => null);
    const snapshot = await setup.setupSnapshot(owner, nova.agent);
    const planned = setup.planSetupChange("apps_add", { apps: ["linear"] }, snapshot, { linkedApps: ["linear"] });
    assert.ok(planned.ok);
    if (!planned.ok) return;
    assert.equal(planned.plan.direction, "widening");
    const row = await setup.recordSetupChange({ userId: owner, agentId: nova.agent.id, conversationId: nova.conversationId, userMessageId: "m9", callKey: "k9", plan: planned.plan, status: "declined" });
    const params = { params: Promise.resolve({ id: nova.agent.id, changeId: row.id }) };
    signedIn = { id: owner, email: `${owner}@example.invalid` };
    const bad = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "apply", digest: "0".repeat(64) }) }), params);
    assert.equal(bad.status, 409);
    assert.equal((await db.agent.findUniqueOrThrow({ where: { id: nova.agent.id } })).connectorIds.length, 0, "nothing applied");
    const live = (await (await GET(new Request("http://x"), params)).json()) as { change: { digest: string } };
    const good = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "apply", digest: live.change.digest }) }), params);
    const goodBody = (await good.json()) as { change?: { status: string }; message?: string };
    assert.equal(good.status, 200, goodBody.message);
    assert.equal(goodBody.change?.status, "applied");
    signedIn = { id: stranger, email: `${stranger}@example.invalid` };
    assert.equal((await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "undo" }) }), params)).status, 404);
    signedIn = { id: owner, email: `${owner}@example.invalid` };
    const undo = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ action: "undo" }) }), params);
    assert.equal(undo.status, 200);
    signedIn = null;
  });
}
