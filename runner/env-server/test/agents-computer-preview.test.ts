/**
 * Subagents, computer use and the Preview, per runtime: the tools are
 * exposed (Team and Full access included), a message that names them gets
 * the runtime's tool for each, open_preview serves a static site without a
 * launch file, and Claude's own Agent subagents land in the thread as
 * subagent items the Agents panel reads.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { SystemNoticeItem, TurnItem } from "../src/contracts/code-v2.js";
import { ALEVR_APPEND, mcpConfig } from "../src/providers/claude-agent.js";
import { threadConfig, userDeveloperInstructions } from "../src/providers/codex.js";
import { capabilityGuidance, capabilityHint, requestedCapabilities, withCapabilityHints } from "../src/mcp/capability-hints.js";
import { StaticSiteServers, detectSite, indexFiles, loopbackUrl, openPreview, type PreviewToolDeps } from "../src/mcp/preview-tools.js";
import { TestClient, fakeBinDir, fakeClaudeQuery, tempDir } from "./helpers.js";
import type { AlevrEngine, EngineSessionOptions, EngineSession } from "../src/providers/alevr.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
const sites: StaticSiteServers[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
  await Promise.all(sites.map((s) => s.closeAll()));
});

async function boot() {
  const record = { options: [] as unknown[], prompts: [] as string[], modes: [] as string[], toolResults: [] as string[] };
  const server = await startEnvServer({
    dataDir: tempDir("data"),
    searchDirs: [fakeBinDir()],
    logger: silentLogger,
    probeOnStart: false,
    coalesceMs: 5,
    forcePipeTerminals: true,
    terminalShell: "/bin/sh",
    claudeQuery: fakeClaudeQuery(record),
    computerUse: { available: () => true, bridge: { send: async () => ({ id: "x", ok: false, error: "not in tests" }) as never } },
  });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  return { server, client, record };
}

async function mcpCall(server: EnvServer, token: string, method: string, params: Record<string, unknown>, id = 1) {
  const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return (await res.json()) as { result?: Record<string, any>; error?: { message: string } };
}

const PORTFOLIO = "Code the best looking portfolio using subagents , computer use and show me a preview.";

function writeSite(dir: string, folder: string, html = "<h1>Portfolio</h1>") {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, "index.html"), html);
  fs.writeFileSync(path.join(dir, folder, "styles.css"), "body{color:#111}");
}

// ── What the person asks for ─────────────────────────────────────────────────

test("a message naming subagents, computer use and a preview asks for all three", () => {
  assert.deepEqual(requestedCapabilities(PORTFOLIO), ["subagents", "computer", "preview"]);
  assert.deepEqual(requestedCapabilities("Fix the typo in README"), []);
  assert.deepEqual(requestedCapabilities("take a screenshot of the app"), ["computer"]);
  assert.deepEqual(requestedCapabilities("split this across sub-agents"), ["subagents"]);
});

test("each runtime gets the capability block in its own tool names", () => {
  const claude = capabilityHint(PORTFOLIO, "claude-agent")!;
  assert.match(claude, /<alevr_capabilities>/);
  assert.match(claude, /Agent tool/);
  assert.match(claude, /mcp__alevr__computer_use/);
  assert.match(claude, /mcp__alevr__open_preview/);
  const codex = capabilityHint(PORTFOLIO, "codex")!;
  assert.match(codex, /spawn_subagent/);
  assert.match(codex, /computer_use/);
  assert.match(codex, /open_preview/);
  const engine = capabilityHint(PORTFOLIO, "alevr")!;
  assert.match(engine, /spawn_agent or delegate_tasks/);
  assert.equal(capabilityHint("Rename the variable", "claude-agent"), undefined);
  // Plan mode only plans; skill text ahead of the message never counts as asking.
  assert.equal(withCapabilityHints({ text: PORTFOLIO }, "codex", "plan").text, PORTFOLIO);
  assert.equal(withCapabilityHints({ text: "skill: preview everything\n\nhello" }, "codex", "default", "hello").text, "skill: preview everything\n\nhello");
});

test("the standing guidance says to use them unasked when they help", () => {
  for (const kind of ["claude-agent", "codex", "alevr", null] as const) {
    const g = capabilityGuidance(kind);
    assert.match(g, /on your own when they help/);
    assert.match(g, /Subagents/);
    assert.match(g, /Preview/);
    assert.match(g, /Computer use/);
  }
  assert.match(ALEVR_APPEND, /open_preview/);
  assert.match(ALEVR_APPEND, /computer_use/);
  assert.match(ALEVR_APPEND, /Agent tool/);
});

// ── Exposure per provider ────────────────────────────────────────────────────

test("claude: the Alevr MCP server always loads, never behind tool search", () => {
  const config = mcpConfig({ name: "alevr", url: "http://127.0.0.1:1/mcp", authorization: "Bearer t" });
  assert.equal(config.alwaysLoad, true);
  assert.equal(config.type, "http");
});

test("codex: the thread gets the Alevr MCP server and developer instructions", () => {
  const config = threadConfig({ name: "alevr", url: "http://127.0.0.1:1/mcp", authorization: "Bearer t" })!;
  assert.ok((config.mcp_servers as Record<string, unknown>).alevr);
  assert.match(String(config.developer_instructions), /open_preview/);
  assert.match(String(config.developer_instructions), /spawn_subagent/);
});

test("claude in Team and Full access: tools exposed, the request carries the capability block and the team brief", async () => {
  const { server, client, record } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const selection = { instanceId: "claude-agent:default", model: "claude-haiku-5-5", effort: "low" as const };
  const cwd = tempDir("portfolio");
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  const routing = { preset: "plan-build-verify", orchestrator: selection, workers: [selection, selection], budget: { maxUsd: 5 } };
  const { turnId } = await client.command<{ turnId: string }>("turn.start", {
    sessionId, input: { text: PORTFOLIO }, selection, routing, runtimeMode: "full", interactionMode: "default",
  });
  // The fake CLI acts on words in the prompt ("ask", "plan"), so stop once the request is in.
  await client.waitFor(() => record.prompts.some((p) => p.endsWith(PORTFOLIO)), 5000, "the request reaches Claude");
  await client.command("turn.interrupt", { sessionId });
  await client.turnCompleted(sessionId, turnId);

  const options = record.options.at(-1) as Record<string, any>;
  const alevr = options.mcpServers?.alevr;
  assert.ok(alevr, "the Alevr MCP server is attached");
  assert.equal(alevr.alwaysLoad, true);
  assert.match(options.systemPrompt.append, /open_preview/);
  assert.equal(options.allowedTools, undefined, "no allow-list hides the Agent tool or MCP tools");
  assert.ok(!(options.disallowedTools ?? []).some((t: string) => /^(Agent|Task|mcp__alevr)/.test(t)));

  const sent = record.prompts.filter((p) => p !== "<probe>").at(-1)!;
  assert.match(sent, /<alevr_team>/, "Team mode reaches a subscription lead");
  assert.match(sent, /<alevr_capabilities>/);
  assert.match(sent, /mcp__alevr__open_preview/);
  assert.match(sent, /mcp__alevr__computer_use/);
  assert.ok(sent.endsWith(PORTFOLIO));
  // The thread shows the person's own words only.
  const user = client.snapshot(sessionId).items.find((i) => i.kind === "user_message");
  assert.equal(user?.kind === "user_message" ? user.text : "", PORTFOLIO);

  // The session's MCP scope lists the three capabilities.
  const token = server.mcp.issueToken({ sessionId, depth: 0 });
  const listed = await mcpCall(server, token, "tools/list", {});
  const names = (listed.result?.tools as { name: string }[]).map((t) => t.name);
  for (const name of ["spawn_subagent", "wait_subagent", "open_preview", "computer_use"]) assert.ok(names.includes(name), name);
  const init = await mcpCall(server, token, "initialize", { protocolVersion: "2025-06-18" });
  assert.match(String(init.result?.instructions), /open_preview/);
});

// ── Preview ──────────────────────────────────────────────────────────────────

test("static-site detection: root, usual folders, the newest subfolder, hints, dev servers", () => {
  const root = tempDir("sites");
  assert.equal(detectSite(root).kind, "none");
  writeSite(root, "old");
  const later = Date.now() / 1000 + 5;
  writeSite(root, "portfolio");
  fs.utimesSync(path.join(root, "portfolio", "index.html"), later, later);
  const found = detectSite(root);
  assert.equal(found.kind, "static");
  assert.equal(found.kind === "static" ? found.folder : "", path.join(root, "portfolio"), "the newest index.html wins");
  assert.equal(indexFiles(root)[0], path.join(root, "portfolio", "index.html"));
  const hinted = detectSite(root, "old");
  assert.equal(hinted.kind === "static" ? hinted.folder : "", path.join(root, "old"));
  const file = detectSite(root, "old/index.html");
  assert.equal(file.kind === "static" ? file.entry : "", "index.html");
  assert.equal(detectSite(root, "../elsewhere").kind, "none", "never outside the project");
  writeSite(root, "public");
  const usual = detectSite(root);
  assert.equal(usual.kind === "static" ? usual.folder : "", path.join(root, "public"), "public/ before a newer subfolder");
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.html"), "x");
  assert.ok(!indexFiles(root).some((f) => f.includes("node_modules")));

  const app = tempDir("vite");
  fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }));
  fs.writeFileSync(path.join(app, "index.html"), "<div id=app></div>");
  const dev = detectSite(app);
  assert.deepEqual(dev, { kind: "dev", scripts: ["dev"] }, "a Vite entry page is not a static site");
  assert.equal(loopbackUrl("http://0.0.0.0:5173")?.href, "http://127.0.0.1:5173/");
  assert.equal(loopbackUrl("https://example.com"), undefined);
});

test("open_preview serves a static site with no launch file and tells the thread", async () => {
  const cwd = tempDir("preview");
  writeSite(cwd, "portfolio", "<!doctype html><title>Liam</title><h1>Work</h1>");
  const servers = new StaticSiteServers();
  sites.push(servers);
  const notices: { url: string; folder?: string }[] = [];
  const deps: PreviewToolDeps = { servers, cwd: () => cwd, notify: (_id, opened) => notices.push(opened) };
  const opened = await openPreview("s1", {}, deps);
  assert.ok(!opened.isError, opened.message);
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(notices[0]?.folder, path.join(cwd, "portfolio"));
  assert.equal(notices[0]?.url, opened.url);
  const page = await fetch(opened.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<h1>Work<\/h1>/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const css = await fetch(`${opened.url}styles.css`);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.equal((await fetch(`${opened.url}..%2F..%2Fetc%2Fpasswd`)).status, 404, "nothing outside the folder");
  // The same folder is served once; releasing the last session stops it.
  const again = await openPreview("s2", { path: "portfolio" }, deps);
  assert.equal(again.url, opened.url);
  await servers.release("s1");
  assert.equal((await fetch(opened.url)).status, 200);
  await servers.release("s2");
  assert.deepEqual(servers.folders(), []);

  const none = await openPreview("s3", { url: "https://example.com" }, deps);
  assert.equal(none.isError, true);
});

test("open_preview through MCP adds a preview_opened notice to the lead's thread", async () => {
  const { server, client } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const cwd = tempDir("mcp-preview");
  writeSite(cwd, "portfolio");
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection: { instanceId: "claude-agent:default", model: "default" } });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  const token = server.mcp.issueToken({ sessionId, depth: 0 });
  const res = await mcpCall(server, token, "tools/call", { name: "open_preview", arguments: {} });
  assert.equal(res.result?.isError, undefined, JSON.stringify(res));
  assert.match(res.result?.content[0].text, /portfolio\/ at http:\/\/127\.0\.0\.1/);
  const notice = await client.waitFor(
    () => client.snapshot(sessionId).items.find((i: TurnItem): i is SystemNoticeItem => i.kind === "system_notice" && i.code === "preview_opened"),
    4000, "the preview notice",
  );
  assert.match(notice.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(fs.realpathSync(notice.path ?? ""), fs.realpathSync(path.join(cwd, "portfolio")));
});

test("alevr engine: open_preview is a native tool, the prompt says when to use it, the message gets the block", async () => {
  const options: EngineSessionOptions[] = [];
  const prompts: string[] = [];
  let previewOutput = "";
  const makeSession = (o: EngineSessionOptions): EngineSession => {
    options.push(o);
    return {
      sessionId: "engine-preview", abort() {}, setMode() {}, queueUserMessage: async () => {},
      async prompt(text: string) {
        prompts.push(text);
        type Tool = { spec: { name: string }; execute(input: Record<string, unknown>, ctx: Record<string, unknown>): Promise<{ output: string }> };
        const tool = (o.extraTools as Tool[]).find((t) => t.spec.name === "open_preview");
        previewOutput = tool ? (await tool.execute({}, { callId: "pv" })).output : "no tool";
        o.callbacks.onEvent({ type: "assistant_delta", text: "Built it." });
        o.callbacks.onEvent({ type: "turn_finished", usage: { inputTokens: 1, outputTokens: 1 } });
      },
    };
  };
  const engine: AlevrEngine = { createSession: makeSession, resumeSession: (_id, o) => makeSession(o), providerFor: () => ({}) };
  const server = await startEnvServer({ dataDir: tempDir("data"), searchDirs: [fakeBinDir()], logger: silentLogger, probeOnStart: false, coalesceMs: 5, alevrEngine: engine });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  await client.command("env.configure", { backend: { baseUrl: "https://alevr.example/api/agent", authorization: "Bearer test", models: [] } });
  await client.command("provider.probe", { instanceId: "alevr" });
  const cwd = tempDir("engine-site");
  writeSite(cwd, "portfolio");
  const selection = { instanceId: "alevr", model: "openai:gpt-test" };
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection });
  await client.command("turn.start", { sessionId, input: { text: PORTFOLIO }, selection, runtimeMode: "full", interactionMode: "default" });
  await client.waitFor(() => client.snapshot(sessionId).items.find((i) => i.kind === "assistant_message" && i.text === "Built it."), 4000, "engine answer");
  assert.match(options[0].systemAppendix ?? "", /Preview \(open_preview\)/);
  assert.match(prompts[0], /spawn_agent or delegate_tasks/);
  assert.match(previewOutput, /portfolio\/ at http:\/\/127\.0\.0\.1/);
  assert.ok(client.snapshot(sessionId).items.some((i) => i.kind === "system_notice" && i.code === "preview_opened"));
});

// ── Agents panel: Claude's own subagents ─────────────────────────────────────

test("claude: Agent tool subagents become subagent items with their own trace", async () => {
  const { client } = await boot();
  await client.command("provider.probe", { instanceId: "claude-agent:default" });
  const selection = { instanceId: "claude-agent:default", model: "default" };
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd: tempDir("agents"), selection });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  const { turnId } = await client.command<{ turnId: string }>("turn.start", {
    sessionId, input: { text: "trace two subagents" }, selection, runtimeMode: "full", interactionMode: "default",
  });
  assert.equal((await client.turnCompleted(sessionId, turnId)).outcome, "completed");
  const all = client.snapshot(sessionId).items;
  const agents = all.filter((i) => i.kind === "subagent");
  assert.equal(agents.length, 2);
  for (const a of agents) {
    assert.ok(a.kind === "subagent");
    assert.equal(a.model.instanceId, "claude-agent:default", "attributed to the thread's own instance");
    assert.equal(a.status, "completed");
    assert.ok(all.some((i) => i.kind !== "subagent" && i.agentId === a.agentId), "the child's steps carry its id");
  }
});

test("codex: the user's own developer_instructions from config.toml come first, Alevr's guidance after", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "gpt-5"\ndeveloper_instructions = """\nAlways answer in French.\n"""\n\n[mcp_servers.x]\ndeveloper_instructions = "not this one"\n');
  const own = userDeveloperInstructions(home);
  assert.equal(own?.trim(), "Always answer in French.");
  const config = threadConfig({ name: "alevr", url: "http://127.0.0.1:1/mcp", authorization: "Bearer t" }, own)!;
  const text = String(config.developer_instructions);
  assert.ok(text.startsWith("Always answer in French."));
  assert.match(text, /open_preview/);
  fs.writeFileSync(path.join(home, "config.toml"), 'developer_instructions = "Be terse.\\nNo emoji."\n');
  assert.equal(userDeveloperInstructions(home), "Be terse.\nNo emoji.");
  assert.equal(userDeveloperInstructions(path.join(home, "missing")), undefined);
});
