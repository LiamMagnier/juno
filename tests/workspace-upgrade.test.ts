import test from "node:test";
import assert from "node:assert/strict";
import { createMcpServerInput, mcpConnectionInput, testSavedMcpServerInput } from "../src/lib/mcp-server-input";
import { agentStarterInput } from "../src/lib/agents/starter";
import { AGENT_TEMPLATES } from "../src/lib/agents/templates";
import { createAgentSchema } from "../src/lib/agents/domain";

test("a custom MCP without credentials can be saved and a saved credential can be kept or cleared", () => {
  assert.deepEqual(createMcpServerInput.parse({ name: " My tools ", url: " https://example.com/mcp ", authHeader: null }),
    { name: "My tools", url: "https://example.com/mcp", authHeader: null });
  assert.deepEqual(testSavedMcpServerInput.parse({ url: "https://example.com/new" }), { url: "https://example.com/new" });
  assert.deepEqual(testSavedMcpServerInput.parse({ authHeader: null }), { authHeader: null });
  for (const input of [{ url: 123 }, { url: "" }, { url: "https://example.com", authHeader: {} }])
    assert.equal(mcpConnectionInput.safeParse(input).success, false);
});

test("agent starters never install an example job, instructions, or app grants", () => {
  for (const template of AGENT_TEMPLATES) {
    const input = agentStarterInput(template);
    assert.equal(createAgentSchema.safeParse(input).success, true, template.id);
    assert.equal(input.instructions, "");
    assert.equal(input.firstGoal, undefined);
    assert.deepEqual(input.connectorIds, []);
  }
});
