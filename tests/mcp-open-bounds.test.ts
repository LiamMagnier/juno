import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

/*
 * The bounded MCP open (src/lib/mcp.ts, `openMcpToolset`), driven for real:
 * the MCP SDK's own client against tiny Streamable HTTP servers on
 * 127.0.0.1, one that answers and one that accepts the request and never
 * does. Only the audit rows, the approval broker and the log are stubbed;
 * nothing leaves the machine.
 *
 *  - each server gets its own connect + list budget, a slow one is dropped
 *    (reported `timeout`) and its connection closed, the others are kept;
 *  - the caller's signal cancels the open (the Work runner's deadline);
 *  - a chat turn reuses a recent tool list and dials nobody until a tool is
 *    called; a changed connector, another user, or a server that stopped
 *    answering is listed afresh.
 */

const audits: Array<{ status: string; error?: string }> = [];
const logged: Array<{ event: string; fields: Record<string, unknown> }> = [];
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/tool-audit") {
    return {
      recordToolInvocation: async () => "audit",
      settleToolInvocation: async (_id: string, result: { status: string; error?: string }) => void audits.push(result),
    };
  }
  if (request === "@/lib/action-approval-store") {
    return {
      authorizeExternalAction: async () => ({ kind: "allowed", receiptId: "receipt" }),
      completeExternalAction: async () => undefined,
    };
  }
  if (request === "@/lib/logger") {
    const record = (_level: string, event: string, fields: Record<string, unknown> = {}) => void logged.push({ event, fields });
    return { logSync: record, logAsync: record, log: async () => undefined, logDebug: () => undefined, REQUEST_ID_HEADER: "x-juno-request-id" };
  }
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { openMcpToolset, resetMcpToolListCacheForTests, invalidateMcpToolListCache } = req("../src/lib/mcp") as typeof import("@/lib/mcp");
const { mcpConnectTimeoutMs, CHAT_CONNECT_TIMEOUT_MS } = req("../src/lib/tools/connector-tools") as typeof import("@/lib/tools/connector-tools");
const cacheModule = req("../src/lib/tools/mcp-tool-list-cache") as typeof import("@/lib/tools/mcp-tool-list-cache");
mod._load = origLoad;

/** `hang-list`: completes the handshake, then never answers tools/list. */
type Mode = "ok" | "hang" | "hang-list" | "refuse";

interface Fixture {
  url: string;
  mode: Mode;
  counts: Record<string, number>;
  /** Requests this server never answered, and how many of their connections the client closed. */
  hung: number;
  hungClosed: number;
}

const servers: http.Server[] = [];
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

const TOOLS = [
  { name: "search", description: "Search items", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "create_item", inputSchema: { type: "object", properties: {} } },
];

