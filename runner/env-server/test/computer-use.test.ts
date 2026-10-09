/**
 * computer_use on the env server's Alevr MCP (SPEC §3.12): offered to a live
 * session only while the Mac app's bridge is up, executed through the bridge,
 * recorded as a computer_action item in that session's log, and released
 * when the session closes.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { startEnvServer, computerSessionFor, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import { ALEVR_COMPUTER_TOOL_NAME, type ComputerBridgeRequest, type ComputerBridgeResponse, type TurnItem } from "../src/contracts/code-v2.js";
import type { ComputerBridge } from "../src/mcp/computer-bridge.js";
import { DesktopLock } from "../src/mcp/desktop-lock.js";
import { TestClient, fakeBinDir, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

class FakeBridge implements ComputerBridge {
  sent: Omit<ComputerBridgeRequest, "id" | "token">[] = [];
  async send(request: Omit<ComputerBridgeRequest, "id" | "token">): Promise<ComputerBridgeResponse> {
    this.sent.push(request);
    return { id: `r${this.sent.length}`, ok: true, text: "Screenshot 1366x768 of Finder", image: { data: "AAAA", mediaType: "image/png" } } as ComputerBridgeResponse;
  }
}

async function boot(available: { up: boolean }) {
  const bridge = new FakeBridge();
  const server = await startEnvServer({
    dataDir: tempDir("data"),
    searchDirs: [fakeBinDir()],
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    computerUse: { bridge, available: () => available.up, lock: new DesktopLock({ path: path.join(tempDir("lock"), "desktop.lock") }) },
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  return { server, client, bridge };
}

async function mcpCall(server: EnvServer, token: string, method: string, params: Record<string, unknown>, id = 1) {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await res.json()) as { result?: Record<string, any>; error?: { message: string } };
}

const toolNames = async (server: EnvServer, token: string) =>
  ((await mcpCall(server, token, "tools/list", {}, 2)).result?.tools as { name: string }[]).map((t) => t.name);

test("computer_use: offered only while the Mac bridge is up, runs through it, and lands in the session log", async () => {
  const available = { up: false };
  const { server, client, bridge } = await boot(available);
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd: tempDir("cwd"), selection: { instanceId: "codex:default", model: "gpt-6.1-codex" } });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  const token = server.mcp.issueToken({ sessionId, depth: 0 });
  await mcpCall(server, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });

  assert.ok(!(await toolNames(server, token)).includes(ALEVR_COMPUTER_TOOL_NAME), "hidden while the Mac app's bridge is down");
  available.up = true;
  assert.ok((await toolNames(server, token)).includes(ALEVR_COMPUTER_TOOL_NAME));

  const called = await mcpCall(server, token, "tools/call", { name: ALEVR_COMPUTER_TOOL_NAME, arguments: { action: "screenshot" } }, 3);
  assert.ok(!called.result?.isError, JSON.stringify(called));
  const content = called.result?.content as { type: string }[];
  assert.ok(content.some((c) => c.type === "image"), "the screenshot comes back as an MCP image block");
  assert.ok(bridge.sent.length >= 1);

  const item = await client.waitFor(
    () => client.snapshot(sessionId).items.find((i: TurnItem) => i.kind === "computer_action"),
    4000,
    "a computer_action item",
  );
  assert.equal(item?.kind, "computer_action");

  await client.command("session.close", { sessionId });
});

test("computer_use: the session's model picks the coordinate convention", async () => {
  const { server, client } = await boot({ up: true });
  const open = async (instanceId: string, model: string) => {
    const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd: tempDir("cwd"), selection: { instanceId, model } });
    return sessionId;
  };
  const gemini = await open("acp:gemini", "gemini-3.5-pro");
  const codex = await open("codex:default", "gpt-6.1-codex");
  assert.equal(computerSessionFor(server.sessions, { sessionId: gemini, depth: 0 })?.coordinateSpace, "normalized_1000");
  assert.equal(computerSessionFor(server.sessions, { sessionId: codex, depth: 0 })?.coordinateSpace, "pixels");
  assert.equal(computerSessionFor(server.sessions, { sessionId: "missing", depth: 0 }), undefined);
});
