import assert from "node:assert/strict";
import test from "node:test";
import {
  afterCursor,
  applyThreadUpdate,
  codeThreadKey,
  decodeSyncCursor,
  encodeSyncCursor,
  isThreadKey,
  parseThreadUpdate,
  readThreadSync,
  writeThreadSync,
  type SyncCursor,
  type ThreadSyncRow,
  type ThreadSyncStore,
} from "@/lib/sync/thread-sync";
import {
  approvalFacts,
  buildHandoffPayload,
  buildLinkApprovalPayload,
  noteHostEvents,
  resetRemotePushMemory,
  APNS_CATEGORY_CODE_APPROVAL,
  type HostEventDeps,
  type PushDelivery,
} from "@/lib/code-v2/remote-push";
import type { ServerEventEnvelope } from "@/lib/code-v2/contracts";

/*
 * Hand-off and sync (docs/code-v2/REMOTE-CONTROL.md §Sync): per-thread drafts
 * and composer settings with last-writer-wins by the client's clock, a cursor
 * that neither skips nor repeats rows, long-polls woken by a write, and the
 * approval pushes and needs-you state the device link drives.
 */

function memoryThreads(): ThreadSyncStore & { rows: Map<string, ThreadSyncRow> } {
  const rows = new Map<string, ThreadSyncRow>();
  const id = (u: string, k: string) => `${u}\u0000${k}`;
  return {
    rows,
    async get(userId, key) {
      return rows.get(id(userId, key)) ?? null;
    },
    async put(userId, row) {
      rows.set(id(userId, row.key), { ...row });
      return row;
    },
    async since(userId, cursor: SyncCursor | null, limit, keys) {
      return [...rows.entries()]
        .filter(([k, r]) => k.startsWith(`${userId}\u0000`) && (!keys?.length || keys.includes(r.key)) && afterCursor(r, cursor))
        .map(([, r]) => r)
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || (a.key < b.key ? -1 : 1))
        .slice(0, limit);
    },
  };
}

test("thread keys: chat and code threads only", () => {
  assert.ok(isThreadKey("chat:cm1abc"));
  assert.ok(isThreadKey(codeThreadKey("mac1", "session-1")));
  assert.ok(!isThreadKey("chat:"));
  assert.ok(!isThreadKey("other:x"));
  assert.ok(!isThreadKey("chat:../../etc"));
});

test("updates: parsed strictly, prefs reduced to the composer's settings", () => {
  const ok = parseThreadUpdate({ draft: "hello", prefs: { model: "opus", mode: "full", skills: ["a", 3, "b"], secret: "x" }, device: "iphone" });
  assert.ok(ok.ok);
  assert.deepEqual(ok.update.prefs, { model: "opus", mode: "full", skills: ["a", "b"] });
  assert.equal(parseThreadUpdate({}).ok, false);
  assert.equal(parseThreadUpdate({ draft: 3 }).ok, false);
  assert.equal(parseThreadUpdate({ draft: "x".repeat(100_001) }).ok, false);
  assert.equal(parseThreadUpdate({ read: "yes" }).ok, false);
  assert.equal(parseThreadUpdate({ draft: "x", draftUpdatedAt: "not a date" }).ok, false);
});

test("drafts: the newer write by the client's clock wins, an older one is ignored", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const first = applyThreadUpdate(null, "chat:c1", { draft: "from the Mac", draftUpdatedAt: "2026-10-10T11:59:50Z", device: "mac" }, now).row;
  const stale = applyThreadUpdate(first, "chat:c1", { draft: "old phone text", draftUpdatedAt: "2026-10-10T11:59:40Z", device: "iphone" }, now);
  assert.equal(stale.changed, false);
  assert.equal(stale.row.draft, "from the Mac");
  const newer = applyThreadUpdate(first, "chat:c1", { draft: "phone edit", draftUpdatedAt: "2026-10-10T11:59:55Z", device: "iphone" }, now);
  assert.equal(newer.row.draft, "phone edit");
  assert.equal(newer.row.draftBy, "iphone");
  const future = applyThreadUpdate(first, "chat:c1", { draft: "from the future", draftUpdatedAt: "2027-01-01T00:00:00Z" }, now).row;
  assert.equal(future.draftUpdatedAt?.toISOString(), now.toISOString(), "a skewed clock cannot pin the draft");
});

