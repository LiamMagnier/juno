import test from "node:test";
import assert from "node:assert/strict";
import {
  cutPage, decodeHistoryCursor, encodeHistoryCursor, readHistoryPage, compareCursor,
  type HistoryCursor, type PageReader,
} from "@/lib/chat/history-page";
import { prependOlder, reconcileNewestPage, reconciledHistory } from "@/lib/chat/history-merge";
import { anchoredTranscriptTop, transcriptAnchor, transcriptLayout } from "@/lib/chat/transcript-window";

type Row = { id: string; role: "USER" | "ASSISTANT"; createdAt: Date };

/** A conversation of `n` rows, question then answer, ids sortable like cuids. */
function conversation(n: number, sameMillisecond = false): Row[] {
  const start = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(5, "0")}`,
    role: i % 2 ? "ASSISTANT" : "USER",
    createdAt: new Date(sameMillisecond ? start + Math.floor(i / 4) : start + i * 1000),
  }));
}

/** The reads readHistoryPage makes, over an in-memory conversation. */
function reader(rows: Row[]): PageReader<Row> & { reads: number } {
  const key = (r: Row): HistoryCursor => ({ createdAt: r.createdAt, id: r.id });
  const matches = (r: Row, where: unknown): boolean => {
    if (!where || typeof where !== "object" || !Object.keys(where).length) return true;
    const w = where as { AND?: unknown[]; OR?: Array<{ createdAt: { lt?: Date; gt?: Date } | Date; id?: { lt?: string; gte?: string } }> };
    if (w.AND) return w.AND.every((part) => matches(r, part));
    return (w.OR ?? []).some((clause) => {
      if (clause.createdAt instanceof Date) {
        if (r.createdAt.getTime() !== clause.createdAt.getTime()) return false;
        if (clause.id?.lt !== undefined) return r.id < clause.id.lt;
        if (clause.id?.gte !== undefined) return r.id >= clause.id.gte;
        return true;
      }
      if (clause.createdAt.lt) return r.createdAt < clause.createdAt.lt;
      if (clause.createdAt.gt) return r.createdAt > clause.createdAt.gt;
      return false;
    });
  };
  const sorted = [...rows].sort((a, b) => compareCursor(key(b), key(a)));
  const api = {
    reads: 0,
    async newestFirst(where: object, take: number | undefined) {
      api.reads++;
      const hit = sorted.filter((r) => matches(r, where));
      return take === undefined ? hit : hit.slice(0, take);
    },
    async locate(id: string) {
      const row = rows.find((r) => r.id === id);
      return row ? key(row) : null;
    },
    async count(where: object) {
      return sorted.filter((r) => matches(r, where)).length;
    },
  };
  return api;
}

test("a cursor round-trips and refuses anything it did not make", () => {
  const cursor = { createdAt: new Date("2026-03-04T05:06:07.089Z"), id: "cmabc123" };
  assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(cursor)), cursor);
  for (const bad of [null, "", "not-base64!", Buffer.from("no-bar").toString("base64url"), Buffer.from("nonsense|id").toString("base64url"), Buffer.from("2026-01-01T00:00:00.000Z|bad id; drop").toString("base64url"), "x".repeat(400)]) {
    assert.equal(decodeHistoryCursor(bad), null, String(bad));
  }
});

test("a page starts on a question, never on the reply that answers it", () => {
  const rows = conversation(100);
  const newestFirst = [...rows].reverse();
  // 61 rows from the newest end would open on an answer (row 39): widened by one.
  const { rows: page, history } = cutPage(newestFirst, 61, false);
  assert.equal(page[0].role, "USER");
  assert.equal(page.length, 62);
  assert.equal(page.at(-1)!.id, rows.at(-1)!.id);
  assert.equal(history.hasOlder, true);
  assert.deepEqual(decodeHistoryCursor(history.olderCursor), { createdAt: page[0].createdAt, id: page[0].id });
});

test("a short conversation is one page with nothing older", () => {
  const rows = conversation(12);
  const { rows: page, history } = cutPage([...rows].reverse(), 60, true);
  assert.deepEqual(page.map((r) => r.id), rows.map((r) => r.id));
  assert.deepEqual(history, { hasOlder: false, olderCursor: null });
});

test("a conversation exactly one page long has nothing older", async () => {
  const rows = conversation(60);
  const { rows: page, history } = await readHistoryPage(reader(rows), { limit: 60 });
  assert.equal(page.length, 60);
  assert.equal(history.hasOlder, false);
});

test("walking every cursor yields each message once, in order — even when timestamps tie", async () => {
  for (const tie of [false, true]) {
    const rows = conversation(2001, tie);
    const db = reader(rows);
    const seen: string[] = [];
    let page = await readHistoryPage(db, { limit: 60 });
    seen.unshift(...page.rows.map((r) => r.id));
    while (page.history.hasOlder) {
      page = await readHistoryPage(db, { before: decodeHistoryCursor(page.history.olderCursor), limit: 120 });
      assert.ok(page.rows.length > 0);
      assert.equal(page.rows[0].role === "USER" || !page.history.hasOlder, true);
      seen.unshift(...page.rows.map((r) => r.id));
    }
    assert.deepEqual(seen, rows.map((r) => r.id), tie ? "tied timestamps" : "distinct timestamps");
  }
});

test("a page can be widened to reach a message far above it", async () => {
  const rows = conversation(2000);
  const target = rows[7];
  const { rows: page, history } = await readHistoryPage(reader(rows), { limit: 60, throughMessageId: target.id });
  assert.ok(page.some((r) => r.id === target.id));
  assert.equal(page.at(-1)!.id, rows.at(-1)!.id);
  assert.equal(page[0].role, "USER");
  // A few turns of context above the target, and the rest is still older.
  assert.equal(history.hasOlder, false, "row 7 minus ten rows of context reaches the start");
  const deeper = await readHistoryPage(reader(rows), { limit: 60, throughMessageId: rows[500].id });
  assert.ok(deeper.rows[0].id <= rows[490].id && deeper.history.hasOlder);
});

test("an unknown or newer target leaves the page as it was", async () => {
  const rows = conversation(400);
  const plain = await readHistoryPage(reader(rows), { limit: 60 });
  const unknown = await readHistoryPage(reader(rows), { limit: 60, throughMessageId: "someone-elses-message" });
  assert.deepEqual(unknown.rows.map((r) => r.id), plain.rows.map((r) => r.id));
  const before = decodeHistoryCursor(plain.history.olderCursor)!;
  const newer = await readHistoryPage(reader(rows), { before, limit: 60, throughMessageId: rows.at(-1)!.id });
  assert.ok(newer.rows.every((r) => r.id < before.id));
  assert.equal(newer.rows.length <= 62, true);
});

test("`all` returns everything older than the cursor and says nothing is left", async () => {
  const rows = conversation(1000);
  const first = await readHistoryPage(reader(rows), { limit: 60 });
  const rest = await readHistoryPage(reader(rows), { before: decodeHistoryCursor(first.history.olderCursor), limit: 1, all: true });
  assert.deepEqual([...rest.rows, ...first.rows].map((r) => r.id), rows.map((r) => r.id));
  assert.deepEqual(rest.history, { hasOlder: false, olderCursor: null });
});

test("a request for more than the cap is clamped", async () => {
  const rows = conversation(3000);
  const { rows: page } = await readHistoryPage(reader(rows), { limit: 100_000 });
  assert.ok(page.length <= 502);
});

type Client = { id: string; createdAt: string; content?: string };
const client = (rows: Row[]): Client[] => rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() }));

test("an older page lands above, and rows already held are not doubled", () => {
  const all = client(conversation(200));
  const current = all.slice(100);
  const merged = prependOlder(current, all.slice(40, 101));
  assert.deepEqual(merged.map((m) => m.id), all.slice(40).map((m) => m.id));
  assert.equal(prependOlder(current, []), current);
});

test("a refreshed newest page keeps the history the reader scrolled back through", () => {
  const all = client(conversation(300));
  const loaded = all.slice(100); // the reader paged back to row 100
  const reply = { id: "c99999", createdAt: new Date(Date.UTC(2027, 0, 1)).toISOString() };
  const page = [...all.slice(240), reply]; // the server's newest 61 after one new reply
  const { messages, keptOlder } = reconcileNewestPage(loaded, page, { hasOlder: true, olderCursor: "page" });
  assert.deepEqual(messages.map((m) => m.id), [...all.slice(100), reply].map((m) => m.id));
  assert.equal(keptOlder, 140);
  assert.deepEqual(reconciledHistory({ hasOlder: true, olderCursor: "reader" }, { hasOlder: true, olderCursor: "page" }, keptOlder), { hasOlder: true, olderCursor: "reader" });
});

test("a refreshed page with no overlap, or a whole conversation, replaces what is held", () => {
  const all = client(conversation(300));
  const stale = all.slice(0, 100);
  const page = all.slice(240);
  assert.deepEqual(reconcileNewestPage(stale, page, { hasOlder: true, olderCursor: "p" }), { messages: page, keptOlder: 0 });
  // An edit cut the conversation short: the server now has all of it in one page.
  const short = all.slice(0, 6);
  assert.deepEqual(reconcileNewestPage(all, short, { hasOlder: false, olderCursor: null }), { messages: short, keptOlder: 0 });
});

test("rows prepended above the reader keep the reader's line where it was", () => {
  const keys = Array.from({ length: 60 }, (_, i) => `m${i + 120}`);
  const height = (_: string, i: number) => 140 + (i % 5) * 37;
  const before = transcriptLayout(keys, height);
  const scrollTop = 300;
  const anchor = transcriptAnchor(before, scrollTop - 24)!;
  const older = Array.from({ length: 120 }, (_, i) => `m${i}`);
  const after = transcriptLayout([...older, ...keys], (key, i) => (i < older.length ? 210 : height(key, i - older.length)));
  const top = anchoredTranscriptTop(after, anchor, scrollTop - 24) + 24;
  const added = after.offsets[older.length];
  assert.equal(top - added, scrollTop);
});
