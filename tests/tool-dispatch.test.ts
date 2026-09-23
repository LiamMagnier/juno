import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { FINAL_ROUND_NOTE } from "@/lib/llm/loop";
import { executeToolBatch, type BatchContext, type BatchResult, type ToolCallInput } from "@/lib/tools/dispatch";
import { ToolFeeAccumulator } from "@/lib/tools/metering";
import type { ChatToolset, ResolvedTool } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";
import type { ToolPresentArgs } from "@/types/run";

/*
 * The dispatcher (SPEC §4.2).
 *
 * WS0 landed `executeToolBatch` with its final signature and a minimal body —
 * sequential, `queued` → `running` → result per call, errors as results, no
 * approvals, timeouts or dedupe — so the adapters could be tested against real
 * event shapes before the real one exists. These are that body's checks. WS1
 * owns this file and replaces them with the §13.1 matrix together with the
 * dispatcher.
 */

test("the dispatcher keeps server-only out of its static graph", () => {
  // Its broker, audit and completion functions arrive through `BatchContext.ports` (§13 harness rule 2).
  const source = readFileSync(path.join(process.cwd(), "src/lib/tools/dispatch.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

function fakeToolset(execute: ChatToolset["execute"]): ChatToolset {
  const resolved: ResolvedTool = {
    name: "current_time",
    canonical: "current_time",
    origin: "juno",
    title: "Current time",
    risk: "read",
    parallelSafe: true,
    timeoutMs: 1_000,
    dedupe: false,
    present: (args): ToolPresentArgs => (typeof args.time_zone === "string" ? { time_zone: args.time_zone } : {}),
  };
  return {
    tools: [],
    labelFor: () => "Juno",
    accessFor: () => "read",
    execute,
    close: async () => {},
    resolve: (name) => (name === resolved.name ? resolved : undefined),
    connectors: [],
  };
}

function batchContext(toolset: ChatToolset, nextIsFinal: boolean): BatchContext {
  return {
    toolset,
    toolContext: {} as BatchContext["toolContext"],
    cache: new Map(),
    fees: new ToolFeeAccumulator(),
    nextIsFinal,
    seenCallIds: new Set(),
    ports: {
      authorizeExternalAction: null,
      completeExternalAction: null,
      recordToolInvocation: null,
      settleToolInvocation: null,
      resolvedPolicy: null,
    },
  };
}

async function drain(gen: AsyncGenerator<LlmEvent, BatchResult[]>): Promise<{ events: LlmEvent[]; results: BatchResult[] }> {
  const events: LlmEvent[] = [];
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, results: next.value };
    events.push(next.value);
  }
}

test("executeToolBatch queues every call, runs them in order and reports failures as results", async () => {
  const ran: string[] = [];
  const toolset = fakeToolset(async (name, args, _signal, callId) => {
    ran.push(`${name}:${callId}`);
    return { text: `Now in ${String(args.time_zone ?? "UTC")}`, body: "Now", ok: true, figure: { kind: "value", value: "2026-09-23" } };
  });
  const calls: ToolCallInput[] = [
    { name: "current_time", callId: "c1", providerCallId: "toolu_1", round: 0, index: 0, argsText: "{\"time_zone\":\"Asia/Tokyo\"}" },
    { name: "current_time", callId: "c2", round: 0, index: 1, argsText: "{\"time_zone\":" },
    { name: "teleport", callId: "c3", round: 0, index: 2, argsText: "{}" },
  ];
  const { events, results } = await drain(executeToolBatch(calls, new AbortController().signal, batchContext(toolset, true)));

  const statuses = events.flatMap((ev) =>
    ev.type === "tool" && ev.phase === "status" ? [`${ev.callId}:${ev.status}`] : ev.type === "tool" && ev.phase === "result" ? [`${ev.callId}:${ev.status}`] : [],
  );
  assert.deepEqual(statuses, ["c1:queued", "c2:queued", "c3:queued", "c1:running", "c1:succeeded", "c2:failed", "c3:failed"]);
  const firstQueued = events[0];
  assert.ok(firstQueued.type === "tool" && firstQueued.phase === "status");
  assert.deepEqual(firstQueued.present, { time_zone: "Asia/Tokyo" });
  assert.deepEqual(ran, ["current_time:c1"], "neither the invalid call nor the unknown tool is dispatched");

  assert.deepEqual(results.map((r) => [r.callId, r.isError, r.errorCode ?? null]), [
    ["c1", false, null],
    ["c2", true, "invalid_args"],
    ["c3", true, "unknown_tool"],
  ]);
  assert.equal(results[0].providerCallId, "toolu_1");
  assert.match(results[1].text, /^The arguments were not valid JSON \(/);
  assert.match(results[2].text, /There is no tool named "teleport"/);
  assert.ok(results[2].text.endsWith(`\n\n${FINAL_ROUND_NOTE}`), "the final-round note goes on the last result");
  assert.ok(!results[0].text.includes(FINAL_ROUND_NOTE));
});

test("a thrown executor is a tool_error result, and an aborted turn throws after cancelling", async () => {
  const failing = fakeToolset(async () => {
    throw new Error("socket hang up");
  });
  const one: ToolCallInput[] = [{ name: "current_time", callId: "c1", round: 1, index: 0, argsText: "{}" }];
  const { results } = await drain(executeToolBatch(one, new AbortController().signal, batchContext(failing, false)));
  assert.deepEqual([results[0].isError, results[0].errorCode], [true, "tool_error"]);
  assert.match(results[0].text, /socket hang up/);

  const controller = new AbortController();
  controller.abort();
  const events: LlmEvent[] = [];
  const gen = executeToolBatch(one, controller.signal, batchContext(failing, false));
  await assert.rejects(async () => {
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
    }
  });
  const last = events.at(-1);
  assert.ok(last?.type === "tool" && last.phase === "result" && last.status === "cancelled");
});
