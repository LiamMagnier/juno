import test from "node:test";
import assert from "node:assert/strict";
import { registerLocalToolCall, waitLocalToolResult, LOCAL_TOOL_STORE_FAILURE_OUTPUT } from "@/lib/chat/local-folder-bridge";
import { createLocalFolderTools } from "@/lib/chat/local-folder-tools";
import { LocalToolTestStore } from "./local-folder-test-store";

const identity = (callId: string) => ({ callId, userId: "owner", generationId: "generation-1" });
const result = { outcome: "succeeded" as const, output: "fixture result" };

test("a new waiter recovers a receipt written by another server", async () => {
  const store = new LocalToolTestStore();
  const input = { ...identity("restart"), store, timeoutMs: 1000 };
  await registerLocalToolCall(input);
  assert.equal(await store.deliver({ ...input, result }), "accepted");
  assert.deepEqual(await waitLocalToolResult({ ...input, pollMs: 1 }), result);
});

test("identical response retries are accepted; conflicts and wrong owners are not", async () => {
  const store = new LocalToolTestStore();
  const input = { ...identity("retry"), store, timeoutMs: 1000 };
  await registerLocalToolCall(input);
  assert.equal(await store.deliver({ ...input, userId: "intruder", result }), "unknown");
  assert.equal(await store.deliver({ ...input, generationId: "other-turn", result }), "unknown");
  assert.equal(await store.deliver({ ...input, result }), "accepted");
  assert.equal(await store.deliver({ ...input, result }), "accepted");
  assert.equal(await store.deliver({ ...input, result: { ...result, output: "replacement" } }), "unknown");
  assert.deepEqual((await store.read(input))?.result, result);
});

test("duplicate registration never replaces the original receipt or dispatches again", async () => {
  const store = new LocalToolTestStore();
  const input = { ...identity("duplicate"), store, timeoutMs: 1000 };
  await registerLocalToolCall(input);
  const original = await store.read(input);
  let dispatches = 0;
  const tool = createLocalFolderTools({ folder: { name: "Fixture", access: "read" }, ...input,
    newCallId: () => input.callId, send: () => { dispatches++; } })[0];
  assert.equal((await tool.execute({})).ok, false);
  assert.equal(dispatches, 0);
  assert.deepEqual(await store.read(input), original);
});

test("database insertion failure and pre-dispatch cancellation send no frame", async () => {
  for (const aborted of [false, true]) {
    const store = new LocalToolTestStore();
    store.create = async () => { throw new Error("fixture database unavailable"); };
    const controller = new AbortController();
    if (aborted) controller.abort();
    let dispatches = 0;
    const tool = createLocalFolderTools({ folder: { name: "Fixture", access: "read" }, ...identity("outage"), store,
      send: () => { dispatches++; } })[0];
    assert.equal((await tool.execute({}, controller.signal)).ok, false);
    assert.equal(dispatches, 0);
  }
});

test("a cancellation racing insertion is persisted before any dispatch", async () => {
  const store = new LocalToolTestStore();
  const insert = store.create.bind(store);
  const controller = new AbortController();
  store.create = async row => { const created = await insert(row); controller.abort(); return created; };
  const input = { ...identity("insertion-race"), store, timeoutMs: 1000, signal: controller.signal };
  await assert.rejects(registerLocalToolCall(input));
  assert.equal((await store.read(input))?.status, "cancelled");
  assert.equal(await store.deliver({ ...input, result }), "unknown");
});

test("expired or cancelled receipts reject late answers without replay", async () => {
  for (const status of ["expired", "cancelled"] as const) {
    const store = new LocalToolTestStore();
    const input = identity(status);
    await store.create({ ...input, status: "pending", expiresAt: status === "expired" ? Date.now() - 1 : Date.now() + 1000 });
    await store.end(input, status);
    assert.equal(await store.deliver({ ...input, result }), "unknown");
    assert.equal((await waitLocalToolResult({ ...input, store })).outcome, "failed");
  }
});

test("read failures produce unknown outcomes, not success or automatic recovery", async () => {
  const store = new LocalToolTestStore();
  store.read = async () => { throw new Error("fixture unavailable"); };
  assert.deepEqual(await waitLocalToolResult({ ...identity("read-outage"), store }),
    { outcome: "failed", output: LOCAL_TOOL_STORE_FAILURE_OUTPUT });
});
