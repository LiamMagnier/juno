import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCursor,
  deriveSessionStatusFields,
  deviceIsOnline,
  encodeCursor,
  planSessionEventAppend,
  policyKeepsContent,
  serializeRemoteSession,
  serializeRemoteSessionDetail,
  sessionUpsertData,
  snapshotIsStale,
  type IncomingSessionEvent,
} from "../src/lib/code-remote-sessions";
import type { CodeRemoteSession } from "@prisma/client";

const session = (overrides: Partial<CodeRemoteSession> = {}): CodeRemoteSession => ({
  id: "relay-row",
  userId: "user-a",
  deviceId: "mac-a",
  sessionId: "local-conversation-1",
  workspaceId: null,
  workspaceKey: null,
  workspaceName: null,
  projectId: null,
  projectName: null,
  title: "Standalone investigation",
  titleSource: "manual",
  modelId: "anthropic:claude-sonnet-5",
  reasoningEffort: "high",
  rolePreset: "builder",
  permissionMode: "approvalRequired",
  origin: "local",
  pinned: true,
  archived: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  sessionUpdatedAt: new Date("2026-01-03T00:00:00.000Z"),
  lastMessageAt: new Date("2026-01-02T00:00:00.000Z"),
  currentStatus: "idle",
  isRunning: false,
  isAwaitingApproval: false,
  pendingChangeCount: 0,
  activeBranch: null,
  gitDirtyState: null,
  lastError: null,
  lastEventSequence: 0,
  transcriptVersion: 1,
  snapshotVersion: 1,
  transcriptPolicy: "metadata",
  transcript: null,
  changes: null,
  terminal: null,
  tests: null,
  git: null,
  approvals: null,
  subagents: null,
  usage: null,
  indexedSearch: "Standalone investigation",
  deletedAt: null,
  syncedAt: new Date("2026-01-03T00:00:00.000Z"),
  updatedAt: new Date("2026-01-03T00:00:00.000Z"),
  ...overrides,
});

test("local pre-Remote and standalone sessions retain their Conversation id", () => {
  const input = sessionUpsertData({
    sessionId: "local-conversation-1",
    title: "Standalone investigation",
    modelId: "anthropic:claude-sonnet-5",
    origin: "local",
    pinned: true,
    archived: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    lastMessageAt: "2026-01-02T00:00:00.000Z",
  }, "metadata");
  assert.equal(input.sessionId, "local-conversation-1");
  assert.equal(input.workspaceKey, null);
  assert.equal(input.origin, "local");
  assert.equal(input.pinned, true);
  assert.equal(input.archived, true);
});

test("serialization exposes stable session and device identities", () => {
  const dto = serializeRemoteSession(session(), true);
  assert.equal(dto.sessionID, "local-conversation-1");
  assert.equal(dto.deviceID, "mac-a");
  assert.equal(dto.origin, "local");
  assert.equal(dto.fresh, true);
});

test("session cursor round-trips and malformed cursors fail closed", () => {
  const encoded = encodeCursor(session());
  assert.deepEqual(decodeCursor(encoded), { updatedAt: new Date("2026-01-03T00:00:00.000Z"), id: "relay-row" });
  assert.equal(decodeCursor("not-base64-json"), null);
});

test("offline freshness never claims stale device data is live", () => {
  const now = new Date("2026-01-01T00:10:00.000Z").getTime();
  assert.equal(deviceIsOnline(new Date("2026-01-01T00:09:00.000Z"), now), true);
  assert.equal(deviceIsOnline(new Date("2026-01-01T00:00:00.000Z"), now), false);
});

test("search index covers prompt/file material supplied by the Mac", () => {
  const input = sessionUpsertData({
    sessionId: "s",
    title: "Auth redesign",
    workspaceName: "Juno",
    modelId: "model-x",
    indexedSearch: "Auth redesign Juno rotate token src/auth.ts model-x",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  }, "recent");
  assert.match(input.indexedSearch, /rotate token/);
  assert.match(input.indexedSearch, /src\/auth\.ts/);
});

// ---------------------------------------------------------------------------
// Event stream: ordering, replay, gap detection, reconnection (RULE 16/17)
// ---------------------------------------------------------------------------

const ev = (seq: number, kind = "text_delta", payload: Record<string, unknown> = {}): IncomingSessionEvent => ({
  seq,
  kind,
  payload,
});

test("event append assigns nothing new when the batch is empty", () => {
  const plan = planSessionEventAppend(4, []);
  assert.ok(plan.ok && plan.accepted.length === 0 && plan.lastSeq === 4);
});

