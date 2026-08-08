import test from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import {
  buildSnippet,
  buildTsQuery,
  compareHits,
  markTerms,
  matchesAllTerms,
  parseSearchQuery,
  rankHits,
  searchTerms,
} from "@/lib/search/query";
import { runUnifiedSearch, UNDECRYPTABLE_PLACEHOLDER, type SearchExecutor } from "@/lib/search/engine";
import { SEARCH_TYPES, type SearchHit } from "@/lib/search/types";

/*
 * Unified search.
 *
 * There is no test database here, so the engine is driven through its injected
 * executor by a fake Postgres that does one thing faithfully: it reads the
 * `userId` bound into each statement and returns only rows belonging to it, and
 * it REFUSES a statement that binds no user at all. That is what makes the
 * cross-account test real rather than decorative — a branch that stopped
 * scoping would either throw (no user bound) or return the other account's
 * rows, and both fail below. Every statement is also checked against the
 * compiled SQL for its `"userId" = $n` predicate, because the two failures are
 * different: one is a query that forgot the scope, the other is a query that
 * has the scope but binds the wrong thing.
 *
 * The `simple` text-search configuration Postgres is asked for and the marking
 * rule in query.ts have to agree — prefix per token, no stemming, stopwords
 * kept. Several tests below exist only to hold those two together, since a
 * highlight that lands on the wrong characters in a result the engine swears
 * matched is the specific way search loses a user's trust.
 */

const USER_A = "user-a";
const USER_B = "user-b";
const KNOWN_USERS = new Set([USER_A, USER_B]);

const T0 = new Date("2026-01-01T00:00:00.000Z");

// ---------------------------------------------------------------------------
// The fake database
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown> & { userId: string; _text: string };

/** One row per source per user, with identical text, so only scoping can tell them apart. */
function fixtures(userId: string, tag: string): Record<string, FakeRow[]> {
  return {
    Conversation: [
      {
        userId,
        _text: `The guard clause discussion ${tag}`,
        id: `conv-${tag}`,
        title: `The guard clause discussion ${tag}`,
        projectId: null,
        updatedAt: T0,
        rank: 0.6,
      },
    ],
    Project: [
      {
        userId,
        _text: `guard clause project ${tag}`,
        id: `proj-${tag}`,
        name: `Ownership ${tag}`,
        snippetSource: `Always write a guard clause first, ${tag}.`,
        updatedAt: T0,
        rank: 0.5,
      },
    ],
    Attachment: [
      {
        userId,
        _text: `guard clause notes ${tag}`,
        id: `file-${tag}`,
        fileName: `notes-${tag}.pdf`,
        storageKey: `keys/${tag}`,
        conversationId: `conv-${tag}`,
        messageId: `msg-${tag}`,
        projectId: null,
        snippetSource: `A guard clause keeps the happy path flat, ${tag}.`,
        updatedAt: T0,
        rank: 0.4,
      },
    ],
    KnowledgeBlock: [
      {
        userId,
        _text: `guard clause block ${tag}`,
        id: `block-${tag}`,
        documentId: `doc-${tag}`,
        fileName: `handbook-${tag}.pdf`,
        text: `Every guard clause returns early, ${tag}.`,
        page: 4,
        slide: null,
        sheet: null,
        cellRange: null,
        path: null,
        lineStart: null,
        projectId: `proj-${tag}`,
        storageKey: null,
        attachmentConversationId: null,
        updatedAt: T0,
        rank: 0.3,
      },
    ],
    KnowledgeDocument: [
      { userId, _text: "", id: `doc-${tag}`, state: "ready" },
      { userId, _text: "", id: `doc2-${tag}`, state: "indexing" },
    ],
    ArtifactVersion: [
      {
        userId,
        _text: `guard clause artifact ${tag}`,
        id: `art-${tag}`,
        identifier: `guards-${tag}`,
        title: `Guards ${tag}`,
        conversationId: `conv-${tag}`,
        projectId: null,
        version: 2,
        snippetSource: `function f() { /* guard clause ${tag} */ }`,
        updatedAt: T0,
        rank: 0.7,
      },
    ],
    MemoryEntry: [
      {
        userId,
        _text: `guard clause memory ${tag}`,
        id: `mem-${tag}`,
        snippetSource: `Prefers a guard clause over nesting, ${tag}.`,
        category: "preferences",
        status: "active",
        projectId: null,
        updatedAt: T0,
        rank: 0.8,
      },
    ],
    WorkSession: [
      {
        userId,
        _text: `guard clause task ${tag}`,
        id: `work-${tag}`,
        title: `Refactor ${tag}`,
        goal: `Replace nesting with a guard clause, ${tag}.`,
        status: "completed",
        projectId: null,
        updatedAt: T0,
        rank: 0.55,
      },
    ],
    WorkEvent: [
      {
        userId,
        _text: `guard clause event ${tag}`,
        id: `evt-${tag}`,
        seq: 12,
        kind: "tool_result",
        runId: `run-${tag}`,
        sessionId: `work-${tag}`,
        sessionTitle: `Refactor ${tag}`,
        projectId: null,
        snippetSource: `{"note":"added a guard clause ${tag}"}`,
        updatedAt: T0,
        rank: 0.35,
      },
    ],
    Message: [
      {
        userId,
        _text: "",
        id: `msg-${tag}`,
        conversationId: `conv-${tag}`,
        conversationTitle: `The guard clause discussion ${tag}`,
        projectId: null,
        role: "USER",
        content: `Should I use a guard clause here, ${tag}? A guard clause reads better.`,
        createdAt: T0,
      },
    ],
  };
}

