import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MEMORY_TOKEN_BUDGET,
  classifyFact,
  estimateMemoryTokens,
  memoryReceiptDetail,
  normalizeFact,
  planFactIngestion,
  resolveContradiction,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";

/*
 * Memory v2 lifecycle. The behaviours under test are the ones the old memory
 * system got wrong in ways nobody could see from the UI: it appended a row for
 * every restatement, it had no way to stop believing something, and injection
 * was a `take: 15` with no scope check — so a fact learned inside a project
 * followed the user into unrelated chats.
 *
 * These are pure functions on purpose; there is no database in tests, and the
 * decisions worth protecting are decisions, not queries.
 */

const NOW = new Date("2026-08-08T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function entry(over: Partial<LifecycleEntry> & { id: string; content: string }): LifecycleEntry {
  return {
    normalized: null,
    category: "identity",
    projectId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: daysAgo(1),
    ...over,
  };
}

const context = (entries: LifecycleEntry[], suppressions: string[] = []) => ({
  entries,
  suppressions,
  now: NOW,
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

test("the normalized form ignores phrasing, filler and word order", () => {
  assert.equal(normalizeFact("The user prefers dark mode"), normalizeFact("prefers dark mode"));
  assert.equal(normalizeFact("The user prefers dark mode"), normalizeFact("Dark mode is preferred by the user"));
  // Different facts must NOT collapse — the dedup is worthless if it eats them.
  assert.notEqual(normalizeFact("The user prefers dark mode"), normalizeFact("The user prefers light mode"));
});

test("a restated fact refreshes the existing row instead of adding one", () => {
  const known = entry({ id: "m1", content: "The user prefers dark mode", category: "preferences" });
  const plan = planFactIngestion(
    { content: "Dark mode is preferred by the user", source: "AUTO" },
    context([known])
  );
  assert.equal(plan.action, "refresh");
  assert.equal(plan.action === "refresh" && plan.entryId, "m1");
});

test("an identically worded fact in another project is not a duplicate", () => {
  // Scope is part of the fact: the same sentence inside a project and outside it
  // are two beliefs, because only one of them is visible in unrelated chats.
  const scoped = entry({ id: "m1", content: "The user prefers dark mode", projectId: "proj-a" });
  const plan = planFactIngestion({ content: "The user prefers dark mode", source: "AUTO" }, context([scoped]));
  assert.equal(plan.action, "create");
});

test("a suppression blocks the fact from being stored at all", () => {
  const plan = planFactIngestion(
    { content: "The user lives in Berlin", source: "AUTO" },
    context([], ["lives in Berlin"])
  );
  assert.deepEqual(plan, { action: "skip", reason: "suppressed" });
});

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

test("a conflicting fact supersedes the old one — it never deletes it", () => {
  const old = entry({ id: "m1", content: "The user lives in Berlin" });
  const plan = planFactIngestion({ content: "The user lives in Lisbon", source: "AUTO" }, context([old]));
  assert.equal(plan.action, "create");
  assert.equal(plan.action === "create" && plan.status, "active");
  assert.equal(plan.action === "create" && plan.supersedes?.entryId, "m1");
  // The reason is user-facing copy, so it has to say something.
  assert.ok(plan.action === "create" && (plan.supersedes?.reason.length ?? 0) > 10);
});

test("two facts that merely share vocabulary are both kept", () => {
  // "learning Spanish" and "learning Japanese" overlap almost completely and are
  // both true. A contradiction rule that fires here destroys real memories.
  const known = entry({ id: "m1", content: "The user is learning Spanish", category: "studies" });
  const plan = planFactIngestion({ content: "The user is learning Japanese", source: "AUTO" }, context([known]));
  assert.equal(plan.action, "create");
  assert.equal(plan.action === "create" && plan.supersedes, undefined);
});

test("an explicit correction beats an older inferred fact", () => {
  const inferred = entry({ id: "m1", content: "The user works at Acme", source: "AUTO", confidence: 0.7 });
  const plan = planFactIngestion({ content: "The user works at Globex", source: "MANUAL" }, context([inferred]));
  assert.equal(plan.action === "create" && plan.status, "active");
  assert.equal(plan.action === "create" && plan.supersedes?.entryId, "m1");
});

test("an inferred fact never overturns something the user stated themselves", () => {
  const stated = entry({ id: "m1", content: "The user works at Acme", source: "MANUAL", confidence: 0.9 });
  const plan = planFactIngestion({ content: "The user works at Globex", source: "AUTO" }, context([stated]));
  // Still stored — the trail matters — but marked so retrieval never uses it.
  assert.equal(plan.action, "create");
  assert.equal(plan.action === "create" && plan.status, "contradicted");
  assert.equal(plan.action === "create" && plan.supersedes, undefined);
  assert.ok(plan.action === "create" && (plan.reason?.length ?? 0) > 10);
});

test("between equally explicit facts, the newer one wins unless the old one is far more confident", () => {
  assert.equal(resolveContradiction({ source: "AUTO", confidence: 0.7 }, { source: "AUTO", confidence: 0.65 }).winner, "incoming");
  assert.equal(resolveContradiction({ source: "AUTO", confidence: 0.9 }, { source: "AUTO", confidence: 0.5 }).winner, "existing");
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

test("a time-bounded fact is classified temporary and given a deadline", () => {
  assert.equal(classifyFact("The user is travelling to Lisbon this week").category, "temporary");
  const plan = planFactIngestion({ content: "The user is travelling to Lisbon this week", source: "AUTO" }, context([]));
  assert.equal(plan.action, "create");
  assert.ok(plan.action === "create" && plan.expiresAt instanceof Date);
  assert.ok(plan.action === "create" && plan.expiresAt!.getTime() > NOW.getTime());
});

test("a durable fact is given no deadline", () => {
  const plan = planFactIngestion({ content: "The user lives in Berlin", source: "AUTO" }, context([]));
  assert.equal(plan.action === "create" && plan.expiresAt, null);
});

test("expired entries are excluded from retrieval", () => {
  const result = selectMemoriesForContext(
    [
      entry({ id: "live", content: "The user lives in Berlin" }),
      entry({ id: "stale", content: "The user is in Lisbon until Friday", category: "temporary", expiresAt: daysAgo(2) }),
    ],
    { now: NOW }
  );
  assert.deepEqual(result.selected.map((m) => m.id), ["live"]);
  assert.equal(result.excluded.expired, 1);
});

test("a restated expired fact is revived rather than duplicated", () => {
  const stale = entry({
    id: "m1",
    content: "The user is in Lisbon this week",
    category: "temporary",
    status: "expired",
    expiresAt: daysAgo(2),
  });
  const plan = planFactIngestion({ content: "The user is in Lisbon this week", source: "AUTO" }, context([stale]));
  assert.equal(plan.action, "refresh");
  assert.equal(plan.action === "refresh" && plan.revive, true);
  assert.ok(plan.action === "refresh" && plan.expiresAt!.getTime() > NOW.getTime());
});

test("superseded and contradicted entries are never injected", () => {
  const result = selectMemoriesForContext(
    [
      entry({ id: "old", content: "The user lives in Berlin", status: "superseded" }),
      entry({ id: "new", content: "The user lives in Lisbon" }),
    ],
    { now: NOW }
  );
  assert.deepEqual(result.selected.map((m) => m.id), ["new"]);
  assert.equal(result.excluded.inactive, 1);
});

// ---------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------

test("project-scoped memory is invisible outside its project", () => {
  const entries = [
    entry({ id: "global", content: "The user lives in Berlin" }),
    entry({ id: "scoped", content: "The thesis is due in March", projectId: "proj-a" }),
  ];

  const outside = selectMemoriesForContext(entries, { now: NOW, projectId: null });
  assert.deepEqual(outside.selected.map((m) => m.id), ["global"]);
  assert.equal(outside.excluded.outOfScope, 1);

  const otherProject = selectMemoriesForContext(entries, { now: NOW, projectId: "proj-b" });
  assert.deepEqual(otherProject.selected.map((m) => m.id), ["global"]);

  const inside = selectMemoriesForContext(entries, { now: NOW, projectId: "proj-a" });
  assert.deepEqual(inside.selected.map((m) => m.id).sort(), ["global", "scoped"]);
});

test("inside a project, that project's memory outranks a global fact", () => {
  const result = selectMemoriesForContext(
    [
      entry({ id: "global", content: "The user lives in Berlin" }),
      entry({ id: "scoped", content: "The thesis is due in March", projectId: "proj-a", createdAt: daysAgo(40) }),
    ],
    { now: NOW, projectId: "proj-a" }
  );
  assert.equal(result.selected[0].id, "scoped");
});

// ---------------------------------------------------------------------------
// Token budget and receipt
// ---------------------------------------------------------------------------

test("retrieval stops at the token budget and reports what it dropped", () => {
  const long = "x".repeat(400); // ~102 tokens each
  const entries = Array.from({ length: 20 }, (_, i) =>
    entry({ id: `m${i}`, content: `${long} ${i}`, createdAt: daysAgo(i) })
  );

  const result = selectMemoriesForContext(entries, { now: NOW, budgetTokens: 300 });
  assert.ok(result.usedTokens <= 300, `used ${result.usedTokens} tokens against a 300 budget`);
  assert.ok(result.selected.length > 0 && result.selected.length < entries.length);
  assert.equal(result.selected.length + result.droppedForBudget, entries.length);
});

test("a short fact still fits after a long one was skipped", () => {
  // First-fit rather than stop-at-first-miss: one 500-token fact near the top of
  // the ranking must not cost every short fact behind it its place.
  const result = selectMemoriesForContext(
    [
      entry({ id: "huge", content: "x".repeat(2000), createdAt: daysAgo(0) }),
      entry({ id: "small", content: "The user lives in Berlin", createdAt: daysAgo(1) }),
    ],
    { now: NOW, budgetTokens: 100 }
  );
  assert.deepEqual(result.selected.map((m) => m.id), ["small"]);
  assert.equal(result.droppedForBudget, 1);
});

test("the default budget is small enough not to crowd out the conversation", () => {
  assert.ok(DEFAULT_MEMORY_TOKEN_BUDGET <= 1000);
  assert.ok(estimateMemoryTokens("The user lives in Berlin") < 15);
});

test("the receipt names the memories rather than counting them", () => {
  const result = selectMemoriesForContext(
    [
      entry({ id: "m1", content: "The user lives in Berlin", category: "identity" }),
      entry({ id: "m2", content: "The user prefers dark mode", category: "preferences" }),
    ],
    { now: NOW }
  );
  const detail = memoryReceiptDetail(result);
  assert.match(detail, /Berlin/);
  assert.match(detail, /dark mode/);
  assert.match(detail, /Identity|Preferences/);
});

test("the receipt says so when nothing was used", () => {
  assert.equal(memoryReceiptDetail({ selected: [], droppedForBudget: 0 }), "No stored memory applied");
});
