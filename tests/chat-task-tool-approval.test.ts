import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";

/*
 * `start_task`'s approval, run the way the chat route runs it: through the
 * dispatcher, which always hands the tool its own per-call callback (it marks
 * the row "waiting"). The route's callback is the one that sends the card
 * frame the client draws Approve and Deny from, and pauses the stall clock.
 * Both have to fire; with only the dispatcher's, the person is never shown a
 * card and the task waits until its approval expires.
 *
 * The database, the Work dispatcher and the broker store are stand-ins; the
 * Work protocol schemas are the real ones.
 */

const cards: string[] = [];
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const stub = (request: string, name: string) =>
  request === `@/lib/${name}` || new RegExp(`[\\\\/]src[\\\\/]lib[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`).test(request);
// Left in place: the tool loads these lazily, at the call.
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (stub(request, "prisma")) {
    return {
      prisma: {
        workSession: { findMany: async () => [], findFirst: async () => null, updateMany: async () => ({ count: 1 }) },
        workRun: { findFirst: async () => null },
      },
    };
  }
  if (stub(request, "work/dispatch")) {
    return {
      sessionIdForKey: () => "ws_1",
      createWorkSessionForUser: async () => ({ session: { id: "ws_1", title: "Compare the quotes", goal: "Compare.", deletedAt: null } }),
      startWorkRunForUser: async () => ({ run: null, status: 200, body: {}, preflight: { estimatedCostMicroUsd: 20_000, requiresConfirmation: true } }),
    };
  }
  if (stub(request, "work/serializers")) return { serializeSession: (row: unknown) => row };
  if (stub(request, "action-approval-store")) {
    return {
      authorizeExternalAction: async (request: { onApprovalRequest?: (approval: unknown) => void }) => {
        request.onApprovalRequest?.({ id: "receipt_1", toolName: "start_task" });
        return { kind: "refused", receiptId: "receipt_1", reason: "Action denied.", status: "denied" };
      },
      completeExternalAction: async () => undefined,
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { createStartTaskTool } = req("../src/lib/chat/task-tool") as typeof import("@/lib/chat/task-tool");

test("start_task's approval reaches the route's card and the dispatcher's row alike", async () => {
  const tool = createStartTaskTool({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    userMessageId: "m1",
    userRequest: "Compare these three quotes in the background.",
    skillSlug: null,
    model: "anthropic:claude-opus-5-5",
    reasoningEffort: undefined,
    attachmentIds: [],
    connectorIds: [],
    untrustedContent: true,
    generationId: "gen_1",
    onApprovalRequest: (approval) => void cards.push(`route:${approval.id}`),
  });
  const result = await tool.execute(
    { title: "Compare the quotes", goal: "Compare the three quotes and say which is cheapest." },
    new AbortController().signal,
    { onApprovalRequest: (approval) => void cards.push(`row:${approval.id}`), onAuthorized: () => cards.push("authorized") },
  );
  assert.deepEqual(cards.sort(), ["route:receipt_1", "row:receipt_1"], "both callbacks, once each; nothing authorised");
  assert.equal(result.ok, false, "declined, so not started");
});
