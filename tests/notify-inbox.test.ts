import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  decodeNotificationCursor,
  encodeNotificationCursor,
  parseInboxQuery,
  toClientNotification,
  type NotificationRow,
} from "@/lib/notify/inbox";

/*
 * The inbox's wire format (contract C3): the page cursor, the query a client
 * may send, and the row as the client sees it.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

function query(search: string) {
  return parseInboxQuery(new URLSearchParams(search));
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------

test("a cursor round-trips, ties and all", () => {
  const at = new Date("2026-09-24T10:11:12.345Z");
  for (const id of ["cmf1abc", "cmf1abd"]) {
    const cursor = encodeNotificationCursor({ createdAt: at, id });
    assert.match(cursor, /^[A-Za-z0-9_-]+$/, "opaque and safe in a query string");
    assert.deepEqual(decodeNotificationCursor(cursor), { createdAt: at, id });
  }
  // Two rows in one millisecond still give two different cursors, which is the
  // reason the id is in it at all.
  assert.notEqual(
    encodeNotificationCursor({ createdAt: at, id: "cmf1abc" }),
    encodeNotificationCursor({ createdAt: at, id: "cmf1abd" })
  );
});

test("a cursor this server did not issue is refused rather than guessed at", () => {
  const forge = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  for (const value of [
    "",
    "not base64!",
    "a",
    forge("2026-09-24T10:11:12.345Z"),
    forge("2026-09-24T10:11:12.345Z|"),
    forge("2026-02-31T10:11:12.345Z|cmf1"),
    forge("yesterday|cmf1"),
    forge("2026-09-24T10:11:12.345Z|id with spaces"),
    forge(`2026-09-24T10:11:12.345Z|${"x".repeat(65)}`),
    "A".repeat(400),
  ]) {
    assert.equal(decodeNotificationCursor(value), null, `${value} was accepted`);
  }
});

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

test("no query is the first page of everything", () => {
  assert.deepEqual(query(""), { ok: true, query: { limit: INBOX_DEFAULT_LIMIT, unreadOnly: false, before: null } });
  assert.equal(INBOX_DEFAULT_LIMIT, 20);
  assert.equal(INBOX_MAX_LIMIT, 50);
});

test("limit, before and unread are read as given", () => {
  const at = new Date("2026-09-24T10:11:12.345Z");
  const before = encodeNotificationCursor({ createdAt: at, id: "cmf1abc" });
  const parsed = query(`limit=50&unread=true&before=${before}`);
  assert.deepEqual(parsed, { ok: true, query: { limit: 50, unreadOnly: true, before: { createdAt: at, id: "cmf1abc" } } });
  assert.deepEqual(query("unread=1"), { ok: true, query: { limit: 20, unreadOnly: false, before: null } });
});

test("a garbage limit or cursor is a 400, never a NaN that reaches the database", () => {
  for (const search of ["limit=abc", "limit=0", "limit=51", "limit=1.5", "limit=-3", "limit=", "limit=1e2", "before=nope"]) {
    const parsed = query(search);
    assert.equal(parsed.ok, false, `${search} was accepted`);
  }
});

test("the route answers a bad query with 400 and pages through the library", () => {
  const route = read("../src/app/api/notifications/route.ts");
  assert.match(route, /parseInboxQuery\(/);
  assert.match(route, /status: 400/);
  assert.match(route, /getCurrentUser\(\)/, "bearer and cookie both, through the one resolver");
  const count = read("../src/app/api/notifications/count/route.ts");
  assert.match(count, /countNotifications\(user\.id\)/);
  const one = read("../src/app/api/notifications/[id]/route.ts");
  assert.match(one, /changed: marked\.changed/);
  assert.match(one, /if \(!marked\.found\)/, "404 only when the id is not this account's");
});

// ---------------------------------------------------------------------------
// The row as the client sees it
// ---------------------------------------------------------------------------

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "ntf_1",
    type: "work_approval",
    title: "Organise downloads needs your approval",
    body: "Quill is waiting for you to approve one action.",
    priority: "urgent",
    sourceType: "work_session",
    sourceId: "ses_1",
    actionable: true,
    actionData: {
      runId: "run_1",
      path: "/agents/agt_1",
      agent: { id: "agt_1", name: "Quill", avatar: { shape: "orb", tone: "teal", eyes: "calm", mark: "none" } },
    },
    readAt: null,
    createdAt: new Date("2026-09-24T10:11:12.345Z"),
    ...over,
  };
}

test("a row carries its path and its agent, and nothing else from actionData", () => {
  const item = toClientNotification(row());
  assert.equal(item.href, "/agents/agt_1");
  assert.equal(item.agent?.id, "agt_1");
  assert.equal(item.agent?.name, "Quill");
  assert.ok(item.agent?.avatar.shape, "the face is normalised, so the client can always draw it");
  assert.equal(item.createdAt, "2026-09-24T10:11:12.345Z");
  assert.equal(item.readAt, null);
  assert.equal("userId" in item, false);
  assert.equal("actionData" in item, false);
});

test("an old row's absolute taskUrl still opens, as a relative path", () => {
  const item = toClientNotification(row({ actionData: { taskUrl: "https://chat.liams.dev/chat/cnv_1" } }));
  assert.equal(item.href, "/chat/cnv_1");
  assert.equal(item.agent, null);
});

test("a stored path that is not an app path opens nothing", () => {
  for (const path of ["https://evil.example", "//evil.example/x", "/\\evil", "/admin"]) {
    assert.equal(toClientNotification(row({ actionData: { path } })).href, null, path);
  }
});

test("an unknown priority reads as normal and a half-written agent as none", () => {
  const item = toClientNotification(row({ priority: "shouting", actionData: { agent: { id: "agt_1" } } }));
  assert.equal(item.priority, "normal");
  assert.equal(item.agent, null);
  assert.equal(toClientNotification(row({ actionData: null })).href, null);
});
