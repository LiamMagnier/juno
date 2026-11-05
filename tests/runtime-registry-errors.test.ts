import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";

/*
 * A registry tool (read_document, inspect_image, run_code's bridge) that
 * THROWS, run through `UnifiedAgentRegistry.executeToolCall` with a stand-in
 * broker store. A throw there is Juno's own code failing — a database error,
 * an internal path — and its message is the server log's: not the model's
 * (the summary is what the toolset hands back as the result text), not the
 * panel's, and not the receipt's (a replay of the call hands the stored text
 * to the model). `executeSpec` and the dispatcher already keep that rule.
 */

const completed: Array<{ userId: string; receiptId: string; ok: boolean; result: string }> = [];
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
// Left in place: the runtime loads the store lazily, at the call.
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  // By alias from a static import, by resolved path from the runtime's lazy one.
  if (request === "@/lib/action-approval-store" || /[\\/]src[\\/]lib[\\/]action-approval-store\.ts$/.test(request)) {
    return {
      authorizeExternalAction: async () => ({ kind: "authorized", receiptId: "receipt_1", riskClass: "read_only" }),
      completeExternalAction: async (input: { userId: string; receiptId: string; ok: boolean; result: string }) => void completed.push(input),
    };
  }
  return origLoad.call(this, request, parent, isMain);
};
const req = createRequire(import.meta.url);
const { UnifiedAgentRegistry } = req("../src/lib/agent/runtime") as typeof import("@/lib/agent/runtime");

const SECRET = "connect ECONNREFUSED postgres://juno:hunter2@10.0.0.7:5432/juno";

test("a registry tool that throws reaches the model and the receipt as a generic sentence, never its message", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args));
  const registry = new UnifiedAgentRegistry();
  registry.registerTool({
    id: "read_document",
    name: "Read document",
    category: "filesystem",
    description: "Reads.",
    parameters: { type: "object", properties: {} },
    riskClass: "read_only",
    formatPreview: () => ({ title: "Read document", detail: "", sensitive: false }),
    execute: async () => {
      throw new Error(SECRET);
    },
  } as never);
  completed.length = 0;
  let authorized = 0;
  const result = await registry.executeToolCall(
    "read_document",
    { action: "list" },
    { userId: "u1", sessionId: "gen_1", conversationId: "c1", mode: "chat" } as never,
    { callId: "toolu_1", onAuthorized: () => void (authorized += 1) },
  );
  assert.equal(authorized, 1);
  assert.equal(result.success, false);
  assert.doesNotMatch(JSON.stringify(result), /hunter2|ECONNREFUSED/, "nothing of the message reaches the result");
  assert.match(result.summary ?? "", /internal error/);
  assert.deepEqual(completed, [{ userId: "u1", receiptId: "receipt_1", ok: false, result: "The tool failed with an internal error." }]);
  // The operator still has it.
  assert.ok(logged.some((args) => JSON.stringify(args).includes("ECONNREFUSED")), "logged server-side");
});
