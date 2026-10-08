import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * AN APP'S RESEARCH BECOMES A BACKGROUND RUN (SPEC §9.6.1), THROUGH THE REAL
 * CHAT ROUTE, AGAINST POSTGRES.
 *
 * Before: a Mac or iPhone research turn gathered and wrote its report inside
 * the chat request, so the run lived and died with one HTTP request on one
 * process and the apps could not find it again after a relaunch. Now a
 * client that declares `research_background` gets:
 *
 *  - a durable run, auto-confirmed and marked `delivery: "background"`,
 *    handed to the background driver (the full engine, which writes the
 *    report message and notifies on its own) — the model is never called;
 *  - the terminal `handoff` frame, logged so a resumed stream ends on it too,
 *    no `done`, and no assistant row;
 *  - a run that a client disconnect does not cancel: only Stop does;
 *  - the research surface's own start checks (one live run on Pro), answered
 *    as a notice instead of a run.
 *
 * A client that does not declare it (today's web, older apps) is unchanged —
 * covered by tests/deep-research-adapter.test.ts and the turn-stream suite.
 *
 * Only the session, the model, the search backend's availability and the
 * background driver are stand-ins; a fetch tripwire proves nothing leaves the
 * process. Skipped unless RESEARCH_TEST_DATABASE_URL names a throwaway
 * loopback database (it never falls back to DATABASE_URL):
 *
 *   initdb -D <dir> -U postgres --auth=trust   (unix_socket_directories = '',
 *     listen_addresses = '127.0.0.1', a spare port; start with LC_ALL=en_US.UTF-8)
 *   createdb -h 127.0.0.1 -p <port> -U postgres juno_research_test
 *   DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy
 *   RESEARCH_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/juno_research_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/research-handoff-route.integration.test.ts
 */

const DB_URL = process.env.RESEARCH_TEST_DATABASE_URL;

if (!DB_URL) {
  test("research hand-off route suite is skipped without RESEARCH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const url = new URL(DB_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("The research hand-off suite needs a loopback PostgreSQL.");
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "research-handoff-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  let modelCalls = 0;
  const drives: Array<{ runId: string; userId: string }> = [];
  const outbound: string[] = [];

  test("stand in for the session, the model, the search backend and the background driver", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const target = input instanceof Request ? input.url : String(input);
      outbound.push(target);
      throw new Error(`unexpected network call to ${target}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: { ...providers, isProviderConfigured: () => true, configuredProviders: () => [...providers.PROVIDER_LIST] },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* () {
          modelCalls += 1;
          yield { type: "text", text: "An in-chat answer the hand-off must never write." };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const engine = await import("@/lib/search/search-engine");
    mock.module("@/lib/search/search-engine", { namedExports: { ...engine, isSearchEngineAvailable: () => true } });
    const run = await import("@/lib/research/run");
    mock.module("@/lib/research/run", {
      namedExports: {
        ...run,
        // The real one drives the full engine off the request (searches, the
        // writer, the completion message). Recorded here: what this suite
        // proves is that the run is handed to it and outlives the request.
        driveResearchInBackground: (input: { runId: string; userId: string }) => {
          drives.push({ runId: input.runId, userId: input.userId });
        },
      },
    });
  });

  type Frame = { type: string; [key: string]: unknown };
  const framesOf = (text: string): Frame[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);

  const APP_FEATURES = ["timeline", "resume", "research_background", "suggest_research", "citations", "live_ui"];

  async function post(body: Record<string, unknown>) {
    const route = await import("@/app/api/chat/route");
    return route.POST(
      new Request("http://alevr.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  async function seed(plan: "PRO" | "MAX" = "PRO") {
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const user = await prisma.user.create({
      data: { email: `research-handoff-${suffix}@example.invalid`, name: "Hand-off tester", emailVerified: new Date() },
    });
    await prisma.subscription.create({ data: { userId: user.id, plan, status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email, name: user.name! };
    return user;
  }

  const QUESTION = "How do heat pumps cope with Nordic winters?";

  test("an app's research turn ends on `handoff`, writes no answer, and leaves a durable background run", async () => {
    const user = await seed();
    const before = drives.length;
    const res = await post({ message: QUESTION, deepResearch: true, clientFeatures: APP_FEATURES, timeZone: "Europe/Oslo", locale: "en-GB" });
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 400));
    const frames = framesOf(text);
    const last = frames[frames.length - 1];
    assert.equal(last.type, "handoff", `the terminal frame: ${frames.map((frame) => frame.type).join(", ")}`);
    assert.equal(last.to, "research");
    assert.ok(!frames.some((frame) => frame.type === "done" || frame.type === "error" || frame.type === "delta"));
    const meta = frames.find((frame) => frame.type === "meta")!;
    assert.equal(last.userMessageId, meta.userMessageId, "the frame names the question it came from");
    assert.equal(modelCalls, 0, "the chat model never runs: the engine writes the report");

    const runId = String(last.runId);
    const run = await prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.userId, user.id);
    assert.equal(run.conversationId, meta.conversationId);
    assert.equal(run.goal, QUESTION);
    assert.equal(run.state, "accepted", "created and handed on, not driven inside the request");
    const plan = run.plan as { confirmation?: string; delivery?: string; timeZone?: string; locale?: string };
    assert.equal(plan.confirmation, "auto", "the app's Research toggle is the confirmation");
    assert.equal(plan.delivery, "background");
    assert.equal(plan.timeZone, "Europe/Oslo");
    assert.deepEqual(drives.slice(before), [{ runId, userId: user.id }], "handed to the background driver once");

    const messages = await prisma.message.findMany({ where: { conversationId: run.conversationId! }, select: { role: true } });
    assert.deepEqual(messages.map((message) => message.role), ["USER"], "no assistant row: the completion message is the engine's");

    // The frame is in the generation's log, so a resumed stream ends on it too.
    const logged = await prisma.chatStreamEvent.findMany({ where: { generationId: String(meta.generationId) }, orderBy: { seq: "asc" } });
    assert.equal(logged[logged.length - 1]?.kind, "handoff");
    const { decryptMessageTextSafe } = await import("@/lib/message-crypto");
    assert.equal(JSON.parse(decryptMessageTextSafe(logged[logged.length - 1].payload) ?? "{}").runId, runId);
    // The hold the turn took against the budget is released, not left for the sweep.
    const holds = await prisma.spendReservation.findMany({ where: { userId: user.id, kind: "chat", state: "open" } });
    assert.equal(holds.length, 0);
  });

  test("a client that disconnects mid-turn does not cancel the run; only Stop does", async () => {
    const user = await seed("MAX");
    const before = drives.length;
    const res = await post({ message: QUESTION, deepResearch: true, clientFeatures: APP_FEATURES });
    // The app goes away after the first bytes: the reader is cancelled, the
    // way a closed app or a dropped connection ends a response body.
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel("app closed");

    let run = null as Awaited<ReturnType<typeof prisma.researchRun.findFirst>>;
    for (let attempt = 0; attempt < 100 && !run; attempt += 1) {
      run = await prisma.researchRun.findFirst({ where: { userId: user.id } });
      if (!run) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(run, "the run exists although nobody is reading the stream");
    for (let attempt = 0; attempt < 100 && drives.length === before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(drives.slice(before), [{ runId: run.id, userId: user.id }], "and it was handed to the background driver");
    // Give the detached turn time to finish: nothing it does afterwards may cancel the run.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.notEqual(after.state, "cancelled");
    assert.equal(
      await prisma.researchEvent.count({ where: { runId: run.id, kind: "run_finished" } }),
      0,
      "no `chat_stopped` ending: the request is not the run's lifetime"
    );

    // Stop is the one thing that cancels it.
    const control = await import("@/app/api/research/[id]/control/route");
    const stopped = await control.POST(
      new Request(`http://alevr.test/api/research/${run.id}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      }),
      { params: Promise.resolve({ id: run.id }) }
    );
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal((await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } })).state, "cancelled");
  });

  test("the research surface's start checks still apply: a second live run on Pro is a notice, not a run", async () => {
    const user = await seed("PRO");
    const first = framesOf(await (await post({ message: QUESTION, deepResearch: true, clientFeatures: APP_FEATURES })).text());
    assert.equal(first[first.length - 1].type, "handoff");
    const before = drives.length;
    const second = framesOf(
      await (await post({ message: "And air-source versus ground-source?", deepResearch: true, clientFeatures: APP_FEATURES, conversationId: first.find((f) => f.type === "meta")!.conversationId })).text()
    );
    assert.ok(!second.some((frame) => frame.type === "handoff"), "no hand-off without a run");
    const done = second.find((frame) => frame.type === "done") as Frame & { message: { content: string } };
    assert.ok(done, "a normal turn that says why");
    assert.match(done.message.content, /Too many research runs are going/);
    assert.match(done.message.content, /has not started/);
    assert.equal(drives.length, before);
    assert.equal(await prisma.researchRun.count({ where: { userId: user.id } }), 1);
    assert.equal(modelCalls, 0, "the notice is not a model turn");
  });

  test("a reply to a plan waiting in the conversation starts that plan in the background", async () => {
    const user = await seed("MAX");
    const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Parked plan" } });
    const { researchEngine } = await import("@/lib/research/run");
    const parked = await researchEngine().start({ userId: user.id, goal: QUESTION, conversationId: conversation.id, confirmation: "required" });
    await prisma.researchRun.update({
      where: { id: parked.id },
      data: {
        state: "awaiting_plan_confirmation",
        plan: { ...(parked.plan as object), queries: ["heat pump COP at -20C"], objectives: [{ id: "q1", question: "How efficient are they at -20C?", status: "pending" }] },
      },
    });
    const before = drives.length;
    const frames = framesOf(await (await post({ message: "yes", deepResearch: true, clientFeatures: APP_FEATURES, conversationId: conversation.id })).text());
    const last = frames[frames.length - 1];
    assert.equal(last.type, "handoff");
    assert.equal(last.runId, parked.id, "the plan that was waiting, not a new run");
    assert.notEqual((await prisma.researchRun.findUniqueOrThrow({ where: { id: parked.id } })).state, "awaiting_plan_confirmation");
    assert.deepEqual(drives.slice(before), [{ runId: parked.id, userId: user.id }]);
    assert.equal(await prisma.researchRun.count({ where: { userId: user.id } }), 1);
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound, []);
  });

  test("disconnect", async () => {
    await prisma.$disconnect();
    const { prismaUnguarded } = await import("@/lib/prisma");
    await prismaUnguarded.$disconnect().catch(() => undefined);
  });
}