test("prefs: model, mode, team and skills merge and sync per thread", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const a = applyThreadUpdate(null, "code:mac1:s1", { prefs: { model: "opus", mode: "ask" }, prefsUpdatedAt: "2026-10-10T11:00:00Z" }, now).row;
  const b = applyThreadUpdate(a, "code:mac1:s1", { prefs: { mode: "full", team: "lead-workers", skills: ["tidy"] }, prefsUpdatedAt: "2026-10-10T11:01:00Z" }, now).row;
  assert.deepEqual(b.prefs, { model: "opus", mode: "full", team: "lead-workers", skills: ["tidy"] });
  const old = applyThreadUpdate(b, "code:mac1:s1", { prefs: { mode: "ask" }, prefsUpdatedAt: "2026-10-10T10:00:00Z" }, now);
  assert.equal(old.row.prefs.mode, "full");
});

test("cursor: rows written in the same millisecond are neither skipped nor repeated", async () => {
  const store = memoryThreads();
  const at = new Date("2026-10-10T12:00:00.000Z");
  await writeThreadSync(store, "u", "chat:b", { draft: "b" }, at);
  await writeThreadSync(store, "u", "chat:a", { draft: "a" }, at);
  const first = await readThreadSync(store, "u", { cursor: null });
  assert.deepEqual(first.threads.map((t) => t.key), ["chat:a", "chat:b"]);
  await writeThreadSync(store, "u", "chat:c", { draft: "c" }, at);
  const second = await readThreadSync(store, "u", { cursor: decodeSyncCursor(first.cursor) });
  assert.deepEqual(second.threads.map((t) => t.key), ["chat:c"]);
  const third = await readThreadSync(store, "u", { cursor: decodeSyncCursor(second.cursor) });
  assert.deepEqual(third.threads, []);
  assert.equal(third.cursor, second.cursor);
  assert.equal(encodeSyncCursor(decodeSyncCursor(second.cursor)!), second.cursor);
  assert.equal(decodeSyncCursor("garbage"), null);
});

test("long-poll: a waiting reader wakes on the next write, and only for its own account", async () => {
  const store = memoryThreads();
  const started = Date.now();
  const waiting = readThreadSync(store, "u", { cursor: null, waitMs: 5000 });
  await writeThreadSync(store, "someone-else", "chat:x", { draft: "not yours" });
  setTimeout(() => void writeThreadSync(store, "u", "chat:c1", { draft: "typed on the Mac" }), 30);
  const page = await waiting;
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(page.threads.map((t) => t.draft), ["typed on the Mac"]);
});

test("unchanged writes do not wake readers or bump the cursor", async () => {
  const store = memoryThreads();
  const at = new Date("2026-10-10T12:00:00Z");
  const row = await writeThreadSync(store, "u", "chat:c1", { needsYou: false }, at);
  const again = await writeThreadSync(store, "u", "chat:c1", { needsYou: false }, new Date(at.getTime() + 1000));
  assert.equal(again.updatedAt.getTime(), row.updatedAt.getTime());
});

// ── Approval pushes through the device link ─────────────────────────────────

const approval = (requestId: string, status: "pending" | "resolved", sequence: number): ServerEventEnvelope => ({
  type: "event",
  stream: "session",
  sessionId: "s1",
  sequence,
  at: "2026-10-10T12:00:00Z",
  event: {
    type: sequence === 1 ? "item.added" : "item.updated",
    item: { id: `i-${requestId}`, kind: "approval_request", createdAt: "2026-10-10T12:00:00Z", callId: "c", requestId, action: "command", summary: "Run npm test", status },
  },
});

function hostDeps(phones: string[]) {
  const sent: Array<{ delivery: PushDelivery; payload: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const threads = memoryThreads();
  const deps: HostEventDeps = {
    pairedPhones: async () => phones,
    deviceName: async () => "Studio Mac",
    push: async (_user, delivery, payload, options) => {
      sent.push({ delivery, payload, options });
      return [{ success: true }];
    },
    threads,
  };
  return { deps, sent, threads };
}

test("approvals: a pending approval rings the paired phones once, with Allow once / Deny actions", async () => {
  resetRemotePushMemory();
  const { deps, sent, threads } = hostDeps(["phone-session"]);
  const first = await noteHostEvents(deps, "u", "mac1", [approval("r1", "pending", 1)]);
  assert.equal(first.announced, 1);
  const again = await noteHostEvents(deps, "u", "mac1", [approval("r1", "pending", 1)]);
  assert.equal(again.announced, 0, "a replay does not ring twice");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].delivery, { deviceSessionIds: ["phone-session"], platform: "ios", needsYou: true });
  assert.equal((sent[0].payload.aps as { category: string }).category, APNS_CATEGORY_CODE_APPROVAL);
  assert.equal(sent[0].payload.requestID, "r1");
  assert.equal(sent[0].options?.collapseId, "r1");
  assert.equal((await threads.get("u", "code:mac1:s1"))?.needsYou, true);
});

