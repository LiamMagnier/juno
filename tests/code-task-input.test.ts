import assert from "node:assert/strict";
import test from "node:test";
import { codeTaskInputSchema, codeTaskInputControl } from "../src/lib/code-task-input";

test("question answers carry information, never an approval", () => {
  const answer = codeTaskInputSchema.parse({ type: "question.answer", requestId: "q1", answer: "  Europe  " });
  assert.deepEqual(codeTaskInputControl(answer), { kind: "question_answer", payload: { requestId: "q1", answer: "Europe" } });
  assert.equal(codeTaskInputSchema.safeParse({ type: "question.answer", requestId: "q1", answer: " " }).success, false);
});

test("plan decisions do not transmit permission escalation", () => {
  const input = codeTaskInputSchema.parse({ type: "plan.decide", requestId: "p1", decision: "approve", mode: "full_access" });
  assert.deepEqual(codeTaskInputControl(input), { kind: "plan_response", payload: { requestId: "p1", approve: true } });
  assert.equal(codeTaskInputSchema.safeParse({ type: "plan.decide", requestId: "p1", decision: "allow_always" }).success, false);
});

test("older approval clients keep their existing wire", () => {
  assert.deepEqual(codeTaskInputControl(codeTaskInputSchema.parse({ requestId: "a1", approve: false })), { kind: "approval_response", payload: { requestId: "a1", approve: false } });
});
