import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * CHARACTERISATION OF ONE CHAT TURN, END TO END, THROUGH POST /api/chat.
 *
 * Written before the route was split into a pipeline (docs/rework/program/
 * ORCHESTRATION.md) and kept as its contract afterwards: every behaviour
 * below was observed on the 4,587-line route and must survive the split.
 *
 * What runs for real: the route, admission, model selection, the durable
 * receipt, the user/assistant message writes, the spend reservation and
 * ledger, quota, the SSE sender, the resumable stream log, the resume route,
 * the stall watchdog, terminal-state classification and refunds. Stand-ins:
 * the signed-in session, provider configuration, `after()` (captured so the
 * test can await the detached generation), and THE MODEL (`streamChat`),
 * which is scripted per test. A fetch tripwire proves nothing leaves the
 * process.
 *
 * Reliability cases (BRIEF §48): client disconnect mid-stream, reconnect via
 * the resume route, a provider 429, a provider that goes silent, a user Stop.
 *
 * Skipped unless CHAT_TURN_TEST_DATABASE_URL names a throwaway, migrated
 * database (it never falls back to DATABASE_URL):
 *   CHAT_TURN_TEST_DATABASE_URL=postgresql://juno@127.0.0.1:54329/juno_route_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-turn-pipeline.integration.test.ts
 */

const DB_URL = process.env.CHAT_TURN_TEST_DATABASE_URL;

