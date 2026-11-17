import test from "node:test";
import assert from "node:assert/strict";
import { DUPLICATE_FLAG_JACCARD, findMemoryOverlaps, overlapKey, replacedByReason } from "@/lib/memory-overlaps";
import { MERGE_JACCARD } from "@/lib/memory-lifecycle";

/*
 * The memory page flags two believed memories that say the same thing, or
 * disagree, and asks the person to keep one (memory-overlaps.ts). These pin
 * what it flags and, as much, what it must leave alone.
 */

let seq = 0;
const fact = (content: string, over: Partial<{ projectId: string | null; status: string; kind: string; id: string }> = {}) => ({
  id: over.id ?? `m${++seq}`,
  content,
  kind: over.kind ?? "FACT",
  status: over.status ?? "active",
  projectId: over.projectId ?? null,
});

test("near-copies are flagged as one fact said twice, including two the person typed", () => {
  const a = fact("Prefers short answers that lead with the recommendation", { id: "a" });
  const b = fact("Prefers short answers, leading with the recommendation first", { id: "b" });
  assert.deepEqual(findMemoryOverlaps([a, b]), [{ kind: "duplicate", ids: ["a", "b"] }]);
  // "named" and "called" are one word here, as in the automatic merge.
  const dog = findMemoryOverlaps([fact("Has a dog called Miso", { id: "d1" }), fact("Has a dog named Miso", { id: "d2" })]);
  assert.deepEqual(dog, [{ kind: "duplicate", ids: ["d1", "d2"] }]);
  // Asking starts below where the merge acts on its own.
  assert.ok(DUPLICATE_FLAG_JACCARD < MERGE_JACCARD);
});

test("two values for a one-value slot are flagged as a disagreement, with what it is about", () => {
  const lisbon = fact("The user lives in Lisbon.", { id: "lisbon" });
  const porto = fact("The user lives in Porto.", { id: "porto" });
  assert.deepEqual(findMemoryOverlaps([lisbon, porto]), [{ kind: "conflict", ids: ["lisbon", "porto"], noun: "where you live" }]);
});

test("what must not be flagged: different things, different numbers, other scopes, history", () => {
  assert.deepEqual(findMemoryOverlaps([fact("Is learning Spanish"), fact("Is learning Japanese")]), []);
  assert.deepEqual(findMemoryOverlaps([fact("Has 3 cats"), fact("Has 2 cats")]), []);
  // A project's memory may differ from the account's by design.
  assert.deepEqual(
    findMemoryOverlaps([fact("The user lives in Lisbon."), fact("The user lives in Porto.", { projectId: "p1" })]),
    []
  );
  // Only believed facts: a retired row or a block-list entry is not asked about.
  assert.deepEqual(findMemoryOverlaps([fact("The user lives in Lisbon."), fact("The user lives in Porto.", { status: "superseded" })]), []);
  assert.deepEqual(findMemoryOverlaps([fact("Has a dog called Miso"), fact("Has a dog called Miso", { kind: "SUPPRESSION" })]), []);
  // "lives in Leeds" and "no longer lives in Leeds" share their words and say opposite things.
  const leeds = findMemoryOverlaps([fact("The user lives in Leeds.", { id: "l1" }), fact("The user no longer lives in Leeds.", { id: "l2" })]);
  assert.ok(leeds.every((overlap) => overlap.kind === "conflict"), JSON.stringify(leeds));
});

test("each memory is asked about once, and a pair set aside stays set aside", () => {
  const facts = [
    fact("Has a dog called Miso", { id: "x1" }),
    fact("Has a dog named Miso", { id: "x2" }),
    fact("Has a dog called Miso, a shiba", { id: "x3" }),
  ];
  const overlaps = findMemoryOverlaps(facts);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0].ids, ["x1", "x2"]);
  // "Keep both" on that pair: the next pairing is offered instead.
  const next = findMemoryOverlaps(facts, { dismissed: new Set([overlapKey(["x2", "x1"])]) });
  assert.deepEqual(next.map((overlap) => overlap.ids), [["x1", "x3"]]);
  assert.equal(overlapKey(["b", "a"]), overlapKey(["a", "b"]));
});

test("the reason the set-aside memory shows quotes the one kept", () => {
  assert.equal(replacedByReason("duplicate", "Has a dog called Miso"), "Merged: you kept “Has a dog called Miso”, which says the same.");
  assert.equal(replacedByReason("conflict", "The user lives in Porto."), "You kept “The user lives in Porto.” instead.");
  assert.match(replacedByReason("conflict", "x".repeat(200)), /x{79}…”/);
});
