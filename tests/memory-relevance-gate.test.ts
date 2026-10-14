import test from "node:test";
import assert from "node:assert/strict";
import { selectMemoriesForContext, type LifecycleEntry } from "@/lib/memory-lifecycle";

/*
 * Memory is injected when it is about the message, not into every prompt.
 *
 * Before the gate, selection filled the 600-token budget on every turn: an
 * arithmetic question carried the person's job, trip and thesis notes under a
 * heading telling the model they were "relevant to this message". The suite
 * numbers (memory-eval.ts, tokens section) measure the effect over the
 * recorded histories; these pin the rule itself.
 */

const now = new Date("2026-10-01T00:00:00Z");
let seq = 0;
function fact(content: string, category: string | null, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    id: `f${++seq}`, content, normalized: null, category, projectId: null, source: "AUTO", kind: "FACT",
    confidence: 0.7, status: "active", expiresAt: null, createdAt: now, observedAt: now, ...extra,
  };
}

const facts = [
  fact("The user works at Globex as a product designer.", "identity"),
  fact("The user prefers short answers.", "preferences"),
  fact("The user prefers metric units.", "preferences"),
  fact("The user prefers British spelling.", "preferences"),
  fact("The user writes in a dark editor theme.", "preferences"),
  fact("The user is training for a half marathon in March.", "goals"),
  fact("The user's thesis uses APA citations.", "studies"),
  fact("The user deploys services with Terraform.", "workflows"),
  fact("The user's sister Ana lives in Madrid.", "relationships"),
];
const contents = (query: string | undefined, extra: Parameters<typeof selectMemoriesForContext>[1] = {}) =>
  selectMemoriesForContext(facts, { now, query, ...extra }).selected.map((m) => m.content);

test("an off-topic message gets at most the small ambient allowance — never goals, studies or people", () => {
  const picked = contents("What is 17 times 23?");
  assert.ok(picked.length <= 3, `${picked.length} facts injected`);
  for (const content of picked) assert.match(content, /works at|prefers/, `${content} rode along without relevance`);
  const result = selectMemoriesForContext(facts, { now, query: "What is 17 times 23?" });
  assert.equal(result.excluded.irrelevant, facts.length - picked.length, "the receipt can say why the rest stayed out");
});

test("a fact the message is about is admitted on a shared word", () => {
  assert.ok(contents("Make me a training plan for the marathon").some((c) => c.includes("half marathon")));
  assert.ok(contents("Which citation style does my thesis need?").some((c) => c.includes("APA")));
  assert.ok(!contents("Which citation style does my thesis need?").some((c) => c.includes("Terraform")));
});

test("a fact the message is about is admitted on a vector that stands out, with no shared word", () => {
  const sister = facts.find((f) => f.content.includes("Ana"))!;
  const vectors = new Map(facts.map((f) => [f.id, f === sister ? [0.9, 0.1] : [0.2, 0.98]]));
  const picked = selectMemoriesForContext(facts, {
    now,
    query: "Gift ideas for my sibling?",
    semantic: { queryVector: [1, 0], vectors },
  }).selected.map((m) => m.content);
  assert.ok(picked.some((c) => c.includes("Ana")), "the standout is admitted");
  assert.ok(!picked.some((c) => /marathon|APA|Terraform/.test(c)), "the field it stood out from is not");
});

test("when no vector stands out, semantic evidence admits nothing", () => {
  const vectors = new Map(facts.map((f) => [f.id, [0.5, 0.5]]));
  const picked = selectMemoriesForContext(facts, {
    now,
    query: "What is 17 times 23?",
    semantic: { queryVector: [1, 0], vectors },
  }).selected.map((m) => m.content);
  assert.ok(!picked.some((c) => /marathon|APA|Terraform|Ana/.test(c)));
});

test("no message to judge against, or an explicit opt-out, keeps the profile behaviour", () => {
  assert.equal(contents(undefined).length, facts.length);
  assert.equal(contents("   ").length, facts.length);
  assert.equal(contents("What is 17 times 23?", { relevanceGate: false }).length, facts.length);
});
