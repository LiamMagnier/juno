import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/**
 * A Code turn through the real provider proxy and the real reporter route,
 * against real PostgreSQL, with the provider stubbed. Pins that a Mac Code
 * turn is admitted like a chat turn and lands on the month's counter exactly
 * once — not per call, not per retry, not again from the reporter route.
 *
 *   CODE_TURN_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_test \
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *   tests/code-turn-metering-db.test.ts
 */
const DB_URL = process.env.CODE_TURN_TEST_DATABASE_URL;

if (!DB_URL) {
  test("code turn metering database suite requires CODE_TURN_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(DB_URL).hostname)) throw new Error("loopback only");
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "code-turn-local-test";
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  delete process.env.OWNER_EMAILS;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string } | null = null;
  mock.module("@/lib/session", {
    namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
  });

  const sse = (events: Array<[string, unknown]>) =>
    events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  const STREAM = sse([
    [
      "message_start",
      {
        type: "message_start",
        message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 40, output_tokens: 1 } },
      },
    ],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 12 } }],
    ["message_stop", { type: "message_stop" }],
  ]);

  /** What the stubbed provider answers next, and how many times it was called. */
  let providerStatus = 200;
  let providerCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://api.anthropic.com/")) return realFetch(input, init);
    providerCalls += 1;
    if (providerStatus !== 200) {
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
        status: providerStatus,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(STREAM, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;

  const opening = (text: string, history: unknown[] = []) => ({
    model: "claude-opus-5-5",
    max_tokens: 4096,
    stream: true,
    messages: [...history, { role: "user", content: text }],
  });
  const continuation = {
    model: "claude-opus-5-5",
    max_tokens: 4096,
    stream: true,
    messages: [
      { role: "user", content: "Fix the test" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export {}" }] },
    ],
  };

  async function call(body: unknown): Promise<Response> {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/agent/[...path]/route");
    const req = new NextRequest("http://localhost/api/agent/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await POST(req, { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) });
    await res.text();
    return res;
  }

  async function usage(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/agent/usage/route");
    const res = await POST(
      new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  /** The ledger writes run after the last byte; wait for them to land. */
  async function settled(userId: string, spendRows: number): Promise<number> {
    for (let i = 0; i < 100; i += 1) {
      const rows = await prisma.apiSpend.count({ where: { userId, kind: "code" } });
      if (rows >= spendRows) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The count is written beside the spend row; give it the same chance.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const row = await prisma.usage.findFirst({ where: { userId }, orderBy: { period: "desc" } });
    return row?.messageCount ?? 0;
  }

  async function account(verified: boolean) {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `code-turn-${suffix}@example.invalid`,
        emailVerified: verified ? new Date() : null,
        subscription: { create: { plan: "PRO", status: "ACTIVE" } },
      },
    });
    return user;
  }

  test("a Code turn is counted once: not per call, not per retry, not by the reporter route", async (t) => {
    const user = await account(true);
    t.after(async () => {
      await prisma.rateLimit.deleteMany({ where: { key: { contains: user.id } } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    signedIn = { id: user.id, email: user.email! };

    // The reporter route's start admits and opens a handle, and counts nothing.
    const started = await usage("/api/agent/usage", { phase: "start" });
    assert.equal(started.status, 200);
    assert.equal(typeof started.json.reservationId, "string");
    assert.equal(await settled(user.id, 0), 0, "start does not move the counter");

    // The turn's opening call: billed and counted.
    assert.equal((await call(opening("Fix the test"))).status, 200);
    assert.equal(await settled(user.id, 1), 1);

    // The engine retries the same opening: billed again, not counted again.
    assert.equal((await call(opening("Fix the test"))).status, 200);
    assert.equal(await settled(user.id, 2), 1);

    // The loop answering a tool: billed, the same turn.
    assert.equal((await call(continuation)).status, 200);
    assert.equal(await settled(user.id, 3), 1);

    // The reporter's refund gives nothing back, because nothing was taken.
    const refunded = await usage("/api/agent/usage", { phase: "refund", reservationId: started.json.reservationId });
    assert.equal(refunded.status, 200);
    assert.equal(await settled(user.id, 3), 1);

    // The next thing the person says opens a new turn.
    const history = [
      { role: "user", content: "Fix the test" },
      { role: "assistant", content: "Done." },
    ];
    assert.equal((await call(opening("Now run the linter", history))).status, 200);
    assert.equal(await settled(user.id, 4), 2);

    // Every call was billed: the counter never stood in for the spend.
    assert.equal(await prisma.apiSpend.count({ where: { userId: user.id, kind: "code" } }), 4);
  });

  test("an opening the provider refused is not counted", async (t) => {
    const user = await account(true);
    t.after(async () => {
      providerStatus = 200;
      await prisma.rateLimit.deleteMany({ where: { key: { contains: user.id } } });
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    signedIn = { id: user.id, email: user.email! };
    providerStatus = 529;
    assert.equal((await call(opening("Write the migration"))).status, 529);
    assert.equal(await settled(user.id, 0), 0);
    // The engine's retry succeeds: counted then, once.
    providerStatus = 200;
    assert.equal((await call(opening("Write the migration"))).status, 200);
    assert.equal(await settled(user.id, 1), 1);
  });

  test("an unconfirmed address is refused before the provider is called, at both doors", async (t) => {
    const user = await account(false);
    t.after(async () => {
      await prisma.user.deleteMany({ where: { id: user.id } });
    });
    signedIn = { id: user.id, email: user.email! };
    const before = providerCalls;
    const res = await (async () => {
      const { NextRequest } = await import("next/server");
      const { POST } = await import("@/app/api/agent/[...path]/route");
      return POST(
        new NextRequest("http://localhost/api/agent/anthropic/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opening("Deploy it")),
        }),
        { params: Promise.resolve({ path: ["anthropic", "v1", "messages"] }) },
      );
    })();
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { code?: string }).code, "EMAIL_UNVERIFIED");
    assert.equal(providerCalls, before, "the provider was never called");

    const started = await usage("/api/agent/usage", { phase: "start" });
    assert.equal(started.status, 402);
    assert.equal(started.json.code, "EMAIL_UNVERIFIED");
    assert.equal(await prisma.codeUsageReservation.count({ where: { userId: user.id } }), 0);
  });

  test.after(async () => {
    globalThis.fetch = realFetch;
    await prisma.$disconnect();
  });
}
