/**
 * End-to-end scenarios through the alevr-code-v2 WebSocket protocol, with fake
 * vendor runtimes: a codex app-server emulator, an ACP agent and a stubbed
 * Claude Agent SDK query(). Each test starts its own env server on a free port
 * with its own data dir and bin dir.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { ApprovalRequestItem, ModelSelection, ServerEventEnvelope, TurnItem, UserInputRequestItem } from "../src/contracts/code-v2.js";
import { TestClient, fakeBinDir, fakeClaudeQuery, initRepo, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

async function boot(extra: Parameters<typeof startEnvServer>[0] = {}) {
  const bin = fakeBinDir();
  const record = { options: [] as unknown[], prompts: [] as string[] };
  const server = await startEnvServer({
    dataDir: tempDir("data"),
    searchDirs: [bin],
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    forcePipeTerminals: true,
    terminalShell: "/bin/sh",
    claudeQuery: fakeClaudeQuery(record),
    ...extra,
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  return { server, client, record, bin };
}

const ask = { runtimeMode: "ask", interactionMode: "default" } as const;
const items = (c: TestClient, sid: string): TurnItem[] => c.snapshot(sid).items;
const pendingApproval = (c: TestClient, sid: string) =>
  c.waitFor(() => items(c, sid).find((i): i is ApprovalRequestItem => i.kind === "approval_request" && i.status === "pending"), 8000, "an approval request");
const lastAssistant = (c: TestClient, sid: string) => [...items(c, sid)].reverse().find((i) => i.kind === "assistant_message") as Extract<TurnItem, { kind: "assistant_message" }> | undefined;

/** item.delta events after the given turn started (earlier turns' deltas do not count). */
function deltasSince(c: TestClient, sid: string, turnId: string): number {
  const events = c.sessionEvents(sid);
  const start = events.findIndex((e) => e.event.type === "turn.started" && e.event.turnId === turnId);
  return start < 0 ? 0 : events.slice(start).filter((e) => e.event.type === "item.delta").length;
}

