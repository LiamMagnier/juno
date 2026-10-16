import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
// Next's react-server build of next/navigation, which the bundler swaps in for
// server components (see tests/artifact-routes.test.ts): the redirect and 404
// errors the pages throw are Next's own.
import * as serverNavigation from "next/dist/client/components/navigation.react-server";
import * as React from "react";

// The pages are compiled with the classic JSX runtime here (React in scope); tsx does not inject it.
(globalThis as unknown as { React: typeof React }).React = React;

/*
 * PAGED HISTORY ON THE CODE SURFACES, THROUGH THE REAL PAGES AGAINST POSTGRES.
 *
 * What runs for real: the /code/[id] page (the v2 workspace) and the legacy
 * Code branch of /chat/[id] (?surface=legacy) as Server Components, the
 * queries behind them, GET /api/conversations/[id]/messages (the pager both
 * surfaces scroll back through), GET /api/conversations/[id] (the native
 * apps' whole-thread read), message encryption and the serializers.
 * Stand-ins: the signed-in session, and the client components the pages hand
 * their props to, so the test reads exactly what each page sends the browser.
 *
 * Covers: both Code surfaces open on the newest page with a cursor, not the
 * whole thread; walking that cursor returns every message once, in order; a
 * short session arrives whole with nothing older; the v2 redirect still
 * applies without ?surface=legacy; another account's session is a 404; and
 * the native read of the same Code session is still whole.
 *
 * Skipped unless HISTORY_TEST_DATABASE_URL names a throwaway, migrated database:
 *   HISTORY_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55439/juno_paging_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/code-history-paging.integration.test.ts
 */

const DB_URL = process.env.HISTORY_TEST_DATABASE_URL;

