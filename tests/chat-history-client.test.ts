import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createOlderHistoryLoader,
  fetchOlderHistory,
  LOAD_OLDER_RETRY_MS,
  LOAD_OLDER_WITHIN_PX,
  olderHistoryUrl,
  shouldLoadOlder,
  type LoadOlderRequest,
  type OlderPage,
} from "@/lib/chat/history-client";
import { prependOlder } from "@/lib/chat/history-merge";
import { Thread } from "@/components/code/v2/thread";
import type { TurnItem } from "@/lib/code-v2/contracts";
import type { ClientMessage, ConversationHistory } from "@/types/chat";

/*
 * The client half of paged history, shared by Chat (use-chat) and both Code
 * surfaces (use-code-session): the wire request, the one-request-at-a-time
 * loader, the load-older threshold, and the v2 Code thread drawing a paged
 * session. The server half is tests/chat-history.test.ts; the routes against
 * Postgres are tests/chat-history-paging.integration.test.ts and
 * tests/code-history-paging.integration.test.ts.
 */

(globalThis as unknown as { React: typeof React }).React = React;

const msg = (i: number, role: "USER" | "ASSISTANT" = i % 2 ? "ASSISTANT" : "USER"): ClientMessage =>
  ({ id: `m${String(i).padStart(4, "0")}`, role, content: `body ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), attachments: [] }) as unknown as ClientMessage;

test("olderHistoryUrl: before always, then all or through (all wins)", () => {
  assert.equal(olderHistoryUrl("c1", "CUR"), "/api/conversations/c1/messages?before=CUR");
  assert.equal(olderHistoryUrl("c1", "CUR", { all: true }), "/api/conversations/c1/messages?before=CUR&all=1");
  assert.equal(olderHistoryUrl("c1", "CUR", { throughMessageId: "m9" }), "/api/conversations/c1/messages?before=CUR&through=m9");
  assert.equal(olderHistoryUrl("c1", "CUR", { all: true, throughMessageId: "m9" }), "/api/conversations/c1/messages?before=CUR&all=1");
  assert.equal(olderHistoryUrl("c1", "a+b/c="), "/api/conversations/c1/messages?before=a%2Bb%2Fc%3D");
});

test("fetchOlderHistory: a page, or null for an error status or a malformed body", async () => {
  const page: OlderPage = { messages: [msg(0)], history: { hasOlder: false, olderCursor: null } };
  const seen: string[] = [];
  const ok = (async (url: string) => {
    seen.push(url);
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await fetchOlderHistory("c1", "CUR", {}, ok), page);
  assert.deepEqual(seen, ["/api/conversations/c1/messages?before=CUR"]);
  const status = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  assert.equal(await fetchOlderHistory("c1", "CUR", {}, status), null);
  const malformed = (async () => new Response(JSON.stringify({ messages: "no" }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await fetchOlderHistory("c1", "CUR", {}, malformed), null);
});

test("shouldLoadOlder: two screens (at least 1600px) from the top, and not right after a failure", () => {
  assert.equal(shouldLoadOlder(0, 800), true);
  assert.equal(shouldLoadOlder(LOAD_OLDER_WITHIN_PX, 100), true);
  assert.equal(shouldLoadOlder(LOAD_OLDER_WITHIN_PX + 1, 100), false);
  assert.equal(shouldLoadOlder(2000, 1000), true, "two screens of a tall viewport");
  assert.equal(shouldLoadOlder(2001, 1000), false);
  const now = 1_000_000;
  assert.equal(shouldLoadOlder(0, 800, now - 10, now), false);
  assert.equal(shouldLoadOlder(0, 800, now - LOAD_OLDER_RETRY_MS, now), true);
});

/** A loader over plain values, with a fetch the test resolves by hand. */
function harness(total: number, newest: number) {
  const all = Array.from({ length: total }, (_, i) => msg(i));
  const state = {
    conversationId: "c1" as string | null,
    messages: all.slice(total - newest),
    history: { hasOlder: true, olderCursor: `cur-${total - newest}` } as ConversationHistory,
    loading: [] as boolean[],
  };
  const calls: Array<{ cursor: string; request: LoadOlderRequest; resolve: (page: OlderPage | null) => void }> = [];
  const loader = createOlderHistoryLoader<ClientMessage>({
    conversationId: () => state.conversationId,
    messages: () => state.messages,
    history: () => state.history,
    setLoading: (loading) => state.loading.push(loading),
    land: (older, history) => {
      state.messages = prependOlder(state.messages, older);
      state.history = history;
      return state.messages;
    },
    fetchPage: (_id, cursor, request) => new Promise((resolve) => calls.push({ cursor, request, resolve })),
  });
  /** The page the server would send for a cursor `cur-N`: `size` rows older than index N. */
  const pageFor = (cursor: string, size: number | "all"): OlderPage => {
    const end = Number(cursor.slice(4));
    const start = size === "all" ? 0 : Math.max(0, end - size);
    return { messages: all.slice(start, end), history: start > 0 ? { hasOlder: true, olderCursor: `cur-${start}` } : { hasOlder: false, olderCursor: null } };
  };
  return { all, state, calls, loader, pageFor };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("loader: a page lands above, once, and the cursor moves on", async () => {
  const { all, state, calls, loader, pageFor } = harness(100, 20);
  const pending = loader.load();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, "cur-80");
  calls[0].resolve(pageFor(calls[0].cursor, 30));
  const after = await pending;
  assert.deepEqual(after?.map((m) => m.id), all.slice(50).map((m) => m.id));
  assert.deepEqual(state.history, { hasOlder: true, olderCursor: "cur-50" });
  assert.deepEqual(state.loading, [true, false]);
});

test("loader: one request at a time; a second call waits, then reads from the new cursor", async () => {
  const { state, calls, loader, pageFor } = harness(100, 20);
  const first = loader.load();
  const second = loader.load();
  await tick();
  assert.equal(calls.length, 1, "the second call does not race the first");
  calls[0].resolve(pageFor(calls[0].cursor, 30));
  await first;
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].cursor, "cur-50", "it continues from where the first page ended");
  calls[1].resolve(pageFor(calls[1].cursor, 30));
  await second;
  assert.equal(state.messages.length, 80);
});

test("loader: a jump to a message already loaded, or by the request ahead of it, fetches nothing", async () => {
  const { all, calls, loader, pageFor } = harness(100, 20);
  assert.equal((await loader.load({ throughMessageId: all[95].id }))?.length, 20);
  assert.equal(calls.length, 0);
  const page = loader.load();
  const jump = loader.load({ throughMessageId: all[60].id });
  await tick();
  calls[0].resolve(pageFor(calls[0].cursor, 30));
  await page;
  const landed = await jump;
  assert.equal(calls.length, 1, "the page ahead of it brought the message in");
  assert.ok(landed?.some((m) => m.id === all[60].id));
});

test("loader: through and all are sent as asked, and nothing is read once the start is reached", async () => {
  const { all, state, calls, loader, pageFor } = harness(100, 20);
  const jump = loader.load({ throughMessageId: all[10].id });
  await tick();
  assert.deepEqual(calls[0].request, { throughMessageId: all[10].id });
  calls[0].resolve(pageFor(calls[0].cursor, 75));
  await jump;
  const rest = loader.load({ all: true });
  await tick();
  assert.deepEqual(calls[1].request, { all: true });
  calls[1].resolve(pageFor(calls[1].cursor, "all"));
  assert.equal((await rest)?.length, 100);
  assert.equal(state.history.hasOlder, false);
  assert.equal((await loader.load())?.length, 100);
  assert.equal(calls.length, 2);
});

test("loader: a failed read resolves null and leaves the transcript and cursor as they were", async () => {
  const { state, calls, loader } = harness(100, 20);
  const pending = loader.load();
  await tick();
  calls[0].resolve(null);
  assert.equal(await pending, null);
  assert.equal(state.messages.length, 20);
  assert.equal(state.history.olderCursor, "cur-80");
  assert.deepEqual(state.loading, [true, false]);
});

test("loader: a page read for a conversation the reader has left is dropped", async () => {
  const { state, calls, loader, pageFor } = harness(100, 20);
  const pending = loader.load();
  await tick();
  state.conversationId = "c2";
  loader.reset();
  calls[0].resolve(pageFor(calls[0].cursor, 30));
  assert.equal(await pending, null);
  assert.equal(state.messages.length, 20, "nothing landed in the next conversation");
  assert.deepEqual(state.loading, [true], "and the next conversation's loading flag is not touched");
});

// ── The v2 Code thread, paged ────────────────────────────────────────────────

const turnItems = (n: number): TurnItem[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, turnId: `turn-u${i}`, kind: "user_message", text: `ask ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 2000).toISOString(), delivery: "send", attachments: [] },
    { id: `a${i}-text`, turnId: `turn-u${i}`, kind: "assistant_message", text: `answer ${i}`, streaming: false, createdAt: new Date(Date.UTC(2026, 0, 1) + i * 2000 + 1000).toISOString() },
  ]).flat() as unknown as TurnItem[];

function renderThread(history?: { hasOlder: boolean; loading: boolean }) {
  return renderToStaticMarkup(
    React.createElement(Thread, {
      items: turnItems(4),
      state: "idle",
      instances: [],
      detailLevel: "summary",
      history: history ? { ...history, loadOlder: async () => null } : undefined,
    }),
  );
}

test("the v2 Code thread says when it holds only the newest turns, and while older ones load", () => {
  const paged = renderThread({ hasOlder: true, loading: false });
  assert.match(paged, /data-history-older="true"/);
  assert.match(paged, /data-history-turns="4"/);
  assert.doesNotMatch(paged, /aria-busy/);
  assert.match(renderThread({ hasOlder: true, loading: true }), /aria-busy="true"/);
  assert.match(renderThread({ hasOlder: false, loading: false }), /data-history-older="false"/);
  const whole = renderThread();
  assert.doesNotMatch(whole, /data-history-older|aria-busy/, "a thread that arrived whole does not page");
  for (let i = 0; i < 4; i++) assert.match(whole, new RegExp(`data-turn="turn-u${i}"`));
});
