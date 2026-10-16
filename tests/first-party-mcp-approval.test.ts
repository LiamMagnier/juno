import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { firstPartyTools } from "@/lib/first-party-connectors/tools";

let allowed = false;
let remoteCalls = 0;
let audited = 0;
let authorization: Record<string, unknown> | undefined;
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = modules._load;
class Client {
  async connect() {}
  async listTools() { return { tools: firstPartyTools("gmail") }; }
  async callTool() { remoteCalls++; return { content: [{ type: "text", text: "sent" }] }; }
  async close() {}
}
modules._load = function (name, parent, main) {
  if (name === "server-only") return {};
  if (name === "@modelcontextprotocol/sdk/client/index.js") return { Client };
  if (name === "@modelcontextprotocol/sdk/client/streamableHttp.js") return { StreamableHTTPClientTransport: class {} };
  if (name === "@/lib/action-approval-store") return { authorizeExternalAction: async (input: Record<string, unknown>) => { authorization = input; return allowed ? { kind: "allowed", receiptId: "receipt" } : { kind: "refused", status: "denied", message: "Denied" }; }, completeExternalAction: async () => {} };
  if (name === "@/lib/tool-audit") return { recordToolInvocation: async () => { audited++; return "audit"; }, settleToolInvocation: async () => {} };
  return original.call(this, name, parent, main);
};
const req = createRequire(import.meta.url);
const { openMcpToolset } = req("../src/lib/mcp") as typeof import("@/lib/mcp");
modules._load = original;

test("first-party Gmail sends pass the actual shared dispatcher approval gate", async () => {
  const set = await openMcpToolset([{ id: "gmail", label: "Gmail", mcpUrl: "https://alevr.example/api/mcp/first-party/gmail", headers: { Authorization: "Bearer internal-token" } }], { userId: "owner", conversationId: "chat", sessionId: "turn" });
  try {
    const send = set.tools.find((tool) => tool.function.name.endsWith("send_draft"))!;
    assert.ok(send);
    allowed = false;
    const refused = await set.execute(send.function.name, { draftId: "draft1" }, undefined, "call-denied");
    assert.equal(refused.ok, false);
    assert.equal(remoteCalls, 0, "a denied send never reaches the connector");
    assert.equal(authorization?.connectorId, "gmail");
    assert.equal(authorization?.toolName, "send_draft");
    allowed = true;
    const sent = await set.execute(send.function.name, { draftId: "draft1" }, undefined, "call-approved");
    assert.equal(sent.ok, true);
    assert.equal(remoteCalls, 1);
    assert.ok(audited >= 1);
  } finally { await set.close(); }
});
