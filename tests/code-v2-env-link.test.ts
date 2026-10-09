/**
 * The device link hub (src/lib/code-v2/env-link-hub.ts): the hosted web drives
 * the env server on the user's Mac through it. Unit cases for the relay rules,
 * then one end-to-end run: a real env server with a fake codex, a forwarder
 * that does what the Mac app does (DEVICE-LINK.md "Mac side"), and a browser
 * that only speaks rpc/poll.
 */
import assert from "node:assert/strict";
import { test, after } from "node:test";

import {
  DeviceLink,
  EnvLinkHub,
  LINK_LIMITS,
  parseClientRequest,
  parseHostRequest,
} from "@/lib/code-v2/env-link-hub";
import type { ClientCommand, ServerEventEnvelope, ServerMessage, ServerResponse } from "@/lib/code-v2/contracts";
import { startEnvServer, type EnvServer } from "../runner/env-server/src/server";
import { silentLogger } from "../runner/env-server/src/util";
import { fakeBinDir, tempDir, initRepo } from "../runner/env-server/test/helpers";

const ev = (sessionId: string, sequence: number, type = "item.delta"): ServerEventEnvelope =>
  ({ type: "event", stream: "session", sessionId, sequence, at: new Date().toISOString(), event: type === "session.snapshot" ? { type, snapshotSequence: sequence, session: {} } : { type: "queue.updated", queue: [] } }) as unknown as ServerEventEnvelope;

async function online(link: DeviceLink) {
  await link.pull(0);
}

test("link: a relayed command reaches the Mac under a relay id and its response returns under the caller's id", async () => {
  const link = new DeviceLink();
  await online(link);
  const reply = link.rpc({ id: "7", type: "provider.list", params: {} });
  const { commands } = await link.pull(0);
  assert.equal(commands.length, 1);
  assert.notEqual(commands[0].id, "7", "browser ids never reach the Mac as-is");
  assert.equal(commands[0].type, "provider.list");
  link.push({ responses: [{ type: "response", id: commands[0].id, ok: true, result: { instances: [] } }] });
  const out = await reply;
  assert.deepEqual(out.responses, [{ type: "response", id: "7", ok: true, result: { instances: [] } }]);
  assert.equal(link.stats().pending, 0);
});

test("link: terminals and secrets are never relayed; an offline Mac says so", async () => {
  const link = new DeviceLink();
  const offline = await link.rpc({ id: "1", type: "provider.list", params: {} });
  assert.equal(offline.offline, true);
  await online(link);
  for (const type of ["terminal.open", "terminal.write", "env.configure"] as const) {
    const r = await link.rpc({ id: "2", type, params: {} } as unknown as ClientCommand);
    const res = r.responses?.[0];
    assert.ok(res && !res.ok && res.error.code === "unsupported", type);
  }
  assert.equal(link.stats().queued, 0);
});

test("link: the Mac goes offline when it stops pulling", async () => {
  let now = 1_000_000;
  const hub = new EnvLinkHub(() => now);
  assert.equal(hub.isOnline("u", "d"), false);
  await hub.link("u", "d").pull(0);
  assert.equal(hub.isOnline("u", "d"), true);
  now += LINK_LIMITS.hostOnlineMs + 1;
  assert.equal(hub.isOnline("u", "d"), false);
  assert.equal(hub.isOnline("other-user", "d"), false, "links are per user");
});

test("link: polls return events after the cursor, wait for new ones, and dedupe replays", async () => {
  const link = new DeviceLink();
  await online(link);
  link.push({ events: [ev("s1", 4, "session.snapshot"), ev("s1", 5), ev("s1", 6)] });
  const first = await link.poll({ s1: 4 }, -1, 0);
  assert.deepEqual(first.events?.map((e) => e.sequence), [5, 6]);
  // A snapshot newer than the cursor supersedes everything before it.
  const fresh = await link.poll({ s1: -1 }, -1, 0);
  assert.deepEqual(fresh.events?.map((e) => e.sequence), [4, 5, 6]);
  // Waiting poll wakes on a push.
  const waiting = link.poll({ s1: 6 }, -1, 5_000);
  setTimeout(() => link.push({ events: [ev("s1", 7), ev("s1", 7)] }), 20);
  assert.deepEqual((await waiting).events?.map((e) => e.sequence), [7]);
  // Replayed duplicates do not double up.
  link.push({ events: [ev("s1", 5), ev("s1", 6)] });
  assert.deepEqual((await link.poll({ s1: 4 }, -1, 0)).events?.map((e) => e.sequence), [5, 6, 7]);
});

