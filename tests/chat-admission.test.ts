import test from "node:test";
import assert from "node:assert/strict";
import { admitChatRequest, type AdmissibleBody } from "@/lib/chat-admission";
import { MAX_MESSAGE_CHARS, MAX_REQUEST_BODY_BYTES } from "@/lib/request-limits";

/*
 * Characterisation tests for the first stage lifted out of the 2,500-line chat
 * route. They pin the behaviour the route had *before* the extraction, so the
 * remaining stages can be split afterwards against a known-good baseline
 * rather than against a reading of the code.
 */

/** Stands in for the route's zod schema. */
const acceptAll = (value: unknown) =>
  value !== null && typeof value === "object"
    ? { success: true as const, data: value as AdmissibleBody }
    : { success: false as const };

const rejectAll = () => ({ success: false as const });

test("a well-formed body is admitted with its parsed input", () => {
  const verdict = admitChatRequest(JSON.stringify({ message: "hello" }), acceptAll);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.input.message, "hello");
});

test("an unreadable body is a 400, not a crash", () => {
  const verdict = admitChatRequest(null, acceptAll);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 400);
});

test("malformed JSON and schema-invalid JSON produce the same answer", () => {
  // Deliberate: telling a caller which of the two it was describes the parser,
  // not anything they can act on.
  const malformed = admitChatRequest("{not json", acceptAll);
  const invalid = admitChatRequest(JSON.stringify({ message: 1 }), rejectAll);

  assert.equal(malformed.ok, false);
  assert.equal(invalid.ok, false);
  assert.deepEqual(
    malformed.ok === false && malformed.body,
    invalid.ok === false && invalid.body,
  );
});

test("size is checked before the body is parsed", () => {
  // An oversized body must be refused as `body_too_large`, not as invalid
  // JSON — which is what would happen if it were parsed first and the parse
  // failed for some unrelated reason.
  const huge = "x".repeat(MAX_REQUEST_BODY_BYTES + 10);
  const verdict = admitChatRequest(huge, acceptAll);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 413);
  assert.equal(verdict.ok === false && verdict.body.code, "body_too_large");
});

test("an oversized message is refused with a machine-readable code", () => {
  const body = JSON.stringify({ message: "x".repeat(MAX_MESSAGE_CHARS + 1) });
  const verdict = admitChatRequest(body, acceptAll);

  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok === false && verdict.status, 413);
  assert.equal(verdict.ok === false && verdict.body.code, "message_too_long");
});

test("a long paste is told to attach, which is a 422 rather than a refusal", () => {
  const body = JSON.stringify({ message: "x".repeat(150_000) });
  const verdict = admitChatRequest(body, acceptAll);

  assert.equal(verdict.ok === false && verdict.status, 422);
  assert.equal(verdict.ok === false && verdict.body.code, "message_should_be_attached");
});

test("oversized private history is refused", () => {
  const body = JSON.stringify({
    privateHistory: Array.from({ length: 500 }, () => ({ content: "hi" })),
  });
  const verdict = admitChatRequest(body, acceptAll);
  assert.equal(verdict.ok === false && verdict.body.code, "history_too_large");
});

test("an attachment-only request with no message is admitted", () => {
  const verdict = admitChatRequest(JSON.stringify({ attachmentIds: ["a"] }), acceptAll);
  assert.equal(verdict.ok, true);
});

test("admission is pure, so a retry of a rejected request is rejected identically", () => {
  // The property that lets admission run before idempotency recovery: a
  // request too large to serve must never be recovered into a stored receipt.
  const body = JSON.stringify({ message: "x".repeat(MAX_MESSAGE_CHARS + 1) });
  assert.deepEqual(admitChatRequest(body, acceptAll), admitChatRequest(body, acceptAll));
});

test("no rejection body carries any of the submitted content", () => {
  const secret = "the user's private paste ".repeat(20_000);
  const verdict = admitChatRequest(JSON.stringify({ message: secret }), acceptAll);
  assert.ok(!JSON.stringify(verdict).includes("private paste"));
});
