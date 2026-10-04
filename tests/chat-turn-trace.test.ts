import test from "node:test";
import assert from "node:assert/strict";
import { createTurnTrace, traceUsage, type TurnTrace, type TurnTraceStart } from "@/lib/chat/turn/trace";

/*
 * The per-turn trace (src/lib/chat/turn/trace.ts, BRIEF §47).
 *
 * Its redaction is structural: the record has no field that can carry
 * message text, reasoning, tool arguments or results, URLs or a provider's raw
 * error text. These tests pin the shape so a field added later is a reviewed
 * change, and prove that content offered to the recorder never reaches it.
 */

const SECRET = "the user's private words 4242";

function start(overrides: Partial<TurnTraceStart> = {}): TurnTraceStart {
  return {
    runId: "gen-1",
    requestId: "req-1",
    accountId: "user-1",
    conversationId: "conv-1",
    surface: "saved",
    client: "web",
    agentId: null,
    model: { id: "claude-x", provider: "anthropic" },
    requestedModel: "juno:auto",
    rerouted: false,
    reasoningEffort: "medium",
    features: {
      webSearch: false,
      research: false,
      connectors: 1,
      actingTools: 0,
      skill: false,
      artifactEdit: false,
      regenerate: false,
    },
    ...overrides,
  };
}

function clock(...ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

test("a completed turn: latency, first token, tool calls by name only, usage, one emission", () => {
  const emitted: TurnTrace[] = [];
  const trace = createTurnTrace(start(), (t) => emitted.push(t), clock(1_000, 1_250, 3_000));
  trace.observe({ kind: "tool_call", server: "Build server", name: "search_issues", callId: "c1", args: `{"q":"${SECRET}"}` });
  trace.observe({ kind: "text", text: SECRET, startedWriting: true }); // first token at 1250
  trace.observe({ kind: "text", text: SECRET, startedWriting: false });
  trace.observe({
    kind: "tool_result",
    server: "Build server",
    name: "search_issues",
    callId: "c1",
    args: `{"q":"${SECRET}"}`,
    result: SECRET,
    ok: true,
    durationMs: 412.6,
    status: "succeeded" as never,
  });
  trace.noteApproval();
  const out = trace.finish({
    finishReason: "stop",
    outcome: "completed",
    usage: traceUsage({ totalInput: 120, output: 30, cost: 0.0021 }, { tokens: { cacheReadTokens: 80 } }),
  });
  assert.ok(out);
  assert.equal(emitted.length, 1);
  assert.equal(out.latency.totalMs, 2_000);
  assert.equal(out.latency.ttftMs, 250);
  assert.deepEqual(out.toolCalls, [
    { name: "search_issues", ok: true, durationMs: 413, status: "succeeded", errorCode: null, cached: false },
  ]);
  assert.equal(out.approvals, 1);
  assert.deepEqual(out.usage, { promptTokens: 120, completionTokens: 30, cacheReadTokens: 80, costUsd: 0.0021 });
  assert.equal(out.requestedModel, "juno:auto", "routing is visible when the model used differs");
  assert.equal(out.attempts, 1, "the chat route never replays a provider call");

  // Finishing twice emits once: every terminal branch may call finish.
  assert.equal(trace.finish({ finishReason: "error", outcome: "failed" }), null);
  assert.equal(emitted.length, 1);
  assert.equal(trace.finished, true);
});

test("nothing the turn said, read or sent reaches the trace", () => {
  const emitted: TurnTrace[] = [];
  const trace = createTurnTrace(start(), (t) => emitted.push(t));
  trace.observe({ kind: "reasoning", text: SECRET, round: 0 });
  trace.observe({ kind: "tool_call", server: SECRET, name: "fetch", callId: "c", args: SECRET });
  trace.observe({ kind: "tool_result", server: SECRET, name: "fetch", callId: "c", result: SECRET, ok: false, errorCode: "timeout" as never });
  trace.observe({ kind: "sources", added: [{ url: `https://example.com/${SECRET}`, title: SECRET }], all: [] } as never);
  trace.finish({
    finishReason: "error",
    outcome: "failed",
    failureCode: "GENERATION_FAILED",
    error: Object.assign(new Error(`upstream said: ${SECRET}`), { status: 500 }),
  });
  const line = JSON.stringify(emitted[0]);
  assert.doesNotMatch(line, /4242|private words|example\.com/);
  assert.equal(emitted[0].error?.class, "capacity");
  assert.equal(emitted[0].error?.status, 500);
});

test("the trace's fields are exactly these — a new field is a reviewed privacy change", () => {
  const out = createTurnTrace(start(), () => {}).finish({ finishReason: "stop", outcome: "completed" })!;
  assert.deepEqual(Object.keys(out).sort(), [
    "accountId",
    "agentId",
    "approvals",
    "attempts",
    "cancellation",
    "client",
    "conversationId",
    "error",
    "failureCode",
    "features",
    "finishReason",
    "latency",
    "model",
    "outcome",
    "provider",
    "reasoningEffort",
    "requestId",
    "requestedModel",
    "rerouted",
    "runId",
    "startedAt",
    "surface",
    "toolCalls",
    "usage",
  ]);
  assert.deepEqual(Object.keys(out.cancellation).sort(), ["budgetHalted", "leaseLost", "shutdown", "stalled", "userStopped"]);
});

test("a rate-limited provider is classified, retryable, and not echoed", () => {
  const out = createTurnTrace(start(), () => {}).finish({
    finishReason: "error",
    outcome: "failed",
    failureCode: "GENERATION_FAILED",
    error: Object.assign(new Error("429 Too Many Requests"), { status: 429 }),
  })!;
  assert.equal(out.error?.class, "rate_limit");
  assert.equal(out.error?.retryable, true);
  assert.equal(out.attempts, 1);
});

test("a stop and a stall are told apart in the cancellation record", () => {
  const stopped = createTurnTrace(start(), () => {}).finish({
    finishReason: "user_stopped",
    outcome: "stopped",
    cancellation: { userStopped: true },
  })!;
  assert.equal(stopped.cancellation.userStopped, true);
  assert.equal(stopped.error, null, "a stop is not an error");
  const stalled = createTurnTrace(start(), () => {}).finish({
    finishReason: "error",
    outcome: "failed",
    cancellation: { stalled: true },
  })!;
  assert.equal(stalled.cancellation.stalled, true);
  assert.equal(stalled.cancellation.userStopped, false);
});

test("a sink that throws never fails the turn", () => {
  const trace = createTurnTrace(start(), () => {
    throw new Error("log pipe closed");
  });
  assert.doesNotThrow(() => trace.finish({ finishReason: "stop", outcome: "completed" }));
});

test("tool names are kept plain and short", () => {
  const out = (() => {
    const trace = createTurnTrace(start(), () => {});
    trace.observe({ kind: "tool_call", server: "s", name: `weird name/${"x".repeat(200)}`, callId: "c" });
    return trace.finish({ finishReason: "stop", outcome: "completed" })!;
  })();
  assert.match(out.toolCalls[0].name, /^weird_name_x+$/);
  assert.ok(out.toolCalls[0].name.length <= 80);
});
