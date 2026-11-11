/**
 * Restart recovery: a turn that was running when the env server stopped.
 *
 * Two ways it stops. The hard way (the process is killed, the Mac loses
 * power): nothing gets to write the turn's ending, so the next process has to.
 * The ordinary way (the Mac app quits while a turn runs): the turn must get to
 * write its own ending before the process goes.
 *
 * Either way the ending has to be in the log, not only in memory: a phone or a
 * browser that follows the thread reconnects with its cursor and is replayed
 * events, never a fresh snapshot.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startEnvServer, type EnvServer } from "../src/server.js";
import { silentLogger } from "../src/util.js";
import { CUT_OFF_MESSAGE } from "../src/sessions/cut-off-turn.js";
import type { ModelSelection, ServerEventEnvelope, TurnItem } from "../src/contracts/code-v2.js";
import { TestClient, fakeBinDir, initRepo, tempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const servers: EnvServer[] = [];
const clients: TestClient[] = [];
const hosts: ChildProcess[] = [];
after(async () => {
  for (const c of clients) c.close();
  for (const h of hosts) h.kill("SIGKILL");
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

const codex: ModelSelection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
const full = { runtimeMode: "full", interactionMode: "default" } as const;
const ask = { runtimeMode: "ask", interactionMode: "default" } as const;

async function connect(url: string, token: string): Promise<TestClient> {
  const client = await TestClient.connect(url, token);
  clients.push(client);
  await client.command("provider.probe", { instanceId: "codex:default" });
  return client;
}

/** An env server in this process, on `dataDir`. */
async function boot(dataDir: string, bin: string) {
  const server = await startEnvServer({ dataDir, searchDirs: [bin], logger: silentLogger, probeOnStart: false, coalesceMs: 5, forcePipeTerminals: true, computerUse: false });
  servers.push(server);
  return { server, client: await connect(server.url, server.token) };
}

/** An env server in a process of its own, so it can be killed without warning. */
async function bootKillable(dataDir: string, bin: string) {
  const child = spawn(process.execPath, ["--import", "tsx", path.join(here, "fixtures", "crash-host.ts"), dataDir, bin], {
    cwd: path.join(here, ".."),
    stdio: ["ignore", "pipe", "inherit"],
  });
  hosts.push(child);
  const address = await new Promise<{ url: string; token: string }>((resolve, reject) => {
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as { url: string; token: string });
    });
    child.once("exit", (code) => reject(new Error(`the env server host exited early (${code})`)));
    child.once("error", reject);
  });
  const kill = () =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  return { client: await connect(address.url, address.token), kill };
}

async function open(client: TestClient, cwd: string): Promise<string> {
  const { sessionId } = await client.command<{ sessionId: string }>("session.open", { cwd, selection: codex });
  await client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot");
  return sessionId;
}

/** A device that has never seen the thread: it is sent the snapshot. */
async function freshSnapshot(client: TestClient, sessionId: string) {
  await client.command("session.open", { sessionId, cwd: "/", afterSequence: -1 });
  return client.waitFor(() => client.snapshots.get(sessionId), 4000, "snapshot after restart");
}

const itemsOf = <K extends TurnItem["kind"]>(items: TurnItem[], kind: K, turnId: string) =>
  items.filter((i): i is Extract<TurnItem, { kind: K }> => i.kind === kind && i.turnId === turnId);

const turnCompleted = (events: ServerEventEnvelope[], turnId: string) =>
  events.map((e) => e.event).find((e): e is Extract<ServerEventEnvelope["event"], { type: "turn.completed" }> => e.type === "turn.completed" && e.turnId === turnId);

function storedEvents(dataDir: string, sessionId: string): ServerEventEnvelope["event"][] {
  return fs
    .readFileSync(path.join(dataDir, "sessions", sessionId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: ServerEventEnvelope["event"] }).event);
}

