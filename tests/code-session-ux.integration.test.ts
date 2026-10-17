import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * The Code session UX routes against Postgres, through the real handlers:
 *
 *   - /api/code/prefs: the account's Code defaults that Settings edits
 *     without a session open (G41);
 *   - /api/code/feedback: thumbs on answers in a Mac-hosted session, which has
 *     no Message row to carry them (G39);
 *   - /api/share with a transcript: a Mac-hosted session's link carries its
 *     messages and answers, redacted, and only a Code session's may (G40).
 *
 * Skipped unless CODE_UX_TEST_DATABASE_URL names a throwaway, migrated
 * database (never DATABASE_URL):
 *
 *   CODE_UX_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_codeux_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/code-session-ux.integration.test.ts
 */

const DB_URL = process.env.CODE_UX_TEST_DATABASE_URL;
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!DB_URL || !canMockModules) {
  test("code session UX database suite is skipped without CODE_UX_TEST_DATABASE_URL and module mocks", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "code-ux-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;

  test("stand in for the session", () => {
    mock.module("@/lib/session", {
      namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn },
    });
  });

  const request = (method: string, body?: unknown, url = "http://alevr.test/api") =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signUp(label: string) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `code-ux-${label}-${suffix}@example.invalid`, name: "Code owner", emailVerified: new Date() },
    });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  test("Code defaults: read, patched, cleared, refused when wrong, per account", async () => {
    const route = await import("@/app/api/code/prefs/route");
    const owner = await signUp("prefs");
    let res = await route.GET();
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).prefs, {}, "no Settings row yet: the built-in defaults");

    res = await route.PATCH(request("PATCH", { runtimeMode: "ask", detailLevel: "steps", team: { preset: "best-of-n", maxUsd: 5 } }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual((await res.json()).prefs, { runtimeMode: "ask", detailLevel: "steps", team: { preset: "best-of-n", maxUsd: 5 } });

    res = await route.PATCH(request("PATCH", { detailLevel: null }));
    assert.deepEqual((await res.json()).prefs, { runtimeMode: "ask", team: { preset: "best-of-n", maxUsd: 5 } }, "null goes back to the built-in default");

    res = await route.PATCH(request("PATCH", { runtimeMode: "yolo" }));
    assert.equal(res.status, 400);
    res = await route.PATCH(request("PATCH", { theme: "dark" }));
    assert.equal(res.status, 400, "only Code defaults go through this route");

    const stored = await prisma.settings.findUniqueOrThrow({ where: { userId: owner.id }, select: { codePrefs: true } });
    assert.deepEqual(stored.codePrefs, { runtimeMode: "ask", team: { preset: "best-of-n", maxUsd: 5 } });

    await signUp("prefs-other");
    res = await route.GET();
    assert.deepEqual((await res.json()).prefs, {}, "another account sees its own");
    signedIn = null;
    assert.equal((await route.GET()).status, 401);
  });

  test("answer feedback on a Mac-hosted session: set, changed, cleared, owner-only, Code only", async () => {
    const route = await import("@/app/api/code/feedback/route");
    const owner = await signUp("feedback");
    const code = await prisma.conversation.create({ data: { userId: owner.id, kind: "code", title: "Cart" } });
    const chat = await prisma.conversation.create({ data: { userId: owner.id, title: "A chat" } });
    const get = async () => (await (await route.GET(request("GET", undefined, `http://alevr.test/api/code/feedback?conversationId=${code.id}`))).json()).feedback;

    let res = await route.PUT(request("PUT", { conversationId: code.id, turnKey: "turn-1", feedback: "UP", model: "alevr-code" }));
    assert.equal(res.status, 200, await res.clone().text());
    res = await route.PUT(request("PUT", { conversationId: code.id, turnKey: "turn-2", feedback: "DOWN" }));
    assert.deepEqual(await get(), { "turn-1": "UP", "turn-2": "DOWN" });
    await route.PUT(request("PUT", { conversationId: code.id, turnKey: "turn-1", feedback: "DOWN" }));
    await route.PUT(request("PUT", { conversationId: code.id, turnKey: "turn-2", feedback: null }));
    assert.deepEqual(await get(), { "turn-1": "DOWN" }, "changed in place, cleared by null");
    const row = await prisma.codeTurnFeedback.findFirstOrThrow({ where: { conversationId: code.id, turnKey: "turn-1" } });
    assert.equal(row.model, "alevr-code", "the model is kept from the first verdict");

    assert.equal((await route.PUT(request("PUT", { conversationId: chat.id, turnKey: "t", feedback: "UP" }))).status, 404, "a chat's answers use the message route");
    assert.equal((await route.PUT(request("PUT", { conversationId: code.id, turnKey: "", feedback: "UP" }))).status, 400);

    await signUp("feedback-intruder");
    assert.equal((await route.PUT(request("PUT", { conversationId: code.id, turnKey: "turn-1", feedback: "UP" }))).status, 404, "another account cannot vote");
    assert.deepEqual(await get(), {}, "nor read the votes");
  });

  test("sharing a Mac-hosted session: its transcript, redacted, refreshed in place; only a Code session may send one", async () => {
    const route = await import("@/app/api/share/route");
    const { getPublicShare, getSharedChatSnapshot } = await import("@/lib/share");
    const owner = await signUp("share");
    const code = await prisma.conversation.create({ data: { userId: owner.id, kind: "code", title: "Round the total" } });
    const chat = await prisma.conversation.create({ data: { userId: owner.id, title: "A chat" } });
    const key = `sk-ant-${"b".repeat(32)}`;

    // From the sidebar, where the session is not open: nothing on the server to show.
    let res = await route.POST(request("POST", { kind: "CHAT", conversationId: code.id }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "transcript_invalid");

    res = await route.POST(
      request("POST", {
        kind: "CHAT",
        conversationId: code.id,
        transcript: [
          { role: "user", content: `Round the cart total. My key is ${key}` },
          { role: "assistant", content: "Rounded to cents." },
        ],
      }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    const { share } = (await res.json()) as { share: { token: string } };
    const stored = await prisma.share.findUniqueOrThrow({ where: { token: share.token } });
    assert.ok(stored.transcript && typeof stored.transcript === "object" && "enc" in stored.transcript, "sealed at rest");
    assert.ok(!JSON.stringify(stored.transcript).includes("Round the cart"), "no plaintext in the row");

    const pub = await getPublicShare(share.token);
    assert.ok(pub);
    const snapshot = await getSharedChatSnapshot(pub!);
    assert.equal(snapshot?.fromDevice, true);
    assert.deepEqual(snapshot?.messages.map((m) => m.role), ["USER", "ASSISTANT"]);
    assert.ok(!snapshot?.messages[0].content.includes(key), "the key never reaches the public page");

    // Sharing again refreshes what the same link shows.
    res = await route.POST(request("POST", { kind: "CHAT", conversationId: code.id, transcript: [{ role: "user", content: "Round it again" }] }));
    assert.equal(((await res.json()) as { share: { token: string } }).share.token, share.token, "the link people have stays the link");
    const again = await getSharedChatSnapshot((await getPublicShare(share.token))!);
    assert.deepEqual(again?.messages.map((m) => m.content), ["Round it again"]);

    // A chat's link is built from its own messages: a client cannot put words on it.
    res = await route.POST(request("POST", { kind: "CHAT", conversationId: chat.id, transcript: [{ role: "user", content: "made up" }] }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "transcript_invalid");
    res = await route.POST(request("POST", { kind: "CHAT", conversationId: code.id, transcript: [{ role: "assistant", content: "only an answer" }] }));
    assert.equal(res.status, 400, "nothing the person said, nothing to share");
  });

  test("disconnect", async () => {
    await prisma.$disconnect();
    const { prisma: appPrisma } = await import("@/lib/prisma");
    await appPrisma.$disconnect();
  });
}
