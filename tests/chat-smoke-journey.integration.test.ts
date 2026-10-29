import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { parseTestEnv } from "../scripts/qa/lib/safe-env.mjs";

/*
 * THE BROWSER JOURNEY'S SERVER HALF, WITHOUT A BROWSER (ledger P1-5).
 *
 * The e2e journey (e2e/journey, e2e/chat.spec.ts, e2e/regenerate.spec.ts)
 * runs on the QA runner's production build with the deterministic smoke
 * provider standing in for a model. This drives the same server path through
 * POST /api/chat and POST /api/chat/cancel in the same configuration — a
 * production NODE_ENV, the runner's flag, its disposable database, and
 * scripts/qa/test.env's environment — so a break in it is a precise unit
 * failure here rather than a timeout in a browser:
 *
 *   - streaming: the turn answers with the token and is persisted;
 *   - artifacts: the artifact block becomes a stored MARKDOWN artifact;
 *   - Stop: the cancel endpoint stops the slow stream mid-answer, the turn
 *     ends user_stopped and the partial answer is the stored one;
 *   - Auto with no eligible model still answers under the smoke provider;
 *   - MCP add: a token server is saved through POST /api/mcp/servers with its
 *     secret encrypted and never echoed, and an unreachable sign-in server is
 *     refused by the probe in words;
 *   - without the runner's flag the gate stays shut in production: no smoke
 *     answer, the honest "no eligible model" refusal.
 *
 * What runs for real: the route, admission, the smoke gate, model selection,
 * the durable receipt, message and artifact writes, the SSE sender, the cancel
 * registry. Stand-ins: the signed-in session and `after()`. A fetch tripwire
 * records every outbound call; only the runner's own loopback may appear.
 *
 * Skipped unless SMOKE_JOURNEY_TEST_DATABASE_URL names the QA runner's kind
 * of disposable, migrated database:
 *   SMOKE_JOURNEY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/alevr_smoke_journey_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-smoke-journey.integration.test.ts
 */

