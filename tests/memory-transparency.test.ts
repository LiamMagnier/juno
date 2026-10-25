import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFact,
  consolidationMayUse,
  planDeletionEffects,
  planDuplicateMerges,
  planFactIngestion,
  planRewriteEffects,
  requestImpliesFact,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { revokedSensitiveTopics } from "@/lib/memory-sensitive";
import { compileBlockList, findSuppression, proseCoveredBySuppression } from "@/lib/memory-suppression";
import { invalidateSummariesForDeletedConversations } from "@/lib/memory-summary-changes";

/*
 * Master brief §10.3 — transparent and accurate memory — the pure rules:
 *
 *   - the person's own hand (a typed add, a rewrite) supersedes what it
 *     contradicts, with history, exactly as extraction does;
 *   - deleting a fact removes it from every row that remains (pointers and
 *     quoted reasons), not only from its own;
 *   - inappropriate personalisation: a sensitive fact Juno inferred never
 *     rides along with an unrelated message (a typed one does, like any typed
 *     fact), a request makes the dietary facts it does not name relevant, and
 *     turning a sensitive topic off stops the inferred facts already stored on
 *     it from being used or summarised.
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

test("a sensitive fact Juno inferred never rides along with an unrelated message; one the person typed does", () => {
  const entries = [
    fact("faith", "The user is a practising Muslim.", { category: "identity" }),
    fact("name", "The user is called Sam.", { category: "identity" }),
    fact("style", "The user prefers short answers.", { category: "preferences" }),
  ];
  const offTopic = selectMemoriesForContext(entries, { query: "What is 17 times 23?", now: NOW, allowedSensitiveTopics: ["religion"] });
  assert.ok(!offTopic.selected.some((m) => m.id === "faith"), "not ambient, even when the topic is allowed");
  assert.ok(offTopic.selected.some((m) => m.id === "style"), "ordinary ambient facts still ride along");
  // Typed, it is the person's to have used, like any other typed fact.
  const typed = entries.map((e): LifecycleEntry => (e.id === "faith" ? { ...e, source: "MANUAL", confidence: 0.9 } : e));
  const typedOffTopic = selectMemoriesForContext(typed, { query: "What is 17 times 23?", now: NOW, allowedSensitiveTopics: [] });
  assert.ok(typedOffTopic.selected.some((m) => m.id === "faith"), "a typed fact rides along within the allowance");
  assert.ok(typedOffTopic.selected.length <= 3, "still only the ambient allowance");
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

// ---------------------------------------------------------------------------
// What a request makes relevant without naming it
// ---------------------------------------------------------------------------

/** As the stored row would be: classified by the product's own rule. */
function classified(id: string, content: string, source: "AUTO" | "MANUAL"): LifecycleEntry {
  const { category, confidence } = classifyFact(content, { source });
  return fact(id, content, { category, confidence: source === "MANUAL" ? 0.9 : confidence, source });
}

test("a typed allergy reaches a recipe request in the lexical fallback (the verifier's probe)", () => {
  // Exactly the rows the review used: four typed facts, three of them on
  // food, no embedder. The allergy was dropped before; the legacy rule kept it.
  const entries = [
    classified("allergy", "The user has a severe peanut allergy.", "MANUAL"),
    classified("halal", "The user is Muslim and only eats halal food.", "MANUAL"),
    classified("veg", "The user is vegetarian.", "MANUAL"),
    classified("name", "The user's name is Liam.", "MANUAL"),
  ];
  for (const query of ["Suggest a dinner recipe for tonight", "Plan a 3-day food tour of Bangkok for me"]) {
    const ids = selectMemoriesForContext(entries, { query, now: NOW, allowedSensitiveTopics: [] }).selected.map((m) => m.id);
    for (const id of ["allergy", "halal", "veg"]) assert.ok(ids.includes(id), `${id} missing for ${query}: ${ids.join(",")}`);
  }
});