test("event append accepts a contiguous batch and reports the new high-water mark", () => {
  const plan = planSessionEventAppend(0, [ev(1), ev(2), ev(3)]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.accepted.map((e) => e.seq), [1, 2, 3]);
    assert.equal(plan.lastSeq, 3);
  }
});

test("event append sorts an out-of-order host batch before validating continuity", () => {
  const plan = planSessionEventAppend(0, [ev(3), ev(1), ev(2)]);
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.accepted.map((e) => e.seq), [1, 2, 3]);
});

test("event append is idempotent — a full replay writes nothing (no duplicate deltas/tools)", () => {
  const plan = planSessionEventAppend(3, [ev(1), ev(2), ev(3)]);
  assert.ok(plan.ok && plan.accepted.length === 0 && plan.lastSeq === 3);
});

test("event append de-dupes the overlap on reconnect and keeps only the tail", () => {
  // Client reconnected and re-sent 2..4 after we already had 1..3.
  const plan = planSessionEventAppend(3, [ev(2), ev(3), ev(4), ev(5)]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.deepEqual(plan.accepted.map((e) => e.seq), [4, 5]);
    assert.equal(plan.lastSeq, 5);
  }
});

test("event append rejects the first gap so a hole never looks like a complete transcript", () => {
  const plan = planSessionEventAppend(3, [ev(4), ev(6)]); // missing 5
  assert.ok(!plan.ok);
  if (!plan.ok) {
    assert.equal(plan.error, "missing_events");
    assert.equal(plan.expectedSeq, 5);
  }
});

test("event append rejects a batch that starts past the next expected seq", () => {
  const plan = planSessionEventAppend(3, [ev(6), ev(7)]); // expected 4
  assert.ok(!plan.ok);
  if (!plan.ok) assert.equal(plan.expectedSeq, 4);
});

test("event append derives the session status from the LAST status_update in the batch", () => {
  const plan = planSessionEventAppend(0, [
    ev(1, "status_update", { status: "running" }),
    ev(2, "text_delta", { text: "hi" }),
    ev(3, "status_update", { status: "awaiting_approval" }),
  ]);
  assert.ok(plan.ok);
  if (plan.ok) assert.equal(plan.status, "awaiting_approval");
});

test("event append leaves status undefined when no status_update is present", () => {
  const plan = planSessionEventAppend(0, [ev(1), ev(2)]);
  assert.ok(plan.ok && plan.status === undefined);
});

test("status fields map running/awaiting/idle and reject unknown states", () => {
  assert.deepEqual(deriveSessionStatusFields("running"), { currentStatus: "running", isRunning: true, isAwaitingApproval: false });
  assert.deepEqual(deriveSessionStatusFields("awaiting_approval"), { currentStatus: "awaiting_approval", isRunning: false, isAwaitingApproval: true });
  assert.deepEqual(deriveSessionStatusFields("completed"), { currentStatus: "completed", isRunning: false, isAwaitingApproval: false });
  assert.equal(deriveSessionStatusFields("idle")?.isRunning, false);
  assert.equal(deriveSessionStatusFields("bogus"), null);
  assert.equal(deriveSessionStatusFields(undefined), null);
});

// ---------------------------------------------------------------------------
// Snapshot optimistic concurrency + transcript privacy policy (RULE 8)
// ---------------------------------------------------------------------------

test("snapshot upload is stale when either version or event seq moves backwards", () => {
  const current = { snapshotVersion: 5, lastEventSequence: 40 };
  assert.equal(snapshotIsStale({ snapshotVersion: 4, lastEventSequence: 40 }, current), true);
  assert.equal(snapshotIsStale({ snapshotVersion: 5, lastEventSequence: 39 }, current), true);
  assert.equal(snapshotIsStale({ snapshotVersion: 5, lastEventSequence: 40 }, current), false);
  assert.equal(snapshotIsStale({ snapshotVersion: 6, lastEventSequence: 41 }, current), false);
});

test("only the metadata policy strips host transcript content", () => {
  assert.equal(policyKeepsContent("metadata"), false);
  assert.equal(policyKeepsContent("recent"), true);
  assert.equal(policyKeepsContent("full"), true);
});

test("offline session detail is flagged stale and never live", () => {
  const detail = serializeRemoteSessionDetail(session({ isRunning: true }), false);
  assert.equal(detail.stale, true);
  assert.equal(detail.live, false);
});

test("online running session detail is live", () => {
  const detail = serializeRemoteSessionDetail(session({ isRunning: true }), true);
  assert.equal(detail.stale, false);
  assert.equal(detail.live, true);
});
