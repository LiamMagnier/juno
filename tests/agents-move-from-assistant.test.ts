import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MAX_MOVED_IDEAS,
  memberFromAssistant,
  moveCreationKey,
  roleFromDescription,
} from "@/lib/agents/move-from-assistant";
import { MAX_AGENT_INSTRUCTIONS_CHARS, createAgentSchema } from "@/lib/agents/domain";

/*
 * Move to crew (D-007): an assistant becomes a crew member without inventing
 * anything, and the assistant row is marked, never deleted or rewritten.
 */

const assistant = {
  id: "skl_1",
  name: "Contract reviewer",
  description: "Reviews supplier contracts for risky clauses. Uses the legal checklist.",
  systemPrompt: "You review contracts.",
  starterPrompts: ["Review this NDA", "review this nda", "  ", "Summarise the indemnity clause"],
  enabledConnectors: ["gmail", "gmail", "drive"],
  attachedProjectIds: ["prj_1"],
  preferredModelId: "not-a-real-model",
  reasoningEffort: "high",
};

test("what carries over, and nothing else", () => {
  const member = memberFromAssistant(assistant);
  assert.equal(member.name, "Contract reviewer");
  assert.equal(member.role, "Reviews supplier contracts for risky clauses");
  assert.equal(member.instructions, "You review contracts.");
  assert.equal(member.instructionsCut, false);
  assert.equal(member.model, null, "a model Juno does not offer is dropped, not guessed at");
  assert.equal(member.reasoningEffort, "high");
  assert.deepEqual(member.connectorIds, ["gmail", "drive"]);
  assert.equal(member.projectId, "prj_1");
  // Starter prompts become ideas, deduplicated, never tasks.
  assert.deepEqual(member.ideas.map((idea) => idea.prompt), ["Review this NDA", "Summarise the indemnity clause"]);
});

test("a long prompt is cut to the brief limit and says so", () => {
  const member = memberFromAssistant({ ...assistant, systemPrompt: "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 500) });
  assert.equal(member.instructionsCut, true);
  assert.ok(member.instructions.length <= MAX_AGENT_INSTRUCTIONS_CHARS);
  assert.match(member.instructions, /cut when it moved from Assistants/);
  const many = memberFromAssistant({ ...assistant, starterPrompts: Array.from({ length: 20 }, (_, i) => `Prompt ${i}`) });
  assert.equal(many.ideas.length, MAX_MOVED_IDEAS);
  assert.equal(roleFromDescription(""), "");
  assert.ok(roleFromDescription("a ".repeat(200)).length <= 80);
});

test("the creation key is a stable UUID, so a double press makes one member", () => {
  const key = moveCreationKey("user_1", "skl_1");
  assert.equal(key, moveCreationKey("user_1", "skl_1"));
  assert.notEqual(key, moveCreationKey("user_2", "skl_1"));
  assert.notEqual(key, moveCreationKey("user_1", "skl_1:ag_retired"));
  assert.equal(createAgentSchema.safeParse({ name: "X", creationKey: key }).success, true);
});

test("the move marks the assistant instead of deleting it, and lists leave it out", () => {
  const store = readFileSync("src/lib/agents/move-from-assistant-store.ts", "utf8");
  assert.match(store, /data: \{ movedToAgentId: agent\.id, movedAt: new Date\(\) \}/);
  assert.doesNotMatch(store, /workSkill\.(delete|deleteMany)\(/);
  assert.match(store, /proactive: false/);
  assert.match(store, /kind: "moved_from_assistant"/);
  const assistants = readFileSync("src/lib/assistants.ts", "utf8");
  const list = assistants.slice(assistants.indexOf("export async function listUserAssistants"), assistants.indexOf("export async function getAssistantById"));
  assert.match(list, /movedToAgentId: null/);
  const byId = assistants.slice(assistants.indexOf("export async function getAssistantById"), assistants.indexOf("export async function createAssistant"));
  assert.doesNotMatch(byId, /movedToAgentId: null/, "a moved assistant stays readable by id");
});