async function mcpServer(mode: Mode): Promise<Fixture> {
  const fixture: Fixture = { url: "", mode, counts: {}, hung: 0, hungClosed: 0 };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (fixture.mode === "hang") {
        // Accept and say nothing: the server that used to freeze a turn.
        fixture.hung += 1;
        response.on("close", () => {
          fixture.hungClosed += 1;
        });
        return;
      }
      if (fixture.mode === "refuse") {
        response.writeHead(503).end("down");
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      fixture.counts[message.method] = (fixture.counts[message.method] ?? 0) + 1;
      if (fixture.mode === "hang-list" && message.method === "tools/list") {
        fixture.hung += 1;
        response.on("close", () => {
          fixture.hungClosed += 1;
        });
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
          : message.method === "tools/list"
            ? { tools: TOOLS }
            : { content: [{ type: "text", text: "found it" }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return fixture;
}

/** A built-in connector id, so the plain fetch (not the SSRF-safe one) dials loopback. */
function connector(id: string, fixture: Fixture, extra: { toolListVersion?: string } = {}) {
  return { id, label: id[0].toUpperCase() + id.slice(1), mcpUrl: fixture.url, headers: { Authorization: "Bearer test-token-1" }, ...extra };
}

const ctx = { userId: "user-1", conversationId: "chat-1", sessionId: "gen-1", surface: "chat" };

async function eventually(check: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

const opens = () => logged.filter((entry) => entry.event === "mcp.open").map((entry) => entry.fields);

beforeEach(() => {
  resetMcpToolListCacheForTests();
  audits.length = 0;
  logged.length = 0;
});

test("a server that does not answer within its budget is dropped and its connection closed; the others are kept", async () => {
  const fast = await mcpServer("ok");
  const slow = await mcpServer("hang");
  // Answers the handshake, then sits on its tool list: the SDK does not close
  // this one by itself, so only the toolset's own close frees the socket.
  const stalling = await mcpServer("hang-list");
  const statuses: Array<[string, string]> = [];
  const startedAt = Date.now();
  // Generous for a loopback handshake even on a loaded CI runner; the slow
  // server still has to be dropped long before the SDK's own 60 s.
  const toolset = await openMcpToolset([connector("beta", slow), connector("alpha", fast), connector("gamma", stalling)], ctx, {
    connectTimeoutMs: 2_000,
    onConnectorStatus: (id, state) => statuses.push([id, state]),
  });
  const took = Date.now() - startedAt;
  try {
    assert.ok(took >= 1_900 && took < 8_000, `the open waited ${took} ms: the budget, not the SDK's 60 s`);
    assert.deepEqual(toolset.tools.map((tool) => tool.function.name), ["alpha__search", "alpha__create_item"]);
    assert.deepEqual(statuses.sort(), [["alpha", "ready"], ["beta", "timeout"], ["gamma", "timeout"]]);
    assert.ok(slow.hung >= 1 && stalling.hung === 1, "both slow servers were asked");
    assert.ok(await eventually(() => slow.hungClosed === slow.hung), "every request it never answered had its connection closed");
    assert.ok(await eventually(() => stalling.hungClosed === 1), "the stalled tool list's connection was closed too");
    const [open] = opens();
    assert.equal(open.servers, 3);
    assert.equal(open.ready, 1);
    assert.deepEqual(open.dropped, [
      { connector: "beta", reason: "timeout" },
      { connector: "gamma", reason: "timeout" },
    ]);
    assert.equal(open.aborted, false);
    // A tool of the dropped server is not routable: never dialled again this turn.
    const result = await toolset.execute("beta__search", {}, undefined, "call-x");
    assert.equal(result.ok, false);
    assert.match(result.text, /Unknown tool/);
  } finally {
    await toolset.close();
  }
});

test("the caller's signal cancels the open: nothing comes back, and the hung connection is closed", async () => {
  const fast = await mcpServer("ok");
  const slow = await mcpServer("hang");
  const statuses: Array<[string, string]> = [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const startedAt = Date.now();
  // No budget of its own: only the signal (the Work runner's deadline) ends it.
  const toolset = await openMcpToolset([connector("alpha", fast), connector("beta", slow)], ctx, {
    signal: controller.signal,
    onConnectorStatus: (id, state) => statuses.push([id, state]),
  });
  const took = Date.now() - startedAt;
  try {
    assert.ok(took < 5_000, `the open took ${took} ms after a 300 ms abort`);
    assert.deepEqual(toolset.tools, [], "a cancelled open hands nothing back, not even the server that answered");
    assert.deepEqual(statuses.filter(([id]) => id === "beta"), [], "an external abort is the caller's to report");
    assert.ok(await eventually(() => slow.hung >= 1 && slow.hungClosed === slow.hung), "the hung request's connection was closed");
    assert.equal(opens()[0].aborted, true);
    const result = await toolset.execute("alpha__search", {}, undefined, "call-y");
    assert.equal(result.ok, false, "nothing is dialled after a cancelled open");
    assert.equal(fast.counts["tools/call"], undefined);
  } finally {
    await toolset.close();
  }
  // An already-aborted signal dials nobody.
  const before = fast.counts.initialize ?? 0;
  const none = await openMcpToolset([connector("alpha", fast)], ctx, { signal: AbortSignal.abort() });
  assert.deepEqual(none.tools, []);
  assert.equal(fast.counts.initialize ?? 0, before);
  await none.close();
});

test("a chat turn reuses a recent tool list: nobody is dialled at open, and the first call connects without listing", async () => {
  const fast = await mcpServer("ok");
  const gamma = connector("gamma", fast, { toolListVersion: "v1" });

  const first = await openMcpToolset([gamma], ctx, { cacheTools: true, connectTimeoutMs: 2_000 });
  const names = first.tools.map((tool) => tool.function.name);
  await first.close();
  assert.deepEqual([fast.counts.initialize, fast.counts["tools/list"]], [1, 1]);

  const statuses: Array<[string, string]> = [];
  const second = await openMcpToolset([gamma], ctx, {
    cacheTools: true,
    connectTimeoutMs: 2_000,
    onConnectorStatus: (id, state) => statuses.push([id, state]),
  });
  try {
    assert.deepEqual(second.tools.map((tool) => tool.function.name), names, "the same tools, named the same way");
    assert.deepEqual([fast.counts.initialize, fast.counts["tools/list"]], [1, 1], "no handshake and no list at open");
    assert.deepEqual(statuses, [["gamma", "ready"]]);
    assert.equal(opens().at(-1)?.cached, 1);
    // The read/write verdict and the annotations survive the cache.
    assert.equal(second.accessFor("gamma__search"), "read");
    assert.deepEqual(second.tools.find((tool) => tool.function.name === "gamma__search")?.annotations, { readOnlyHint: true });

    const result = await second.execute("gamma__search", { q: "x" }, undefined, "call-1");
    assert.equal(result.ok, true);
    assert.match(result.body, /found it/);
    assert.deepEqual([fast.counts.initialize, fast.counts["tools/list"], fast.counts["tools/call"]], [2, 1, 1]);
    // A second call rides the same connection.
    await second.execute("gamma__search", { q: "y" }, undefined, "call-2");
    assert.deepEqual([fast.counts.initialize, fast.counts["tools/call"]], [2, 2]);
  } finally {
    await second.close();
  }
});

test("a changed connector, another user, a chat that asks no cache, or an invalidation lists afresh", async () => {
  const fast = await mcpServer("ok");
  const open = async (c: ReturnType<typeof connector>, context = ctx, cacheTools = true) =>
    (await openMcpToolset([c], context, { cacheTools, connectTimeoutMs: 2_000 })).close();

  await open(connector("gamma", fast, { toolListVersion: "v1" }));
  assert.equal(fast.counts["tools/list"], 1);
  await open(connector("gamma", fast, { toolListVersion: "v1" }));
  assert.equal(fast.counts["tools/list"], 1, "cached");
  await open(connector("gamma", fast, { toolListVersion: "v2" }));
  assert.equal(fast.counts["tools/list"], 2, "the connector row changed (edited, re-linked, refreshed)");
  await open(connector("gamma", fast, { toolListVersion: "v2" }), { ...ctx, userId: "user-2" });
  assert.equal(fast.counts["tools/list"], 3, "never shared between users");
  await open(connector("gamma", fast, { toolListVersion: "v2" }), ctx, false);
  assert.equal(fast.counts["tools/list"], 4, "Work does not ask for the cache");
  // Without a version the credential stands in for it.
  await open({ ...connector("gamma", fast), headers: { Authorization: "Bearer a" } });
  await open({ ...connector("gamma", fast), headers: { Authorization: "Bearer a" } });
  assert.equal(fast.counts["tools/list"], 5);
  await open({ ...connector("gamma", fast), headers: { Authorization: "Bearer b" } });
  assert.equal(fast.counts["tools/list"], 6, "a new credential is a new entry");
  assert.ok(invalidateMcpToolListCache("user-1", "gamma") >= 1);
  await open(connector("gamma", fast, { toolListVersion: "v2" }));
  assert.equal(fast.counts["tools/list"], 7);
});

test("a cached server that stopped answering fails the call before any approval, and is listed afresh next turn", async () => {
  const flaky = await mcpServer("ok");
  const delta = connector("delta", flaky, { toolListVersion: "v1" });
  await (await openMcpToolset([delta], ctx, { cacheTools: true, connectTimeoutMs: 2_000 })).close();

  flaky.mode = "refuse";
  const cached = await openMcpToolset([delta], ctx, { cacheTools: true, connectTimeoutMs: 2_000 });
  try {
    assert.equal(cached.tools.length, 2, "offered from the cache");
    const result = await cached.execute("delta__create_item", {}, undefined, "call-1");
    assert.equal(result.ok, false);
    assert.match(result.text, /Connector delta is not available\./);
    assert.deepEqual(audits.at(-1), { status: "failed", error: "connector unavailable" });
  } finally {
    await cached.close();
  }

  const statuses: Array<[string, string]> = [];
  const next = await openMcpToolset([delta], ctx, {
    cacheTools: true,
    connectTimeoutMs: 2_000,
    onConnectorStatus: (id, state) => statuses.push([id, state]),
  });
  assert.deepEqual(next.tools, [], "the failed connect forgot the list");
  assert.deepEqual(statuses, [["delta", "unreachable"]]);
  await next.close();
});

test("the tool-list cache: a lifetime, a size bound, copies out, and keys that hold no credential", () => {
  let clock = 0;
  let ttl = 300_000;
  const cache = cacheModule.createMcpToolListCache({ ttlMs: () => ttl, maxEntries: 2, now: () => clock });
  const key = (connectorId: string, token = "secret-token") =>
    cacheModule.mcpToolListCacheKey({ userId: "u", connectorId, mcpUrl: "https://mcp.example.com/x", headers: { Authorization: `Bearer ${token}` } });
  assert.doesNotMatch(key("a"), /secret-token|mcp\.example\.com/);
  assert.notEqual(key("a"), key("a", "other-token"));
  assert.equal(
    cacheModule.mcpToolListCacheKey({ userId: "u", connectorId: "a", mcpUrl: "https://x", headers: { A: "1" }, version: "7" }),
    cacheModule.mcpToolListCacheKey({ userId: "u", connectorId: "a", mcpUrl: "https://x", headers: { A: "2" }, version: "7" }),
    "a version stands for the connector; per-turn minted tokens do not split it"
  );

  cache.set(key("a"), [{ name: "t", inputSchema: { type: "object" } }]);
  const out = cache.get(key("a"))!;
  (out[0].inputSchema as Record<string, unknown>).type = "changed";
  assert.equal(cache.get(key("a"))![0].inputSchema?.type, "object", "a caller cannot change an entry");
  clock = 299_999;
  assert.ok(cache.get(key("a")));
  clock = 300_000;
  assert.equal(cache.get(key("a")), undefined, "expired");

  cache.set(key("a"), [{ name: "t" }]);
  cache.set(key("b"), [{ name: "t" }]);
  cache.set(key("c"), [{ name: "t" }]);
  assert.equal(cache.size, 2);
  assert.equal(cache.get(key("a")), undefined, "the oldest went first");
  assert.equal(cache.invalidate("u", "b"), 1);
  assert.equal(cache.invalidate("u"), 1);
  ttl = 0;
  cache.set(key("d"), [{ name: "t" }]);
  assert.equal(cache.size, 0, "0 turns the cache off");

  assert.equal(cacheModule.mcpToolListCacheTtlMs({}), 300_000);
  assert.equal(cacheModule.mcpToolListCacheTtlMs({ MCP_TOOL_LIST_CACHE_SECONDS: "0" }), 0);
  assert.equal(cacheModule.mcpToolListCacheTtlMs({ MCP_TOOL_LIST_CACHE_SECONDS: "99999" }), 3_600_000);
  assert.equal(cacheModule.mcpToolListCacheTtlMs({ MCP_TOOL_LIST_CACHE_SECONDS: "soon" }), 300_000);
});

test("a chat turn's per-server budget: 5 s by default, tunable within 1 to 30 s", () => {
  assert.equal(CHAT_CONNECT_TIMEOUT_MS, 5_000);
  assert.equal(mcpConnectTimeoutMs({}), 5_000);
  assert.equal(mcpConnectTimeoutMs({ MCP_CONNECT_TIMEOUT_MS: "8000" }), 8_000);
  assert.equal(mcpConnectTimeoutMs({ MCP_CONNECT_TIMEOUT_MS: "10" }), 1_000);
  assert.equal(mcpConnectTimeoutMs({ MCP_CONNECT_TIMEOUT_MS: "600000" }), 30_000);
  assert.equal(mcpConnectTimeoutMs({ MCP_CONNECT_TIMEOUT_MS: "" }), 5_000);
});

test("the chat path asks for the bounded, cached open, and a dropped connector becomes one warning row", () => {
  const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
  const runtime = read("src/lib/agent/runtime.ts");
  assert.match(runtime, /openMcpToolset\(activeConnectors, mcpContext, \{\s*connectTimeoutMs: mcpConnectTimeoutMs\(\),\s*cacheTools: true,\s*signal: context\.abortSignal,\s*onConnectorStatus: options\?\.onConnectorStatus,/);
  const llm = read("src/lib/llm.ts");
  assert.match(llm, /onConnectorStatus: opts\.onConnectorStatus,/);
  assert.ok(llm.indexOf("opts.onProviderRequest?.()") > llm.indexOf("openUnifiedAgentToolset(active"), "the request goes out after the toolset opened");
  assert.ok(llm.indexOf("opts.onProviderRequest?.()") < llm.indexOf("switch (adapter)"));
  const runTurn = read("src/lib/chat/turn/run-turn.ts");
  assert.match(runTurn, /onProviderRequest: trace\.noteProviderCall,\s*onConnectorStatus: reportConnectorStatus,/);
  assert.match(runTurn, /sendActivity\(connectorUnavailableRow\(\{ label, reason: state \}\)\);/);
  const mcp = read("src/lib/mcp.ts");
  assert.equal((mcp.match(/toolListVersion: toolListVersionOf\(/g) ?? []).length, 5, "every connector getActiveConnectors returns carries its version");
});
