import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyErrorFinishReason,
  effectiveReasoningEffort,
  generationFailureCode,
  isAbortLike,
  plural,
  sourceHost,
} from "@/lib/chat-responses";
import type { ModelInfo } from "@/lib/models";

/*
 * These classifiers decide what gets PERSISTED as a turn's finish reason and
 * failure code — values native clients read back and tests/chat-first-submission
 * asserts on. They lived inside the 2,600-line chat route, where nothing could
 * reach them.
 */

test("a client abort is not reported as a failure", () => {
  // Pressing Stop must not look like the model broke.
  assert.equal(isAbortLike(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isAbortLike(Object.assign(new Error("x"), { code: "ABORT_ERR" })), true);
  assert.equal(isAbortLike(new Error("The operation was aborted")), true);
  assert.equal(isAbortLike(new Error("Request was cancelled")), true);
  assert.equal(isAbortLike(new Error("boom")), false);
  assert.equal(classifyErrorFinishReason(Object.assign(new Error(""), { name: "AbortError" })), "user_stopped");
});

test("transport faults are network_error, not a generic failure", () => {
  for (const message of [
    "socket hang up",
    "ECONNRESET",
    "ETIMEDOUT",
    "fetch failed",
    "terminated",
    "network error",
  ]) {
    assert.equal(
      classifyErrorFinishReason(new Error(message)),
      "network_error",
      `${message} should classify as network_error`
    );
  }
});

test("a context overflow is distinguishable, because the UI offers a different remedy", () => {
  for (const message of [
    "This model's maximum context length is 200000 tokens",
    "context_length_exceeded",
    "prompt exceeds the context window",
  ]) {
    assert.equal(classifyErrorFinishReason(new Error(message)), "model_context_window_exceeded", message);
  }
});

test("a safety refusal is its own reason", () => {
  assert.equal(classifyErrorFinishReason(new Error("blocked by content filter")), "sensitive");
  assert.equal(classifyErrorFinishReason(new Error("flagged as sensitive")), "sensitive");
});

test("anything unrecognised falls back to a plain error", () => {
  assert.equal(classifyErrorFinishReason(new Error("something odd")), "error");
  assert.equal(classifyErrorFinishReason(null), "error");
  assert.equal(classifyErrorFinishReason(undefined), "error");
  assert.equal(classifyErrorFinishReason({}), "error");
});

test("abort beats every other pattern", () => {
  // An abort whose message also mentions a network fault is still a user stop —
  // classifying it as network_error would trigger drop-recovery on a
  // deliberate Stop.
  const err = Object.assign(new Error("socket hang up"), { name: "AbortError" });
  assert.equal(classifyErrorFinishReason(err), "user_stopped");
});

test("each finish reason maps to a stable persisted failure code", () => {
  // These strings are stored and read by native clients; changing one is a
  // wire-format change, not a rename.
  assert.equal(generationFailureCode("user_stopped"), "GENERATION_STOPPED_BEFORE_OUTPUT");
  assert.equal(generationFailureCode("network_error"), "GENERATION_NETWORK_ERROR");
  assert.equal(generationFailureCode("model_context_window_exceeded"), "GENERATION_CONTEXT_LIMIT");
  assert.equal(generationFailureCode("sensitive"), "GENERATION_SENSITIVE_CONTENT");
  assert.equal(generationFailureCode("error"), "GENERATION_FAILED");
  assert.equal(generationFailureCode("stop"), "GENERATION_FAILED");
});

test("reasoning effort is clamped to what the model supports", () => {
  const noReasoning = { id: "x", provider: "openai", reasoning: false } as ModelInfo;
  assert.equal(effectiveReasoningEffort(noReasoning, "high"), undefined);
});

test("plural agrees with its count", () => {
  assert.equal(plural(1, "source"), "1 source");
  assert.equal(plural(2, "source"), "2 sources");
  assert.equal(plural(0, "source"), "0 sources");
  assert.equal(plural(1, "entry", "entries"), "1 entry");
  assert.equal(plural(3, "entry", "entries"), "3 entries");
});

test("sourceHost strips www and survives a malformed URL", () => {
  assert.equal(sourceHost("https://www.example.com/a/b?c=1"), "example.com");
  assert.equal(sourceHost("https://sub.example.com/"), "sub.example.com");
  // Citation chips render whatever this returns, so it must never throw.
  assert.equal(sourceHost("not a url"), "not a url");
  assert.equal(sourceHost(""), "");
});
