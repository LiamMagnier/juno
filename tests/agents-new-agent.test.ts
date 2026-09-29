import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAgentSchema } from "../src/lib/agents/domain";
import { AGENT_EYES, AGENT_SHAPES, AGENT_TONES } from "../src/lib/agents/avatar";
import {
  AGENT_JOB_EXAMPLES,
  agentNeedsYou,
  newAgentInput,
  nextAgentFace,
  nextAgentName,
  sortRosterAgents,
} from "../src/lib/agents/new-agent";
import type { ClientAgent } from "../src/lib/agents/types";

function member(id: string, patch: Partial<ClientAgent>): ClientAgent {
  return {
    id, name: id, role: "", avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "none" }, style: "warm",
    instructions: "", model: null, reasoningEffort: null, approvalMode: "balanced", connectorIds: [], projectId: null,
    conversationId: null, status: "active", proactive: true, pinnedAt: null, template: null, lastReflectedAt: null,
    sortOrder: 0, createdAt: "", updatedAt: "", state: "idle", stateSentence: "", task: null, needsYou: 0,
    nextRoutine: null, newIdeas: 0, ...patch,
  };
}

test("what Agents home sends is exactly what the server accepts", () => {
  for (const text of AGENT_JOB_EXAMPLES) {
    const body = newAgentInput({ text, name: "Wren", avatar: nextAgentFace([], 11), creationKey: randomUUID() });
    const parsed = createAgentSchema.parse(body);
    assert.equal(parsed.name, "Wren");
    assert.equal(parsed.starterMessage, text);
    assert.equal(parsed.instructions, "", "the brief starts blank; the agent writes it in conversation");
    assert.deepEqual(parsed.connectorIds, [], "no app is granted by the field");
    assert.deepEqual(parsed.avatar, body.avatar, "the face shown beside the field is the face it gets");
  }
});

test("a new face is always a valid one, and avoids the team's tones and shapes while it can", () => {
  const team = [
    member("a", { avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "none" } }),
    member("b", { avatar: { shape: "tile", tone: "teal", eyes: "round", mark: "ring" } }),
  ];
  for (let salt = 0; salt < 200; salt++) {
    const face = nextAgentFace(team, salt);
    assert.ok(AGENT_SHAPES.includes(face.shape) && AGENT_TONES.includes(face.tone) && AGENT_EYES.includes(face.eyes));
    assert.ok(!["coral", "teal"].includes(face.tone), `salt ${salt} reused a tone`);
    assert.ok(!["orb", "tile"].includes(face.shape), `salt ${salt} reused a shape`);
  }
  const full = AGENT_TONES.map((tone, i) => member(`t${i}`, { avatar: { shape: AGENT_SHAPES[i], tone, eyes: "soft", mark: "none" } }));
  assert.ok(AGENT_TONES.includes(nextAgentFace(full, 3).tone), "a full palette still yields a face");
});

test("a new name is not already on the team", () => {
  const team = [member("x", { name: "Nova" }), member("y", { name: "Pip" })];
  for (let salt = 0; salt < 50; salt++) assert.ok(!["Nova", "Pip"].includes(nextAgentName(team, salt)));
});

test("the team reads needs-you first, then busy, then pinned", () => {
  const order = sortRosterAgents([
    member("idle", { sortOrder: 0 }),
    member("pinned", { pinnedAt: "2026-09-30T00:00:00Z", sortOrder: 1 }),
    member("working", { state: "working", sortOrder: 2 }),
    member("waiting", { state: "waiting", sortOrder: 3 }),
    member("paused", { state: "sleeping", sortOrder: 4 }),
  ]).map((a) => a.id);
  assert.deepEqual(order, ["waiting", "working", "pinned", "idle", "paused"]);
  assert.equal(agentNeedsYou(member("q", { needsYou: 2 })), true);
  assert.equal(agentNeedsYou(member("r", { state: "working" })), false);
});