async function openSession(c: TestClient, cwd: string, selection: ModelSelection): Promise<string> {
  const { sessionId } = await c.command<{ sessionId: string }>("session.open", { cwd, selection });
  await c.waitFor(() => c.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

// ── Transport ────────────────────────────────────────────────────────────────

test("transport: bearer required, loopback host only, health has no secrets", async () => {
  const { server } = await boot();
  await assert.rejects(TestClient.connect(server.url, "wrong-token"), /401/);
  await assert.rejects(TestClient.connect(server.url, server.token, { headers: { origin: "https://evil.example" } }), /401/);
  // Subprotocol token for clients that cannot set headers (browsers).
  const viaProtocol = await TestClient.connect(server.url, "unused", { protocols: ["alevr-code-v2", `alevr-token.${server.token}`] });
  clients.push(viaProtocol);
  const list = await viaProtocol.command<{ instances: { id: string }[] }>("provider.list", {});
  assert.ok(list.instances.some((i) => i.id === "codex:default"));
  const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json() as Promise<Record<string, unknown>>);
  assert.equal(health.ok, true);
  assert.ok(!JSON.stringify(health).includes(server.token));
  const mcp = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", body: "{}" });
  assert.equal(mcp.status, 401, "MCP needs a scoped token");
});

// ── Codex app-server ─────────────────────────────────────────────────────────

test("codex: probe reads account, paged models and limit windows without a session", async () => {
  const { client } = await boot();
  const { instance } = await client.command<{ instance: import("../src/contracts/code-v2.js").ProviderInstance }>("provider.probe", { instanceId: "codex:default" });
  assert.equal(instance.status, "ready");
  assert.equal(instance.account?.email, "dev@example.com");
  assert.deepEqual(instance.models?.map((m) => m.id).sort(), ["gpt-6.1-codex", "gpt-6.1-mini"]);
  assert.ok(instance.limits?.some((w) => typeof w.usedPct === "number"));
  assert.equal(instance.capabilities?.steering, true);
  const { step } = await client.command<{ step: { command: string } }>("provider.setup", { instanceId: "codex:default", action: "login" });
  assert.match(step.command, /codex' login|codex login/);
});

test("codex: approval, file change, checkpoint and per-turn diff", async () => {
  const { client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const repo = initRepo();
  const sid = await openSession(client, repo, { instanceId: "codex:default", model: "gpt-6.1-codex" });
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "approve then write notes.md" }, selection: { instanceId: "codex:default", model: "gpt-6.1-codex" }, ...ask });
  const approval = await pendingApproval(client, sid);
  assert.equal(approval.action, "command");
  assert.match(approval.summary, /npm test/);
  assert.equal(client.snapshot(sid).state, "waiting");
  await client.command("approval.respond", { sessionId: sid, requestId: approval.requestId, decision: "accept" });
  const done = await client.turnCompleted(sid, turnId);
  assert.equal(done.outcome, "completed");
  assert.ok(done.usage && done.usage.inputTokens > 0);
  const snap = client.snapshot(sid);
  const cmd = snap.items.find((i) => i.kind === "command_execution");
  assert.ok(cmd && cmd.kind === "command_execution" && cmd.status === "completed" && /passes/.test(cmd.output ?? ""));
  assert.ok(snap.items.some((i) => i.kind === "file_change"));
  assert.ok(snap.items.some((i) => i.kind === "reasoning"));
  assert.match(lastAssistant(client, sid)?.text ?? "", /^Done: approve/);
  const cp = snap.items.find((i) => i.kind === "checkpoint");
  assert.ok(cp && cp.kind === "checkpoint");
  assert.equal(cp.filesChanged, 1);
  const turnDiff = await client.command<{ diff: string; files: { path: string }[] }>("checkpoint.diff", { sessionId: sid, checkpointId: cp.checkpointId });
  assert.deepEqual(turnDiff.files.map((f) => f.path), ["notes.md"]);
  assert.match(turnDiff.diff, /written by fake codex/);
  // Whole-thread diff includes later uncommitted edits too.
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const whole = await client.command<{ files: { path: string }[] }>("checkpoint.diff", { sessionId: sid });
  assert.deepEqual(whole.files.map((f) => f.path).sort(), ["README.md", "notes.md"]);
  // Rolling back to before the first turn restores both.
  const { restoredFiles } = await client.command<{ restoredFiles: number }>("checkpoint.rollback", { sessionId: sid, checkpointId: "cp_0" });
  assert.equal(restoredFiles, 2);
  assert.equal(fs.existsSync(path.join(repo, "notes.md")), false);
  assert.equal(fs.readFileSync(path.join(repo, "README.md"), "utf8"), "hello\n");
  assert.deepEqual(client.gaps, [], "no sequence gaps on the wire");
});

test("codex: steer lands in the running turn, interrupt stops the next", async () => {
  const { client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const sid = await openSession(client, tempDir("cwd"), { instanceId: "codex:default", model: "gpt-6.1-codex" });
  const selection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
  const t1 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow one" }, selection, ...ask });
  await client.waitFor(() => deltasSince(client, sid, t1.turnId) > 0, 5000, "streaming");
  const steer = await client.command<{ accepted: boolean }>("turn.steer", { sessionId: sid, turnId: t1.turnId, input: { text: "use tabs" } });
  assert.equal(steer.accepted, true);
  assert.equal((await client.turnCompleted(sid, t1.turnId)).outcome, "completed");
  assert.match(lastAssistant(client, sid)?.text ?? "", /noted: use tabs/);
  assert.ok(items(client, sid).some((i) => i.kind === "user_message" && i.delivery === "steer"));

  const t2 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow two" }, selection, ...ask });
  await client.waitFor(() => deltasSince(client, sid, t2.turnId) > 0, 5000, "streaming");
  // A message queued while running waits; the interrupt does not drain it.
  await client.command("turn.queue", { sessionId: sid, input: { text: "after that" } });
  assert.equal(client.snapshot(sid).queue.length, 1);
  await client.command("turn.interrupt", { sessionId: sid, turnId: t2.turnId });
  assert.equal((await client.turnCompleted(sid, t2.turnId)).outcome, "interrupted");
  assert.ok(items(client, sid).some((i) => i.kind === "interrupt" && i.reason === "user"));
  assert.equal(client.snapshot(sid).queue.length, 1);
});

test("codex: usage limit becomes 'limited' with a reset time, on the session and the instance", async () => {
  const { client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const sid = await openSession(client, tempDir("cwd"), { instanceId: "codex:default", model: "gpt-6.1-codex" });
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "limit please" }, selection: { instanceId: "codex:default", model: "gpt-6.1-codex" }, ...ask });
  assert.equal((await client.turnCompleted(sid, turnId)).outcome, "limited");
  const snap = client.snapshot(sid);
  assert.equal(snap.state, "limited");
  assert.ok(snap.resumeAt && Date.parse(snap.resumeAt) > Date.now());
  const int = snap.items.find((i) => i.kind === "interrupt");
  assert.ok(int && int.kind === "interrupt" && int.reason === "limit");
  const update = await client.waitFor(
    () => client.events.find((e) => e.stream === "global" && e.event.type === "provider.updated" && e.event.instance.id === "codex:default" && e.event.instance.status === "limited"),
    4000,
    "instance limited",
  );
  assert.ok(update);
  // A new turn on a limited instance is still allowed (the user may know better); start is not refused by status alone.
});