test("a food request makes dietary facts relevant — inferred or typed — and nothing else", () => {
  const entries = [
    classified("name", "The user is called Sam.", "AUTO"),
    classified("style", "The user prefers short answers.", "AUTO"),
    classified("diabetes", "The user has type 1 diabetes.", "AUTO"),
    classified("shellfish", "The user is allergic to shellfish.", "AUTO"),
    classified("kosher", "The user keeps kosher.", "MANUAL"),
    classified("coeliac", "The user is coeliac and cannot eat gluten.", "AUTO"),
    classified("faith", "The user is a practising Catholic.", "AUTO"),
    classified("debt", "The user is in debt after a failed startup.", "AUTO"),
  ];
  const all = ["health", "religion", "finances"];
  const meals = selectMemoriesForContext(entries, { query: "Plan my meals this week.", now: NOW, allowedSensitiveTopics: all });
  const ids = meals.selected.map((m) => m.id);
  for (const id of ["diabetes", "shellfish", "kosher", "coeliac"]) assert.ok(ids.includes(id), `${id} missing: ${ids.join(",")}`);
  assert.ok(!ids.includes("faith") && !ids.includes("debt"), "a sensitive fact unrelated to food stays out");

  // Not a food request: the inferred dietary facts are not ambient.
  const off = selectMemoriesForContext(entries, { query: "Explain how a hash map handles collisions.", now: NOW, allowedSensitiveTopics: all });
  assert.ok(!off.selected.some((m) => ["diabetes", "shellfish", "coeliac", "faith", "debt"].includes(m.id)));

  // Health switched off: what Juno inferred about it is not used even for a
  // recipe; the gates before this rule still decide.
  const revoked = selectMemoriesForContext(entries, { query: "Suggest a dinner recipe.", now: NOW, allowedSensitiveTopics: ["religion"] });
  assert.ok(!revoked.selected.some((m) => m.id === "diabetes" || m.id === "shellfish"));
  assert.ok(revoked.selected.some((m) => m.id === "kosher"));
  // And the block-list wins over relevance.
  const blocked = selectMemoriesForContext(entries, {
    query: "Suggest a dinner recipe.",
    now: NOW,
    allowedSensitiveTopics: all,
    suppressions: ["Anything about my diabetes"],
  });
  assert.ok(!blocked.selected.some((m) => m.id === "diabetes"));
});

test("the request → fact rule, read in full", () => {
  for (const query of ["Suggest a dinner recipe", "plan my meals this week", "Pick a restaurant for lunch", "What should I cook?", "a 3-day food tour of Bangkok", "grocery list for the week"]) {
    assert.ok(requestImpliesFact(query, "The user has a severe peanut allergy."), query);
  }
  for (const content of ["The user is lactose intolerant.", "The user keeps kosher.", "The user doesn't eat pork.", "The user is vegan.", "The user takes insulin before meals."]) {
    assert.ok(requestImpliesFact("Suggest a dinner recipe", content), content);
  }
  assert.equal(requestImpliesFact("What is 17 times 23?", "The user has a severe peanut allergy."), false);
  assert.equal(requestImpliesFact("Explain how a hash map works", "The user is vegan."), false);
  assert.equal(requestImpliesFact("Suggest a dinner recipe", "The user is a practising Catholic."), false);
  assert.equal(requestImpliesFact("Suggest a dinner recipe", "The user prefers short answers."), false);
  // Words that only sometimes mean food do not count: a coding question is not a meal.
  for (const query of ["Build a dropdown menu in React", "Bake the config into the Docker image", "What are the key takeaways from this RFC?", "Point the satellite dish"]) {
    assert.equal(requestImpliesFact(query, "The user has type 1 diabetes."), false, query);
  }
});

// ---------------------------------------------------------------------------
// The block-list, compiled once
// ---------------------------------------------------------------------------

