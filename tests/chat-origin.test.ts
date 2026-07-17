import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_ORIGINS,
  chatOriginSchema,
  classifyFirstSubmissionClaim,
  clientIdempotencyKeySchema,
  clientSubmissionMetadataIssue,
  coerceChatOrigin,
  legacyChatClientForOrigin,
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

test("stored origins are narrowed before reaching client contracts", () => {
  assert.equal(coerceChatOrigin("quick_windows"), "quick_windows");
  assert.equal(coerceChatOrigin("app"), null);
  assert.equal(coerceChatOrigin(null), null);
});

test("canonical native origins inherit the legacy app spend dimension", () => {
  assert.equal(legacyChatClientForOrigin({ origin: "quick_macos" }), "app");
  assert.equal(legacyChatClientForOrigin({ origin: "main_windows" }), "app");
  assert.equal(legacyChatClientForOrigin({ origin: "web" }), "web");
  assert.equal(legacyChatClientForOrigin({}), "web");
  // Explicit legacy callers retain their historical accounting choice.
  assert.equal(legacyChatClientForOrigin({ origin: "quick_macos", client: "web" }), "web");
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
  assert.equal(clientSubmissionMetadataIssue({ ...pair, clarificationReply: true })?.path, "clientRequestId");
  assert.equal(clientSubmissionMetadataIssue({ origin: "quick_macos" })?.path, "clientRequestId");
  assert.equal(clientSubmissionMetadataIssue({ origin: "quick_windows", privateMode: true }), null);
  assert.equal(clientSubmissionMetadataIssue({ origin: "quick_windows", conversationId: "existing" }), null);
});

test("idempotency keys are bounded and log-safe", () => {
  assert.equal(clientIdempotencyKeySchema.safeParse("request:12345678").success, true);
  assert.equal(clientIdempotencyKeySchema.safeParse("too-short").success, true);
  assert.equal(clientIdempotencyKeySchema.safeParse("short").success, false);
  assert.equal(clientIdempotencyKeySchema.safeParse("request id with spaces").success, false);
  assert.equal(clientIdempotencyKeySchema.safeParse("request\nheader").success, false);
});

test("a request key can claim only one first message key", () => {
  assert.deepEqual(classifyFirstSubmissionClaim(null, "message:one"), { kind: "new" });
  assert.deepEqual(
    classifyFirstSubmissionClaim({ id: "stored-message", clientId: "message:one" }, "message:one"),
    { kind: "replay", messageId: "stored-message" }
  );
  assert.deepEqual(
    classifyFirstSubmissionClaim({ id: "stored-message", clientId: "message:one" }, "message:two"),
    { kind: "conflict" }
  );
  assert.deepEqual(
    classifyFirstSubmissionClaim({ id: "legacy-message", clientId: null }, "message:one"),
    { kind: "conflict" }
  );
});
