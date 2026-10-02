import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * L1 review: `UnifiedAgentRegistry.executeSpec`, the one place a provider spec
 * (run_code, use_skill…) runs, against a stand-in broker store.
 *
 *   - a spec that writes and declares `broker: "none"` is brokered anyway: a
 *     provider never waives its own authorisation;
 *   - a refused call never reaches the spec;
 *   - a spec that throws settles its receipt with a generic sentence, never
 *     the error's own message (a replay would hand that to the model);
 *   - a long result is stored whole or not at all, never cut through the
 *     untrusted envelope that may close it.
 *
 * Needs module mocks (`--experimental-test-module-mocks`); skipped without.
 */

type Authorization = { kind: "authorized"; receiptId: string | null; riskClass: string } | { kind: "refused"; receiptId: null; reason: string };

const authorized: Array<{ toolName: string; callId: string; sessionId: string }> = [];
const completed: Array<{ receiptId: string; ok: boolean; result: string }> = [];
let answer: Authorization = { kind: "authorized", receiptId: "receipt_1", riskClass: "external_write" };

const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const brokerTest = canMockModules ? test : test.skip;
if (canMockModules) {
  mock.module("@/lib/action-approval-store", {
    namedExports: {
      authorizeExternalAction: async (request: { toolName: string; callId: string; sessionId: string }) => {
        authorized.push({ toolName: request.toolName, callId: request.callId, sessionId: request.sessionId });
        return answer;
      },
      completeExternalAction: async (input: { receiptId: string; ok: boolean; result: string }) => {
        completed.push({ receiptId: input.receiptId, ok: input.ok, result: input.result });
      },
    },
  });
}

const context = { userId: "u1", sessionId: "gen_1", conversationId: "c1", projectId: null, mode: "chat" } as never;

function spec(overrides: Record<string, unknown> = {}) {
  let runs = 0;
  return {
    get runs() {
      return runs;
    },
    spec: {
      id: "write_note",
      title: "Write a note",
      description: "Writes a note.",
      input: { type: "object" as const, properties: {} },
      risk: "write" as const,
      parallelSafe: false,
      timeoutMs: 1_000,
      broker: "none" as const,
      dedupe: false,
      execute: async () => {
        runs += 1;
        return { status: "succeeded" as const, text: "written", body: "written" };
      },
      ...overrides,
    },
  };
}

brokerTest("a writing spec that declares itself unbrokered is brokered anyway", async () => {
  const { UnifiedAgentRegistry } = await import("@/lib/agent/runtime");
  authorized.length = 0;
  answer = { kind: "authorized", receiptId: "receipt_1", riskClass: "external_write" };
  const s = spec();
  const outcome = await new UnifiedAgentRegistry().executeSpec(s.spec as never, {}, context, { callId: "toolu_1" });
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(authorized, [{ toolName: "write_note", callId: "toolu_1", sessionId: "gen_1" }]);

  // The read it may legitimately be: no broker round trip.
  authorized.length = 0;
  const read = spec({ risk: "read" });
  await new UnifiedAgentRegistry().executeSpec(read.spec as never, {}, context, { callId: "toolu_2" });
  assert.equal(authorized.length, 0);
  assert.equal(read.runs, 1);
});

brokerTest("a refused call never reaches the spec", async () => {
  const { UnifiedAgentRegistry } = await import("@/lib/agent/runtime");
  answer = { kind: "refused", receiptId: null, reason: "Lockdown is on." };
  const s = spec({ broker: "juno_runtime" });
  const outcome = await new UnifiedAgentRegistry().executeSpec(s.spec as never, {}, context, { callId: "toolu_3" });
  assert.equal(s.runs, 0);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error?.code, "not_permitted");
});

brokerTest("a spec that throws keeps its error message out of the receipt", async () => {
  const { UnifiedAgentRegistry } = await import("@/lib/agent/runtime");
  answer = { kind: "authorized", receiptId: "receipt_2", riskClass: "external_write" };
  completed.length = 0;
  const s = spec({
    broker: "juno_runtime",
    execute: async () => {
      throw new Error("connect ECONNREFUSED exec.internal:8443 (token=abc)");
    },
  });
  await assert.rejects(new UnifiedAgentRegistry().executeSpec(s.spec as never, {}, context, { callId: "toolu_4" }), /ECONNREFUSED/);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].ok, false);
  assert.doesNotMatch(completed[0].result, /exec\.internal|token|ECONNREFUSED/);
});

brokerTest("a long result is kept whole or not at all, never cut through its envelope", async () => {
  const { UnifiedAgentRegistry } = await import("@/lib/agent/runtime");
  const { wrapUntrusted } = await import("@/lib/untrusted-content");
  answer = { kind: "authorized", receiptId: "receipt_3", riskClass: "external_write" };
  completed.length = 0;
  const long = wrapUntrusted("stdout", "y".repeat(40_000));
  const s = spec({ broker: "juno_runtime", execute: async () => ({ status: "succeeded", text: long, body: long }) });
  const outcome = await new UnifiedAgentRegistry().executeSpec(s.spec as never, {}, context, { callId: "toolu_5" });
  assert.equal(outcome.text, long, "the model is given the whole result now");
  assert.ok(completed[0].result.length < 500);
  assert.doesNotMatch(completed[0].result, /y{100}/);

  completed.length = 0;
  const short = wrapUntrusted("stdout", "fine");
  const t = spec({ broker: "juno_runtime", execute: async () => ({ status: "succeeded", text: short, body: short }) });
  await new UnifiedAgentRegistry().executeSpec(t.spec as never, {}, context, { callId: "toolu_6" });
  assert.equal(completed[0].result, short, "a result that fits is kept exactly, for the replay");
});
