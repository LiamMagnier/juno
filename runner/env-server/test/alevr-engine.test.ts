/**
 * The Alevr engine adapter through the wire protocol with a fake agent-core
 * engine: sign-in via env.configure, streamed text and reasoning, approvals,
 * steering through the engine's queue, interrupts, and plan limits.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { AlevrEngine, EngineSessionOptions, EngineSession } from "../src/providers/alevr.js";
import type { ApprovalRequestItem, ProviderInstance, TurnItem } from "../src/contracts/code-v2.js";
import { TestClient, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

interface Recorded {
  providers: { instance: string; model: string; authorization?: string }[];
  modes: string[];
}

function fakeEngine(rec: Recorded): AlevrEngine {
  let n = 0;
  return {
    providerFor: (instance, model, secrets) => {
      if (instance.kind === "alevr" && !secrets.backend) throw new Error("Open Alevr and sign in so Code can use your Alevr plan.");
      rec.providers.push({ instance: instance.id, model, ...(secrets.backend ? { authorization: secrets.backend.authorization } : {}) });
      return {};
    },
    resumeSession: (_id, o) => makeSession(o),
    createSession: (o) => makeSession(o),
  };
  function makeSession(o: EngineSessionOptions): EngineSession {
    const id = `eng_${++n}`;
    let aborted = false;
    const queued: string[] = [];
    rec.modes.push(o.mode ?? "?");
    const emit = o.callbacks.onEvent;
    return {
      sessionId: id,
      setMode: (m) => rec.modes.push(m),
      abort: () => {
        aborted = true;
      },
      queueUserMessage: async (t) => {
        queued.push(t);
      },
      prompt: async (text) => {
        aborted = false;
        emit({ type: "thinking_delta", text: "Let me see. " });
        emit({ type: "thinking_message", text: "Let me see. " });
        if (/limit/.test(text)) {
          emit({ type: "error", message: "You have used this month's Alevr allowance.", code: "plan_limit" });
          return;
        }
        if (/bash/.test(text)) {
          emit({ type: "tool_started", name: "bash", callId: "c1", input: { command: "npm test" } });
          const d = await o.callbacks.requestApproval({ callId: "c1", toolName: "bash", input: { command: "npm test" }, risk: "command", summary: "npm test" });
          if (d === "deny") emit({ type: "tool_denied", callId: "c1" });
          else emit({ type: "tool_finished", callId: "c1", output: "ok\n", exitCode: 0, durationMs: 3 });
        }
        if (/slow/.test(text)) {
          for (let i = 0; i < 300 && !aborted && queued.length === 0; i++) {
            emit({ type: "assistant_delta", text: "." });
            await new Promise((r) => setTimeout(r, 10));
          }
          if (aborted) throw new Error("aborted");
        }
        const reply = queued.length ? `Engine heard ${text} then ${queued.splice(0).join(", ")}` : `Engine: ${text}`;
        for (const w of reply.split(/(?= )/)) emit({ type: "assistant_delta", text: w });
        emit({ type: "turn_finished", usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 100 } });
      },
    };
  }
}

async function boot() {
  const rec: Recorded = { providers: [], modes: [] };
  const server = await startEnvServer({ dataDir: tempDir("data"), searchDirs: [], logger: silentLogger, probeOnStart: false, coalesceMs: 5, alevrEngine: fakeEngine(rec) });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  return { server, client, rec };
}

const ask = { runtimeMode: "ask", interactionMode: "default" } as const;
const items = (c: TestClient, sid: string): TurnItem[] => c.snapshot(sid).items;

test("alevr engine: signed out until the app passes the session, then ready with the backend's models", async () => {
  const { client } = await boot();
  const before = await client.command<{ instance: ProviderInstance }>("provider.probe", { instanceId: "alevr" });
  assert.equal(before.instance.status, "signed-out");
  await client.command("env.configure", {
    backend: {
      baseUrl: "https://alevr.example/api/agent",
      authorization: "Bearer session-abc",
      models: [
        { provider: "anthropic", kind: "anthropic", model: "claude-opus-5-5", label: "Opus 5.5", available: true, contextWindow: 1_000_000 },
        { provider: "openai", kind: "openai", model: "gpt-6.1", label: "GPT-6.1", available: false },
      ],
    },
  });
  const { instance } = await client.command<{ instance: ProviderInstance }>("provider.probe", { instanceId: "alevr" });
  assert.equal(instance.status, "ready");
  assert.deepEqual(instance.models?.map((m) => m.id), ["anthropic:claude-opus-5-5"], "unavailable models are not offered");
  assert.equal(instance.models?.[0].contextTiers?.[0].tokens, 1_000_000);
  const list = await client.command<{ instances: ProviderInstance[] }>("provider.list", {});
  assert.ok(!JSON.stringify(list).includes("session-abc"), "the Alevr session never goes back out on the wire");
});

test("alevr engine: approvals, streaming, steering, interrupt and plan limits", async () => {
  const { client, rec } = await boot();
  await client.command("env.configure", { backend: { baseUrl: "https://alevr.example/api/agent", authorization: "Bearer s", models: [] } });
  await client.command("provider.probe", { instanceId: "alevr" });
  const selection = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
  const { sessionId: sid } = await client.command<{ sessionId: string }>("session.open", { cwd: tempDir("cwd"), selection });
  await client.waitFor(() => client.snapshots.get(sid), 4000, "snapshot");

  const t1 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "run bash" }, selection, ...ask });
  const approval = await client.waitFor(() => items(client, sid).find((i): i is ApprovalRequestItem => i.kind === "approval_request" && i.status === "pending"), 5000, "approval");
  assert.equal(approval.action, "command");
  await client.command("approval.respond", { sessionId: sid, requestId: approval.requestId, decision: "accept" });
  const done = await client.turnCompleted(sid, t1.turnId);
  assert.equal(done.outcome, "completed");
  assert.equal(done.usage?.inputTokens, 300);
  const cmd = items(client, sid).find((i) => i.kind === "command_execution");
  assert.ok(cmd && cmd.kind === "command_execution" && cmd.status === "completed" && cmd.exitCode === 0);
  assert.ok(items(client, sid).some((i) => i.kind === "reasoning" && !i.streaming));
  const msg = [...items(client, sid)].reverse().find((i) => i.kind === "assistant_message");
  assert.ok(msg && msg.kind === "assistant_message" && msg.text === "Engine: run bash" && !msg.streaming);
  assert.equal(rec.providers[0].model, "anthropic:claude-opus-5-5");
  assert.equal(rec.modes[0], "ask");

  const t2 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection, ...ask });
  await client.waitFor(() => client.snapshot(sid).state === "running" && items(client, sid).some((i) => i.kind === "assistant_message" && i.turnId === t2.turnId), 5000, "streaming");
  const steer = await client.command<{ accepted: boolean }>("turn.steer", { sessionId: sid, turnId: t2.turnId, input: { text: "add tests" } });
  assert.equal(steer.accepted, true);
  await client.turnCompleted(sid, t2.turnId);
  assert.match([...items(client, sid)].reverse().find((i) => i.kind === "assistant_message")?.["text" as never] ?? "", /then add tests/);

  const t3 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow again" }, selection, runtimeMode: "full", interactionMode: "default" });
  await client.waitFor(() => items(client, sid).some((i) => i.kind === "assistant_message" && i.turnId === t3.turnId), 5000, "streaming");
  await client.command("turn.interrupt", { sessionId: sid });
  assert.equal((await client.turnCompleted(sid, t3.turnId)).outcome, "interrupted");
  assert.ok(rec.modes.includes("full"), "the runtime mode reaches the engine");

  const t4 = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "limit" }, selection, ...ask });
  assert.equal((await client.turnCompleted(sid, t4.turnId)).outcome, "limited");
  assert.equal(client.snapshot(sid).state, "limited");
});
