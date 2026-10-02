import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTION_TOOL_IDS,
  RUN_CODE_TOOL_ID,
  canonicalToolId,
  defineTool,
  portableSchemaProblem,
  type ToolSpec,
} from "@/lib/tools/types";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";

/*
 * The contract types land on the trunk before anything uses them (design §7:
 * L1 lands `src/lib/tools/types.ts` and the `LlmEvent` additions first, so the
 * execution and skill lanes build against one shape). These tests pin the few
 * pieces of it that are code, not declarations.
 */

const okSpec = (): ToolSpec => ({
  id: "multiply",
  title: "Multiply",
  description: "Multiplies two numbers.",
  input: {
    type: "object",
    properties: {
      a: { type: "number", description: "First factor." },
      b: { type: "number", description: "Second factor." },
    },
    required: ["a", "b"],
  },
  risk: "read",
  parallelSafe: true,
  timeoutMs: 1_000,
  broker: "none",
  dedupe: true,
  execute: async () => ({ status: "succeeded", text: "", body: "" }),
});

test("defineTool accepts a portable spec and refuses what a lab would reject", () => {
  assert.equal(defineTool(okSpec()).id, "multiply");
  assert.throws(() => defineTool({ ...okSpec(), id: "Multiply-Now" }), /not a valid tool name/);
  assert.throws(
    () =>
      defineTool({
        ...okSpec(),
        input: { type: "object", properties: { a: { type: "number", description: "x", default: 1 } as never } },
      }),
    /not portable/,
  );
  assert.throws(() => defineTool({ ...okSpec(), risk: "write", parallelSafe: true }), /only a read/);
  assert.throws(() => defineTool({ ...okSpec(), timeoutMs: 0 }), /timeoutMs/);
});

test("portableSchemaProblem names the first problem it finds", () => {
  assert.equal(portableSchemaProblem({ type: "object", properties: {} }), null);
  assert.match(
    portableSchemaProblem({ type: "object", properties: {}, required: ["x"] }) ?? "",
    /required names "x"/,
  );
  assert.match(
    portableSchemaProblem({ type: "object", properties: { n: { type: "number", description: "n", enum: ["1"] } } }) ?? "",
    /enum must be a list of strings on a string/,
  );
  assert.match(
    portableSchemaProblem({ type: "object", properties: { l: { type: "array", description: "l" } } }) ?? "",
    /items is not an object/,
  );
});

test("the old code tool id reads as run_code, and both are execution tools", () => {
  assert.equal(canonicalToolId("code_interpreter"), RUN_CODE_TOOL_ID);
  assert.equal(canonicalToolId("read_document"), "read_document");
  for (const id of ["run_code", "check_run", "use_skill", "read_skill_file", "code_interpreter"]) {
    assert.ok(EXECUTION_TOOL_IDS.includes(id), id);
  }
  assert.ok(!EXECUTION_TOOL_IDS.includes("read_document"));
});

test("the accumulator maps the new tool acts instead of mistaking them for results", () => {
  const acc = new GenerationAccumulator();
  assert.deepEqual(
    acc.apply({ type: "tool", phase: "status", server: "Alevr", name: "run_code", callId: "c1", status: "running", timeoutMs: 130_000 }),
    { kind: "tool_status", server: "Alevr", name: "run_code", callId: "c1", status: "running", timeoutMs: 130_000 },
  );
  const progress = { lines: [{ stream: "stdout" as const, text: "step 3" }], stdoutBytes: 42 };
  assert.deepEqual(acc.apply({ type: "tool", phase: "progress", server: "Alevr", name: "run_code", callId: "c1", progress }), {
    kind: "tool_progress",
    server: "Alevr",
    name: "run_code",
    callId: "c1",
    progress,
  });
  const result = acc.apply({
    type: "tool",
    phase: "result",
    server: "Alevr",
    name: "run_code",
    callId: "c1",
    result: "Stopped.",
    ok: false,
    status: "cancelled",
    error: { code: "cancelled" },
  });
  assert.equal(result.kind, "tool_result");
  if (result.kind === "tool_result") {
    assert.equal(result.status, "cancelled");
    assert.equal(result.errorCode, "cancelled");
    assert.equal(result.ok, false);
  }
});
