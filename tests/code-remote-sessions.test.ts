import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  MAX_EVENT_BATCH_BYTES,
  MAX_EVENT_FRAME_BYTES,
  MAX_EVENT_PAYLOAD_BYTES,
  appendedStatusFields,
  checkSessionEventBatch,
  chunkEventFrames,
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

test("event append reports when the host recorded the status it derives", () => {
  const plan = planSessionEventAppend(0, [
    { ...ev(1, "status_update", { status: "running" }), createdAt: "2026-09-22T10:00:00.000Z" },
    { ...ev(2, "status_update", { status: "completed" }), createdAt: "2026-09-22T10:05:00.000Z" },
    { ...ev(3), createdAt: "2026-09-22T10:06:00.000Z" },
  ]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.status, "completed");
    assert.equal(plan.statusAt, "2026-09-22T10:05:00.000Z");
  }
});

// A Mac lists a session waiting on the reader as awaiting_approval, and does
// not journal that wait as a status. Its journal, uploaded after the fact,
// ends on the run's earlier "running". That must not overwrite the list.
test("a journal status older than the host's list does not overwrite it", () => {
  const listedAt = new Date("2026-09-22T10:10:00.000Z");
  const backfill = planSessionEventAppend(0, [
    { ...ev(1, "status_update", { status: "running" }), createdAt: "2026-09-22T10:00:00.000Z" },
    { ...ev(2, "approval_request", { requestId: "a-1" }), createdAt: "2026-09-22T10:09:59.000Z" },
  ]);
  assert.ok(backfill.ok);
  if (backfill.ok) assert.equal(appendedStatusFields(backfill, listedAt), null);
});

test("a journal status newer than the host's list moves it", () => {
  const listedAt = new Date("2026-09-22T10:10:00.000Z");
  const live = planSessionEventAppend(4, [
    { ...ev(5, "status_update", { status: "completed" }), createdAt: "2026-09-22T10:10:00.000Z" },
  ]);
  assert.ok(live.ok);
  if (live.ok) {
    assert.deepEqual(appendedStatusFields(live, listedAt), {
      currentStatus: "completed",
      isRunning: false,
      isAwaitingApproval: false,
    });
  }
});

test("a journal status without a time is taken as current, as before", () => {
  const plan = planSessionEventAppend(0, [ev(1, "status_update", { status: "running" })]);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(appendedStatusFields(plan, new Date("2030-01-01T00:00:00.000Z"))?.currentStatus, "running");
  }
  assert.equal(appendedStatusFields({ status: "bogus", statusAt: undefined }, new Date(0)), null);
  assert.equal(appendedStatusFields({ status: undefined, statusAt: undefined }, new Date(0)), null);
});

test("the events route folds status through the list-aware gate", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/code/devices/[deviceId]/sessions/[sessionId]/events/route.ts"),
    "utf8",
  );
  assert.match(route, /appendedStatusFields\(plan, session\.sessionUpdatedAt\)/);
  assert.doesNotMatch(route, /deriveSessionStatusFields\(/, "no path folds a journal status without the gate");
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

// ---------------------------------------------------------------------------
// Host uploads: batch size, duplicates and frame size
// ---------------------------------------------------------------------------

test("a batch that repeats a sequence is refused whole, not reported as a gap", () => {
  const check = checkSessionEventBatch([ev(1), ev(2), ev(2)]);
  assert.deepEqual(check, { ok: false, status: 400, error: "duplicate_seq", seq: 2 });
});

test("an event too large to render on a phone is refused with its sequence", () => {
  const huge = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 1);
  const check = checkSessionEventBatch([ev(1), ev(2, "command_output", { text: huge })]);
  assert.deepEqual(check, { ok: false, status: 413, error: "event_too_large", seq: 2 });
});

test("an ordinary batch passes the checks and then the append planner", () => {
  const batch = [ev(5), ev(4, "user_message", { text: "hi" }), ev(6)];
  assert.deepEqual(checkSessionEventBatch(batch), { ok: true });
  const plan = planSessionEventAppend(3, batch);
  assert.ok(plan.ok);
  if (plan.ok) assert.deepEqual(plan.accepted.map((e) => e.seq), [4, 5, 6]);
});

test("a page is cut into bounded SSE frames, in order", () => {
  const events = Array.from({ length: 30 }, (_, index) => ({
    seq: index + 1,
    kind: "text_delta",
    payload: { text: "y".repeat(1_000) },
  }));
  const frames = chunkEventFrames(events, 8 * 1024);
  assert.ok(frames.length > 1, "a page larger than a frame is split");
  assert.deepEqual(frames.flat().map((e) => e.seq), events.map((e) => e.seq), "nothing is lost or reordered");
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame), "utf8") <= 8 * 1024 + 64);
  }
});

test("an event larger than a frame still travels, alone", () => {
  const big = { seq: 1, kind: "text_delta", payload: { text: "z".repeat(20_000) } };
  const frames = chunkEventFrames([big, { seq: 2, kind: "heartbeat", payload: {} }], 8 * 1024);
  assert.deepEqual(frames.map((frame) => frame.map((e) => e.seq)), [[1], [2]]);
});

test("a frame fits the phone's line limit and a batch fits a hundred events", () => {
  // CodeRemoteSSEParser.maximumLineBytes in NativeCodeRemoteClient.swift.
  assert.ok(MAX_EVENT_FRAME_BYTES < 1024 * 1024);
  assert.ok(MAX_EVENT_BATCH_BYTES >= 100 * 8 * 1024);
});

test("the events route bounds the body before parsing and keeps the high-water mark monotone", () => {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/code/devices/[deviceId]/sessions/[sessionId]/events/route.ts"),
    "utf8",
  );
  const sizeCheck = route.indexOf("> MAX_EVENT_BATCH_BYTES");
  const parse = route.indexOf("JSON.parse(raw)");
  assert.ok(sizeCheck !== -1 && parse !== -1 && sizeCheck < parse, "size is checked before JSON is parsed");
  assert.match(route, /checkSessionEventBatch\(parsed\.data\.events\)/);
  assert.match(route, /lastEventSequence: \{ lt: plan\.lastSeq \}/);
  assert.match(route, /chunkEventFrames\(/);
});