test("codex: signed-out instance refuses turns with a plain sign-in message", async () => {
  process.env.FAKE_CODEX_SIGNED_OUT = "1";
  try {
    const { client } = await boot();
    const { instance } = await client.command<{ instance: { status: string } }>("provider.probe", { instanceId: "codex:default" });
    assert.equal(instance.status, "signed-out");
    const sid = await openSession(client, tempDir("cwd"), { instanceId: "codex:default", model: "gpt-6.1-codex" });
    await assert.rejects(
      client.command("turn.start", { sessionId: sid, input: { text: "hi" }, selection: { instanceId: "codex:default", model: "x" }, ...ask }),
      (e: Error & { code?: string }) => e.code === "not_ready",
    );
  } finally {
    delete process.env.FAKE_CODEX_SIGNED_OUT;
  }
});

// ── Claude (the user's own claude CLI through the Agent SDK) ─────────────────

test("claude: no-cost probe reports account, models and usage windows", async () => {
  const { client, record } = await boot();
  const { instance } = await client.command<{ instance: import("../src/contracts/code-v2.js").ProviderInstance }>("provider.probe", { instanceId: "claude-agent:default" });
  assert.equal(instance.status, "ready");
  assert.equal(instance.label, "Claude (your subscription)");
  assert.equal(instance.account?.plan?.toLowerCase().includes("max"), true);
  assert.ok(instance.models?.some((m) => m.id === "claude-opus-5-5"));
  assert.ok(instance.limits?.some((w) => w.usedPct === 22));
  const probeOptions = record.options[0] as Record<string, unknown>;
  assert.equal(probeOptions.persistSession, false);
  assert.deepEqual(probeOptions.allowedTools, []);
  assert.ok(String(probeOptions.pathToClaudeCodeExecutable).endsWith("/claude"));
  assert.ok(!record.prompts.some((p) => p !== "<probe>"), "the probe sends no prompt");
});

