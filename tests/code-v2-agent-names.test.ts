/**
 * Agents are named for their work (src/lib/code-v2/agent-names.ts), never
 * "Worker 2". These cases are also the contract for the Swift twin,
 * native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2/CodeV2AgentNames.swift
 * (CodeV2AgentNamesTests.swift reads the same contracts/code/agent-names.json).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { AGENT_NAME_MAX_CHARS, agentDisplayName, agentDisplayNames, isGenericAgentLabel, verbBase } from "@/lib/code-v2/agent-names";
import { agentNamesFor } from "@/lib/code-v2/agent-tree";
import type { SubagentItem, TurnItem } from "@/lib/code-v2/contracts";

type Case = [string | null, string | null, string | null, SubagentItem["role"], string];
const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "contracts/code/agent-names.json"), "utf8")) as {
  cases: Case[];
  repeats: { tasks: string[]; names: string[] };
};

test("names come from the work, and labels chosen on purpose are kept", () => {
  assert.ok(fixture.cases.length >= 20);
  for (const [label, title, task, role, want] of fixture.cases) {
    assert.equal(agentDisplayName({ label: label ?? undefined, title: title ?? undefined, task: task ?? undefined, role }), want, JSON.stringify({ label, title, task }));
  }
});

test("only a role word and a number counts as a generic label", () => {
  for (const generic of ["Worker 1", "worker", "Builder 12", "Agent #3", "Subagent 2", "Explorer", "", undefined]) assert.equal(isGenericAgentLabel(generic), true, String(generic));
  for (const kept of ["Hook audit", "Candidate B", "Architect", "Verifier", "Reviewer", "Worker bee"]) assert.equal(isGenericAgentLabel(kept), false, kept);
});

test("a verb is read in any of its forms", () => {
  assert.equal(verbBase("redesigning"), "redesign");
  assert.equal(verbBase("checks"), "check");
  assert.equal(verbBase("mapped"), "map");
  assert.equal(verbBase("writing"), "write");
  assert.equal(verbBase("fixes"), "fix");
  assert.equal(verbBase("server"), null);
  // Only the lexicon's own words: nothing on Object.prototype is a verb.
  assert.equal(verbBase("constructor"), null);
  assert.equal(verbBase("toString"), null);
  assert.equal(agentDisplayName({ role: "worker", task: "Constructor cleanup for the parser" }), "Cleanup builder");
});

test("a name stays short enough for a row", () => {
  const long = agentDisplayName({ role: "worker", task: "Refactor the extremely complicated legacy payment reconciliation service" });
  assert.ok(long.length <= AGENT_NAME_MAX_CHARS, long);
  assert.match(long, /refactorer$/);
});

test("two agents with the same work are told apart by a number after the first", () => {
  const names = agentDisplayNames(fixture.repeats.tasks.map((task, i) => ({ agentId: `a${i}`, role: "worker" as const, task })));
  assert.deepEqual([...names.values()], fixture.repeats.names);
});

test("a run's names are read once from its items, newest snapshot per agent", () => {
  const at = "2026-11-22T12:00:00.000Z";
  const items: TurnItem[] = [
    { id: "s1", kind: "subagent", agentId: "w1", role: "worker", label: "Worker 1", title: "Map the auth middleware", model: { instanceId: "alevr", model: "m" }, status: "running", createdAt: at },
    { id: "s2", kind: "subagent", agentId: "w2", role: "worker", label: "Worker 2", title: "Check the password reset form", model: { instanceId: "alevr", model: "m" }, status: "running", createdAt: at },
    { id: "s3", kind: "subagent", agentId: "w1", role: "worker", label: "Worker 1", title: "Map the auth middleware", model: { instanceId: "alevr", model: "m" }, status: "completed", createdAt: at },
  ];
  assert.deepEqual(Object.fromEntries(agentNamesFor(items)), { w1: "Auth middleware mapper", w2: "Reset form checker" });
});
