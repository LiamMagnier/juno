import test from "node:test";
import assert from "node:assert/strict";
import { finishReasonDetail, finishReasonTitle, normalizeFinishReason } from "@/lib/finish-reason";
import type { ChatFinishReason } from "@/types/chat";

/*
 * The published terminal enums of every provider Juno ships.
 *
 * An unmapped value does not fail loudly: it becomes "unknown", which the UI
 * renders as "Stream ended unexpectedly — the provider closed the stream
 * without a recognized finish reason". Gemini alone has ten of these, and an
 * answer Google BLOCKED was being explained to the user as a transport glitch.
 */

const GEMINI: Record<string, ChatFinishReason> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  SAFETY: "sensitive",
  RECITATION: "sensitive",
  BLOCKLIST: "sensitive",
  PROHIBITED_CONTENT: "sensitive",
  SPII: "sensitive",
  IMAGE_SAFETY: "sensitive",
  UNEXPECTED_TOOL_CALL: "tool_calls",
  TOO_MANY_TOOL_CALLS: "length",
  // Deliberately unknown: Juno will not restate these as stop/length/safety.
  MALFORMED_FUNCTION_CALL: "unknown",
  LANGUAGE: "unknown",
  OTHER: "unknown",
};

const ANTHROPIC: Record<string, ChatFinishReason> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  pause_turn: "tool_calls",
  refusal: "sensitive",
  model_context_window_exceeded: "model_context_window_exceeded",
};

const OPENAI: Record<string, ChatFinishReason> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_calls",
  function_call: "tool_calls",
  content_filter: "sensitive",
};

test("Gemini's terminal reasons are mapped, and only three stay unknown", () => {
  for (const [raw, expected] of Object.entries(GEMINI)) {
    assert.equal(normalizeFinishReason(raw), expected, `${raw}`);
  }
  const unknowns = Object.entries(GEMINI).filter(([, v]) => v === "unknown").map(([k]) => k);
  assert.deepEqual(unknowns.sort(), ["LANGUAGE", "MALFORMED_FUNCTION_CALL", "OTHER"]);
});

test("Anthropic's stop reasons are mapped, pause_turn included", () => {
  for (const [raw, expected] of Object.entries(ANTHROPIC)) {
    assert.equal(normalizeFinishReason(raw), expected, `${raw}`);
  }
});

test("OpenAI's finish reasons are mapped", () => {
  for (const [raw, expected] of Object.entries(OPENAI)) {
    assert.equal(normalizeFinishReason(raw), expected, `${raw}`);
  }
});

test("case and whitespace never decide the verdict", () => {
  assert.equal(normalizeFinishReason("  Prohibited_Content "), "sensitive");
  assert.equal(normalizeFinishReason("PAUSE_TURN"), "tool_calls");
  assert.equal(normalizeFinishReason(undefined), "unknown");
  assert.equal(normalizeFinishReason(""), "unknown");
});

test("a blocked answer is explained as a block, not as a lost stream", () => {
  assert.equal(finishReasonTitle(normalizeFinishReason("RECITATION")), "Response stopped by safety filter");
  assert.match(String(finishReasonDetail(normalizeFinishReason("RECITATION"))), /safety/i);
  assert.equal(finishReasonTitle(normalizeFinishReason("TOO_MANY_TOOL_CALLS")), "Response hit the token limit");
});