test("claude: tool approval, plan capture, questions, steer and interrupt", async () => {
  const { client, record } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const selection = { instanceId: "claude-agent:default", model: "claude-opus-5-5" };
  const sid = await openSession(client, tempDir("cwd"), selection);

  const t1 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "run bash" }, selection, ...ask });
  const approval = await pendingApproval(client, sid);
  assert.match(approval.summary, /ls -la/);
  assert.ok(approval.options?.includes("acceptForSession"), "SDK suggestions offer 'for this session'");
  await client.command("approval.respond", { sessionId: sid, requestId: approval.requestId, decision: "decline" });
  assert.equal((await client.turnCompleted(sid, t1.turnId)).outcome, "completed");
  const turnOptions = record.options.at(-1) as Record<string, unknown>;
  assert.equal(turnOptions.permissionMode, "default");
  assert.ok((turnOptions.mcpServers as Record<string, unknown>)?.alevr, "the Alevr MCP server is injected");

  const t2 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "make a plan" }, selection, runtimeMode: "ask", interactionMode: "plan" });
  await client.turnCompleted(sid, t2.turnId);
  const plan = items(client, sid).find((i) => i.kind === "plan");
  assert.ok(plan && plan.kind === "plan" && plan.awaitingApproval && /Fix the bug/.test(plan.text));

  const t3 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "ask me" }, selection, ...ask });
  const q = await client.waitFor(() => items(client, sid).find((i): i is UserInputRequestItem => i.kind === "user_input_request" && i.status === "pending"), 5000, "question");
  assert.deepEqual(q.questions[0].options, ["WebKit", "Chromium"]);
  await client.command("approval.respond", { sessionId: sid, requestId: q.requestId, decision: "accept", answers: { browser: ["WebKit"] } });
  await client.turnCompleted(sid, t3.turnId);
  assert.match(lastAssistant(client, sid)?.text ?? "", /WebKit/);

  const t4 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection, ...ask });
  await client.waitFor(() => client.sessionEvents(sid).some((e) => e.event.type === "item.delta" && e.event.append === "."), 5000, "stream");
  const steer = await client.command<{ accepted: boolean }>("turn.steer", { sessionId: sid, turnId: t4.turnId, input: { text: "and be brief" } });
  assert.equal(steer.accepted, true);
  await client.turnCompleted(sid, t4.turnId);
  assert.match(lastAssistant(client, sid)?.text ?? "", /and be brief/);

  const t5 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow again" }, selection, ...ask });
  await client.waitFor(() => client.snapshot(sid).state === "running", 4000, "running");
  await client.command("turn.interrupt", { sessionId: sid });
  assert.equal((await client.turnCompleted(sid, t5.turnId)).outcome, "interrupted");
});

test("claude: a rejected rate limit ends the turn as limited with the vendor's reset", async () => {
  const { client } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const selection = { instanceId: "claude-agent:default", model: "claude-opus-5-5" };
  const sid = await openSession(client, tempDir("cwd"), selection);
  const t = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "hit the limit" }, selection, ...ask });
  assert.equal((await client.turnCompleted(sid, t.turnId)).outcome, "limited");
  const resumeAt = client.snapshot(sid).resumeAt;
  assert.ok(resumeAt);
  assert.ok(Math.abs(Date.parse(resumeAt!) - (Date.now() + 1800_000)) < 120_000);
});

// ── ACP agents ───────────────────────────────────────────────────────────────

test("acp: initialize-only probe, permission options, cancel and quota errors", async () => {
  const { client } = await boot();
  const { instance } = await client.command<{ instance: { status: string; version?: string } }>("provider.probe", { instanceId: "acp:gemini" });
  assert.equal(instance.status, "ready");
  const selection = { instanceId: "acp:gemini", model: "default" };
  const sid = await openSession(client, tempDir("cwd"), selection);

  const t1 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "edit it" }, selection, ...ask });
  const approval = await pendingApproval(client, sid);
  assert.equal(approval.action, "file_change");
  await client.command("approval.respond", { sessionId: sid, requestId: approval.requestId, decision: "accept" });
  assert.equal((await client.turnCompleted(sid, t1.turnId)).outcome, "completed");
  assert.match(lastAssistant(client, sid)?.text ?? "", /ACP says: edit it/);

  const t2 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection, ...ask });
  await client.waitFor(() => client.snapshot(sid).state === "running" && deltasSince(client, sid, t2.turnId) > 0, 5000, "stream");
  await client.command("turn.interrupt", { sessionId: sid });
  assert.equal((await client.turnCompleted(sid, t2.turnId)).outcome, "interrupted");

  const t3 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "limit" }, selection, ...ask });
  assert.equal((await client.turnCompleted(sid, t3.turnId)).outcome, "limited");
  assert.ok(client.snapshot(sid).resumeAt);
});

test("acp: the Alevr MCP server reaches agents (stdio bridge when http MCP is not supported)", async () => {
  const { client } = await boot({ mcpBridge: { command: process.execPath, args: ["-e", "0"] } });
  await client.command("provider.probe", { instanceId: "acp:gemini" });
  const selection = { instanceId: "acp:gemini", model: "default" };
  const sid = await openSession(client, tempDir("cwd"), selection);
  const t = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "mcp list" }, selection, ...ask });
  await client.turnCompleted(sid, t.turnId);
  assert.match(lastAssistant(client, sid)?.text ?? "", /"name":"alevr"/);
});

