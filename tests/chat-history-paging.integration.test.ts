import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * PAGED CHAT HISTORY, THROUGH THE REAL ROUTES AGAINST POSTGRES (Workstream I).
 *
 * What runs for real: GET /api/conversations/[id] (whole, and `?limit=`),
 * GET /api/conversations/[id]/messages (the cursor pager), the queries behind
 * /chat/[id], message encryption at rest and the serializers. Stand-in: the
 * signed-in session.
 *
 * Covers: the native apps' contract (no parameters → the whole thread, no
 * `history` key), walking every cursor returns each message exactly once in
 * order with its attachments, pages start on a question, `through` and `all`,
 * the ?m= widening of the first page, brotli and gzip when offered, owner
 * scoping (another account's conversation and cursor are a 404), bodies stay
 * ciphertext in the database, and malformed parameters are refused.
 *
 * Skipped unless HISTORY_TEST_DATABASE_URL names a throwaway, migrated database:
 *   HISTORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_paging_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/chat-history-paging.integration.test.ts
 */

const DB_URL = process.env.HISTORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("paged history suite is skipped without HISTORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "history-paging-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });

  type Wire = { id: string; role: string; content: string; createdAt: string; attachments: Array<{ fileName: string; url: string }> };
  type HistoryBody = { messages: Wire[]; history: { hasOlder: boolean; olderCursor: string | null } };
  const COUNT = 523;
  const tag = randomUUID().slice(0, 8);
  let alice: { id: string; email: string; name: string };
  let mallory: { id: string; email: string; name: string };
  let conversationId = "";
  let ordered: string[] = [];

  const get = (url: string) => new Request(`http://juno.test${url}`);
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  async function thread(url: string, id = conversationId) {
    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.GET(get(url), params(id));
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  }
  async function history(query: string, id = conversationId) {
    const route = await import("@/app/api/conversations/[id]/messages/route");
    const res = await route.GET(get(`/api/conversations/${id}/messages${query}`), params(id));
    return { status: res.status, body: (res.status === 200 ? await res.json() : null) as HistoryBody | null };
  }

  test("seed a long encrypted conversation with files, and a second account", async () => {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const make = (name: string) => prisma.user.create({ data: { email: `${name}-${tag}@history.test`, name } });
    const a = await make("alice");
    const m = await make("mallory");
    alice = { id: a.id, email: a.email!, name: "alice" };
    mallory = { id: m.id, email: m.email!, name: "mallory" };
    const conversation = await prisma.conversation.create({ data: { userId: a.id, title: "Long" } });
    conversationId = conversation.id;
    const start = Date.UTC(2026, 5, 1);
    // Every fourth pair shares one millisecond: a cursor on createdAt alone would skip or repeat them.
    await prisma.message.createMany({
      data: Array.from({ length: COUNT }, (_, i) => ({
        conversationId,
        role: i % 2 ? ("ASSISTANT" as const) : ("USER" as const),
        content: encryptMessageText(`plaintext-${i} body`),
        createdAt: new Date(start + (i % 8 < 2 ? Math.floor(i / 8) * 8 : i) * 1000),
      })),
    });
    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, content: true } });
    ordered = rows.map((r) => r.id);
    await prisma.attachment.create({
      data: { userId: a.id, conversationId, messageId: ordered[20], kind: "FILE", fileName: "notes.pdf", mimeType: "application/pdf", size: 10, storageKey: `k/${tag}`, extractedText: "secret extracted text" },
    });
    assert.equal(rows.length, COUNT);
    assert.ok(rows.every((r) => !r.content.includes("plaintext-")), "bodies are ciphertext at rest");
  });

  test("without parameters the thread is whole: the Mac and iPhone contract", async () => {
    signedIn = alice;
    const { status, body } = await thread(`/api/conversations/${conversationId}`);
    assert.equal(status, 200);
    assert.equal(body.messages.length, COUNT);
    assert.equal("history" in body, false);
    assert.deepEqual(body.messages.map((m: Wire) => m.id), ordered);
    assert.ok(Array.isArray(body.artifacts));
  });

  test("?limit= answers the newest page and a cursor for the rest", async () => {
    signedIn = alice;
    const { status, body } = await thread(`/api/conversations/${conversationId}?limit=40`);
    assert.equal(status, 200);
    assert.ok(body.messages.length >= 40 && body.messages.length <= 48);
    assert.equal(body.messages.at(-1).id, ordered.at(-1));
    assert.equal(body.messages[0].role, "USER");
    assert.equal(body.history.hasOlder, true);
    assert.equal(typeof body.history.olderCursor, "string");
    for (const bad of ["0", "501", "abc", "1.5"]) assert.equal((await thread(`/api/conversations/${conversationId}?limit=${bad}`)).status, 400, bad);
  });

  test("walking the cursor returns every message once, in order, decrypted, with its files", async () => {
    signedIn = alice;
    const { getConversationThreadPage } = await import("@/lib/queries");
    const first = (await getConversationThreadPage(alice.id, conversationId))!;
    const seen = first.messages.map((m) => m.id);
    let cursor = first.history.olderCursor;
    let pages = 1;
    while (cursor) {
      const { status, body } = await history(`?before=${encodeURIComponent(cursor)}&limit=100`);
      assert.equal(status, 200);
      assert.ok(body!.messages.length > 0);
      if (body!.history.hasOlder) assert.equal(body!.messages[0].role, "USER", "a page never opens on a reply");
      seen.unshift(...body!.messages.map((m) => m.id));
      cursor = body!.history.olderCursor;
      pages++;
    }
    assert.deepEqual(seen, ordered);
    assert.ok(pages >= 5);
    const whole = (await thread(`/api/conversations/${conversationId}`)).body;
    const withFile = whole.messages.find((m: Wire) => m.id === ordered[20]);
    assert.equal(withFile.content, "plaintext-20 body");
    assert.equal(withFile.attachments[0].fileName, "notes.pdf");
    assert.equal(JSON.stringify(whole).includes("secret extracted text"), false);
  });

  test("`through` reaches a message far above, and `all` returns the rest", async () => {
    signedIn = alice;
    const { getConversationThreadPage } = await import("@/lib/queries");
    const first = (await getConversationThreadPage(alice.id, conversationId))!;
    const before = encodeURIComponent(first.history.olderCursor!);
    const through = await history(`?before=${before}&through=${ordered[30]}`);
    assert.ok(through.body!.messages.some((m) => m.id === ordered[30]));
    assert.ok(through.body!.messages.some((m) => m.id === ordered[25]), "a little context above the target");
    assert.equal(through.body!.messages.at(-1)!.id, ordered[ordered.indexOf(first.messages[0].id) - 1], "contiguous with what is held");
    const rest = await history(`?before=${before}&all=1`);
    assert.deepEqual([...rest.body!.messages, ...first.messages].map((m) => m.id), ordered);
    assert.deepEqual(rest.body!.history, { hasOlder: false, olderCursor: null });
  });

  test("both routes compress for a client that offers it, and decode to the same JSON", async () => {
    signedIn = alice;
    const { brotliDecompressSync, gunzipSync } = await import("node:zlib");
    const threadRoute = await import("@/app/api/conversations/[id]/route");
    const historyRoute = await import("@/app/api/conversations/[id]/messages/route");
    const offered = (url: string, encoding: string) => new Request(`http://juno.test${url}`, { headers: { "accept-encoding": encoding } });
    const plainThread = (await thread(`/api/conversations/${conversationId}`)).body;
    const plainRest = (await history("?all=1")).body;
    for (const [encoding, decode] of [["gzip, deflate, br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
      const whole = await threadRoute.GET(offered(`/api/conversations/${conversationId}`, encoding), params(conversationId));
      assert.equal(whole.headers.get("content-encoding"), encoding === "gzip" ? "gzip" : "br");
      assert.match(whole.headers.get("vary") ?? "", /Accept-Encoding/);
      assert.deepEqual(JSON.parse(decode(Buffer.from(await whole.arrayBuffer())).toString("utf8")), plainThread);
      const rest = await historyRoute.GET(offered(`/api/conversations/${conversationId}/messages?all=1`, encoding), params(conversationId));
      assert.equal(rest.headers.get("content-encoding"), encoding === "gzip" ? "gzip" : "br");
      assert.deepEqual(JSON.parse(decode(Buffer.from(await rest.arrayBuffer())).toString("utf8")), plainRest);
    }
  });

  test("a ?m= deep link widens the first page back to its message", async () => {
    const { getConversationThreadPage } = await import("@/lib/queries");
    const page = (await getConversationThreadPage(alice.id, conversationId, { focusMessageId: ordered[100] }))!;
    assert.ok(page.messages.some((m) => m.id === ordered[100]));
    assert.equal(page.messages.at(-1)!.id, ordered.at(-1));
    assert.equal(page.history.hasOlder, true);
    // Someone else's message id changes nothing.
    const plain = (await getConversationThreadPage(alice.id, conversationId, { focusMessageId: "cmnotamessage00000000000" }))!;
    assert.ok(plain.messages.length < 70);
  });

  test("another account sees nothing: not the thread, not a page, not with a valid cursor", async () => {
    signedIn = alice;
    const { getConversationThreadPage } = await import("@/lib/queries");
    const cursor = encodeURIComponent((await getConversationThreadPage(alice.id, conversationId))!.history.olderCursor!);
    signedIn = mallory;
    assert.equal((await thread(`/api/conversations/${conversationId}`)).status, 404);
    assert.equal((await thread(`/api/conversations/${conversationId}?limit=10`)).status, 404);
    assert.equal((await history(`?before=${cursor}`)).status, 404);
    assert.equal((await history(`?all=1`)).status, 404);
    assert.equal(await getConversationThreadPage(mallory.id, conversationId), null);
    signedIn = null;
    assert.equal((await history(`?before=${cursor}`)).status, 401);
  });

  test("malformed parameters are refused", async () => {
    signedIn = alice;
    for (const query of ["?before=not-a-cursor", "?limit=0", "?limit=501", "?limit=x", "?through=bad%20id", `?before=${Buffer.from("2026-01-01T00:00:00.000Z|x';--").toString("base64url")}`]) {
      assert.equal((await history(query)).status, 400, query);
    }
  });

  test("clean up", async () => {
    await prisma.attachment.deleteMany({ where: { conversationId } });
    await prisma.conversation.deleteMany({ where: { userId: { in: [alice.id, mallory.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, mallory.id] } } });
    await prisma.$disconnect();
  });
}
