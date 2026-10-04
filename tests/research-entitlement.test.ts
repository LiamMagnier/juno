import test from "node:test";
import assert from "node:assert/strict";
import type { Plan } from "@prisma/client";
import {
  RESEARCH_REFUSAL_COPY,
  researchEntitlement,
  researchRefusalLine,
  type ResearchRefusal,
} from "@/lib/research/entitlement";
import { serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * SPEC §9.1: who may start Research at all. Money and concurrency are
 * `researchBudgetFor`'s; this is the plan, the deployment and the surface.
 */

const allowed = {
  plan: "PRO" as Plan,
  privateMode: false,
  lockdown: false,
  voiceMode: false,
  workspace: null,
  configured: true,
};

function verdict(overrides: Partial<Parameters<typeof researchEntitlement>[0]> = {}) {
  return researchEntitlement({ ...allowed, ...overrides });
}

test("entitlement.ts stays importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/entitlement.ts"), []);
});

test("every paid plan is entitled; FREE is not", () => {
  for (const plan of ["PRO", "MAX", "MAX20", "OWNER"] as Plan[]) {
    assert.deepEqual(verdict({ plan }), { allowed: true }, plan);
  }
  assert.deepEqual(verdict({ plan: "FREE" }), { allowed: false, reason: "plan" });
});

test("a deployment with no search backend refuses with not_configured", () => {
  assert.deepEqual(verdict({ configured: false }), { allowed: false, reason: "not_configured" });
});

test("private chats never start a durable run (INV-32)", () => {
  assert.deepEqual(verdict({ privateMode: true }), { allowed: false, reason: "private" });
});

test("lockdown stops Research, reading included", () => {
  assert.deepEqual(verdict({ lockdown: true }), { allowed: false, reason: "lockdown" });
});

test("voice turns do not start Research", () => {
  assert.deepEqual(verdict({ voiceMode: true }), { allowed: false, reason: "voice" });
});

test("a workspace decides with its existing deepResearch key", () => {
  assert.deepEqual(verdict({ workspace: { allowedTools: ["webSearch"] } }), { allowed: false, reason: "workspace" });
  assert.deepEqual(verdict({ workspace: { allowedTools: ["deepResearch"] } }), { allowed: true });
  // No list is no opinion.
  assert.deepEqual(verdict({ workspace: {} }), { allowed: true });
});

test("the first refusal is the plan's, then the deployment's, then the surface's", () => {
  assert.equal((verdict({ plan: "FREE", configured: false, privateMode: true }) as { reason: string }).reason, "plan");
  assert.equal((verdict({ configured: false, privateMode: true, lockdown: true }) as { reason: string }).reason, "not_configured");
  assert.equal((verdict({ privateMode: true, lockdown: true, voiceMode: true }) as { reason: string }).reason, "private");
});

test("every refusal has a line, and none says Deep or names a depth (§9.9)", () => {
  const reasons: ResearchRefusal[] = ["plan", "not_configured", "workspace", "private", "lockdown", "voice", "live_runs", "daily_starts", "budget"];
  for (const reason of reasons) {
    const line = researchRefusalLine(reason);
    assert.equal(line.title, "Research was skipped");
    assert.ok(line.detail.length > 0, reason);
    assert.doesNotMatch(line.detail, /deep|quick|standard|\bmax\b/i, reason);
  }
  assert.equal(RESEARCH_REFUSAL_COPY.reasons.plan, "Research is included from the Pro plan.");
  assert.equal(RESEARCH_REFUSAL_COPY.reasons.not_configured, "Research isn't set up on this server.");
});

test("the reset date rides beside the line, never inside it", () => {
  const line = researchRefusalLine("budget", { shareLeft: 3, resetsOn: "2026-10-01" });
  assert.equal(line.resetsOn, "2026-10-01");
  assert.doesNotMatch(line.detail, /2026/);
  assert.equal(researchRefusalLine("budget", { resetsOn: "soon" }).resetsOn, null);
});
