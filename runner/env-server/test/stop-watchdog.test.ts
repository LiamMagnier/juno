/**
 * Stop always works. A vendor runtime can be alive and still not stop when
 * asked (a tool that ignores the interrupt, a deadlock). The turn must end
 * anyway, and the thread must be usable afterwards.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import type { ModelSelection, TurnItem } from "../src/contracts/code-v2.js";
import { TestClient, fakeBinDir, tempDir } from "./helpers.js";

const servers: EnvServer[] = [];
const clients: TestClient[] = [];
after(async () => {
  for (const c of clients) c.close();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

const codex: ModelSelection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
const full = { runtimeMode: "full", interactionMode: "default" } as const;

async function boot(stopGraceMs: number) {
  const server = await startEnvServer({ dataDir: tempDir("stop-data"), searchDirs: [fakeBinDir()], logger: silentLogger, probeOnStart: false, coalesceMs: 5, forcePipeTerminals: true, computerUse: false, stopGraceMs });
  servers.push(server);
  const client = await TestClient.connect(server.url, server.token);
  clients.push(client);
  await client.command("provider.probe", { instanceId: "codex:default" });
  return client;
}

async function open(client: TestClient, cwd: string): Promise<string> {
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection: codex });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

const streamed = (client: TestClient, sid: string, turnId: string) =>
  client.snapshot(sid).items.find((i): i is Extract<TurnItem, { kind: "assistant_message" }> => i.kind === "assistant_message" && i.turnId === turnId);

test("stop: a runtime that will not stop is stopped anyway, and the thread carries on", async () => {
  const client = await boot(300);
  const cwd = tempDir("stop-cwd");
  const sid = await open(client, cwd);
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "stubborn" }, selection: codex, ...full });
  await client.waitFor(() => (streamed(client, sid, turnId)?.text.length ?? 0) > 3, 8000, "the turn streaming");

  await client.command("turn.interrupt", { sessionId: sid });
  // The fake keeps streaming for six seconds; the turn has to end long before that.
  const ended = await client.waitFor(
    () => client.sessionEvents(sid).map((e) => e.event).find((e) => e.type === "turn.completed" && e.turnId === turnId),
    3000,
    "the turn ending although the runtime ignored the interrupt",
  );
  assert.equal(ended.type === "turn.completed" && ended.outcome, "interrupted");
  assert.equal(client.snapshot(sid).state, "idle");
  assert.equal(streamed(client, sid, turnId)?.streaming, false);
  assert.ok(client.snapshot(sid).items.some((i) => i.kind === "system_notice" && i.code === "force_stopped"), "the thread says the runtime was restarted");

  // Nothing of the stopped turn is written after its ending.
  const length = streamed(client, sid, turnId)!.text.length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(streamed(client, sid, turnId)!.text.length, length);

  // And the next message runs, on a fresh runtime.
  const next = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "write after.md" }, selection: codex, ...full });
  assert.equal((await client.turnCompleted(sid, next.turnId)).outcome, "completed");
  assert.ok(fs.existsSync(path.join(cwd, "after.md")));
});

test("stop: a runtime that stops when asked is left alone", async () => {
  const client = await boot(300);
  const sid = await open(client, tempDir("stop-cwd2"));
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection: codex, ...full });
  await client.waitFor(() => (streamed(client, sid, turnId)?.text.length ?? 0) > 3, 8000, "the turn streaming");
  await client.command("turn.interrupt", { sessionId: sid });
  assert.equal((await client.turnCompleted(sid, turnId)).outcome, "interrupted");
  // Past the grace period: nothing was restarted.
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(client.snapshot(sid).items.some((i) => i.kind === "system_notice" && i.code === "force_stopped"), false);
});
