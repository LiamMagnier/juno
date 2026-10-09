import assert from "node:assert/strict";
import { test } from "node:test";

import { isSettled, relativeAge, workList, workProjects, type ThreadSummary } from "@/lib/code-v2/thread-sections";
import { gapBefore } from "@/components/code/v2/dock";
import { agentStep, teamHead } from "@/components/code/v2/thread";
import { modelSourceLine, roleTabs, usageLine } from "@/components/code/v2/pickers";
import { placeholder } from "@/components/code/v2/composer";
import { parseUnifiedDiff, type DiffHunk } from "@/lib/code-v2/diff";
import type { SubagentItem } from "@/lib/code-v2/contracts";
import { INSTANCES } from "../src/app/dev/code-v2/fixtures";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (m: number) => new Date(NOW - m * 60_000).toISOString();
const t = (id: string, over: Partial<ThreadSummary>): ThreadSummary => ({ id, title: id, project: "storefront", state: "idle", updatedAt: ago(5), ...over });

test("work list: needs you, then working, then by recency; old or settled sessions fold away", () => {
  const list = workList(
    [
      t("idle-new", { updatedAt: ago(1) }),
      t("working", { state: "running", updatedAt: ago(30) }),
      t("needs", { state: "waiting", updatedAt: ago(90) }),
      t("old", { updatedAt: ago(60 * 24 * 5) }),
      t("marked", { settled: true }),
      t("other-project", { project: "docs", updatedAt: ago(2) }),
    ],
    { now: NOW },
  );
  assert.deepEqual(list.active.map((x) => x.id), ["needs", "working", "idle-new", "other-project"]);
  assert.deepEqual(list.settled.map((x) => x.id), ["marked", "old"]);
  assert.equal(isSettled(t("w", { state: "running", settled: true }), NOW), false, "a working session never settles");
  assert.deepEqual(workList([t("a", {}), t("b", { project: "docs" })], { project: "docs", now: NOW }).active.map((x) => x.id), ["b"]);
  assert.deepEqual(workProjects([t("a", { updatedAt: ago(9) }), t("b", { project: "docs", updatedAt: ago(1) })]), ["docs", "storefront"]);
});

test("relative age is short: now, minutes, hours, days, weeks", () => {
  assert.equal(relativeAge(ago(0.2), NOW), "now");
  assert.equal(relativeAge(ago(12), NOW), "12m");
  assert.equal(relativeAge(ago(180), NOW), "3h");
  assert.equal(relativeAge(ago(60 * 24 * 2), NOW), "2d");
  assert.equal(relativeAge(ago(60 * 24 * 30), NOW), "4w");
});

test("diff gaps count the unmodified lines between hunks", () => {
  const [file] = parseUnifiedDiff("--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -30,2 +30,3 @@\n e\n+f\n g\n", "x.ts");
  const hunks: DiffHunk[] = file.hunks;
  assert.equal(gapBefore(hunks, 0), 0);
  assert.equal(gapBefore(hunks, 1), 26);
});

test("team words: one line for the group, one step per agent, Waiting for you when it needs the reader", () => {
  const base = { kind: "subagent" as const, createdAt: "t", model: { instanceId: "alevr", model: "m" } };
  const items: SubagentItem[] = [
    { ...base, id: "1", agentId: "w1", role: "worker", status: "completed", closingText: "Done it." },
    { ...base, id: "2", agentId: "w2", role: "worker", status: "waiting", liveLine: "wants to run a command" },
    { ...base, id: "3", agentId: "w3", role: "worker", status: "running", liveLine: "Editing total.ts" },
    { ...base, id: "4", agentId: "e1", role: "explorer", status: "completed" },
  ];
  assert.equal(teamHead(items), "3 workers and an explorer");
  assert.deepEqual(agentStep(items[1]), { text: "Waiting for you", needs: true });
  assert.equal(agentStep(items[2]).text, "Editing total.ts");
  assert.equal(teamHead([{ ...items[0], label: "Candidate A" }, { ...items[2], label: "Candidate B" }]), "2 candidates");
});

test("picker words: source lines, plan usage, role tabs; placeholders without em dashes", () => {
  const claude = INSTANCES.find((i) => i.id === "claude-agent:default")!;
  assert.equal(modelSourceLine(claude, "claude-opus-5-5"), "Your Claude plan · 1M");
  const alevr = INSTANCES.find((i) => i.id === "alevr")!;
  assert.match(modelSourceLine(alevr, alevr.models![0].id), /^Alevr · \$[\d.]+ \/ \$[\d.]+ · /);
  assert.match(usageLine(claude) ?? "", /^38% of 5-hour window, resets /);
  assert.equal(usageLine(alevr), "$12.40 of $40 this month");
  assert.deepEqual(roleTabs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "m" } }), []);
  assert.deepEqual(roleTabs({ preset: "lead-workers", orchestrator: { instanceId: "alevr", model: "m" } }).map((r) => r.label), ["Lead", "Workers", "Reviewer", "Explorer"]);
  for (const p of [placeholder(true), placeholder(false)]) assert.doesNotMatch(p, /[–—]/);
});