const DB: Record<string, FakeRow[]> = (() => {
  const a = fixtures(USER_A, "a");
  const b = fixtures(USER_B, "b");
  const merged: Record<string, FakeRow[]> = {};
  for (const table of Object.keys(a)) merged[table] = [...a[table], ...b[table]];
  return merged;
})();

/** The table a statement reads from — its first FROM. */
function tableOf(text: string): string {
  return text.match(/FROM "(\w+)"/)?.[1] ?? "";
}

/** Terms carried by the statement, recovered from its bound tsquery. */
function termsOf(values: readonly unknown[]): string[] {
  const tsquery = values.find((v) => typeof v === "string" && v.endsWith(":*")) as string | undefined;
  return tsquery ? tsquery.split(" & ").map((t) => t.replace(/:\*$/, "")) : [];
}

interface Recorded {
  text: string;
  values: readonly unknown[];
}

function fakeDatabase() {
  const statements: Recorded[] = [];

  const executor: SearchExecutor = {
    async run<T>(statement: Prisma.Sql): Promise<T[]> {
      const text = statement.text;
      const values = statement.values;
      statements.push({ text, values });

      // The scope check. A statement that binds no known user is not "a query
      // that found nothing" — it is a query that would have read the whole
      // table in production, so it fails loudly here.
      const scoped = values.filter((v): v is string => typeof v === "string" && KNOWN_USERS.has(v));
      if (scoped.length === 0) throw new Error(`unscoped statement against ${tableOf(text)}`);
      const owners = new Set(scoped);

      const table = tableOf(text);
      const own = (DB[table] ?? []).filter((row) => owners.has(row.userId));

      // The readiness count, which is an aggregate rather than a row set.
      if (table === "KnowledgeDocument" && text.includes("count(*)")) {
        const pending = own.filter((r) => r.state === "indexing").length;
        const impaired = own.filter((r) => r.state === "degraded").length;
        return [{ pending, impaired }] as T[];
      }

      // The message scan asks for conversations without ranking them.
      const isMessageScanWindow = table === "Conversation" && !text.includes("ts_rank");
      if (isMessageScanWindow) {
        return own.map((r) => ({ id: r.id, title: r.title, projectId: r.projectId })) as T[];
      }
      // Message bodies are matched in TypeScript after decryption, never in SQL.
      if (table === "Message") return own.map(strip) as T[];

      const terms = termsOf(values);
      return own.filter((r) => matchesAllTerms(r._text, terms)).map(strip) as T[];
    },
  };

  return { executor, statements };
}

function strip(row: FakeRow): Record<string, unknown> {
  const { _text, userId, ...rest } = row;
  void _text;
  void userId;
  return rest;
}

const deps = (executor: SearchExecutor, decrypt: (s: string) => string = (s) => s) => ({
  executor,
  decryptMessage: decrypt,
  now: new Date("2026-02-01T00:00:00.000Z"),
});

// ---------------------------------------------------------------------------
// Cross-account isolation — the one this file exists for
// ---------------------------------------------------------------------------

test("a second account's content is never returned, in any group", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));

  const found = result.groups.map((g) => g.type).sort();
  assert.deepEqual(
    found,
    [...SEARCH_TYPES].sort(),
    "every source should have produced a hit for the account that owns one"
  );

  // Serialised whole, so a leak through any field — title, snippet, href,
  // locator, id — fails, not only through the ones this test thought to name.
  const blob = JSON.stringify(result);
  assert.doesNotMatch(blob, /-b\b/, "user B's rows are tagged '-b' and must not appear anywhere");
  assert.match(blob, /-a\b/, "user A's own rows must appear");
});

