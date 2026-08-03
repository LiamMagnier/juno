import test from "node:test";
import assert from "node:assert/strict";
import {
  LONG_PASTE_ATTACH_THRESHOLD_CHARS,
  MAX_ASSEMBLED_CONTEXT_CHARS,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_PRIVATE_HISTORY_CHARS,
  MAX_PRIVATE_HISTORY_ENTRIES,
  MAX_REQUEST_BODY_BYTES,
  checkAssembledContext,
  checkBodyBytes,
  checkMessageSize,
  checkPrivateHistory,
  limitErrorBody,
} from "@/lib/request-limits";

/*
 * The chat body accepted an unbounded `message` string, with a comment saying
 * so. Model context is not the limit that bites first: a multi-megabyte paste
 * is decrypted, moderated, tokenised and written to Postgres long before any
 * provider rejects it, and what the user finally sees is a 500.
 */

test("an oversized body is refused before it is parsed", () => {
  assert.equal(checkBodyBytes(1024), null);
  const violation = checkBodyBytes(MAX_REQUEST_BODY_BYTES + 1);
  assert.equal(violation?.code, "body_too_large");
  assert.equal(violation?.status, 413);
});

test("a body exactly at the limit is accepted", () => {
  assert.equal(checkBodyBytes(MAX_REQUEST_BODY_BYTES), null);
});

test("an ordinary message passes untouched", () => {
  assert.equal(checkMessageSize("what is the capital of France?"), null);
});

test("a long paste is told to become a file, which is recoverable, before it is refused", () => {
  const paste = "x".repeat(LONG_PASTE_ATTACH_THRESHOLD_CHARS + 1);
  const violation = checkMessageSize(paste);
  assert.equal(violation?.code, "message_should_be_attached");
  assert.equal(violation?.status, 422, "422 — resend it differently, not 413 'go away'");
  assert.match(violation!.message, /Attach it as a file/);
});

test("past the hard cap it is a flat refusal", () => {
  const violation = checkMessageSize("x".repeat(MAX_MESSAGE_CHARS + 1));
  assert.equal(violation?.code, "message_too_long");
  assert.equal(violation?.status, 413);
});

test("multibyte text is measured in bytes as well as characters", () => {
  // The case a character-only cap lets through at three times the size: well
  // under the character limit, well over the byte limit.
  const japanese = "あ".repeat(Math.ceil(MAX_MESSAGE_BYTES / 3) + 10);
  assert.ok(
    japanese.length < MAX_MESSAGE_CHARS,
    "must be under the character cap or it is not testing the byte cap"
  );
  assert.ok(Buffer.byteLength(japanese, "utf8") > MAX_MESSAGE_BYTES);

  const violation = checkMessageSize(japanese);
  assert.equal(violation?.code, "message_too_long");
  assert.match(violation!.message, /bytes/);
});

test("the byte cap is low enough to be reachable", () => {
  // A UTF-16 unit costs at most 3 UTF-8 bytes, so a byte cap at or above
  // 3 × the character cap can never fire and is decoration.
  assert.ok(
    MAX_MESSAGE_BYTES < MAX_MESSAGE_CHARS * 3,
    "the byte limit is unreachable and therefore meaningless"
  );
});

test("a CJK message the byte cap allows is not rejected for its length", () => {
  const japanese = "あ".repeat(1_000);
  assert.equal(checkMessageSize(japanese), null);
});

test("an attachment-only message is not treated as an empty violation", () => {
  // Sending no text with an attachment is normal; the limit must not fire.
  assert.equal(checkMessageSize(""), null);
});

test("private history is bounded by entry count and by total size", () => {
  const many = Array.from({ length: MAX_PRIVATE_HISTORY_ENTRIES + 1 }, () => ({ content: "hi" }));
  assert.equal(checkPrivateHistory(many)?.code, "history_too_large");

  const heavy = [{ content: "x".repeat(MAX_PRIVATE_HISTORY_CHARS + 1) }];
  const violation = checkPrivateHistory(heavy);
  assert.equal(violation?.code, "history_too_large");
  assert.equal(violation?.status, 413);

  assert.equal(checkPrivateHistory([{ content: "short" }]), null);
});

test("the assembled context has its own ceiling", () => {
  assert.equal(checkAssembledContext(1_000), null);
  const violation = checkAssembledContext(MAX_ASSEMBLED_CONTEXT_CHARS + 1);
  assert.equal(violation?.code, "context_too_large");
  assert.equal(violation?.status, 413);
});

test("the error body is machine-readable and carries no content", () => {
  const secret = "my private paste ".repeat(20_000);
  const violation = checkMessageSize(secret)!;
  const body = limitErrorBody(violation);

  assert.equal(typeof body.code, "string");
  assert.equal(typeof body.limit, "number");
  assert.equal(typeof body.actual, "number");
  // A client can decide what to do from `code` alone, without parsing English.
  assert.ok(["message_too_long", "message_should_be_attached"].includes(body.code));
  assert.ok(!JSON.stringify(body).includes("my private paste"));
});

test("the attach threshold sits below the hard cap, so the band exists", () => {
  assert.ok(
    LONG_PASTE_ATTACH_THRESHOLD_CHARS < MAX_MESSAGE_CHARS,
    "without this there is no size at which the answer is 'attach it' rather than 'no'"
  );
});

test("a rejected request rejects identically when retried", () => {
  // Idempotency after a refusal: the limits are pure, so a retry of the same
  // oversized body cannot be recovered into a stored receipt on the second try.
  const paste = "x".repeat(MAX_MESSAGE_CHARS + 5);
  const first = checkMessageSize(paste);
  const second = checkMessageSize(paste);
  assert.deepEqual(first, second);
});