test("acp: legal-hold preset stays off until enabled", async () => {
  const { client, bin } = await boot();
  fs.writeFileSync(path.join(bin, "antigravity-acp"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "fake-acp.mjs")}" "$@"\n`, { mode: 0o755 });
  const sid = await openSession(client, tempDir("cwd"), { instanceId: "acp:antigravity", model: "default" });
  await assert.rejects(
    client.command("turn.start", { sessionId: sid, input: { text: "hi" }, selection: { instanceId: "acp:antigravity", model: "default" }, ...ask }),
    (e: Error & { code?: string }) => e.code === "not_ready" || e.code === "not_found",
  );
});

// ── Alevr MCP: subagents on any instance, thread search ─────────────────────

async function mcpCall(server: EnvServer, token: string, method: string, params: Record<string, unknown>, id = 1) {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: Record<string, any>; error?: { message: string } };
}

test("mcp: a session spawns a Codex subagent, waits for it, and finds threads", async () => {
  const { server, client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const cwd = tempDir("cwd");
  const parent = await openSession(client, cwd, { instanceId: "codex:default", model: "gpt-6.1-codex" });
  const t = await client.command<{ turnId: string }>("turn.start", { sessionId: parent, input: { text: "hello parent" }, selection: { instanceId: "codex:default", model: "gpt-6.1-codex" }, ...ask });
  await client.turnCompleted(parent, t.turnId);

  const token = server.mcp.issueToken({ sessionId: parent, depth: 0 });
  const init = await mcpCall(server, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.ok(init.result?.serverInfo);
  const tools = await mcpCall(server, token, "tools/list", {}, 2);
  const names = (tools.result?.tools as { name: string }[]).map((x) => x.name);
  for (const n of ["spawn_subagent", "wait_subagent", "list_subagents", "cancel_subagent", "search_threads"]) assert.ok(names.includes(n), n);

  const spawned = await mcpCall(server, token, "tools/call", { name: "spawn_subagent", arguments: { task: "summarize the repo", instanceId: "codex:default", model: "gpt-6.1-codex" } }, 3);
  const agentId = (spawned.result?.structuredContent as { agentId?: string })?.agentId ?? JSON.parse(spawned.result?.content[0].text).agentId;
  assert.ok(agentId, JSON.stringify(spawned));
  const waited = await mcpCall(server, token, "tools/call", { name: "wait_subagent", arguments: { agentId } }, 4);
  assert.match(JSON.stringify(waited.result), /Done: summarize the repo/);
  const sub = await client.waitFor(() => items(client, parent).find((i) => i.kind === "subagent" && i.status === "completed"), 5000, "subagent item");
  assert.ok(sub);

  // Children cannot spawn grandchildren.
  const childToken = server.mcp.issueToken({ sessionId: agentId, depth: 1 });
  const childTools = await mcpCall(server, childToken, "tools/list", {}, 5);
  assert.ok(!(childTools.result?.tools as { name: string }[]).some((x) => x.name === "spawn_subagent"));

  const found = await mcpCall(server, token, "tools/call", { name: "search_threads", arguments: { query: "summarize" } }, 6);
  assert.match(JSON.stringify(found.result), new RegExp(agentId));
  const list = await client.command<{ sessions: { id: string; parentSessionId?: string }[] }>("session.list", {});
  assert.equal(list.sessions.find((s) => s.id === agentId)?.parentSessionId, parent);
});

test("mcp: the routing budget is a hard stop for vendor subagents", async () => {
  const { server, client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const selection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
  const parent = await openSession(client, tempDir("cwd"), selection);
  const routing = { preset: "lead-workers", orchestrator: selection, workers: [selection], budget: { maxTokens: 100 } };
  const t = await client.command<{ turnId: string }>("turn.start", { sessionId: parent, input: { text: "hello parent" }, selection, routing, ...ask });
  await client.turnCompleted(parent, t.turnId);

  const token = server.mcp.issueToken({ sessionId: parent, depth: 0 });
  const first = await mcpCall(server, token, "tools/call", { name: "spawn_subagent", arguments: { task: "one" } }, 1);
  const agentId = (first.result?.structuredContent as { agentId?: string })?.agentId;
  assert.ok(agentId, JSON.stringify(first));
  await mcpCall(server, token, "tools/call", { name: "wait_subagent", arguments: { agentId } }, 2);
  // The child used 1,280 tokens; the budget is 100, so a second child is refused.
  const second = await mcpCall(server, token, "tools/call", { name: "spawn_subagent", arguments: { task: "two" } }, 3);
  assert.equal(second.result?.isError, true);
  assert.match(JSON.stringify(second.result), /token budget/);
});

// ── Persistence and reconnect ────────────────────────────────────────────────

test("reconnect: afterSequence replays exactly the missed events; restart restores the log", async () => {
  const { server, client } = await boot();
  await client.command("provider.probe", { instanceId: "codex:default" });
  const sid = await openSession(client, tempDir("cwd"), { instanceId: "codex:default", model: "gpt-6.1-codex" });
  const t = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "first" }, selection: { instanceId: "codex:default", model: "gpt-6.1-codex" }, ...ask });
  await client.turnCompleted(sid, t.turnId);
  const cursor = client.cursors.get(sid)!;

  const late = await TestClient.connect(server.url, server.token);
  clients.push(late);
  await late.command("session.open", { sessionId: sid, cwd: "/", afterSequence: 2 });
  await late.waitFor(() => late.sessionEvents(sid).some((e) => e.sequence === cursor), 4000, "replay");
  const replayed = late.sessionEvents(sid).map((e: ServerEventEnvelope) => e.sequence);
  assert.equal(replayed[0], 3);
  assert.deepEqual(replayed, [...new Set(replayed)].sort((a, b) => a - b), "in order, no duplicates");

  // A re-attach never creates: an unknown id with afterSequence is not_found, and no session appears.
  const before = (await late.command<{ sessions: { id: string }[] }>("session.list", {})).sessions.length;
  await assert.rejects(late.command("session.open", { sessionId: "s_unknown", cwd: "/", afterSequence: -1 }), /No session/);
  assert.equal((await late.command<{ sessions: { id: string }[] }>("session.list", {})).sessions.length, before);

  // A second server process on the same data dir sees the same snapshot.
  const again = await startEnvServer({ dataDir: server.dataDir, searchDirs: [], logger: silentLogger, probeOnStart: false });
  servers.push(again);
  const c2 = await TestClient.connect(again.url, again.token);
  clients.push(c2);
  await c2.command("session.open", { sessionId: sid, cwd: "/" });
  const snap = await c2.waitFor(() => c2.snapshots.get(sid), 4000, "snapshot");
  assert.equal(snap.items.filter((i) => i.kind === "assistant_message").length, 1);
  assert.equal(snap.state === "running", false);
});