test("the same query as the other account returns only that account's content", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_B, query: "guard clause" }, deps(executor));
  const blob = JSON.stringify(result);
  assert.doesNotMatch(blob, /-a\b/);
  assert.match(blob, /-b\b/);
});

test("every statement scopes by userId in its SQL and binds the searching account", async () => {
  const { executor, statements } = fakeDatabase();
  await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));

  assert.ok(statements.length >= 11, `expected a statement per source, got ${statements.length}`);
  for (const s of statements) {
    assert.match(
      s.text,
      /"userId" = \$\d+/,
      `statement against ${tableOf(s.text)} has no userId predicate:\n${s.text}`
    );
    assert.ok(
      s.values.includes(USER_A),
      `statement against ${tableOf(s.text)} does not bind the searching user`
    );
    assert.ok(
      !s.values.includes(USER_B),
      `statement against ${tableOf(s.text)} binds another account's id`
    );
  }
});

test("filters are scoped too — a project filter never widens the account scope", async () => {
  const { executor, statements } = fakeDatabase();
  await runUnifiedSearch(
    { userId: USER_A, query: "guard clause", projectId: "proj-b", window: "week" },
    deps(executor)
  );
  for (const s of statements) {
    assert.ok(s.values.includes(USER_A), `unscoped after filtering: ${tableOf(s.text)}`);
  }
});

test("Work run events honour the visibility default rather than leaking internal telemetry", async () => {
  // WorkEvent.visibility defaults to "internal" precisely so an unclassified
  // event stays invisible. Search is a new reader of that table; if this
  // predicate is ever dropped it becomes the one surface that shows operator
  // events to the user.
  const { executor, statements } = fakeDatabase();
  await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));
  const workEvents = statements.find((s) => tableOf(s.text) === "WorkEvent");
  assert.ok(workEvents, "the Work event statement should have run");
  assert.match(workEvents.text, /"visibility" = 'user'/);
});

// ---------------------------------------------------------------------------
// Snippets: the marks must select the characters that matched
// ---------------------------------------------------------------------------

test("the snippet marks exactly the matched span", () => {
  const text = "The ownership guard rejects an unscoped query.";
  const snippet = buildSnippet(text, ["guard"]);
  assert.ok(snippet);
  assert.equal(snippet.marks.length, 1);
  assert.equal(snippet.text.slice(snippet.marks[0].start, snippet.marks[0].end), "guard");
});

test("a prefix query marks only the prefix, because that is what Postgres matched", () => {
  // `guard:*` matches the token "guardrail"; it does not match the whole word,
  // and a highlight covering the whole word would claim more than the engine did.
  const snippet = buildSnippet("The guardrail is not a guard.", ["guard"]);
  assert.ok(snippet);
  assert.deepEqual(
    snippet.marks.map((m) => snippet.text.slice(m.start, m.end)),
    ["guard", "guard"]
  );
  assert.equal(snippet.text.indexOf("guardrail"), snippet.marks[0].start);
});

test("a term inside a word is not a match — token prefixes start at word boundaries", () => {
  assert.deepEqual(markTerms("safeguard", ["guard"]), []);
  assert.equal(buildSnippet("safeguard", ["guard"]), null);
});

test("marks stay aligned when the snippet is elided and its whitespace collapsed", () => {
  const text = `${"x ".repeat(200)}NEEDLE\n\n${"y ".repeat(200)}`;
  const snippet = buildSnippet(text, ["needle"]);
  assert.ok(snippet);
  assert.equal(snippet.text.slice(snippet.marks[0].start, snippet.marks[0].end), "NEEDLE");
  assert.ok(snippet.text.startsWith("…") && snippet.text.endsWith("…"), "elided on both sides");
  assert.doesNotMatch(snippet.text, /\n/, "a snippet is one line");
  assert.ok(snippet.text.length < 200, "a snippet is a line, not the document");
});

test("overlapping terms produce one span rather than two", () => {
  // "guard" and "guardrail" both match the same word; two overlapping marks
  // would be double-wrapped by any renderer that trusts the list.
  const snippet = buildSnippet("The guardrail held.", ["guard", "guardrail"]);
  assert.ok(snippet);
  assert.equal(snippet.marks.length, 1);
  assert.equal(snippet.text.slice(snippet.marks[0].start, snippet.marks[0].end), "guardrail");
});