test("link: a cursor the ring can't serve asks the Mac to replay from the env server's log", async () => {
  const link = new DeviceLink();
  await online(link);
  link.push({ events: [ev("s1", 40), ev("s1", 41)] });
  await link.poll({ s1: 10 }, -1, 0);
  const { commands } = await link.pull(0);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "session.open");
  assert.deepEqual(commands[0].params, { sessionId: "s1", cwd: "/", afterSequence: 10 });
  // Not asked again while the replay is fresh.
  await link.poll({ s1: 10 }, -1, 0);
  assert.equal((await link.pull(0)).commands.length, 0);
  // The Mac replays, then answers the open: the ring now covers the cursor.
  const replayed = Array.from({ length: 30 }, (_, i) => ev("s1", 11 + i));
  link.push({ events: replayed, responses: [{ type: "response", id: commands[0].id, ok: true, result: { sessionId: "s1" } }] });
  const out = await link.poll({ s1: 10 }, -1, 0);
  assert.deepEqual(out.events?.map((e) => e.sequence), Array.from({ length: 31 }, (_, i) => 11 + i));
  // An idle session after a hub restart: replay once, then the floor says "nothing more".
  const idle = new DeviceLink();
  await online(idle);
  await idle.poll({ s9: 50 }, -1, 0);
  const open = (await idle.pull(0)).commands[0];
  idle.push({ responses: [{ type: "response", id: open.id, ok: true, result: { sessionId: "s9" } }] });
  await idle.poll({ s9: 50 }, -1, 0);
  assert.equal((await idle.pull(0)).commands.length, 0);
});

test("link: the global stream is renumbered by the hub and survives a stale cursor", async () => {
  const link = new DeviceLink();
  await online(link);
  const g = (n: number) => ({ type: "event", stream: "global", sequence: n, at: "", event: { type: "provider.updated", instance: { id: `i${n}` } } }) as unknown as ServerEventEnvelope;
  link.push({ events: [g(100), g(3)] }); // the Mac reconnected to its env server: numbering restarted
  const all = await link.poll({}, -1, 0);
  assert.deepEqual(all.events?.map((e) => e.sequence), [1, 2]);
  assert.deepEqual((await link.poll({}, 1, 0)).events?.map((e) => e.sequence), [2]);
  assert.deepEqual((await link.poll({}, 999, 0)).events?.map((e) => e.sequence), [1, 2], "a cursor from before a hub restart gets what is kept");
});

test("link: request parsing rejects malformed bodies", () => {
  assert.equal(parseClientRequest(null), null);
  assert.equal(parseClientRequest({ kind: "rpc", command: { id: 1, type: "x", params: {} } }), null);
  assert.deepEqual(parseClientRequest({ kind: "poll", cursors: { a: 3.7, b: "x", c: Infinity } }), { kind: "poll", cursors: { a: 3 }, globalCursor: -1 });
  assert.deepEqual(parseHostRequest({ kind: "pull", waitMs: -5, appVersion: "1.11.0" }), { kind: "pull", appVersion: "1.11.0", waitMs: 0 });
  assert.equal(parseHostRequest({ kind: "nope" }), null);
});

// ── End to end: browser → hub → "Mac" forwarder → env server ─────────────

const servers: EnvServer[] = [];
const stops: (() => void)[] = [];
after(async () => {
  for (const s of stops) s();
  await Promise.all(servers.map((s) => s.close().catch(() => undefined)));
});

/** What the Mac app does: pull, forward to its env server over a dedicated socket, push back in arrival order. */
function startForwarder(link: DeviceLink, server: EnvServer): () => void {
  // Node's built-in WebSocket can't set headers: the token rides as a subprotocol, like a browser's.
  const ws = new WebSocket(server.url, ["alevr-code-v2", `alevr-token.${server.token}`]);
  let stopped = false;
  let outbox: { responses: ServerResponse[]; events: ServerEventEnvelope[] } = { responses: [], events: [] };
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    const batch = outbox;
    outbox = { responses: [], events: [] };
    if (batch.responses.length || batch.events.length) link.push(batch);
  };
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(String(m.data)) as ServerMessage;
    // Keep arrival order: events first within a batch is what the env server guarantees for replays.
    if (msg.type === "response") outbox.responses.push(msg);
    else outbox.events.push(msg);
    flushTimer ??= setTimeout(flush, 10);
  });
  const allowed = new Set(["session.open", "session.list", "session.close", "turn.start", "turn.steer", "turn.queue", "turn.interrupt", "approval.respond", "checkpoint.diff", "checkpoint.rollback", "provider.list", "provider.probe", "provider.setup"]);
  void (async () => {
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    while (!stopped) {
      const { commands } = await link.pull(200);
      for (const c of commands) {
        if (!allowed.has(c.type)) {
          outbox.responses.push({ type: "response", id: c.id, ok: false, error: { code: "unsupported", message: "Not over the link." } });
          flushTimer ??= setTimeout(flush, 0);
          continue;
        }
        ws.send(JSON.stringify(c));
      }
    }
  })();
  return () => {
    stopped = true;
    ws.close();
  };
}