test("a compiled block-list gives exactly the answers the plain one does", () => {
  const list = [
    "The user works at Acme",
    "Anything about my divorce",
    "topic: my ex",
    "Never remember anything about my side business",
    "",
    "   ",
  ];
  const compiled = compileBlockList(list);
  assert.equal(compiled.size, 4, "empty statements match nothing and are dropped");
  const candidates = [
    "The user works at Acme as a staff designer.",
    "works at acme",
    "The user is going through a divorce.",
    "The user is divorcing.",
    "The user's ex lives in Leeds.",
    "The user is preparing for the next exam.",
    "The user runs a side business selling prints.",
    "The user lives in Porto.",
    "Crème brûlée is the user's favourite.",
    "",
  ];
  for (const candidate of candidates) {
    assert.equal(findSuppression(candidate, compiled), findSuppression(candidate, list), candidate);
    assert.equal(proseCoveredBySuppression(candidate, compiled), proseCoveredBySuppression(candidate, list), candidate);
  }
  assert.equal(findSuppression("The user is going through a divorce.", compiled), "Anything about my divorce");
  assert.equal(findSuppression("The user is preparing for the next exam.", compiled), null, "ex is a word, not a substring");
  // An accented candidate still folds before matching.
  assert.equal(findSuppression("The user's divórce is final.", ["Anything about my divorce"]), "Anything about my divorce");
});

test("selection's block-list gate costs one parse per call, not one per fact", () => {
  const entries = Array.from({ length: 2000 }, (_, i) => fact(`f${i}`, `The user likes topic number ${i}.`, { category: "preferences" }));
  const suppressions = [
    ...Array.from({ length: 17 }, (_, i) => `The user works at Company${i}`),
    "Anything about my divorce",
    "Anything about my health",
    "Anything about my side business",
  ];
  const time = (opts: Parameters<typeof selectMemoriesForContext>[1]) => {
    const runs: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      selectMemoriesForContext(entries, { query: "topic plan", now: NOW, ...opts });
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[7];
  };
  const plain = time({});
  const gated = time({ suppressions, allowedSensitiveTopics: [] });
  // Before compilation the gated pass was ~9x the plain one (≈45 ms vs 5 ms on
  // the review machine). A generous bound: this guards the shape, not a number.
  assert.ok(gated < plain * 5 + 10, `gated ${gated.toFixed(1)} ms vs plain ${plain.toFixed(1)} ms`);
});

// ---------------------------------------------------------------------------
// Deletion propagation: only what the lifecycle actually quotes
// ---------------------------------------------------------------------------

test("deleting a short fact rewrites only reasons that QUOTE it, not every reason containing its words", () => {
  const forgotten = { ...fact("forgotten", "The user works at Initech.", { status: "suppressed" }), reason: "You asked Juno to forget this in a conversation." };
  const merged = { ...fact("merged", "Juno", { status: "superseded" }), reason: "Merged: it says the same as “Juno”.", supersededById: null };
  const effects = planDeletionEffects([{ id: "short", content: "Juno" }], [forgotten, merged]);
  assert.deepEqual(effects.map((e) => e.id), ["merged"], "the merge quote is rewritten; the unrelated reason is not");
});

// ---------------------------------------------------------------------------
// Deleting a chat takes the summaries its digest fed out of service
// ---------------------------------------------------------------------------

test("deleting chats invalidates the summary of every scope their digests went into, once", async () => {
  const calls: { account: number; projects: string[]; asked: unknown } = { account: 0, projects: [], asked: null };
  const db = {
    conversationMemory: {
      findMany: async (args: { where: { userId: string; conversationId: { in: string[] } } }) => {
        calls.asked = args.where;
        // Two digested chats in the account scope, one in project p1; the
        // undigested chat is not returned (digest: { not: null }).
        return [{ conversation: { projectId: null } }, { conversation: { projectId: null } }, { conversation: { projectId: "p1" } }];
      },
    },
    memorySummary: { deleteMany: async () => void calls.account++ },
    projectMemorySummary: {
      deleteMany: async (args: { where: { userId: string; projectId: string } }) => void calls.projects.push(args.where.projectId),
    },
  };
  const scopes = await invalidateSummariesForDeletedConversations(db as never, "u1", ["c1", "c2", "c3", "c4"]);
  assert.equal(scopes, 2);
  assert.equal(calls.account, 1, "the account summary once, however many of its chats went");
  assert.deepEqual(calls.projects, ["p1"]);
  assert.deepEqual(calls.asked, { userId: "u1", conversationId: { in: ["c1", "c2", "c3", "c4"] }, digest: { not: null } });
  // Nothing deleted: nothing asked.
  calls.asked = null;
  assert.equal(await invalidateSummariesForDeletedConversations(db as never, "u1", []), 0);
  assert.equal(calls.asked, null);
});