test("marks are ascending and non-overlapping", () => {
  const snippet = buildSnippet("guard clause, guard rail, clause two", ["guard", "clause"]);
  assert.ok(snippet);
  let previousEnd = -1;
  for (const mark of snippet.marks) {
    assert.ok(mark.start >= previousEnd, "marks must not overlap or go backwards");
    assert.ok(mark.end > mark.start);
    previousEnd = mark.end;
  }
});

test("no match means no snippet, rather than a fragment implying one", () => {
  // Happens for real: a row matches on its file name and is snippeted from a
  // body that contains none of the terms.
  assert.equal(buildSnippet("nothing relevant in here", ["guard"]), null);
  assert.equal(buildSnippet("", ["guard"]), null);
});

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

test("tsquery syntax typed by a user is searched for, not executed", () => {
  // The tokeniser is a whitelist of letters and digits, which is the whole
  // reason the tsquery string is safe to build by concatenation.
  const parsed = parseSearchQuery("guard | clause & !(x):*");
  assert.ok(parsed);
  assert.deepEqual(parsed.terms, ["guard", "clause", "x"]);
  assert.equal(parsed.tsquery, "guard:* & clause:* & x:*");
  // The `&` separators are the engine's own; no operator survives from the
  // user's text into a term.
  for (const term of parsed.terms) assert.match(term, /^[\p{L}\p{N}]+$/u);
});

test("a query with no letters or digits is 'no query', not 'no results'", () => {
  for (const q of ["", "   ", "…", "/", "-–—"]) {
    assert.equal(parseSearchQuery(q), null, `${JSON.stringify(q)} should parse to null`);
  }
});

test("terms are deduplicated, lowercased, and capped", () => {
  assert.deepEqual(searchTerms("Guard guard GUARD"), ["guard"]);
  assert.equal(searchTerms("a b c d e f g h i j k").length, 8);
});

test("non-ASCII words are terms", () => {
  assert.deepEqual(searchTerms("garde-fou Größe 日本語"), ["garde", "fou", "größe", "日本語"]);
});

test("buildTsQuery ANDs every token with a prefix flag", () => {
  assert.equal(buildTsQuery(["conv", "gua"]), "conv:* & gua:*");
});

test("matchesAllTerms reaches the same verdict the tsquery would", () => {
  assert.equal(matchesAllTerms("a guard clause", ["guard", "clause"]), true);
  assert.equal(matchesAllTerms("a guard", ["guard", "clause"]), false, "AND, not OR");
  assert.equal(matchesAllTerms("guarded clauses", ["guard", "clause"]), true, "prefixes count");
  assert.equal(matchesAllTerms("safeguard clause", ["guard", "clause"]), false, "mid-word does not");
  assert.equal(matchesAllTerms("anything", []), false);
});

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    id: "conversation:x",
    type: "conversation",
    title: "x",
    snippet: null,
    href: "/chat/x",
    locator: null,
    projectId: null,
    updatedAt: T0.toISOString(),
    score: 1,
    ...over,
  };
}

test("ranking is a total order: equal score and age fall back to id", () => {
  const a = hit({ id: "a" });
  const b = hit({ id: "b" });
  assert.ok(compareHits(a, b) < 0);
  assert.ok(compareHits(b, a) > 0);
  assert.equal(compareHits(a, a), 0);
});

test("ranking is stable across identical searches regardless of arrival order", () => {
  // Eight sources are queried concurrently, so the merged array's order is
  // whatever the event loop produced. In a palette, where the user is pressing
  // Enter on "the second row", a list that reorders under an unchanged query is
  // a wrong-destination bug.
  const hits = [
    hit({ id: "m1", score: 0.5, updatedAt: T0.toISOString() }),
    hit({ id: "m2", score: 0.5, updatedAt: T0.toISOString() }),
    hit({ id: "m3", score: 0.9, updatedAt: T0.toISOString() }),
    hit({ id: "m4", score: 0.5, updatedAt: "2026-03-01T00:00:00.000Z" }),
  ];
  const expected = rankHits(hits).map((h) => h.id);
  assert.deepEqual(expected, ["m3", "m4", "m1", "m2"]);
  for (const permutation of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    assert.deepEqual(rankHits(permutation.map((i) => hits[i])).map((h) => h.id), expected);
  }
});

