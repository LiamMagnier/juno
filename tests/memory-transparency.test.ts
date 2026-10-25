import test from "node:test";
import assert from "node:assert/strict";
import {
  consolidationMayUse,
  planDeletionEffects,
  planDuplicateMerges,
  planFactIngestion,
  planRewriteEffects,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { revokedSensitiveTopics } from "@/lib/memory-sensitive";

/*
 * Master brief §10.3 — transparent and accurate memory — the pure rules:
 *
 *   - the person's own hand (a typed add, a rewrite) supersedes what it
 *     contradicts, with history, exactly as extraction does;
 *   - deleting a fact removes it from every row that remains (pointers and
 *     quoted reasons), not only from its own;
 *   - inappropriate personalisation: a sensitive fact never rides along with
 *     an unrelated message, and turning a sensitive topic off stops the
 *     inferred facts already stored on it from being used or summarised.
 */

const NOW = new Date("2026-10-25T12:00:00Z");
const DAY = 86_400_000;

function fact(id: string, content: string, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    id,
    content,
    normalized: null,
    category: "identity",
    projectId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: new Date(NOW.getTime() - 10 * DAY),
    observedAt: new Date(NOW.getTime() - 10 * DAY),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Manual writes supersede, with history
// ---------------------------------------------------------------------------

test("a typed fact replaces the inferred one it contradicts (the manual add path)", () => {
  const lisbon = fact("lisbon", "The user lives in Lisbon.");
  const plan = planFactIngestion(
    { content: "The user lives in Porto.", source: "MANUAL", observedAt: NOW },
    { entries: [lisbon], suppressions: [], now: NOW }
  );
  assert.equal(plan.action, "create");
  assert.ok(plan.action === "create" && plan.status === "active");
  assert.equal(plan.action === "create" ? plan.supersedes?.entryId : null, "lisbon");
  assert.match(plan.action === "create" ? plan.supersedes!.reason : "", /You said this yourself/);
});

test("a newer typed fact replaces an older typed one; typing a known fact confirms it", () => {
  const typed = fact("old", "The user lives in Lisbon.", { source: "MANUAL", confidence: 0.9 });
  const newer = planFactIngestion(
    { content: "The user lives in Porto.", source: "MANUAL", observedAt: NOW },
    { entries: [typed], suppressions: [], now: NOW }
  );
  assert.equal(newer.action === "create" ? newer.supersedes?.entryId : null, "old");
  const same = planFactIngestion(
    { content: "the user lives in Lisbon", source: "MANUAL", observedAt: NOW },
    { entries: [typed], suppressions: [], now: NOW }
  );
  assert.equal(same.action, "refresh", "a duplicate is a confirmation, never a second row");
});

test("rewrite effects: the new wording retires what it contradicts, duplicates or ends — in its scope only", () => {
  const written = { id: "w", content: "The user lives in Porto.", projectId: null };
  const entries = [
    fact("w", "The user lives in Porto.", { source: "MANUAL", confidence: 0.9, observedAt: NOW }),
    fact("lisbon", "The user lives in Lisbon."),
    fact("twin", "The user lives in Porto.", { createdAt: new Date(NOW.getTime() - 3 * DAY) }),
    fact("project-city", "The user lives in Madrid.", { projectId: "p1" }),
    fact("tea", "The user prefers tea.", { category: "preferences" }),
    fact("gone", "The user lives in Rome.", { status: "superseded" }),
  ];
  const effects = planRewriteEffects(written, entries, { now: NOW });
  assert.deepEqual(effects.map((e) => e.entryId).sort(), ["lisbon", "twin"]);
  assert.match(effects.find((e) => e.entryId === "twin")!.reason, /^Merged/);
  assert.match(effects.find((e) => e.entryId === "lisbon")!.reason, /where you live/);
});

test("rewrite effects: additive facts are never treated as conflicts", () => {
  const written = { id: "w", content: "The user is learning Japanese.", projectId: null };
  const entries = [fact("w", written.content), fact("es", "The user is learning Spanish.")];
  assert.deepEqual(planRewriteEffects(written, entries, { now: NOW }), []);
});

test("rewrite effects: a new job ends an inferred job search said before it", () => {
  const written = { id: "w", content: "The user works at Hooli.", projectId: null };
  const entries = [fact("w", written.content), fact("search", "The user is looking for a new job.")];
  const effects = planRewriteEffects(written, entries, { now: NOW });
  assert.deepEqual(effects.map((e) => e.entryId), ["search"]);
});

// ---------------------------------------------------------------------------
// Deletion propagation
// ---------------------------------------------------------------------------

test("deleting a fact clears every pointer at it and every reason that quotes it", () => {
  const keep = fact("keep", "The user prefers short answers with code examples.", { category: "preferences" });
  const twin = fact("merged", "The user prefers short answers with examples.", { category: "preferences" });
  // Use the merge rule's own reason, so the quote is exactly what production writes.
  const [merge] = planDuplicateMerges([{ ...keep, source: "MANUAL" }, twin]);
  assert.ok(merge?.reason.includes(keep.content), "the merge reason quotes the kept fact");
  const merged = { ...twin, status: "superseded", supersededById: "keep", reason: merge.reason };
  const stray = { ...fact("stray", "Old note", { status: "contradicted" }), reason: `It conflicts with “${keep.content}”.` };
  const unrelated = { ...fact("unrelated", "The user prefers tea.", { status: "superseded" }), reason: "Replaced by something newer." };

  const effects = planDeletionEffects([{ id: keep.id, content: keep.content }], [keep, merged, stray, unrelated]);
  assert.deepEqual(effects.map((e) => e.id).sort(), ["merged", "stray"]);
  const m = effects.find((e) => e.id === "merged")!;
  assert.equal(m.clearSupersededBy, true);
  assert.equal(m.reason, "Replaced by a memory you have since deleted.");
  assert.doesNotMatch(m.reason, /code examples/);
  const s = effects.find((e) => e.id === "stray")!;
  assert.equal(s.clearSupersededBy, false);
  assert.doesNotMatch(s.reason, /code examples/);
});

test("deleting a long fact also catches the truncated quote a merge writes", () => {
  const long = `The user ${"really ".repeat(15)}likes very long sentences.`;
  const truncatedQuote = `Merged: it says the same as “${long.slice(0, 79)}…”.`;
  const effects = planDeletionEffects(
    [{ id: "long", content: long }],
    [{ id: "other", supersededById: null, reason: truncatedQuote, status: "superseded" }]
  );
  assert.equal(effects.length, 1);
});

// ---------------------------------------------------------------------------
// Inappropriate personalisation
// ---------------------------------------------------------------------------

test("a sensitive fact never rides along with an unrelated message", () => {
  const entries = [
    fact("faith", "The user is a practising Muslim.", { category: "identity" }),
    fact("name", "The user is called Sam.", { category: "identity" }),
    fact("style", "The user prefers short answers.", { category: "preferences" }),
  ];
  const offTopic = selectMemoriesForContext(entries, { query: "What is 17 times 23?", now: NOW, allowedSensitiveTopics: ["religion"] });
  assert.ok(!offTopic.selected.some((m) => m.id === "faith"), "not ambient, even when the topic is allowed");
  assert.ok(offTopic.selected.some((m) => m.id === "style"), "ordinary ambient facts still ride along");
  // About the message: used.
  const onTopic = selectMemoriesForContext(entries, {
    query: "Suggest a Ramadan-friendly meal plan; I'm a practising Muslim",
    now: NOW,
    allowedSensitiveTopics: ["religion"],
  });
  assert.ok(onTopic.selected.some((m) => m.id === "faith"));
});

test("turning a sensitive topic off stops inferred facts on it from being used; typed ones stay", () => {
  const entries = [
    fact("auto", "The user has asthma.", { category: "identity" }),
    fact("typed", "The user takes insulin twice a day.", { source: "MANUAL", confidence: 0.9 }),
  ];
  const query = "asthma insulin plan for my run";
  const off = selectMemoriesForContext(entries, { query, now: NOW, allowedSensitiveTopics: [] });
  assert.deepEqual(off.selected.map((m) => m.id), ["typed"]);
  assert.equal(off.excluded.sensitive, 1);
  const on = selectMemoriesForContext(entries, { query, now: NOW, allowedSensitiveTopics: ["health"] });
  assert.deepEqual(on.selected.map((m) => m.id).sort(), ["auto", "typed"]);
  // A caller that did not load the setting gets the old behaviour, not a silent filter.
  assert.equal(selectMemoriesForContext(entries, { query, now: NOW }).selected.length, 2);
});

test("the summariser is shown only what the chat may use", () => {
  assert.equal(consolidationMayUse({ content: "The user has asthma.", source: "AUTO" }, [], []), false);
  assert.equal(consolidationMayUse({ content: "The user has asthma.", source: "AUTO" }, [], ["health"]), true);
  assert.equal(consolidationMayUse({ content: "The user has asthma.", source: "MANUAL" }, [], []), true);
  assert.equal(consolidationMayUse({ content: "The user's ex lives in Leeds.", source: "MANUAL" }, ["Anything about my ex"], []), false);
  assert.equal(consolidationMayUse({ content: "The user lives in Porto.", source: "AUTO" }, ["Anything about my ex"], []), true);
});

test("revoked sensitive topics: only what was on before and is off now", () => {
  assert.deepEqual(revokedSensitiveTopics(["health", "religion"], ["religion"]), ["health"]);
  assert.deepEqual(revokedSensitiveTopics([], ["health"]), []);
  assert.deepEqual(revokedSensitiveTopics(["health", "not-a-topic"], []), ["health"]);
  assert.deepEqual(revokedSensitiveTopics(null, null), []);
});
