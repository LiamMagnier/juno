import test from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_FROM,
  TOPIC_GROUPS,
  groupMemories,
  memorySearchText,
  offerSearch,
  sourceGroupOf,
  topicGroupOf,
} from "@/components/memory/memory-groups";
import type { Memory } from "@/components/memory/memory-model";
import { MEMORY_CATEGORIES } from "@/lib/memory-categories";

/*
 * The memory list's groups (memory-groups.ts): five topics a person sorts
 * their life by in place of the classifier's nine, where each memory came
 * from, and when. Retired rows never appear in a group.
 */

const NOW = new Date("2026-11-16T12:00:00Z");
let seq = 0;
function memory(content: string, over: Partial<Memory> = {}): Memory {
  seq += 1;
  return {
    id: `m${seq}`,
    content,
    source: "AUTO",
    kind: "FACT",
    sourceRef: `chat000000000${seq}`,
    createdAt: "2026-11-10T09:00:00.000Z",
    category: "identity",
    projectId: null,
    projectName: null,
    sourceMessageId: null,
    confidence: 0.8,
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

test("every category the classifier writes lands in exactly one topic group", () => {
  for (const category of MEMORY_CATEGORIES) {
    if (category === "suppression") continue;
    const owners = TOPIC_GROUPS.filter((group) => group.categories.includes(category));
    assert.equal(owners.length, 1, category);
  }
  // No category, or one this build has never heard of: "Other", never a crash.
  assert.equal(topicGroupOf(null), "other");
  assert.equal(topicGroupOf("hobbies-from-the-future"), "other");
  assert.equal(topicGroupOf("relationships"), "about");
  assert.equal(topicGroupOf("workflows"), "work");
});

test("by topic: groups in reading order, newest first inside, empty groups and retired rows left out", () => {
  const facts = [
    memory("Prefers British spelling", { category: "preferences", createdAt: "2026-10-01T09:00:00.000Z" }),
    memory("Lives in Lisbon", { category: "identity" }),
    memory("Prefers metric units", { category: "preferences", createdAt: "2026-11-15T09:00:00.000Z" }),
    memory("Lived in Dublin", { category: "identity", status: "superseded" }),
    memory("Flying to Tokyo on Friday", { category: "temporary" }),
    memory("Never remember my salary", { kind: "SUPPRESSION", category: "suppression" }),
    memory("An old fact", { category: null }),
  ];
  const groups = groupMemories(facts, "topic", NOW);
  assert.deepEqual(groups.map((group) => group.id), ["about", "preferences", "now", "other"]);
  assert.deepEqual(groups[0].rows.map((row) => row.content), ["Lives in Lisbon"]);
  assert.deepEqual(groups[1].rows.map((row) => row.content), ["Prefers metric units", "Prefers British spelling"]);
  assert.equal(groups.find((group) => group.id === "about")?.label, "About you");
});

test("by source: what you told it, what it learned from chats, what was imported", () => {
  assert.equal(sourceGroupOf({ sourceRef: "manual", source: "MANUAL" }), "you");
  assert.equal(sourceGroupOf({ sourceRef: "edit", source: "MANUAL" }), "you");
  assert.equal(sourceGroupOf({ sourceRef: "import", source: "MANUAL" }), "imported");
  assert.equal(sourceGroupOf({ sourceRef: "chat0000000001", source: "AUTO" }), "chats");
  // "Remember that…" said in a chat is the person's own statement.
  assert.equal(sourceGroupOf({ sourceRef: "chat0000000001", source: "MANUAL" }), "you");
  assert.equal(sourceGroupOf({ sourceRef: null, source: "AUTO" }), "other");

  const groups = groupMemories(
    [memory("Goes by Liam", { sourceRef: "import", source: "MANUAL" }), memory("Lives in Lisbon"), memory("Wants metric units", { sourceRef: "manual", source: "MANUAL" })],
    "source",
    NOW
  );
  assert.deepEqual(groups.map((group) => [group.id, group.rows.length]), [["you", 1], ["chats", 1], ["imported", 1]]);
});

test("by newest: dated by when it was said, not when it was written down", () => {
  const groups = groupMemories(
    [
      memory("Said today", { createdAt: "2026-11-16T08:00:00.000Z" }),
      // Re-read today out of a chat from last month.
      memory("Said last month", { createdAt: "2026-11-16T08:30:00.000Z", observedAt: "2026-10-20T08:00:00.000Z" }),
    ],
    "newest",
    NOW
  );
  assert.deepEqual(groups.map((group) => [group.id, group.rows.map((row) => row.content)]), [
    ["today", ["Said today"]],
    ["month", ["Said last month"]],
  ]);
});

test("search is offered once the list is long, or while a query is typed", () => {
  assert.equal(offerSearch(SEARCH_FROM - 1), false);
  assert.equal(offerSearch(SEARCH_FROM), true);
  assert.equal(offerSearch(2, "lis"), true);
  assert.equal(offerSearch(2, "   "), false);
  // A memory is found by its words, its group and its project.
  const text = memorySearchText(memory("Cites in APA", { category: "projects", projectName: "Thesis" }));
  assert.match(text, /cites in apa/);
  assert.match(text, /your work/);
  assert.match(text, /thesis/);
});