test("re-ranking an already-ranked list changes nothing", () => {
  const hits = [hit({ id: "a", score: 0.2 }), hit({ id: "b", score: 0.9 }), hit({ id: "c", score: 0.2 })];
  const once = rankHits(hits);
  assert.deepEqual(rankHits(once), once);
});

test("an unparseable timestamp sorts last instead of poisoning the comparison", () => {
  const good = hit({ id: "good", updatedAt: T0.toISOString() });
  const bad = hit({ id: "bad", updatedAt: "not a date" });
  assert.ok(compareHits(good, bad) < 0);
  assert.ok(compareHits(bad, good) > 0);
});

test("groups come back in a fixed order, whatever the query", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));
  const order = result.groups.map((g) => g.type);
  assert.deepEqual(order, SEARCH_TYPES.filter((t) => order.includes(t)));
});

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

test("a hit resolves to the exact location, not merely its container", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));
  const byType = Object.fromEntries(result.groups.map((g) => [g.type, g.hits]));

  assert.equal(byType.message[0].href, "/chat/conv-a?m=msg-a", "the message, not just the chat");
  assert.equal(
    byType.artifact[0].href,
    "/chat/conv-a?artifact=guards-a&v=2",
    "the version that matched, which need not be the current one"
  );
  assert.equal(byType.artifact[0].locator, "v2");
  assert.equal(byType.knowledge[0].locator, "Page 4", "a citation has to be able to say where");
  assert.equal(byType.knowledge[0].href, "/projects/proj-a?doc=doc-a&block=block-a");
  assert.equal(byType.work[1].href, "/work/work-a?run=run-a&event=12", "the step inside the run");
  assert.equal(byType.file[0].href, "/chat/conv-a?m=msg-a", "the message the file was attached to");
});

test("hit ids are unique across types, so a keyboard cursor cannot land on two rows", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));
  const ids = result.groups.flatMap((g) => g.hits.map((h) => h.id));
  assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Coverage: a partial index says so
// ---------------------------------------------------------------------------

test("an unindexed document is reported rather than silently missing", async () => {
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(executor));
  const knowledge = result.coverage.find((c) => c.type === "knowledge");
  assert.equal(knowledge?.state, "partial");
  assert.match(knowledge?.detail ?? "", /still being indexed/);
  assert.equal(result.partial, true);
});

test("messages that cannot be decrypted are reported as unavailable, not as absent", async () => {
  // A wrong or missing key makes every body read as the same placeholder. Left
  // unreported, that is indistinguishable from "you never wrote that" — the
  // most damaging thing a search box can tell someone, because they will not
  // search again.
  const { executor } = fakeDatabase();
  const result = await runUnifiedSearch(
    { userId: USER_A, query: "guard clause" },
    deps(executor, () => UNDECRYPTABLE_PLACEHOLDER)
  );
  const messages = result.coverage.find((c) => c.type === "message");
  assert.equal(messages?.state, "unavailable");
  assert.match(messages?.detail ?? "", /encryption key/);
  assert.equal(result.groups.some((g) => g.type === "message"), false);
});

test("a source that throws costs its own group and nothing else", async () => {
  const { executor } = fakeDatabase();
  const breaking: SearchExecutor = {
    run: (statement) => {
      if (statement.text.includes('FROM "MemoryEntry"')) throw new Error("relation does not exist");
      return executor.run(statement);
    },
  };
  const result = await runUnifiedSearch({ userId: USER_A, query: "guard clause" }, deps(breaking));
  assert.equal(result.coverage.find((c) => c.type === "memory")?.state, "unavailable");
  assert.ok(result.groups.some((g) => g.type === "conversation"), "the chats someone wanted still arrive");
});

test("a query with nothing searchable in it is not an empty account", async () => {
  const { executor, statements } = fakeDatabase();
  const result = await runUnifiedSearch({ userId: USER_A, query: "  …  " }, deps(executor));
  assert.deepEqual(result.groups, []);
  assert.equal(result.partial, false, "no query is not a degraded search");
  assert.equal(statements.length, 0, "and it costs the database nothing");
});

test("a type filter searches only what was asked for", async () => {
  const { executor, statements } = fakeDatabase();
  const result = await runUnifiedSearch(
    { userId: USER_A, query: "guard clause", types: ["conversation", "memory"] },
    deps(executor)
  );
  assert.deepEqual(result.groups.map((g) => g.type), ["conversation", "memory"]);
  assert.equal(
    statements.some((s) => tableOf(s.text) === "ArtifactVersion"),
    false,
    "an unasked-for source should not be queried at all"
  );
});
