import test from "node:test";
import assert from "node:assert/strict";
import { isTeamActivity, teamMemberLines, workSummaryLines, type ActivityEventLike } from "../src/lib/agents/activity-words";

const at = "2026-10-04T12:00:00Z";
const ev = (kind: string, payload: Record<string, unknown>, extra: Partial<ActivityEventLike> = {}): ActivityEventLike => ({ kind, payload, createdAt: at, ...extra });

test("a run's activity reads as work named after its actor, with the technical side kept apart", () => {
  const events = [
    ...Array.from({ length: 12 }, (_, i) => ev("source_cited", { url: `https://e.com/${i}` })),
    ev("source_cited", { url: "https://e.com/0" }),
    ev("tool_finished", { tool: "web_search" }),
    ev("tool_finished", { tool: "fetch_url" }),
    ev("tool_finished", { tool: "fetch_url" }),
    ev("tool_finished", { tool: "github__list_issues" }),
    ev("files_changed", { count: 3 }),
    ev("approval_requested", { approvalId: "a1", tool: "github__create_issue", summary: "Update GitHub." }, { seq: 9 }),
    ev("artifact_created", { kind: "report" }),
  ];
  const lines = workSummaryLines(events, "Scout");
  const sentences = lines.map((l) => l.sentence);
  assert.deepEqual(sentences, [
    "Waiting for your approval to update GitHub",
    "Report ready",
    "Scout searched 12 sources",
    "Scout read 2 pages",
    "Scout worked in GitHub",
    "Scout changed 3 files",
  ]);
  assert.equal(lines[0]!.tone, "attention");
  assert.match(lines[0]!.technical, /approval_requested · github__create_issue/);
  for (const line of lines) {
    assert.doesNotMatch(line.sentence, /tool_|_call|worker_|mcp|subagent/i, "no internal tokens in a sentence");
  }
});

test("an answered approval is no longer waiting; plurals are right; nothing done says nothing", () => {
  const lines = workSummaryLines([
    ev("approval_requested", { approvalId: "a1", summary: "Send the email" }),
    ev("approval_resolved", { approvalId: "a1" }),
    ev("tool_finished", { tool: "fetch_url" }),
  ], "Mira");
  assert.deepEqual(lines.map((l) => l.sentence), ["Mira read 1 page"]);
  assert.deepEqual(workSummaryLines([], "Mira"), []);
});

test("team activity: one line per member, newest wins, in the team's order", () => {
  const events = [
    ev("subagent_update", { role: "engineer", phase: "started", title: "Engineer started" }, { seq: 1 }),
    ev("subagent_update", { role: "researcher", phase: "started", title: "Researcher started" }, { seq: 2 }),
    ev("subagent_update", { role: "researcher", phase: "finished", title: "Researcher finished", sessionId: "s1" }, { seq: 3 }),
    ev("subagent_update", { role: "designer", phase: "waiting", title: "Designer is waiting for your approval" }, { seq: 4 }),
    ev("subagent_update", { title: "A sub-agent from the runtime" }, { agentId: "a1b2c3", seq: 5 }),
  ];
  assert.equal(isTeamActivity(events), true);
  assert.equal(isTeamActivity([ev("subagent_update", { title: "x" })]), false);
  const lines = teamMemberLines(events);
  assert.deepEqual(lines.map((l) => l.sentence), ["Researcher finished", "Engineer started", "Designer is waiting for your approval"]);
  assert.deepEqual(lines.map((l) => l.tone), ["done", "quiet", "attention"]);
  assert.equal(lines[0]!.technical, "researcher · finished · task s1 · seq 3");
});
