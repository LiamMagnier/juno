import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { ClientAgent } from "@/lib/agents/types";
import { agentIsWorking, filterRoster } from "@/lib/agents/roster-view";
import { computerPollDelay } from "@/components/agents/use-computer-session";
import { fetchComputerStatus } from "@/components/agents/agents-transport";

const agent = (id: string, extra: Partial<ClientAgent> = {}) => ({
  id, name: id, role: "", state: "idle", status: "active", needsYou: 0, task: null, ...extra,
}) as ClientAgent;
const roster = [
  agent("Mira", { role: "Chief of staff", state: "waiting", needsYou: 1 }),
  agent("Scout", { state: "working", task: { title: "Competitor pricing brief" } as ClientAgent["task"] }),
  agent("Quill", { state: "thinking" }),
  agent("Rove", { status: "paused", state: "working" }),
  agent("Atlas", { state: "blocked" }),
];

test("roster search matches every word across name, role and current task without changing order", () => {
  assert.deepEqual(filterRoster(roster, "  CHIEF mira  ", "all").map(a => a.id), ["Mira"]);
  assert.deepEqual(filterRoster(roster, "pricing competitor", "all").map(a => a.id), ["Scout"]);
  assert.deepEqual(filterRoster(roster, "not found", "all"), []);
  assert.deepEqual(filterRoster(roster, "", "all"), roster);
  assert.equal(roster[0].id, "Mira");
});

test("working excludes paused agents even while their last state is stale", () => {
  assert.deepEqual(filterRoster(roster, "", "working").map(a => a.id), ["Scout", "Quill"]);
  assert.equal(agentIsWorking(roster[3]), false);
  assert.deepEqual(filterRoster(roster, "", "paused").map(a => a.id), ["Rove"]);
  assert.deepEqual(filterRoster(roster, "", "attention").map(a => a.id), ["Mira", "Atlas"]);
  assert.deepEqual(filterRoster(roster, "pricing", "attention"), []);
});

test("computer status preserves access refusals and the last actual server state", async () => {
  const original = globalThis.fetch;
  const access = { ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO" };
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "/api/agents/agent%2Fone/computer");
      assert.equal(init?.method, "GET");
      return Response.json({ computer: null, access });
    };
    const result = await fetchComputerStatus("agent/one");
    assert.deepEqual(result, { kind: "ok", value: { computer: null, access } });
    globalThis.fetch = async () => Response.json({ error: "unavailable", message: "Host is unavailable." }, { status: 503 });
    assert.deepEqual(await fetchComputerStatus("a"), { kind: "failed", status: 503, error: "unavailable", message: "Host is unavailable." });
  } finally { globalThis.fetch = original; }
});

test("transitional computer states are checked promptly; steady states use the slower cadence", () => {
  for (const state of ["starting", "stopping", "resting"]) assert.equal(computerPollDelay(state), 1500);
  for (const state of ["awake", "asleep", "disabled", "error", undefined]) assert.equal(computerPollDelay(state), 5000);
});

test("the six native and web starters carry the same job descriptions", () => {
  const web = readFileSync(new URL("../src/components/agents/orbit-capabilities.tsx", import.meta.url), "utf8");
  const native = readFileSync(new URL("../native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentWorkspace.swift", import.meta.url), "utf8");
  const prompts = [...web.matchAll(/prompt: "([^"]+)"/g)].map(m => m[1]);
  assert.equal(prompts.length, 6);
  for (const prompt of prompts) assert.ok(native.includes(`prompt: "${prompt}"`), prompt);
});


test("native and web explain the same first-agent setup", async () => {
  const { ORBIT_SETUP_STEPS } = await import("../src/lib/agents/onboarding");
  const native = readFileSync(new URL("../native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/NativeAgentWorkspace.swift", import.meta.url), "utf8");
  for (const step of ORBIT_SETUP_STEPS) {
    assert.ok(native.includes(`title: "${step.title}"`));
    assert.ok(native.includes(`detail: "${step.detail}"`));
  }
});
