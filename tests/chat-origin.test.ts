import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ORIGINS,
  chatOriginSchema,
  clientIdempotencyKeySchema,
  clientSubmissionMetadataIssue,
} from "../src/lib/chat-origin";

test("chat origin accepts every canonical surface", () => {
  for (const origin of CHAT_ORIGINS) {
    assert.equal(chatOriginSchema.parse(origin), origin);
  }
});

test("chat origin rejects ambiguous and untrusted values", () => {
  for (const origin of ["app", "quick", "desktop", "QUICK_MACOS", "quick_macos\nweb"]) {
    assert.equal(chatOriginSchema.safeParse(origin).success, false);
  }
});

test("first-submission identifiers are paired and restricted to new saved chats", () => {
  const pair = { clientRequestId: "request:12345678", clientMessageId: "message:12345678" };
  assert.equal(clientSubmissionMetadataIssue(pair), null);
  assert.equal(clientSubmissionMetadataIssue({}), null);
  assert.equal(clientSubmissionMetadataIssue({ clientRequestId: pair.clientRequestId })?.path, "clientMessageId");
  assert.equal(clientSubmissionMetadataIssue({ clientMessageId: pair.clientMessageId })?.path, "clientRequestId");
  assert.equal(clientSubmissionMetadataIssue({ ...pair, conversationId: "existing" })?.path, "clientRequestId");
  assert.equal(clientSubmissionMetadataIssue({ ...pair, regenerate: true })?.path, "clientRequestId");
  assert.equal(clientSubmissionMetadataIssue({ ...pair, privateMode: true })?.path, "clientRequestId");
});

test("idempotency keys are bounded and log-safe", () => {
  assert.equal(clientIdempotencyKeySchema.safeParse("request:12345678").success, true);
  assert.equal(clientIdempotencyKeySchema.safeParse("too-short").success, true);
  assert.equal(clientIdempotencyKeySchema.safeParse("short").success, false);
  assert.equal(clientIdempotencyKeySchema.safeParse("request id with spaces").success, false);
  assert.equal(clientIdempotencyKeySchema.safeParse("request\nheader").success, false);
});