// ── Terminals ────────────────────────────────────────────────────────────────

test("terminals: pipe fallback runs a typed command and streams output", async () => {
  const { client } = await boot();
  const { terminalId } = await client.command<{ terminalId: string }>("terminal.open", { cwd: tempDir("term"), cols: 80, rows: 24, command: "echo alevr-$((40+2))" });
  const output = () => client.events.filter((e) => e.event.type === "terminal.output" && e.event.terminalId === terminalId).map((e) => (e.event as { data: string }).data).join("");
  // The setup command is typed, not submitted: nothing runs until the user presses Return.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!output().includes("alevr-42"));
  await client.command("terminal.write", { terminalId, data: "\r" });
  await client.waitFor(
    () => client.events.filter((e) => e.event.type === "terminal.output" && e.event.terminalId === terminalId).map((e) => (e.event as { data: string }).data).join("").includes("alevr-42"),
    6000,
    "terminal output",
  );
  await client.command("terminal.close", { terminalId });
});

// ── Worktrees ────────────────────────────────────────────────────────────────

test("worktree: a session can run in its own git worktree", async () => {
  const { client } = await boot();
  const repo = initRepo();
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd: repo, selection: { instanceId: "codex:default", model: "x" }, worktree: true });
  const snap = await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  assert.ok(snap.worktree);
  assert.notEqual(snap.cwd, repo);
  assert.ok(fs.existsSync(path.join(snap.cwd, "README.md")));
  assert.equal(fs.realpathSync(snap.worktree!.repoRoot), fs.realpathSync(repo));
});