const DB_URL = process.env.SMOKE_JOURNEY_TEST_DATABASE_URL;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (!DB_URL) {
  test("smoke journey suite is skipped without SMOKE_JOURNEY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  assert.match(DB_URL, /^postgresql:\/\/postgres@127\.0\.0\.1:55439\/[a-z][a-z0-9_]*_test$/, "only the QA runner's kind of disposable database");

  // The server environment the runner gives `next start`: test.env's fake
  // values, the disposable database, the smoke opt-in and the runner flag.
  const testEnv = parseTestEnv(readFileSync(path.join(ROOT, "scripts", "qa", "test.env"), "utf8")) as Record<string, string>;
  Object.assign(process.env, testEnv);
  delete process.env.DATA_ENCRYPTION_KEY;
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.JUNO_E2E_SMOKE_PROVIDER = "1";
  process.env.ALEVR_QA_RUNNER = "1";

  const env = process.env as Record<string, string | undefined>;
  /** Runs `fn` as a production process, as `next start` is. */
  async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      return await fn();
    } finally {
      env.NODE_ENV = previous;
    }
  }

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });
  const afterQueue: Array<() => unknown> = [];
  const outbound: string[] = [];

  test("stand in for the session and after(); trip on any outbound call", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      outbound.push(url);
      throw new Error(`unexpected network call to ${url}`);
    };
    const server = await import("next/server");
    mock.module("next/server", {
      namedExports: { ...server, after: (fn: () => unknown) => void afterQueue.push(fn) },
    });
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

  const chatRequest = (body: unknown) =>
    new Request("http://127.0.0.1/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-juno-request-id": `req-${randomUUID()}` },
      body: JSON.stringify(body),
    });

  async function chat(body: unknown) {
    return asProduction(async () => {
      const route = await import("@/app/api/chat/route");
      const res = await route.POST(chatRequest(body));
      const text = await res.text();
      await drainAfter();
      return { status: res.status, text, frames: res.headers.get("content-type")?.includes("event-stream") ? parseFrames(text) : [] };
    });
  }

  async function seedUser() {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({ data: { email: `journey-${suffix}@example.invalid`, name: "Journey", emailVerified: new Date() } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  type Done = Frame & { finishReason: string; message: { id: string; content: string } };
  const doneOf = (frames: Frame[]) => {
    const done = frames.at(-1) as Done | undefined;
    assert.equal(done?.type, "done", `the turn ends with a done frame (got ${frames.map((f) => f.type).join(", ")})`);
    return done!;
  };

  test("streaming: the smoke provider answers a production turn and the answer is stored", async () => {
    await seedUser();
    const { status, text, frames } = await chat({ message: "Healthy probe: reply with JUNO_HEALTHY_CHAT_OK.", model: "qwen:qwen3.8-flash" });
    assert.equal(status, 200, text);
    const done = doneOf(frames);
    assert.equal(done.finishReason, "stop");
    assert.equal(done.message.content, "JUNO_HEALTHY_CHAT_OK");
    const conversationId = frames[0].conversationId as string;
    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(rows.map((row) => row.role), ["USER", "ASSISTANT"]);
    assert.equal(rows[1].id, done.message.id);
  });

  test("artifacts: the artifact block becomes this conversation's stored MARKDOWN artifact", async () => {
    const user = await seedUser();
    const { SMOKE_ARTIFACT_TITLE, SMOKE_ARTIFACT_TOKEN, SMOKE_ARTIFACT_BODY } = await import("@/lib/chat/turn/model-streams");
    const { status, text, frames } = await chat({ message: "Write a short note. JUNO_E2E_ARTIFACT", model: "qwen:qwen3.8-flash" });
    assert.equal(status, 200, text);
    const done = doneOf(frames);
    assert.equal(done.finishReason, "stop");
    assert.match(done.message.content, new RegExp(SMOKE_ARTIFACT_TOKEN));
    const conversationId = frames[0].conversationId as string;
    const artifacts = await prisma.artifact.findMany({ where: { conversationId, userId: user.id } });
    assert.equal(artifacts.length, 1, "one artifact for the one block");
    assert.equal(artifacts[0].title, SMOKE_ARTIFACT_TITLE);
    assert.equal(artifacts[0].type, "MARKDOWN");
    const version = await prisma.artifactVersion.findFirst({ where: { artifactId: artifacts[0].id }, orderBy: { version: "desc" } });
    assert.match(version?.content ?? "", new RegExp(SMOKE_ARTIFACT_BODY));
  });

  test("Stop: the cancel endpoint stops the slow stream mid-answer and the partial answer is stored", async () => {
    const user = await seedUser();
    const { SMOKE_SLOW_END, SMOKE_SLOW_START } = await import("@/lib/chat/turn/model-streams");
    // The id Stop names is the one the meta frame announces, as the browser
    // reads it (a durable submission gets its id from its receipt).
    let generationId = "";
    const frames: Frame[] = [];
    let cancelAnswer: unknown = null;
    const started = Date.now();
    await asProduction(async () => {
      const route = await import("@/app/api/chat/route");
      const cancelRoute = await import("@/app/api/chat/cancel/route");
      // A durable first submission, as the web client sends one, so the
      // receipt records how the turn ended.
      const res = await route.POST(
        chatRequest({
          message: "Write at length. JUNO_E2E_SLOW_STREAM",
          model: "qwen:qwen3.8-flash",
          clientRequestId: `req-${randomUUID()}`,
          clientMessageId: `msg-${randomUUID()}`,
        })
      );
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamed = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const frame of parseFrames(lines.join("\n"))) {
          frames.push(frame);
          if (frame.type === "meta" && typeof frame.generationId === "string") generationId = frame.generationId;
          if (frame.type === "delta") streamed += String(frame.text ?? "");
        }
        if (cancelAnswer === null && generationId && /word3 /.test(streamed)) {
          const answer = await cancelRoute.POST(
            new Request("http://127.0.0.1/api/chat/cancel", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ generationId }),
            })
          );
          cancelAnswer = await answer.json();
        }
      }
      if (buffer.trim()) frames.push(...parseFrames(buffer));
      await drainAfter();
    });
    assert.deepEqual(cancelAnswer, { ok: true, cancelled: true, delivery: "local" }, "Stop reached the running generation");
    assert.ok(Date.now() - started < 20_000, "the stream ended at Stop, not at the end of its 45 seconds");
    const done = doneOf(frames);
    assert.equal(done.finishReason, "user_stopped");
    assert.ok(done.message.content.startsWith(SMOKE_SLOW_START), done.message.content);
    assert.ok(!done.message.content.includes(SMOKE_SLOW_END), "a stopped answer never reaches its end");
    const stored = await prisma.message.findUnique({ where: { id: done.message.id } });
    assert.ok(stored, "the partial answer was saved as a message");
    const receipt = await prisma.chatFirstSubmissionReceipt.findUnique({ where: { generationId } });
    assert.equal(receipt?.finishReason, "user_stopped", "the durable receipt records a Stop");
    assert.equal(receipt?.assistantMessageId, done.message.id);
    const { decryptMessageText } = await import("@/lib/message-crypto");
    assert.equal(decryptMessageText(stored!.content), done.message.content, "the partial answer is the stored one");
    const usage = await prisma.usage.findFirst({ where: { userId: user.id } });
    assert.equal(usage?.messageCount, 1, "a Stop is charged like any answer");
  });

  test("Auto with no eligible model still answers under the smoke provider, as the default model", async () => {
    await seedUser();
    const { DEFAULT_MODEL } = await import("@/lib/models");
    const key = env.DASHSCOPE_API_KEY;
    delete env.DASHSCOPE_API_KEY; // no configured provider at all: Auto has no candidate
    try {
      const { status, text, frames } = await chat({ message: "Auto probe: JUNO_AUTO_SMOKE_OK", model: "juno:auto" });
      assert.equal(status, 200, text);
      const done = doneOf(frames);
      assert.equal(done.message.content, "JUNO_AUTO_SMOKE_OK");
      const stored = await prisma.message.findUnique({ where: { id: done.message.id } });
      assert.equal(stored?.model, DEFAULT_MODEL);
    } finally {
      env.DASHSCOPE_API_KEY = key;
    }
  });

  test("without the runner's flag the gate stays shut in production: no smoke answer", async () => {
    await seedUser();
    const key = env.DASHSCOPE_API_KEY;
    delete env.DASHSCOPE_API_KEY;
    delete env.ALEVR_QA_RUNNER;
    try {
      const { status, text } = await chat({ message: "Gate probe: JUNO_GATE_SHOULD_NOT_ANSWER", model: "juno:auto" });
      assert.equal(status, 503, text);
      assert.equal((JSON.parse(text) as { code?: string }).code, "AUTO_NO_ELIGIBLE_MODEL");
      assert.doesNotMatch(text, /JUNO_GATE_SHOULD_NOT_ANSWER/);
    } finally {
      env.DASHSCOPE_API_KEY = key;
      env.ALEVR_QA_RUNNER = "1";
    }
  });

  test("MCP add: a token server to an unreachable host is saved honestly and never echoes its secret", async () => {
    const user = await seedUser();
    const secret = "Bearer journey-fixture-not-a-real-token";
    const url = "https://journey-tools.invalid/mcp";
    const result = await asProduction(async () => {
      const route = await import("@/app/api/mcp/servers/route");
      const res = await route.POST(
        new Request("http://127.0.0.1/api/mcp/servers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Journey tools", url, authHeader: secret }),
        })
      );
      return { status: res.status, text: await res.text() };
    });
    assert.equal(result.status, 201, result.text);
    assert.doesNotMatch(result.text, /journey-fixture-not-a-real-token/, "the secret is never sent back");
    const { server } = JSON.parse(result.text) as { server: Record<string, unknown> };
    assert.equal(server.name, "Journey tools");
    assert.equal(server.hasAuthHeader, true);
    assert.equal(server.status, "error", "an unreachable server is never marked ok");
    const row = await prisma.userMcpServer.findFirst({ where: { userId: user.id, name: "Journey tools" } });
    assert.ok(row?.authHeader, "the header is stored");
    assert.notEqual(row!.authHeader, secret, "and stored encrypted, not as typed");
  });

  test("MCP add: the sign-in probe refuses an unreachable server in words", async () => {
    await seedUser();
    const verdict = await asProduction(async () => {
      const route = await import("@/app/api/connectors/custom/probe/route");
      const res = await route.POST(
        new Request("http://127.0.0.1/api/connectors/custom/probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: "https://journey-tools.invalid/mcp" }),
        })
      );
      return (await res.json()) as { ok?: boolean; message?: string };
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.message && verdict.message.length > 10, `a refusal in words (got ${JSON.stringify(verdict)})`);
  });

  test("nothing left the runner", async () => {
    await drainAfter();
    for (const url of outbound) assert.equal(new URL(url).hostname, "127.0.0.1", `outbound call to ${url}`);
    await prisma.$disconnect();
  });
}