if (!DB_URL) {
  test("code paged history suite is skipped without HISTORY_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "code-history-paging-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("next/navigation", { namedExports: { ...serverNavigation } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn, requireUser: async () => signedIn } });
  // The client halves of both surfaces: what the page passes them is the subject.
  const CodeV2Client = () => null;
  const CodeSessionViewLazy = () => null;
  const ChatView = () => null;
  mock.module("@/app/(app)/code/[id]/client", { namedExports: { CodeV2Client } });
  mock.module("@/components/code/code-session-view-lazy", { namedExports: { CodeSessionViewLazy } });
  mock.module("@/components/chat/chat-view", { namedExports: { ChatView } });
  mock.module("@/lib/agents/store", { namedExports: { agentForThread: async () => null, pendingAgentStarter: async () => null } });
  mock.module("@/lib/agents/room-store", { namedExports: { loadRoomDetail: async () => null } });

  type Wire = { id: string; role: string; content: string; createdAt: string };
  type History = { hasOlder: boolean; olderCursor: string | null };
  type Element = { type: unknown; props: { initialMessages: Wire[]; initialHistory?: History; initialArtifacts?: unknown[]; conversation: { id: string } } };
  const COUNT = 301;
  const tag = randomUUID().slice(0, 8);
  let owner: { id: string; email: string; name: string };
  let stranger: { id: string; email: string; name: string };
  let longId = "";
  let shortId = "";
  let ordered: string[] = [];
  let shortOrdered: string[] = [];

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  async function codePage(id: string) {
    const page = await import("@/app/(app)/code/[id]/page");
    return (await page.default(params(id))) as unknown as Element;
  }
  async function chatPage(id: string, search: Record<string, string> = {}) {
    const page = await import("@/app/(app)/chat/[id]/page");
    return (await page.default({ ...params(id), searchParams: Promise.resolve(search) })) as unknown as Element;
  }
  async function walk(id: string, first: { initialMessages: Wire[]; initialHistory?: History }) {
    const route = await import("@/app/api/conversations/[id]/messages/route");
    const seen = first.initialMessages.map((m) => m.id);
    let cursor = first.initialHistory?.olderCursor ?? null;
    let pages = 1;
    while (cursor) {
      const res = await route.GET(new Request(`http://juno.test/api/conversations/${id}/messages?before=${encodeURIComponent(cursor)}`), params(id));
      assert.equal(res.status, 200);
      const body = (await res.json()) as { messages: Wire[]; history: History };
      assert.equal(body.messages[0].role, "USER", "an older page starts on a question");
      seen.unshift(...body.messages.map((m) => m.id));
      cursor = body.history.olderCursor;
      pages++;
    }
    return { seen, pages };
  }
  async function rejection(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      return String((error as { digest?: string }).digest ?? (error as Error).message);
    }
    return "resolved";
  }

  test("seed a long and a short Code session, and a second account", async () => {
    const { encryptMessageText } = await import("@/lib/message-crypto");
    const make = (name: string) => prisma.user.create({ data: { email: `${name}-${tag}@code-history.test`, name } });
    const a = await make("owner");
    const s = await make("stranger");
    owner = { id: a.id, email: a.email!, name: "owner" };
    stranger = { id: s.id, email: s.email!, name: "stranger" };
    const code = { kind: "code", codeWorkspaceName: "juno", codeWorkspacePath: "/Users/owner/juno" };
    longId = (await prisma.conversation.create({ data: { userId: a.id, title: "Long session", ...code } })).id;
    shortId = (await prisma.conversation.create({ data: { userId: a.id, title: "Short session", ...code } })).id;
    const start = Date.UTC(2026, 6, 1);
    const rows = (conversationId: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        conversationId,
        role: i % 2 ? ("ASSISTANT" as const) : ("USER" as const),
        content: encryptMessageText(`run ${i}`),
        // Pairs share a millisecond now and then, as a native batch stamps them.
        createdAt: new Date(start + (i % 6 < 2 ? Math.floor(i / 6) * 6 : i) * 1000),
      }));
    await prisma.message.createMany({ data: [...rows(longId, COUNT), ...rows(shortId, 12)] });
    const order = [{ createdAt: "asc" as const }, { id: "asc" as const }];
    ordered = (await prisma.message.findMany({ where: { conversationId: longId }, orderBy: order, select: { id: true } })).map((r) => r.id);
    shortOrdered = (await prisma.message.findMany({ where: { conversationId: shortId }, orderBy: order, select: { id: true } })).map((r) => r.id);
    assert.equal(ordered.length, COUNT);
  });

  test("/code/[id] opens on the newest page with a cursor, not the whole session", async () => {
    signedIn = owner;
    const element = await codePage(longId);
    assert.equal(element.type, CodeV2Client);
    const { initialMessages, initialHistory } = element.props;
    assert.ok(initialMessages.length >= 60 && initialMessages.length <= 68, `first page: ${initialMessages.length}`);
    assert.ok(initialMessages.length < COUNT);
    assert.equal(initialMessages.at(-1)?.id, ordered.at(-1), "it ends on the newest message");
    assert.equal(initialMessages[0].role, "USER", "and starts on a question");
    assert.deepEqual(initialMessages.map((m) => m.id), ordered.slice(COUNT - initialMessages.length));
    assert.equal(initialMessages.at(-1)?.content, `run ${COUNT - 1}`, "decrypted");
    assert.equal(initialHistory?.hasOlder, true);
    assert.equal(typeof initialHistory?.olderCursor, "string");
  });

  test("scrolling back from /code/[id] reads every older message once, in order", async () => {
    signedIn = owner;
    const element = await codePage(longId);
    const { seen, pages } = await walk(longId, element.props);
    assert.deepEqual(seen, ordered);
    assert.ok(pages >= 3, `pages: ${pages}`);
  });

  test("the legacy Code surface (?surface=legacy) pages the same way", async () => {
    signedIn = owner;
    const element = await chatPage(longId, { surface: "legacy" });
    assert.equal(element.type, CodeSessionViewLazy);
    const { initialMessages, initialHistory, initialArtifacts } = element.props;
    assert.ok(initialMessages.length >= 60 && initialMessages.length <= 68, `first page: ${initialMessages.length}`);
    assert.equal(initialMessages.at(-1)?.id, ordered.at(-1));
    assert.equal(initialHistory?.hasOlder, true);
    assert.ok(Array.isArray(initialArtifacts));
    const { seen } = await walk(longId, element.props);
    assert.deepEqual(seen, ordered);
  });

  test("a session shorter than a page arrives whole, with nothing older", async () => {
    signedIn = owner;
    for (const element of [await codePage(shortId), await chatPage(shortId, { surface: "legacy" })]) {
      assert.deepEqual(element.props.initialMessages.map((m) => m.id), shortOrdered);
      assert.deepEqual(element.props.initialHistory, { hasOlder: false, olderCursor: null });
    }
  });

  test("/chat/[id] still sends a Code session to /code/[id] without ?surface=legacy", async () => {
    signedIn = owner;
    const outcome = await rejection(() => chatPage(longId));
    assert.match(outcome, /NEXT_REDIRECT/);
    assert.match(outcome, new RegExp(`/code/${longId}`));
  });

  test("another account's Code session is a 404 on both surfaces and on the pager", async () => {
    signedIn = stranger;
    assert.match(await rejection(() => codePage(longId)), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    assert.match(await rejection(() => chatPage(longId, { surface: "legacy" })), /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    signedIn = owner;
    const cursor = (await codePage(longId)).props.initialHistory?.olderCursor;
    signedIn = stranger;
    const route = await import("@/app/api/conversations/[id]/messages/route");
    const res = await route.GET(new Request(`http://juno.test/api/conversations/${longId}/messages?before=${encodeURIComponent(cursor ?? "")}`), params(longId));
    assert.equal(res.status, 404);
  });

  test("the native apps' read of a Code session is unchanged: the whole thread, no history key", async () => {
    signedIn = owner;
    const route = await import("@/app/api/conversations/[id]/route");
    const res = await route.GET(new Request(`http://juno.test/api/conversations/${longId}`), params(longId));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { messages: Wire[] };
    assert.deepEqual(body.messages.map((m) => m.id), ordered);
    assert.equal("history" in body, false);
  });

  test("clean up", async () => {
    await prisma.message.deleteMany({ where: { conversationId: { in: [longId, shortId] } } });
    await prisma.conversation.deleteMany({ where: { id: { in: [longId, shortId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } });
    await prisma.$disconnect();
  });
}
