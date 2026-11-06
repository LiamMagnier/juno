import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";

let enabled = true;
let blocked: string[] = [];
let allowed = false;
let remoteCalls = 0;
let audited = 0;
let closed = 0;
let failDiscovery = false;
let discoveryOptions: { timeout?: number; signal?: AbortSignal } | undefined;
let currentUser: { id: string } | null = { id: "owner" };
let cloud: { user: { id: string }; taskId: string; status: string } | null = null;
let activeTask = true;
let authorization: Record<string, unknown> | undefined;
const server = { id: "one", userId: "owner", name: "Example", url: "https://mcp.example.com/", authHeader: null, enabled: true };
const modules = Module as unknown as { _load: (name: string, parent: unknown, main: boolean) => unknown };
const original = modules._load;
const prisma = {
  userMcpServer: { findMany: async (input: { where: { userId: string; enabled?: boolean; id?: { in: string[] } } }) => input.where.userId === server.userId && enabled && (!input.where.id || input.where.id.in.includes(server.id)) ? [server] : [] },
  settings: { findUnique: async () => ({ blockedConnectors: blocked }) },
  connection: { findMany: async () => [] },
  user: { findFirst: async () => ({ id: "owner" }) },
  codeTask: { findFirst: async () => activeTask ? { id: "task" } : null },
};
class Client {
  async connect(_transport: unknown, options?: { timeout?: number; signal?: AbortSignal }) { discoveryOptions = options; if (failDiscovery) throw new Error("unreachable"); }
  async listTools() { return { tools: [{ name: "send_message", inputSchema: { type: "object" } }] }; }
  async callTool() { remoteCalls++; return { content: [{ type: "text", text: "sent" }] }; }
  async close() { closed++; }
}
modules._load = function (name, parent, main) {
  if (name === "server-only") return {};
  if (name === "@/lib/prisma") return { prisma };
  if (name === "@/lib/session") return { getCurrentUser: async () => currentUser };
  if (name === "@/lib/code-remote") return { taskTokenAuth: async () => cloud, isTerminalTaskStatus: (s: string) => s === "completed" };
  if (name === "@/lib/rate-limit") return { rateLimit: async () => ({ success: true }) };
  if (name === "@modelcontextprotocol/sdk/client/index.js") return { Client };
  if (name === "@modelcontextprotocol/sdk/client/streamableHttp.js") return { StreamableHTTPClientTransport: class {} };
  if (name === "@/lib/action-approval-store") return { authorizeExternalAction: async (input: Record<string, unknown>) => { authorization = input; return allowed ? { kind: "allowed", receiptId: "receipt" } : { kind: "refused", reason: "Denied" }; }, completeExternalAction: async () => {} };
  if (name === "@/lib/tool-audit") return { recordToolInvocation: async () => { audited++; return "audit"; }, settleToolInvocation: async () => {} };
  return original.call(this, name, parent, main);
};
const require = createRequire(import.meta.url);
const { sessionMcpRpc } = require("../src/lib/session-mcp") as typeof import("@/lib/session-mcp");
const { POST } = require("../src/app/api/mcp/session/route") as typeof import("@/app/api/mcp/session/route");
modules._load = original;

const request = (method: string, params: object = {}, headers: Record<string, string> = {}) => new Request("https://alevr.example/api/mcp/session", { method: "POST", headers: { "content-type": "application/json", "x-alevr-mcp-session": "local-thread", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: "rpc1", method, params }) });
const ctx = { userId: "owner", sessionId: "code:local-thread", surface: "code" };

test("only the owner's enabled, unblocked servers appear, and no credentials leave the server", async () => {
  const listed = await (await sessionMcpRpc(request("tools/list"), ctx)).json();
  assert.equal(listed.result.tools.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /mcp\.example|authHeader|Authorization/);
  assert.equal((await (await sessionMcpRpc(request("tools/list"), { ...ctx, userId: "other" })).json()).result.tools.length, 0);
  blocked = ["user_mcp:one"];
  assert.equal((await (await sessionMcpRpc(request("tools/list"), ctx)).json()).result.tools.length, 0);
  blocked = [];
  enabled = false;
  assert.equal((await (await sessionMcpRpc(request("tools/list"), ctx)).json()).result.tools.length, 0);
  enabled = true;
});

