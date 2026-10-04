import test from "node:test";
import assert from "node:assert/strict";
import { questionState, researchAuditClean, researchWorkspace } from "@/components/research/workspace-model";
import type { ResearchRunView } from "@/components/research/use-research-run";
import type { ResearchEventDTO } from "@/lib/research/domain";

const source = (id: string, read: boolean) => ({ id, read, url: `https://example.com/${id}`, title: id, contentHash: null, fetchedAt: "2026-10-04", publishedAt: null, authority: null, freshness: null, directness: null, independence: null, composite: null, sourceType: null });
const run = (patch: Partial<ResearchRunView> = {}): ResearchRunView => ({
  id: "r", goal: "Question", state: "investigating", live: true, costMicroUsd: "0", budgetMicroUsd: null, error: null, report: null,
  plan: { steps: [], queries: [], constraints: [], pinnedSources: [], confirmed: true }, sources: [], ...patch,
});
const event = (seq: number, kind: ResearchEventDTO["kind"], payload: Record<string, unknown>): ResearchEventDTO => ({ id: `${seq}`, seq, kind, payload, createdAt: "2026-10-04T10:00:00Z" });

test("questions link only evidence actually read, with stable deduplicated IDs", () => {
  const value = run({ sources: [source("read", true), source("lead", false)], plan: { ...run().plan, objectives: [{ id: "q", question: "Why?", status: "partial" }], coverage: [{ objectiveId: "q", requirementId: "e", status: "partial", supportingSourceIds: ["read", "read", "lead", "missing"], evidenceStrength: .5, independentSourceCount: 1 }] } });
  assert.deepEqual(researchWorkspace(value, []).questions[0].sourceIds, ["read"]);
  assert.equal(questionState("partial"), "Partial evidence");
});
test("paused workers never imply ongoing spend; guidance is accepted without resume", () => {
  const events = [event(1, "worker_spawned", { workerId: "w1", role: "Primary sources" }), event(2, "state_changed", { from: "reviewing", state: "paused" })];
  const value = researchWorkspace(run({ state: "paused" }), events);
  assert.equal(value.activeWorkers, 0);
  assert.equal(value.stage, 2);
  assert.equal(value.canGuide, true);
  assert.equal(value.workers[0].label, "Primary sources");
});
test("worker completion deduplicates a repeated event and leaves others active", () => {
  const events = [event(1, "worker_spawned", { workerId: "w1" }), event(2, "worker_spawned", { workerId: "w2" }), event(3, "worker_finished", { workerId: "w1" }), event(4, "worker_finished", { workerId: "w1" })];
  assert.equal(researchWorkspace(run(), events).activeWorkers, 1);
});
test("missing citation counts stay unknown, and discovered leads stay distinct", () => {
  const value = researchWorkspace(run({ sources: [source("a", true), source("b", false)] }), []);
  assert.equal(value.found, 2);
  assert.equal(value.read, 1);
  assert.equal(value.cited, null);
});
test("finish requests and plan gates accept no additional guidance", () => {
  assert.equal(researchWorkspace(run({ finishRequested: true }), []).canGuide, false);
  assert.equal(researchWorkspace(run({ state: "awaiting_plan_confirmation" }), []).canGuide, false);
});
test("a missing pause history leaves the stage unknown rather than fabricating progress", () => {
  assert.equal(researchWorkspace(run({ state: "paused" }), []).stage, -1);
});
test("a clean audit requires every claim checked and supported", () => {
  const audit = { claims: 2, supported: 2, partiallySupported: 0, unsupported: 0, contradicted: 0, unverified: 0, duplicateSources: 0 };
  assert.equal(researchAuditClean(audit), true);
  assert.equal(researchAuditClean({ ...audit, supported: 1, unverified: 1 }), false);
  assert.equal(researchAuditClean({ ...audit, supported: 1, partiallySupported: 1 }), false);
  assert.equal(researchAuditClean({ ...audit, claims: 0, supported: 0 }), false);
});
