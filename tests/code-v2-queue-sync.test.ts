import { test } from "node:test";
import assert from "node:assert/strict";
import { overlayQueue, opSettled, promoteOutcomeMessage, queueErrorMessage, reconcileQueueOps, type QueueOp } from "@/lib/code-v2/queue-sync";
import { LINK_RELAYED_COMMANDS } from "@/lib/code-v2/env-link-hub";
import { CLIENT_COMMAND_TYPE_VALUES } from "@/lib/code-v2/contracts";

const row = (id: string, text = id) => ({ id, text });

test("the queue lane is on the wire and relayed to the Mac", () => {
  for (const type of ["queue.remove", "queue.edit", "queue.move", "queue.promote"] as const) {
    assert.ok((CLIENT_COMMAND_TYPE_VALUES as readonly string[]).includes(type), `${type} is a client command`);
    assert.ok(LINK_RELAYED_COMMANDS.has(type), `${type} reaches the Mac from the web`);
  }
});

test("overlay draws pending ops over the server's queue, in order", () => {
  const server = [row("a"), row("b"), row("c")];
  const ops: QueueOp[] = [
    { opId: "1", kind: "edit", id: "b", text: "b, edited" },
    { opId: "2", kind: "move", id: "c", to: 0 },
    { opId: "3", kind: "remove", id: "a" },
  ];
  assert.deepEqual(overlayQueue(server, ops), [row("c"), row("b", "b, edited")]);
  // Empty text removes, like the env server's queue.edit.
  assert.deepEqual(overlayQueue(server, [{ opId: "4", kind: "edit", id: "a", text: "  " }]), [row("b"), row("c")]);
  // An op whose row already left the queue draws nothing.
  assert.deepEqual(overlayQueue(server, [{ opId: "5", kind: "remove", id: "zz" }]), server);
});

test("an op settles when the server shows it, or when its row is gone", () => {
  assert.equal(opSettled([row("a")], { opId: "1", kind: "remove", id: "a" }), false);
  assert.equal(opSettled([], { opId: "1", kind: "remove", id: "a" }), true);
  assert.equal(opSettled([row("a", "old")], { opId: "2", kind: "edit", id: "a", text: "new" }), false);
  assert.equal(opSettled([row("a", "new")], { opId: "2", kind: "edit", id: "a", text: "new" }), true);
  assert.equal(opSettled([row("a"), row("b")], { opId: "3", kind: "move", id: "b", to: 0 }), false);
  assert.equal(opSettled([row("b"), row("a")], { opId: "3", kind: "move", id: "b", to: 0 }), true);
  assert.equal(opSettled([row("b"), row("a")], { opId: "4", kind: "move", id: "a", to: 99 }), true, "a move past the end is clamped");
  const ops: QueueOp[] = [{ opId: "1", kind: "remove", id: "a" }];
  assert.equal(reconcileQueueOps([row("a")], ops), ops, "nothing settled keeps the same array (no re-render loop)");
});

test("remove, then Steer now, while the turn ends and the queue drains underneath", () => {
  // Queued: A, B, C. The reader removes A, then presses Steer now on B.
  let server = [row("A"), row("B"), row("C")];
  let ops: QueueOp[] = [
    { opId: "1", kind: "remove", id: "A" },
    { opId: "2", kind: "remove", id: "B" }, // Steer now hides B at once
  ];
  assert.deepEqual(overlayQueue(server, ops), [row("C")]);

  // Meanwhile the turn ended and the env server started A from the queue (queue.remove answers removed:false).
  server = [row("B"), row("C")];
  ops = reconcileQueueOps(server, ops);
  assert.deepEqual(ops.map((o) => o.opId), ["2"], "A's remove settled: it is not queued any more");
  assert.deepEqual(overlayQueue(server, ops), [row("C")], "B never flashes back while its promote is in flight");

  // queue.promote answered "steered" or "started": the server's queue no longer has B.
  server = [row("C")];
  ops = reconcileQueueOps(server, ops);
  assert.deepEqual(ops, []);
  assert.deepEqual(overlayQueue(server, ops), [row("C")], "B is neither left queued nor sent twice");
});

test("Steer now that could not steer leaves the message at the front, shown again", () => {
  const ops: QueueOp[] = [{ opId: "2", kind: "remove", id: "B" }];
  // The runtime cannot steer: queue.promote answered "next" and moved B to the front.
  const server = [row("B"), row("C")];
  const afterNext = ops.filter((o) => o.opId !== "2"); // what live-route does on "next"
  assert.deepEqual(overlayQueue(server, afterNext), [row("B"), row("C")]);
  assert.match(promoteOutcomeMessage("next") ?? "", /runs next/);
  assert.equal(promoteOutcomeMessage("steered"), null);
  assert.equal(promoteOutcomeMessage("started"), null);
});

test("a failed request says why, and an old Mac is told to update", () => {
  assert.match(queueErrorMessage({ code: "unsupported", message: "This command is not available from another device." }), /Update Alevr on your Mac/);
  assert.match(queueErrorMessage({ code: "not_ready" }), /could not be reached/);
  assert.equal(queueErrorMessage(new Error("No session s1.")), "No session s1.");
  assert.match(queueErrorMessage(null), /Could not change the queue/);
});