test("approvals: answered anywhere, the notification is withdrawn and needs-you clears everywhere", async () => {
  resetRemotePushMemory();
  const { deps, sent, threads } = hostDeps(["phone-session"]);
  await noteHostEvents(deps, "u", "mac1", [approval("r2", "pending", 1)]);
  const state: ServerEventEnvelope = { type: "event", stream: "session", sessionId: "s1", sequence: 3, at: "2026-10-10T12:00:01Z", event: { type: "session.state", state: "running" } };
  const result = await noteHostEvents(deps, "u", "mac1", [approval("r2", "resolved", 2), state]);
  assert.equal(result.cleared, 1);
  const clear = sent.at(-1)!;
  assert.equal(clear.options?.pushType, "background");
  assert.equal(clear.payload.clearApproval, "r2");
  assert.equal((await threads.get("u", "code:mac1:s1"))?.needsYou, false);
  const late = await noteHostEvents(deps, "u", "mac1", [approval("r2", "pending", 1)]);
  assert.equal(late.announced, 0, "a stale replay after the answer never rings again");
});

test("approvals: with no paired phone nothing rings (the same account is not enough)", async () => {
  resetRemotePushMemory();
  const { deps, sent } = hostDeps([]);
  await noteHostEvents(deps, "u", "mac1", [approval("r3", "pending", 1)]);
  assert.equal(sent.length, 0);
});

test("approval facts: snapshots count, malformed events are skipped", () => {
  const snapshot = {
    type: "event",
    stream: "session",
    sessionId: "s9",
    sequence: 5,
    at: "x",
    event: { type: "session.snapshot", snapshotSequence: 5, session: { items: [{ id: "i", kind: "approval_request", requestId: "r9", summary: "Edit", action: "file_change", status: "pending", callId: "c", createdAt: "x" }] } },
  } as unknown as ServerEventEnvelope;
  const facts = approvalFacts([snapshot, { type: "event", stream: "session", sessionId: "s9", sequence: 6, at: "x" } as unknown as ServerEventEnvelope]);
  assert.deepEqual(facts.map((f) => [f.sessionId, f.requestId, f.pending]), [["s9", "r9", true]]);
});

test("payloads: approval and hand-off pushes carry the ids the apps route on", () => {
  const payload = buildLinkApprovalPayload({ deviceId: "mac1", deviceName: "Studio Mac", fact: { sessionId: "s1", requestId: "r1", summary: "Run npm test", action: "command", pending: true } });
  assert.match(String((payload.aps.alert as { title: string }).title), /Studio Mac wants to run a command/);
  assert.equal(payload.link, "v2");
  const chat = buildHandoffPayload({ target: "ios", kind: "chat", id: "conv1", title: "Trip plan" });
  assert.equal(chat.conversationId, "conv1");
  assert.equal(chat.path, "/chat/conv1");
  const code = buildHandoffPayload({ target: "macos", kind: "code", id: "s1", deviceId: "mac1" });
  assert.deepEqual([code.deviceID, code.sessionID, code.handoff], ["mac1", "s1", "code"]);
});

// ── Sync audit: a push the Mac retried is not relayed twice ─────────────────

test("device link hub: a global batch pushed twice reaches the browser once, a new one still arrives", async () => {
  const { EnvLinkHub } = await import("@/lib/code-v2/env-link-hub");
  const link = new EnvLinkHub().link("u", "mac1");
  const output = (sequence: number, data: string): ServerEventEnvelope => ({
    type: "event",
    stream: "global",
    sequence,
    at: "2026-10-10T12:00:00Z",
    event: { type: "terminal.output", terminalId: "t1", data },
  });
  link.push({ events: [output(7, "ls\n"), output(8, "README.md\n")] });
  link.push({ events: [output(7, "ls\n"), output(8, "README.md\n")] });
  link.push({ events: [output(9, "$ ")] });
  const reply = await link.poll({}, -1, 0);
  const data = (reply.events ?? []).map((e) => (e.event.type === "terminal.output" ? e.event.data : ""));
  assert.deepEqual(data, ["ls\n", "README.md\n", "$ "]);
});
