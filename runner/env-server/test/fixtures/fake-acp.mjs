#!/usr/bin/env node
// A minimal ACP agent over stdio for the env server's tests. Prompt text picks
// the scenario: "edit" asks session/request_permission before a file edit,
// "slow" streams until session/cancel, "limit" fails with a quota error,
// "mcp" reports which MCP servers session/new received.
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-acp 1.2.3\n");
  process.exit(0);
}
if (process.env.FAKE_ACP_REQUIRE_FLAG && !process.argv.includes(process.env.FAKE_ACP_REQUIRE_FLAG)) {
  process.stderr.write("unknown flag\n");
  process.exit(3);
}

let nextId = 5000;
const pending = new Map();
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = new Map();
let cancelled = new Set();

async function prompt(id, params) {
  const sid = params.sessionId;
  const text = params.prompt.map((b) => b.text ?? "").join(" ");
  cancelled.delete(sid);
  if (/limit/.test(text)) {
    send({ id, error: { code: -32603, message: "Quota exceeded for this account. Try again in 2 hours." } });
    return;
  }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Considering." } });
  if (/edit/.test(text)) {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Edit src/app.ts", kind: "edit", status: "pending", locations: [{ path: "src/app.ts" }] });
    const answer = await request("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "tc1", title: "Edit src/app.ts", kind: "edit" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.outcome?.outcome === "selected" && answer.outcome.optionId !== "no";
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc1",
      status: allowed ? "completed" : "failed",
      ...(allowed ? { content: [{ type: "diff", path: "src/app.ts", oldText: "a", newText: "b" }] } : {}),
    });
  }
  if (/slow/.test(text)) {
    for (let i = 0; i < 400 && !cancelled.has(sid); i++) {
      update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
      await wait(10);
    }
    if (cancelled.has(sid)) {
      send({ id, result: { stopReason: "cancelled" } });
      return;
    }
  }
  const mcp = sessions.get(sid)?.mcpServers ?? [];
  const reply = /mcp/.test(text) ? `mcp: ${JSON.stringify(mcp.map((s) => ({ name: s.name, type: s.type ?? "stdio" })))}` : `ACP says: ${text}`;
  for (const word of reply.split(/(?= )/)) update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: word } });
  update(sid, { sessionUpdate: "plan", entries: [{ content: "Reply", priority: "high", status: "completed" }] });
  send({ id, result: { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) {
    pending.get(msg.id)?.(msg.result ?? {});
    pending.delete(msg.id);
    return;
  }
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return send({
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.FAKE_ACP_HTTP_MCP === "1" } },
          authMethods: [],
          agentInfo: { name: "fake-acp", version: "1.2.3" },
        },
      });
    case "session/new": {
      const sessionId = `acp_${sessions.size + 1}`;
      sessions.set(sessionId, { mcpServers: params.mcpServers ?? [] });
      return send({ id, result: { sessionId, modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }, { id: "bypassPermissions", name: "Bypass" }] } } });
    }
    case "session/load":
      sessions.set(params.sessionId, { mcpServers: params.mcpServers ?? [] });
      return send({ id, result: {} });
    case "session/set_mode":
      return send({ id, result: {} });
    case "session/prompt":
      void prompt(id, params);
      return;
    case "session/cancel":
      cancelled.add(params.sessionId);
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `no ${method}` } });
  }
});
