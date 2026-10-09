import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClientCommand, ServerEventEnvelope, ServerMessage, SessionSnapshot } from "@/lib/code-v2/contracts";
import { applyCoalesced, applyEnvelope, applyEnvelopes, coalesceDeltas, emptySessionView, pendingRequests, sessionItems } from "@/lib/code-v2/session-store";
import { DeviceLinkTransport, EnvClient, parseServerMessage, resolveEnvEndpoint, type EnvTransport, type TransportStatus } from "@/lib/code-v2/env-client";
import { activityToItem, legacyToItems } from "@/lib/code-v2/legacy-adapter";

const AT = "2026-10-08T10:00:00.000Z";
const sel = { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };

function snapshot(seq: number, items: SessionSnapshot["items"] = []): ServerEventEnvelope {
  return {
    type: "event",
    stream: "session",
    sessionId: "s1",
    sequence: seq,
    at: AT,
    event: {
      type: "session.snapshot",
      snapshotSequence: seq,
      session: { id: "s1", cwd: "/repo", selection: sel, runtimeMode: "auto-edit", interactionMode: "default", state: "idle", items, queue: [] },
    },
  };
}

function ev(seq: number, event: ServerEventEnvelope["event"]): ServerEventEnvelope {
  return { type: "event", stream: "session", sessionId: "s1", sequence: seq, at: AT, event };
}

test("snapshot then in-order events apply; duplicates are ignored; gaps flag a resync", () => {
  let v = emptySessionView("s1", sel);
  let r = applyEnvelope(v, snapshot(10));
  assert.equal(r.disposition, "apply");
  v = r.view;
  assert.equal(v.cursor, 10);

  r = applyEnvelope(v, ev(11, { type: "item.added", item: { id: "a", kind: "assistant_message", text: "Hel", streaming: true, createdAt: AT } }));
  v = r.view;
  r = applyEnvelope(v, ev(12, { type: "item.delta", itemId: "a", field: "text", append: "lo" }));
  v = r.view;
  assert.equal((v.items.a as { text: string }).text, "Hello");

  // duplicate
  r = applyEnvelope(v, ev(12, { type: "item.delta", itemId: "a", field: "text", append: "lo" }));
  assert.equal(r.disposition, "duplicate");
  assert.equal((r.view.items.a as { text: string }).text, "Hello");

  // gap
  r = applyEnvelope(v, ev(14, { type: "item.delta", itemId: "a", field: "text", append: "!" }));
  assert.equal(r.disposition, "gap");
  assert.equal(r.view.needsResync, true);
  assert.equal((r.view.items.a as { text: string }).text, "Hello");
});

test("events before any snapshot are gaps", () => {
  const r = applyEnvelope(emptySessionView("s1", sel), ev(1, { type: "queue.updated", queue: [] }));
  assert.equal(r.disposition, "gap");
});

test("turn.completed settles streaming items and records limited", () => {
  let v = applyEnvelope(emptySessionView("s1", sel), snapshot(0)).view;
  v = applyEnvelopes(v, [
    ev(1, { type: "turn.started", turnId: "t1", selection: sel }),
    ev(2, { type: "item.added", item: { id: "a", turnId: "t1", kind: "assistant_message", text: "x", streaming: true, createdAt: AT } }),
    ev(3, { type: "turn.completed", turnId: "t1", outcome: "limited" }),
  ]).view;
  assert.equal(v.state, "limited");
  assert.equal(v.activeTurnId, undefined);
  assert.equal((v.items.a as { streaming: boolean }).streaming, false);
});

test("coalesced deltas render once and advance the cursor to the last sequence", () => {
  const base = applyEnvelope(emptySessionView("s1", sel), snapshot(0, [{ id: "c", kind: "command_execution", callId: "c", command: "pnpm test", status: "running", createdAt: AT }])).view;
  const burst = [1, 2, 3].map((n) => ev(n, { type: "item.delta", itemId: "c", field: "output", append: `line ${n}\n` }));
  assert.equal(coalesceDeltas(burst).length, 1);
  const { view, disposition } = applyCoalesced(base, burst);
  assert.equal(disposition, "apply");
  assert.equal(view.cursor, 3);
  assert.equal((view.items.c as { output: string }).output, "line 1\nline 2\nline 3\n");
});

test("pendingRequests lists open approvals and questions", () => {
  const v = applyEnvelope(
    emptySessionView("s1", sel),
    snapshot(0, [
      { id: "p", kind: "approval_request", callId: "x", requestId: "r", action: "command", summary: "run", status: "pending", createdAt: AT },
      { id: "q", kind: "approval_request", callId: "y", requestId: "r2", action: "command", summary: "run", status: "resolved", createdAt: AT },
    ]),
  ).view;
  assert.deepEqual(pendingRequests(v).map((i) => i.id), ["p"]);
  assert.equal(sessionItems(v).length, 2);
});

// ── EnvClient ───────────────────────────────────────────────────────────────

class FakeTransport implements EnvTransport {
  sent: ClientCommand[] = [];
  cursors: Record<string, number> = {};
  private msg = new Set<(m: ServerMessage) => void>();
  private st = new Set<(s: TransportStatus) => void>();
  send(c: ClientCommand) {
    this.sent.push(c);
  }
  onMessage(l: (m: ServerMessage) => void) {
    this.msg.add(l);
    return () => this.msg.delete(l);
  }
  onStatus(l: (s: TransportStatus) => void) {
    this.st.add(l);
    return () => this.st.delete(l);
  }
  setCursors(c: Record<string, number>) {
    this.cursors = c;
  }
  close() {}
  emit(m: ServerMessage) {
    for (const l of this.msg) l(m);
  }
  status(s: TransportStatus) {
    for (const l of this.st) l(s);
  }
}