if (!DB_URL) {
  test("chat turn pipeline suite is skipped without CHAT_TURN_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "chat-turn-pipeline-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  type Script = (opts: { signal?: AbortSignal; system: string }) => AsyncGenerator<Record<string, unknown>>;
  let script: Script;
  let streamCalls = 0;
  const afterQueue: Array<() => unknown> = [];
  const outbound: string[] = [];
  /** Shortens the stall watchdog for the one test that needs it. */
  let stallMs: number | null = null;
  /** Makes the deep-research leg throw, for the one test that needs it. */
  let researchThrows = false;
  const logLines: string[] = [];

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function* answer(text: string, chunks = 1, gapMs = 0) {
    const size = Math.ceil(text.length / chunks);
    for (let i = 0; i < text.length; i += size) {
      yield { type: "text", text: text.slice(i, i + size) };
      if (gapMs) await sleep(gapMs);
    }
    yield { type: "usage", input: 40, output: 12 };
    yield { type: "finish", reason: "stop" };
  }

  test("stand in for the session, the model and after()", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      outbound.push(url);
      throw new Error(`unexpected network call to ${url}`);
    };
    const server = await import("next/server");
    mock.module("next/server", {
      namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) },
    });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: {
        ...providers,
        isProviderConfigured: () => true,
        configuredProviders: () => [...providers.PROVIDER_LIST],
      },
    });
    const stall = await import("@/lib/chat-stall");
    mock.module("@/lib/chat-stall", {
      namedExports: {
        ...stall,
        createStallWatchdog: (onStall: () => void, idle?: number, startup?: number) =>
          stall.createStallWatchdog(onStall, stallMs ?? idle, stallMs ?? startup),
      },
    });
    const webSearch = await import("@/lib/web-search");
    mock.module("@/lib/web-search", { namedExports: { ...webSearch, isWebSearchConfigured: () => true } });
    const deepResearch = await import("@/lib/deep-research");
    mock.module("@/lib/deep-research", {
      namedExports: {
        ...deepResearch,
        runDeepResearch: async (...args: Parameters<typeof deepResearch.runDeepResearch>) => {
          if (researchThrows) throw new Error("research backend unavailable");
          return deepResearch.runDeepResearch(...args);
        },
      },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        // Only the turn itself is scripted. Background work after the turn
        // (moderation, memory extraction) also reaches `streamChat`; it gets an
        // empty reply so it neither hangs nor counts as a turn call.
        streamChat: (opts: { signal?: AbortSignal; system: string; requestContext?: unknown }) => {
          if (!opts.requestContext) return (async function* () { yield { type: "finish", reason: "stop" }; })();
          streamCalls += 1;
          return script(opts);
        },
      },
    });
    // Capture structured log lines (the turn trace rides `logSync`).
    const original = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === "string") logLines.push(args[0]);
      original(...args);
    };
  });

  const request = (body: unknown) =>
    new Request("http://juno.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-juno-request-id": `req-${randomUUID()}` },
      body: JSON.stringify(body),
    });

  type Frame = { type: string; [key: string]: unknown };
  const parseFrames = (text: string) =>
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);

  async function drainAfter() {
    while (afterQueue.length) await afterQueue.shift()!();
  }

  async function chat(body: unknown) {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(request(body));
    const text = await res.text();
    await drainAfter();
    return { status: res.status, text, frames: res.headers.get("content-type")?.includes("event-stream") ? parseFrames(text) : [] };
  }

  async function seedUser(plan: "PRO" | "FREE" = "PRO") {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `turn-${suffix}@example.invalid`, name: "Turn tester", emailVerified: new Date() },
    });
    if (plan === "PRO") await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  // ── Pre-stream refusals ───────────────────────────────────────────────────

  test("refusals before the stream: unauthenticated, malformed, no paid plan", async () => {
    signedIn = null;
    assert.equal((await chat({ message: "hi" })).status, 401);

    await seedUser();
    const malformed = await (await import("@/app/api/chat/route")).POST(
      new Request("http://juno.test/api/chat", { method: "POST", body: "{not json" })
    );
    assert.equal(malformed.status, 400);

    await seedUser("FREE");
    const before = streamCalls;
    const free = await chat({ message: "hi" });
    assert.equal(free.status, 402);
    assert.equal((JSON.parse(free.text) as { code?: string }).code, "PLAN_REQUIRED");
    assert.equal(streamCalls, before, "no model call for a refused turn");
  });

  // ── The ordinary saved turn ───────────────────────────────────────────────

  test("a saved turn: frame order, persisted rows, spend settled, quota consumed, stream log kept", async () => {
    const user = await seedUser();
    script = () => answer("Paris is the capital of France.");
    const { status, frames } = await chat({ message: "What is the capital of France?" });
    assert.equal(status, 200);

    assert.equal(frames[0].type, "meta", "meta is always first");
    assert.equal(frames[0].resumable, true, "a saved turn advertises a resumable log");
    const types = frames.map((frame) => frame.type);
    assert.ok(types.indexOf("delta") > types.indexOf("meta"));
    assert.equal(types.at(-1), "done", "done is the terminal frame");
    assert.equal(types.filter((type) => type === "done").length, 1);
    const kinds = frames.filter((f) => f.type === "activity").map((f) => (f.event as { kind: string }).kind);
    assert.deepEqual(kinds.slice(0, 2), ["context", "model"], "context then the selected model");
    assert.ok(kinds.includes("write") && kinds.includes("usage") && kinds.at(-1) === "done");

    const done = frames.at(-1) as Frame & { message: { id: string; content: string }; finishReason: string };
    assert.equal(done.finishReason, "stop");
    assert.equal(done.message.content, "Paris is the capital of France.");

    const conversationId = frames[0].conversationId as string;
    const generationId = frames[0].generationId as string;
    const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(messages.map((m) => m.role), ["USER", "ASSISTANT"]);
    assert.equal(messages[1].id, done.message.id);

    const reservation = await prisma.spendReservation.findFirst({ where: { userId: user.id, ref: generationId } });
    assert.equal(reservation?.state, "settled", "the hold is settled by the recorded spend");
    assert.equal(await prisma.apiSpend.count({ where: { userId: user.id, completionTokens: 12 } }), 1);
    const usage = await prisma.usage.findFirst({ where: { userId: user.id } });
    assert.equal(usage?.messageCount, 1);
    assert.ok((await prisma.chatStreamEvent.count({ where: { generationId } })) > 0, "frames were logged");
  });

  test("a durable first submission completes its receipt and a retry recovers instead of re-running", async () => {
    await seedUser();
    script = () => answer("Durable hello.");
    const body = { message: "Hello", clientRequestId: `req-${randomUUID()}`, clientMessageId: `msg-${randomUUID()}` };
    const first = await chat(body);
    assert.equal(first.status, 200);
    const generationId = first.frames[0].generationId as string;
    assert.equal(first.frames[0].receiptState, "running");
    const receipt = await prisma.chatFirstSubmissionReceipt.findUnique({ where: { generationId } });
    assert.equal(receipt?.state, "completed");
    assert.equal(receipt?.finishReason, "stop");
    assert.ok(receipt?.assistantMessageId);

    const calls = streamCalls;
    const retry = await chat(body);
    assert.equal(streamCalls, calls, "a retried submission never calls the model again");
    assert.ok(retry.status < 500);
    assert.equal(
      await prisma.message.count({ where: { conversationId: receipt!.conversationId } }),
      2,
      "and writes nothing new"
    );
  });

  test("a regenerate keeps the previous answer as a version", async () => {
    await seedUser();
    script = () => answer("First answer.");
    const first = await chat({ message: "Tell me something." });
    const conversationId = first.frames[0].conversationId as string;
    script = () => answer("Second answer.");
    const second = await chat({ conversationId, regenerate: true });
    assert.equal(second.status, 200);
    const assistant = await prisma.message.findMany({ where: { conversationId, role: "ASSISTANT" } });
    assert.equal(assistant.length, 1, "the reply row is superseded in place");
    assert.equal(await prisma.messageVersion.count({ where: { messageId: assistant[0].id } }), 1);
  });

  test("a private turn stores nothing and still settles its spend hold", async () => {
    const user = await seedUser();
    script = () => answer("Private reply.");
    const { status, frames } = await chat({
      privateMode: true,
      message: "secret question",
      privateHistory: [{ role: "USER", content: "secret question" }],
    });
    assert.equal(status, 200);
    assert.equal(frames[0].conversationId, "private");
    assert.equal(frames.at(-1)?.type, "done");
    assert.equal(await prisma.conversation.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.spendReservation.count({ where: { userId: user.id, state: "open" } }), 0);
  });

  // ── Reliability (BRIEF §48) ───────────────────────────────────────────────

  test("a client that disconnects mid-stream still gets its answer saved, and can resume the log", async () => {
    const user = await seedUser();
    script = () => answer("One two three four five six seven eight.", 8, 15);
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(request({ message: "Count to eight." }));
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const meta = parseFrames(new TextDecoder().decode(first.value))[0];
    assert.equal(meta.type, "meta");
    await reader.cancel(); // the tab closed
    await drainAfter(); // the detached generation runs to the end

    const conversationId = meta.conversationId as string;
    const generationId = meta.generationId as string;
    const reply = await prisma.message.findFirst({ where: { conversationId, role: "ASSISTANT" } });
    assert.ok(reply, "the answer was persisted although nobody was listening");
    const { decryptMessageText } = await import("@/lib/message-crypto");
    assert.equal(decryptMessageText(reply!.content), "One two three four five six seven eight.");
    assert.equal(
      (await prisma.spendReservation.findFirst({ where: { userId: user.id, ref: generationId } }))?.state,
      "settled"
    );

    // A refreshed page reconnects to the log and sees the terminal frame.
    const resume = await import("@/app/api/chat/stream/[generationId]/route");
    const replay = await resume.GET(new Request(`http://juno.test/api/chat/stream/${generationId}?after=0`), {
      params: Promise.resolve({ generationId }),
    });
    const replayed = parseFrames(await replay.text());
    assert.ok(replayed.some((frame) => frame.type === "done"), "the resumed stream ends on done");
  });

  test("a provider 429 is reported once, refunded, never retried, and fails the durable receipt", async () => {
    const user = await seedUser();
    script = async function* () {
      throw Object.assign(new Error("429 Too Many Requests: rate limit exceeded"), { status: 429 });
    };
    const calls = streamCalls;
    const { status, frames } = await chat({
      message: "Hello?",
      clientRequestId: `req-${randomUUID()}`,
      clientMessageId: `msg-${randomUUID()}`,
    });
    assert.equal(status, 200, "the failure arrives on the stream, after acceptance");
    assert.equal(streamCalls - calls, 1, "the provider call is not retried behind the accounting boundary");
    const error = frames.at(-1) as Frame & { message: string; receiptState?: string; failureCode?: string };
    assert.equal(error.type, "error");
    assert.equal(error.receiptState, "failed");
    assert.ok(error.failureCode);
    assert.doesNotMatch(error.message, /429 Too Many Requests: rate limit exceeded/, "raw provider text is not echoed");
    const usage = await prisma.usage.findFirst({ where: { userId: user.id } });
    assert.equal(usage?.messageCount, 0, "the consumed message was refunded");
    assert.equal(await prisma.spendReservation.count({ where: { userId: user.id, state: "open" } }), 0, "the hold was released");
    const receipt = await prisma.chatFirstSubmissionReceipt.findFirst({ where: { userId: user.id } });
    assert.equal(receipt?.state, "failed");
  });

  test("a provider that goes silent is stopped by the watchdog: an error, refunded, never a user Stop", async () => {
    const user = await seedUser();
    stallMs = 60;
    script = async function* (opts) {
      yield { type: "text", text: "Partial" };
      await new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("aborted", "AbortError");
    };
    try {
      const { frames } = await chat({ message: "Write a lot." });
      // terminal-state.ts: a stall is an error (the provider failed), so the
      // partial is not persisted and the message is refunded.
      const last = frames.at(-1) as Frame & { finishReason: string; message: string };
      assert.equal(last.type, "error");
      assert.equal(last.finishReason, "error", "a stall is not recorded as the user's Stop");
      assert.equal((await prisma.usage.findFirst({ where: { userId: user.id } }))?.messageCount, 0);
      assert.ok(
        frames.some((f) => f.type === "activity" && (f.event as { title?: string }).title === "Model stopped responding")
      );
    } finally {
      stallMs = null;
    }
  });

  test("a user Stop keeps the partial answer and the charge", async () => {
    const user = await seedUser();
    let generationId = "";
    script = async function* (opts) {
      yield { type: "text", text: "Half an" };
      const { cancelGeneration } = await import("@/lib/generation-cancel");
      cancelGeneration(generationId, user.id);
      if (opts.signal?.aborted) throw new DOMException("Stopped by user", "AbortError");
      yield { type: "text", text: " answer" };
    };
    generationId = `gen-${randomUUID()}`;
    const { frames } = await chat({ message: "Go.", generationId });
    const done = frames.at(-1) as Frame & { finishReason: string; message: { content: string } };
    assert.equal(done.type, "done");
    assert.equal(done.finishReason, "user_stopped");
    assert.equal(done.message.content, "Half an");
    const usage = await prisma.usage.findFirst({ where: { userId: user.id } });
    assert.equal(usage?.messageCount, 1, "a stop is not refunded");
  });

  // ── The per-turn trace (BRIEF §47) ───────────────────────────────────────

  test("every turn leaves one redacted trace: run id, model, latency, outcome, spend", async () => {
    const { recentTurnTraces } = await import("@/lib/chat/turn/trace-sink");
    const user = await seedUser();
    const secret = "my bank PIN is 9921";
    script = () => answer("Noted, never repeated.");
    const before = logLines.length;
    const { frames } = await chat({ message: secret });
    const generationId = frames[0].generationId as string;
    const trace = recentTurnTraces().find((t) => t.runId === generationId);
    assert.ok(trace, "the turn's trace was recorded");
    assert.equal(trace.accountId, user.id);
    assert.equal(trace.surface, "saved");
    assert.equal(trace.outcome, "completed");
    assert.equal(trace.finishReason, "stop");
    assert.equal(trace.attempts, 1);
    assert.equal(trace.usage.completionTokens, 12);
    assert.ok(trace.latency.ttftMs !== null && trace.latency.totalMs >= trace.latency.ttftMs);
    assert.ok(trace.requestId?.startsWith("req-"));

    const lines = logLines.slice(before).filter((line) => line.includes('"event":"chat.turn"'));
    assert.equal(lines.length, 1, "one structured log line per turn");
    assert.doesNotMatch(lines[0], /9921|bank PIN|never repeated/, "no message or answer text in the log");
    assert.match(lines[0], new RegExp(generationId));
  });

  test("failures, stops and private turns are traced with their cause", async () => {
    const { recentTurnTraces } = await import("@/lib/chat/turn/trace-sink");
    const user = await seedUser();
    script = async function* () {
      throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
    };
    const limited = await chat({ message: "Hello?" });
    const limitedTrace = recentTurnTraces().find((t) => t.runId === limited.frames[0].generationId);
    assert.equal(limitedTrace?.outcome, "failed");
    assert.equal(limitedTrace?.error?.class, "rate_limit");
    assert.equal(limitedTrace?.error?.retryable, true);

    let generationId = `gen-${randomUUID()}`;
    script = async function* (opts) {
      yield { type: "text", text: "Half" };
      const { cancelGeneration } = await import("@/lib/generation-cancel");
      cancelGeneration(generationId, user.id);
      if (opts.signal?.aborted) throw new DOMException("Stopped by user", "AbortError");
    };
    await chat({ message: "Go.", generationId });
    const stopped = recentTurnTraces().find((t) => t.runId === generationId);
    assert.equal(stopped?.outcome, "partial");
    assert.equal(stopped?.cancellation.userStopped, true);

    generationId = `gen-${randomUUID()}`;
    script = () => answer("Private.");
    await chat({ privateMode: true, message: "psst", privateHistory: [{ role: "USER", content: "psst" }], generationId });
    const privateTrace = recentTurnTraces().find((t) => t.runId === generationId);
    assert.equal(privateTrace?.surface, "private");
    assert.equal(privateTrace?.conversationId, null);
    assert.equal(privateTrace?.outcome, "completed");
  });

  test("a research leg that throws releases the spend hold, refunds, and fails the receipt (was: hold leaked to the sweep)", async () => {
    const user = await seedUser();
    researchThrows = true;
    try {
      script = () => answer("unreachable");
      const calls = streamCalls;
      const { frames } = await chat({
        message: "Research the history of tea.",
        deepResearch: true,
        clientRequestId: `req-${randomUUID()}`,
        clientMessageId: `msg-${randomUUID()}`,
      });
      assert.equal(streamCalls, calls, "synthesis never ran");
      const last = frames.at(-1) as Frame & { receiptState?: string };
      assert.equal(last.type, "error");
      assert.equal(last.receiptState, "failed");
      assert.equal(
        await prisma.spendReservation.count({ where: { userId: user.id, state: "open" } }),
        0,
        "no hold is left open against the account"
      );
      assert.equal((await prisma.usage.findFirst({ where: { userId: user.id } }))?.messageCount, 0);
      const { recentTurnTraces } = await import("@/lib/chat/turn/trace-sink");
      assert.equal(recentTurnTraces().find((t) => t.runId === frames[0].generationId)?.outcome, "failed");
    } finally {
      researchThrows = false;
    }
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound.filter((url) => !url.startsWith("http://127.0.0.1")), []);
  });

  test("disconnect", async () => {
    await prisma.$disconnect();
  });
}
