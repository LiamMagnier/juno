import assert from "node:assert/strict";
import test from "node:test";

import { executeToolBatch, type BatchContext, type ToolCallInput } from "@/lib/tools/dispatch";
import { ToolFeeAccumulator } from "@/lib/tools/metering";
import { junoToolSpec } from "@/lib/tools/registry";
import type { ChatToolset, ResolvedTool, ToolContext, ToolSpec } from "@/lib/tools/types";

/*
 * What a brokered Alevr tool's receipt and audit row say when the call does
 * not end normally (docs/quality/memory-and-tools-2026-11.md, defects 4 and 5).
 *
 *   4. Stopped mid-run, the receipt was completed `failed` with an EMPTY
 *      result: the approvals history said the action failed when it may have
 *      taken effect, and a replay handed the model "" as a failed result.
 *   5. The audit row is written `executed` before authorisation; when the
 *      broker itself threw, the row was never settled and claimed a call ran
 *      that never left Alevr.
 *
 * The dispatcher is the real one; the broker and the audit store are fakes
 * that record what they are told.
 */

type Completed = { receiptId: string | null; ok: boolean; result: string };
type Settled = { id: string | null; status: string; error?: string };

function resolved(spec: ToolSpec, execute: ToolSpec["execute"]): ResolvedTool {
  return {
    name: spec.id,
    canonical: spec.id,
    origin: "juno",
    title: spec.title,
    risk: spec.risk,
    parallelSafe: spec.parallelSafe,
    timeoutMs: spec.timeoutMs,
    dedupe: false,
    present: () => ({}),
    spec: { ...spec, broker: "juno_runtime", execute },
    input: spec.input,
  };
}

function harness(tool: ResolvedTool, authorize: NonNullable<BatchContext["ports"]>["authorizeExternalAction"]) {
  const completed: Completed[] = [];
  const settled: Settled[] = [];
  const toolset: ChatToolset = {
    tools: [],
    labelFor: (name) => name,
    accessFor: () => "unknown",
    execute: async () => ({ text: "unused", body: "unused", ok: false }),
    close: async () => {},
    resolve: (name) => (name === tool.name ? tool : undefined),
    connectors: [],
  };
  const ctx: BatchContext = {
    toolset,
    toolContext: {
      userId: "u1",
      conversationId: "c1",
      projectId: null,
      generationId: "gen-1",
      private: false,
      plan: "PRO",
      citationsNumbered: false,
      sources: {} as ToolContext["sources"],
      ledger: null,
      taint: { mark: () => {} } as unknown as ToolContext["taint"],
      limits: {} as ToolContext["limits"],
      attachments: async () => [],
    },
    cache: new Map(),
    fees: new ToolFeeAccumulator(),
    nextIsFinal: false,
    seenCallIds: new Set(),
    ports: {
      authorizeExternalAction: authorize,
      completeExternalAction: async (input: Completed) => {
        completed.push({ receiptId: input.receiptId, ok: input.ok, result: input.result });
      },
      recordToolInvocation: async () => "audit_1",
      settleToolInvocation: async (id: string | null, settle: { status: string; error?: string }) => {
        settled.push({ id, status: settle.status, ...(settle.error === undefined ? {} : { error: settle.error }) });
      },
      resolvedPolicy: null,
    } as unknown as BatchContext["ports"],
  };
  return { ctx, completed, settled };
}

async function drain(ctx: BatchContext, calls: ToolCallInput[], signal: AbortSignal): Promise<void> {
  const gen = executeToolBatch(calls, signal, ctx);
  for (;;) {
    const next = await gen.next();
    if (next.done) return;
  }
}

const call: ToolCallInput[] = [{ name: "run_code", callId: "call_1", round: 0, index: 0, argsText: '{"code":"print(1)"}' }];

test("a brokered tool stopped mid-run leaves a receipt that says it may have taken effect", async () => {
  const stop = new AbortController();
  const tool = resolved(junoToolSpec("run_code")!, (_args, context) => {
    // Running: the stop lands while the tool is still out.
    setTimeout(() => stop.abort(new Error("stopped by the person")), 10);
    return new Promise((_resolve, reject) => {
      context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const { ctx, completed, settled } = harness(tool, (async () => ({
    kind: "authorized",
    receiptId: "receipt_1",
    riskClass: "external_write",
  })) as unknown as NonNullable<BatchContext["ports"]>["authorizeExternalAction"]);

  await drain(ctx, call, stop.signal).catch(() => undefined);

  assert.equal(completed.length, 1, "the receipt is completed once");
  assert.equal(completed[0].ok, false);
  assert.notEqual(completed[0].result, "", "never an empty result: a replay would hand the model nothing");
  assert.match(completed[0].result, /may have taken effect/);
  assert.equal(settled.at(-1)?.status, "failed");
  assert.match(settled.at(-1)?.error ?? "", /may have taken effect/);
});

test("a broker that throws settles the audit row instead of leaving it 'executed'", async () => {
  const tool = resolved(junoToolSpec("run_code")!, async () => ({ status: "succeeded", text: "ran", body: "ran" }));
  const { ctx, completed, settled } = harness(tool, (async () => {
    throw new Error("database unavailable");
  }) as unknown as NonNullable<BatchContext["ports"]>["authorizeExternalAction"]);

  await drain(ctx, call, new AbortController().signal).catch(() => undefined);

  assert.equal(completed.length, 0, "nothing ran, so no receipt is completed");
  assert.deepEqual(
    settled.map((row) => [row.id, row.status]),
    [["audit_1", "failed"]],
    "the row written before authorisation is settled as failed, not left as executed",
  );
  assert.doesNotMatch(settled[0].error ?? "", /database unavailable/, "the store's own error stays out of the audit text");
});
