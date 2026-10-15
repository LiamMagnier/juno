import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

// Exercise openMcpToolset.execute itself. Only the remote client, approval
// decision and audit storage are replaced; no database or connector is touched.
let remoteError = true;
const receipts: Array<{ ok: boolean; result: string }> = [];
const audits: Array<{ status: string; error?: string }> = [];
let calls = 0;
class Client {
  async connect() {}
  async listTools() { return { tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }] }; }
  async callTool() { calls++; return { isError: remoteError, content: [{ type: "text", text: remoteError ? "Quota exceeded" : "Result" }] }; }
  async close() {}
}
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = modules._load;
modules._load = function (name, parent, main) {
  if (name === "server-only") return {};
  if (name === "@modelcontextprotocol/sdk/client/index.js") return { Client };
  if (name === "@modelcontextprotocol/sdk/client/streamableHttp.js") return { StreamableHTTPClientTransport: class {} };
  if (name === "@/lib/tool-audit") return { recordToolInvocation: async () => "audit", settleToolInvocation: async (_id: string, result: { status: string; error?: string }) => audits.push(result) };
  if (name === "@/lib/action-approval-store") return { authorizeExternalAction: async () => ({ kind: "allowed", receiptId: "receipt" }), completeExternalAction: async (result: { ok: boolean; result: string }) => receipts.push(result) };
  return original.call(this, name, parent, main);
};
globalThis.fetch = async () => { throw new Error("MCP behaviour test attempted network I/O"); };
const req = createRequire(import.meta.url);
const { openMcpToolset } = req("../src/lib/mcp") as typeof import("@/lib/mcp");

for (const isError of [true, false]) {
  test(`MCP isError=${isError}: the model result, audit and receipt agree`, async () => {
    remoteError = isError;
    receipts.length = 0;
    audits.length = 0;
    calls = 0;
    const tools = await openMcpToolset([{ id: "github", label: "Fixture", mcpUrl: "https://fixture.invalid/mcp", headers: {} }], { userId: "test-user", conversationId: "test-chat", sessionId: "test-turn" });
    try {
      assert.equal(tools.tools.length, 1);
      const result = await tools.execute(tools.tools[0].function.name, {}, undefined, "call");
      assert.equal(calls, 1);
      assert.equal(result.ok, !isError);
      assert.match(result.text, /<<<JUNO_UNTRUSTED_BEGIN>>>/);
      assert.equal(audits.at(-1)?.status, isError ? "failed" : "executed");
      assert.equal(receipts.at(-1)?.ok, !isError);
      if (isError) {
        assert.match(result.text, /Tool error: Quota exceeded/);
        assert.equal(audits.at(-1)?.error, "Quota exceeded");
      }
    } finally { await tools.close(); }
  });
}