test("link end to end: the web opens a session on the Mac, runs a Codex turn, approves, and reads the diff", async () => {
  const server = await startEnvServer({ dataDir: tempDir("link-data"), searchDirs: [fakeBinDir()], logger: silentLogger, probeOnStart: false, coalesceMs: 5 });
  servers.push(server);
  const hub = new EnvLinkHub();
  const link = hub.link("user-1", "mac-1");
  stops.push(startForwarder(link, server));
  await link.pull(0);

  let n = 0;
  const call = async <T,>(type: ClientCommand["type"], params: Record<string, unknown>): Promise<T> => {
    const reply = await link.rpc({ id: `b${++n}`, type, params } as ClientCommand);
    const res = reply.responses?.[0];
    assert.ok(res, JSON.stringify(reply));
    if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result as T;
  };

  await call("provider.probe", { instanceId: "codex:default" });
  const repo = initRepo();
  const selection = { instanceId: "codex:default", model: "gpt-6.1-codex" };
  const { sessionId } = await call<{ sessionId: string }>("session.open", { cwd: repo, selection });
  const { turnId } = await call<{ turnId: string }>("turn.start", { sessionId, input: { text: "approve then write notes.md" }, selection, runtimeMode: "ask", interactionMode: "default" });

  // The browser only polls; it starts before any snapshot (cursor -1).
  const seen: ServerEventEnvelope[] = [];
  let cursor = -1;
  let globalCursor = -1;
  const pollUntil = async (pred: () => boolean, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}; saw ${seen.map((e) => e.event.type).join(",")}`);
      const r = await link.poll({ [sessionId]: cursor }, globalCursor, 500);
      for (const e of r.events ?? []) {
        if (e.stream === "global") globalCursor = Math.max(globalCursor, e.sequence);
        if (e.stream !== "session") continue;
        if (e.event.type !== "session.snapshot" && e.sequence <= cursor) continue;
        seen.push(e);
        cursor = e.sequence;
      }
    }
  };
  const pendingApproval = () =>
    seen.map((e) => e.event).find((e) => (e.type === "item.added" || e.type === "item.updated") && e.item.kind === "approval_request" && e.item.status === "pending");
  await pollUntil(() => !!pendingApproval(), "approval");
  const approval = pendingApproval() as { item: { requestId: string } };
  await call("approval.respond", { sessionId, requestId: approval.item.requestId, decision: "accept" });
  await pollUntil(() => seen.some((e) => e.event.type === "turn.completed" && e.event.turnId === turnId), "turn end");

  const diff = await call<{ files: { path: string }[] }>("checkpoint.diff", { sessionId });
  assert.deepEqual(diff.files.map((f) => f.path), ["notes.md"]);

  // A browser that comes back later with an old cursor still gets a gap-free tail (replayed from the Mac's log).
  const late = new DeviceLink();
  const lateHubLink = late; // a fresh hub link = backend restarted
  stops.push(startForwarder(lateHubLink, server));
  await lateHubLink.pull(0);
  const deadline = Date.now() + 8000;
  let tail: ServerEventEnvelope[] = [];
  while (Date.now() < deadline) {
    tail = ((await lateHubLink.poll({ [sessionId]: 2 }, Number.MAX_SAFE_INTEGER, 300)).events ?? []).filter((e) => e.stream === "session");
    await new Promise((r) => setTimeout(r, 20));
    if (tail.length) break;
  }
  assert.ok(tail.length > 0, "replayed");
  assert.equal(tail[0].sequence, 3);
  const seqs = tail.map((e) => e.sequence);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);

  // Terminals stay on the Mac.
  await assert.rejects(call("terminal.open", { cwd: repo, cols: 80, rows: 24 }), (e: Error & { code?: string }) => e.code === "unsupported");
});