test("actual MCP dispatcher refuses a send before the network sink and audits both outcomes", async () => {
  const { result } = await (await sessionMcpRpc(request("tools/list"), ctx)).json();
  const params = { name: result.tools[0].name, arguments: { text: "hello" }, accountScope: result.accountScope, callId: "provider-1" };
  remoteCalls = 0; audited = 0; closed = 0; allowed = false;
  const denied = await (await sessionMcpRpc(request("tools/call", params), ctx)).json();
  assert.equal(denied.result.isError, true);
  assert.equal(remoteCalls, 0);
  assert.equal(audited, 1);
  assert.equal(authorization?.surface, "code");
  assert.equal(authorization?.sessionId, "code:local-thread");
  assert.equal(authorization?.callId, "provider-1");
  allowed = true;
  assert.equal((await (await sessionMcpRpc(request("tools/call", params), ctx)).json()).result.isError, false);
  assert.equal(remoteCalls, 1);
  assert.equal(audited, 2);
  assert.equal(closed, 2);
  enabled = false;
  assert.equal((await (await sessionMcpRpc(request("tools/call", params), ctx)).json()).result.isError, true);
  assert.equal(remoteCalls, 1, "removal is effective within an existing engine session");
  enabled = true;
});

test("a refreshed credential for a different account cannot execute an old catalog", async () => {
  const { result } = await (await sessionMcpRpc(request("tools/list"), ctx)).json();
  const response = await sessionMcpRpc(request("tools/call", { name: result.tools[0].name, arguments: {}, accountScope: result.accountScope }), { ...ctx, userId: "other" });
  assert.match((await response.json()).error.message, /Reload connections/);
});

test("runtime discovery is bounded and closes a client whose handshake failed", async () => {
  closed = 0;
  failDiscovery = true;
  const response = await sessionMcpRpc(request("tools/list"), ctx);
  assert.equal((await response.json()).result.tools.length, 0);
  assert.equal(discoveryOptions?.timeout, 8000);
  assert.ok(discoveryOptions?.signal instanceof AbortSignal);
  assert.equal(closed, 1);
  failDiscovery = false;
});

test("malformed and chunked oversized requests are refused before opening a server", async () => {
  assert.equal((await sessionMcpRpc(new Request("https://alevr.example", { method: "POST", body: "[1]" }), ctx)).status, 400);
  assert.equal((await sessionMcpRpc(new Request("https://alevr.example", { method: "POST", body: "x".repeat(1_048_577) }), ctx)).status, 413);
  assert.equal((await sessionMcpRpc(request("tools/call", { name: "send", arguments: [] }), ctx)).status, 200);
  assert.equal((await (await sessionMcpRpc(request("tools/call", { name: "send", arguments: [] }), ctx)).json()).error.code, -32602);
});

test("native and cloud route authorization remain scoped and terminal tokens cannot call", async () => {
  currentUser = null;
  assert.equal((await POST(request("tools/list"))).status, 401);
  currentUser = { id: "owner" };
  assert.equal((await POST(request("tools/list", {}, { "x-alevr-mcp-session": "" }))).status, 400);
  cloud = null;
  assert.equal((await POST(request("tools/list", {}, { authorization: "Bearer cct_invalid" }))).status, 401, "invalid bearer cannot fall back to the attached browser user");
  cloud = { user: { id: "owner" }, taskId: "task", status: "completed" };
  assert.equal((await POST(request("tools/list", {}, { authorization: "Bearer cct_test" }))).status, 403);
  cloud.status = "running";
  activeTask = false;
  assert.equal((await POST(request("tools/list", {}, { authorization: "Bearer cct_test" }))).status, 403);
  activeTask = true;
  const listed = await (await POST(request("tools/list", {}, { authorization: "Bearer cct_test" }))).json();
  assert.equal(listed.result.tools.length, 1);
  await POST(request("tools/call", { name: listed.result.tools[0].name, arguments: {}, accountScope: listed.result.accountScope }, { authorization: "Bearer cct_test" }));
  assert.equal(authorization?.unattended, true);
  assert.equal(authorization?.sessionId, "cloud:task");
  cloud = null;
});
