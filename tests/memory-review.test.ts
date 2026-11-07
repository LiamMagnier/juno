import test from "node:test";
import assert from "node:assert/strict";
import { memoriesToReview, reviewReason } from "@/components/memory/memory-review";
import type { Memory } from "@/components/memory/memory-model";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function fact(over: Partial<Memory> = {}): Memory {
  return {
    id: "m",
    content: "Lives in Lyon",
    source: "AUTO",
    kind: "FACT",
    sourceRef: null,
    createdAt: daysAgo(10),
    category: "identity",
    projectId: null,
    projectName: null,
    sourceMessageId: null,
    confidence: 0.9,
    status: "active",
    reason: null,
    expiresAt: null,
    lastUsedAt: null,
    lastVerifiedAt: null,
    supersededById: null,
    sensitive: null,
    ...over,
  };
}

test("a confident, recent fact is not asked about", () => {
  assert.equal(reviewReason(fact(), NOW), null);
});

test("an inferred fact nobody confirmed is unsure", () => {
  assert.equal(reviewReason(fact({ confidence: 0.5 }), NOW), "unsure");
});

test("confirming an inferred fact takes it out of review", () => {
  assert.equal(reviewReason(fact({ confidence: 0.5, lastVerifiedAt: daysAgo(1) }), NOW), null);
});

test("a fact last known true over six months ago is stale", () => {
  assert.equal(reviewReason(fact({ createdAt: daysAgo(200) }), NOW), "stale");
  // When it was SAID wins over when it was written down.
  assert.equal(reviewReason(fact({ createdAt: daysAgo(5), observedAt: daysAgo(400) }), NOW), "stale");
  assert.equal(reviewReason(fact({ createdAt: daysAgo(400), lastVerifiedAt: daysAgo(3) }), NOW), null);
});

test("temporary, expiring, retired and block-list rows are never reviewed", () => {
  assert.equal(reviewReason(fact({ confidence: 0.3, category: "temporary" }), NOW), null);
  assert.equal(reviewReason(fact({ confidence: 0.3, expiresAt: daysAgo(-5) }), NOW), null);
  assert.equal(reviewReason(fact({ confidence: 0.3, status: "superseded" }), NOW), null);
  assert.equal(reviewReason(fact({ confidence: 0.3, kind: "SUPPRESSION" }), NOW), null);
});

test("the least certain come first, then the oldest", () => {
  const list = memoriesToReview(
    [
      fact({ id: "old", createdAt: daysAgo(300) }),
      fact({ id: "guess", confidence: 0.4 }),
      fact({ id: "fine" }),
      fact({ id: "older", createdAt: daysAgo(500) }),
      fact({ id: "half", confidence: 0.6 }),
    ],
    NOW
  );
  assert.deepEqual(
    list.map((item) => item.memory.id),
    ["guess", "half", "older", "old"]
  );
});
