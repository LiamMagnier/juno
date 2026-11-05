/**
 * Agents lane (REA backlog 10): a person's Pause / Resume / Top-up / Steer
 * through the wire protocol, with a fake agent-core engine. The env server
 * relays them to the engine, maps the agent's live state into the thread, and
 * answers a repeated request id with its first answer so a relay retry never
 * steers or tops up twice.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { AlevrEngine, EngineControlResult, EngineSession, EngineSessionOptions } from "../src/providers/alevr.js";
import type { AgentControlResult, SubagentItem, SystemNoticeItem, TurnItem } from "../src/contracts/code-v2.js";
import { TestClient, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

interface Calls {
  pause: (string | undefined)[];
  resume: (string | undefined)[];
  topUp: { agentId?: string; tokens?: number; usd?: number }[];
  message: { agentId: string; text: string }[];
  release: () => void;
}

function engine(calls: Calls): AlevrEngine {
  return {
    providerFor: () => ({}),
    resumeSession: (_id, o) => session(o),
    createSession: (o) => session(o),
  };
  function session(o: EngineSessionOptions): EngineSession {
    const emit = o.callbacks.onEvent;
    let paused = false;
    let tokenBudget = 400_000;
    const child = () => ({
      id: "w1",
      title: "Server route",
      role: "builder",
      contractRole: "worker",
      status: "running",
      currentActivity: paused ? "Paused" : "Editing src/total.ts",
      paused,
      tokenBudget,
      usage: { inputTokens: 12_000, outputTokens: 3_000 },
      startedAt: new Date().toISOString(),
    });
    let released = false;
    calls.release = () => (released = true);
    const result = (r: EngineControlResult) => r;
    return {
      sessionId: "eng_1",
      setMode: () => {},
      abort: () => (released = true),
      queueUserMessage: async () => {},
      messageAgent: (agentId, text) => {
        calls.message.push({ agentId, text });
        return { ok: true, message: `Delivered to running agent ${agentId}; it reads it at its next step.` };
      },
      interruptAgent: () => {},
      pauseAgent: (agentId) => {
        calls.pause.push(agentId);
        paused = true;
        emit({ type: "subagent_update", agent: child() });
        return result({ ok: true, message: "Agent w1 pauses after its current step." });
      },
      resumeAgent: (agentId) => {
        calls.resume.push(agentId);
        paused = false;
        emit({ type: "subagent_update", agent: child() });
        return result({ ok: true, message: "Agent w1 resumed." });
      },
      topUpAgent: (agentId, add) => {
        calls.topUp.push({ ...(agentId ? { agentId } : {}), ...add });
        if (!agentId) return { ok: true, message: "The run budget is now $7.00.", budget: { tokens: 10, costUsd: 1.2, maxUsd: 7 } };
        tokenBudget += add.tokens ?? 0;
        emit({ type: "subagent_update", agent: child() });
        return { ok: true, message: `Agent w1 can now use up to ${tokenBudget} tokens.`, tokenBudget };
      },
      prompt: async () => {
        emit({ type: "subagent_update", agent: child() });
        for (let i = 0; i < 500 && !released; i++) await new Promise((r) => setTimeout(r, 10));
        emit({ type: "assistant_delta", text: "done" });
        emit({ type: "turn_finished", usage: { inputTokens: 1, outputTokens: 1 } });
      },
    };
  }
}

const agentOf = (items: TurnItem[]): SubagentItem | undefined =>
  [...items].reverse().find((i): i is SubagentItem => i.kind === "subagent" && i.agentId === "w1");

test("agent controls: pause, resume, steer and top-up reach the engine once per request id, and the tree sees the state", async () => {
  const calls: Calls = { pause: [], resume: [], topUp: [], message: [], release: () => {} };
  const server = await startEnvServer({ dataDir: tempDir("data"), searchDirs: [], logger: silentLogger, probeOnStart: false, coalesceMs: 5, alevrEngine: engine(calls) });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  await client.command("env.configure", { backend: { baseUrl: "https://alevr.example/api/agent", authorization: "Bearer s", models: [] } });
  await client.command("provider.probe", { instanceId: "alevr" });
  const selection = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
  const { sessionId: sid } = await client.command<{ sessionId: string }>("session.open", { cwd: tempDir("cwd"), selection });
  await client.waitFor(() => client.snapshots.get(sid), 4000, "snapshot");
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "fan out" }, selection, runtimeMode: "ask", interactionMode: "default" });
  const first = await client.waitFor(() => agentOf(client.snapshot(sid).items), 4000, "agent");
  assert.equal(first.tokenBudget, 400_000);
  assert.deepEqual(first.tokens, { input: 12_000, output: 3_000 });
  assert.equal(first.paused, undefined);

  // Pause twice with one request id: the engine hears it once, both get the same answer.
  const p1 = await client.command<AgentControlResult>("agent.pause", { sessionId: sid, agentId: "w1", requestId: "req-pause-1" });
  const p2 = await client.command<AgentControlResult>("agent.pause", { sessionId: sid, agentId: "w1", requestId: "req-pause-1" });
  assert.deepEqual(p1, p2);
  assert.equal(p1.accepted, true);
  assert.deepEqual(calls.pause, ["w1"]);
  const paused = await client.waitFor(() => { const a = agentOf(client.snapshot(sid).items); return a?.paused ? a : undefined; }, 4000, "paused");
  assert.equal(paused.liveLine, "Paused");

  // The same id for a different command is a different request.
  await client.command("agent.resume", { sessionId: sid, agentId: "w1", requestId: "req-pause-1" });
  assert.deepEqual(calls.resume, ["w1"]);
  await client.waitFor(() => { const a = agentOf(client.snapshot(sid).items); return a && !a.paused ? a : undefined; }, 4000, "resumed");

  // Steer, retried.
  await client.command("agent.message", { sessionId: sid, agentId: "w1", text: "Only touch the server route.", requestId: "req-steer-1" });
  await client.command("agent.message", { sessionId: sid, agentId: "w1", text: "Only touch the server route.", requestId: "req-steer-1" });
  assert.equal(calls.message.length, 1);

  // Top-up of one agent, retried; then the run budget, which lands in the thread as a notice.
  const t1 = await client.command<AgentControlResult>("agent.topUp", { sessionId: sid, agentId: "w1", tokens: 100_000, requestId: "req-top-1" });
  await client.command("agent.topUp", { sessionId: sid, agentId: "w1", tokens: 100_000, requestId: "req-top-1" });
  assert.equal(t1.tokenBudget, 500_000);
  assert.equal(calls.topUp.length, 1);
  await client.waitFor(() => (agentOf(client.snapshot(sid).items)?.tokenBudget === 500_000 ? true : undefined), 4000, "raised");
  const run = await client.command<AgentControlResult>("agent.topUp", { sessionId: sid, usd: 5, requestId: "req-top-run" });
  assert.equal(run.budget?.maxUsd, 7);
  await client.waitFor(() => client.snapshot(sid).items.find((i): i is SystemNoticeItem => i.kind === "system_notice" && i.code === "budget_top_up"), 4000, "notice");

  // Pause every agent: no id.
  await client.command("agent.pause", { sessionId: sid });
  assert.deepEqual(calls.pause, ["w1", undefined]);

  // Malformed amounts never reach the engine.
  await assert.rejects(client.command("agent.topUp", { sessionId: sid, agentId: "w1", tokens: -5 }), /whole positive/);
  await assert.rejects(client.command("agent.topUp", { sessionId: sid, agentId: "w1" }), /how much/);
  assert.equal(calls.topUp.length, 2);

  calls.release();
  await client.turnCompleted(sid, turnId);
});
