import test from "node:test";
import assert from "node:assert/strict";
import { detectRepeatedMethods, skillDraftFromCandidate, type MethodRun } from "@/lib/procedural-memory";

const run = (id: string, title: string, goal: string, tools: string[], day: number, projectId: string | null = null): MethodRun => ({
  sessionId: id,
  title,
  goal,
  projectId,
  finishedAt: new Date(Date.UTC(2026, 8, day)),
  tools,
});

test("three successful runs of the same task with the same tools become one proposal; two do not", () => {
  const runs = [
    run("a", "Weekly investor update", "Draft this week's investor update from the metrics sheet", ["read_spreadsheet", "write_document"], 1),
    run("b", "Weekly investor update", "Write the weekly investor update from the metrics sheet", ["read_spreadsheet", "write_document"], 8),
    run("c", "Investor update", "Draft the investor update from the metrics sheet and changelog", ["read_spreadsheet", "write_document", "web_search"], 15),
    run("d", "Plan a trip", "Plan a weekend in Porto", ["web_search"], 16),
    run("e", "Plan a trip", "Plan a weekend in Lisbon", ["web_search"], 17),
  ];
  const candidates = detectRepeatedMethods(runs);
  assert.equal(candidates.length, 1);
  const [c] = candidates;
  assert.equal(c.title, "Weekly investor update", "a title the runs already carried");
  assert.deepEqual(c.tools, ["read_spreadsheet", "write_document"], "tools most runs used, not one run's extra");
  assert.deepEqual(c.sessionIds.sort(), ["a", "b", "c"]);
  assert.equal(detectRepeatedMethods(runs).at(0)?.key, c.key, "stable identity across refreshes");
});

test("the same words with no shared tools, or across projects, are not a method", () => {
  const noTools = [1, 2, 3].map((d) => run(`n${d}`, "Weekly investor update", "Draft the investor update from the metrics sheet", [], d));
  assert.equal(detectRepeatedMethods(noTools).length, 0);
  const split = [
    run("p1", "Weekly investor update", "Draft the investor update from the metrics sheet", ["write_document"], 1, "p-a"),
    run("p2", "Weekly investor update", "Draft the investor update from the metrics sheet", ["write_document"], 2, "p-b"),
    run("p3", "Weekly investor update", "Draft the investor update from the metrics sheet", ["write_document"], 3, null),
  ];
  assert.equal(detectRepeatedMethods(split).length, 0);
});

test("the draft is built only from the person's own requests and tools", () => {
  const draft = skillDraftFromCandidate({ title: "Weekly investor update", examples: ["Draft the update"], tools: ["write_document"] });
  assert.equal(draft.name, "Weekly investor update");
  assert.match(draft.instructions, /- Draft the update/);
  assert.match(draft.instructions, /write_document/);
});