const sync = { setTimeout: () => 0, clearTimeout: () => undefined };

test("EnvClient correlates responses and surfaces wire errors", async () => {
  const t = new FakeTransport();
  let n = 0;
  const client = new EnvClient(t, { coalesceMs: 0, scheduler: sync, idFactory: () => `id${n++}` });
  const p = client.request("provider.list", {});
  assert.equal(t.sent[0].type, "provider.list");
  t.emit({ type: "response", id: "id0", ok: true, result: { instances: [] } });
  assert.deepEqual(await p, { instances: [] });

  const q = client.request("turn.interrupt", { sessionId: "s1" });
  t.emit({ type: "response", id: "id1", ok: false, error: { code: "not_found", message: "No such session." } });
  await assert.rejects(q, /No such session/);
});

test("EnvClient follows a session, keeps early events and re-opens from the cursor on a gap", async () => {
  const t = new FakeTransport();
  let n = 0;
  const client = new EnvClient(t, { coalesceMs: 0, scheduler: sync, idFactory: () => `id${n++}` });
  const views: number[] = [];
  const opening = client.openSession({ cwd: "/repo" }, (v) => views.push(v.cursor ?? -1));
  // Snapshot arrives before the response.
  t.emit(snapshot(5));
  t.emit({ type: "response", id: "id0", ok: true, result: { sessionId: "s1" } });
  const sub = await opening;
  assert.equal(sub.view().cursor, 5);
  assert.deepEqual(t.cursors, { s1: 5 });

  t.emit(ev(6, { type: "queue.updated", queue: [] }));
  assert.equal(sub.view().cursor, 6);

  t.emit(ev(9, { type: "queue.updated", queue: [] }));
  const reopen = t.sent[t.sent.length - 1];
  assert.equal(reopen.type, "session.open");
  assert.deepEqual(reopen.params, { sessionId: "s1", cwd: "/repo", afterSequence: 6 });
  assert.ok(views.includes(6));
  sub.close();
  assert.deepEqual(t.cursors, {});
});

test("parseServerMessage drops garbage", () => {
  assert.equal(parseServerMessage("{"), null);
  assert.equal(parseServerMessage({ type: "event" }), null);
  assert.ok(parseServerMessage(JSON.stringify({ type: "response", id: "1", ok: true })));
});

test("resolveEnvEndpoint prefers an explicit socket, then the device link", () => {
  assert.deepEqual(resolveEnvEndpoint({ explicitUrl: "ws://127.0.0.1:4317", deviceId: "d", deviceOnline: true }), { kind: "socket", url: "ws://127.0.0.1:4317" });
  assert.deepEqual(resolveEnvEndpoint({ deviceId: "d", deviceOnline: true }), { kind: "link", deviceId: "d" });
  assert.deepEqual(resolveEnvEndpoint({ deviceId: "d", deviceOnline: false }), { kind: "none" });
});

test("DeviceLinkTransport posts commands and turns failures into wire errors", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const t = new DeviceLinkTransport("dev1", async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
    return { ok: false, status: 503, json: async () => ({ message: "Your Mac is asleep." }) };
  });
  const got: ServerMessage[] = [];
  t.onMessage((m) => got.push(m));
  t.send({ id: "c1", type: "provider.list", params: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls[0].url, "/api/code/v2/link/dev1");
  assert.deepEqual(calls[0].body, { kind: "rpc", command: { id: "c1", type: "provider.list", params: {} } });
  assert.equal(got[0].type, "response");
  assert.equal((got[0] as { ok: boolean }).ok, false);
  t.close();
});

// ── Legacy adapter ─────────────────────────────────────────────────────────

test("legacy activity rows map onto turn items", () => {
  assert.equal(activityToItem({ id: "1", kind: "write", title: "edit src/a.ts", detail: "+3 −1", createdAt: AT }, "t")?.kind, "file_change");
  const cmd = activityToItem({ id: "2", kind: "tool", title: "Ran `pnpm test`", detail: "ok", createdAt: AT, toolStatus: "ok", exitCode: 0 }, "t");
  assert.equal(cmd?.kind, "command_execution");
  assert.equal((cmd as { command: string }).command, "pnpm test");
  const read = activityToItem({ id: "3", kind: "tool", title: "Read src/cart.ts", createdAt: AT, toolStatus: "ok" }, "t");
  assert.equal(read?.kind, "search");
  assert.equal(activityToItem({ id: "4", kind: "warning", title: "Approval requested", createdAt: AT }, "t"), null);
});

test("legacyToItems builds turns, live agents and a pending approval", () => {
  const out = legacyToItems({
    status: "awaiting_approval",
    messages: [
      { id: "u1", role: "USER", content: "Fix it", createdAt: AT, attachments: [] },
      { id: "a1", role: "ASSISTANT", content: "", createdAt: AT, activity: [{ id: "w", kind: "write", title: "edit src/a.ts", detail: "+1 −0", createdAt: AT }] },
    ],
    agents: [{ id: "g1", title: "Server route", role: "worker", status: "running", currentActivity: "Editing a.ts" }],
    fileChanges: [{ path: "src/a.ts", changeKind: "edit", added: 1, removed: 0, patch: "@@ -1 +1,2 @@\n a\n+b\n" }],
    pendingApproval: { requestId: "r1", summary: "Run pnpm test", risk: "neutral", detail: null },
  });
  assert.equal(out.state, "waiting");
  const kinds = out.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["user_message", "file_change", "subagent", "approval_request"]);
  const fc = out.items[1] as { changes: { diff?: string }[] };
  assert.ok(fc.changes[0].diff?.includes("+b"));
});
