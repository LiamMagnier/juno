import test from "node:test";
import assert from "node:assert/strict";
import { agentMemoryAccessOf, readerMayUse, readerMayUseSummary } from "@/lib/memory-scope";
import { patchAgentSchema } from "@/lib/agents/domain";

const fact = (content: string, category: string | null, projectId: string | null = null) => ({ content, category, projectId });

test("account and project readers see only their own scope", () => {
  assert.equal(readerMayUse(fact("x", "preferences"), { kind: "account" }), true);
  assert.equal(readerMayUse(fact("x", "preferences", "p1"), { kind: "account" }), false);
  assert.equal(readerMayUse(fact("x", "preferences"), { kind: "project", projectId: "p1" }), false);
  assert.equal(readerMayUse(fact("x", "projects", "p1"), { kind: "project", projectId: "p1" }), true);
});

test("an agent's default grant is the durable profile, minus anything sensitive", () => {
  const agent = { kind: "agent" as const, agentId: "a", access: agentMemoryAccessOf(undefined), projectId: null };
  assert.equal(agent.access, "profile");
  assert.equal(readerMayUse(fact("The user prefers concise answers.", "preferences"), agent), true);
  assert.equal(readerMayUse(fact("The user's partner is called Sam.", "relationships"), agent), false);
  assert.equal(readerMayUse(fact("The user studies law.", "studies"), agent), false);
  assert.equal(readerMayUse(fact("The user was diagnosed with ADHD.", "identity"), agent), false);
  assert.equal(readerMayUse(fact("The launch uses Astro.", "projects", "p1"), agent), false);
  assert.equal(readerMayUseSummary(agent), false);
});

test("none reads nothing; full reads what a chat in its scope would; unknown values never widen", () => {
  assert.equal(readerMayUse(fact("x", "preferences"), { kind: "agent", agentId: "a", access: "none", projectId: null }), false);
  const full = { kind: "agent" as const, agentId: "a", access: "full" as const, projectId: "p1" };
  assert.equal(readerMayUse(fact("x", "relationships", "p1"), full), true);
  assert.equal(readerMayUse(fact("x", "relationships"), full), false);
  assert.equal(readerMayUseSummary(full), true);
  assert.equal(agentMemoryAccessOf("everything"), "profile");
});

test("the agent's self-configuration path cannot set its own memory grant", () => {
  // patchAgentSchema is what update_agent and setup changes write through; it
  // strips the field, so only the person-only route can change it.
  const parsed = patchAgentSchema.safeParse({ name: "Scout", memoryAccess: "full" });
  assert.ok(parsed.success);
  assert.equal("memoryAccess" in parsed.data, false);
});