test("a killed env server: the turn it was running is ended in the log, for a device that only gets events", async () => {
  const dataDir = tempDir("crash-data");
  const bin = fakeBinDir();
  const first = await bootKillable(dataDir, bin);
  const sid = await open(first.client, tempDir("crash-cwd"));
  // The fake runtime starts a command and waits for approval: a turn stopped mid-step.
  const { turnId } = await first.client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "approve" }, selection: codex, ...ask });
  await first.client.waitFor(
    () => first.client.snapshot(sid).state === "waiting" && itemsOf(first.client.snapshot(sid).items, "approval_request", turnId).find((i) => i.status === "pending"),
    8000,
    "the pending approval",
  );
  const cursor = first.client.cursors.get(sid)!;
  await first.kill();

  const second = await boot(dataDir, bin);
  // The phone's view: it already holds everything up to `cursor` and asks for what came after.
  await second.client.command("session.open", { sessionId: sid, cwd: "/", afterSequence: cursor });
  const ended = await second.client.waitFor(() => turnCompleted(second.client.sessionEvents(sid), turnId), 4000, "the cut-off turn's ending");
  assert.equal(ended.outcome, "interrupted");

  const snapshot = await freshSnapshot(await connect(second.server.url, second.server.token), sid);
  assert.equal(snapshot.state, "idle");
  assert.equal(snapshot.activeTurnId, undefined);
  // Nothing of that turn still claims to be running.
  assert.deepEqual(itemsOf(snapshot.items, "command_execution", turnId).map((i) => i.status), ["interrupted"]);
  assert.deepEqual(itemsOf(snapshot.items, "approval_request", turnId).map((i) => i.status), ["expired"]);
  // And the thread says why it stops there.
  const why = itemsOf(snapshot.items, "interrupt", turnId);
  assert.equal(why.length, 1);
  assert.equal(why[0].reason, "error");
  assert.equal(why[0].message, CUT_OFF_MESSAGE);
});

test("a killed env server: the ending is written once, however many times the thread is loaded", async () => {
  const dataDir = tempDir("crash-once");
  const bin = fakeBinDir();
  const first = await bootKillable(dataDir, bin);
  const sid = await open(first.client, tempDir("crash-once-cwd"));
  const { turnId } = await first.client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection: codex, ...full });
  await first.client.waitFor(() => first.client.snapshot(sid).state === "running" && itemsOf(first.client.snapshot(sid).items, "assistant_message", turnId).length > 0, 8000, "the turn streaming");
  await first.kill();

  const second = await boot(dataDir, bin);
  await freshSnapshot(second.client, sid);
  second.client.close();
  await second.server.close();
  const afterFirstLoad = storedEvents(dataDir, sid).length;

  const third = await boot(dataDir, bin);
  const snapshot = await freshSnapshot(third.client, sid);
  assert.equal(itemsOf(snapshot.items, "interrupt", turnId).length, 1);
  assert.equal(storedEvents(dataDir, sid).length, afterFirstLoad);
});

test("a killed env server: files the cut-off turn wrote can still be restored after a later turn", async () => {
  const dataDir = tempDir("crash-files");
  const bin = fakeBinDir();
  const repo = initRepo();
  const first = await bootKillable(dataDir, bin);
  const sid = await open(first.client, repo);
  const one = await first.client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "write a.md" }, selection: codex, ...full });
  await first.client.turnCompleted(sid, one.turnId);
  const afterTurnOne = await first.client.waitFor(() => itemsOf(first.client.snapshot(sid).items, "checkpoint", one.turnId)[0], 4000, "turn 1's checkpoint");
  // Turn 2 writes b.md, keeps going, and the process dies under it.
  const two = await first.client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "write b.md slow" }, selection: codex, ...full });
  await first.client.waitFor(() => itemsOf(first.client.snapshot(sid).items, "file_change", two.turnId)[0], 8000, "turn 2's file change");
  await first.kill();
  assert.ok(fs.existsSync(path.join(repo, "b.md")));

  const second = await boot(dataDir, bin);
  await freshSnapshot(second.client, sid);
  const three = await second.client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "write c.md" }, selection: codex, ...full });
  await second.client.turnCompleted(sid, three.turnId);

  // Back to the end of turn 1: both later turns' files go, the cut-off turn's included.
  const { restoredFiles } = await second.client.command<{ restoredFiles: number }>("checkpoint.rollback", { sessionId: sid, checkpointId: afterTurnOne.checkpointId });
  assert.equal(restoredFiles, 2);
  assert.equal(fs.existsSync(path.join(repo, "b.md")), false);
  assert.equal(fs.existsSync(path.join(repo, "c.md")), false);
  assert.ok(fs.existsSync(path.join(repo, "a.md")));
});

test("an env server closed while a turn runs: the turn's ending is in the log before close returns", async () => {
  const dataDir = tempDir("quit-data");
  const bin = fakeBinDir();
  const { server, client } = await boot(dataDir, bin);
  const sid = await open(client, initRepo());
  const { turnId } = await client.command<{ turnId: string }>("turn.start", { sessionId: sid, input: { text: "slow" }, selection: codex, ...full });
  await client.waitFor(() => client.snapshot(sid).state === "running" && itemsOf(client.snapshot(sid).items, "assistant_message", turnId).length > 0, 8000, "the turn streaming");
  client.close();
  await server.close();
  // Read at once: bin.ts exits the process as soon as close() returns.
  const ending = storedEvents(dataDir, sid).find((e) => e.type === "turn.completed" && e.turnId === turnId);
  assert.ok(ending, "turn.completed was not written before the server closed");
});
