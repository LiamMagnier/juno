import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFirstSubmissionRecovery,
  classifyReceiptlessFirstSubmission,
  FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS,
  FIRST_SUBMISSION_RECEIPT_LEASE_MS,
  firstSubmissionLeaseExpiresAt,
  firstSubmissionLeaseHeartbeatOwnsReceipt,
  firstSubmissionReceiptExpiryBoundary,
  firstSubmissionReceiptStatusPayload,
  hashFirstSubmission,
  type FirstSubmissionHashInput,
  type FirstSubmissionReceiptSnapshot,
} from "../src/lib/chat-first-submission";

const base: FirstSubmissionHashInput = {
  origin: "quick_macos",
  projectId: "project_123",
  message: "Plan a launch",
  preflightClarification: {
    originalUserMessage: "Plan a launch",
    answers: [
      { questionId: "audience", question: "Audience?", source: "option", value: "Developers" },
    ],
  },
  attachmentIds: ["attachment_b", "attachment_a"],
  model: "model-a",
  voiceMode: false,
  canvasEnabled: true,
  webSearch: true,
  deepResearch: false,
  reasoningEffort: "high",
  connectors: ["github", "figma"],
  client: "app",
};

test("first-submission hash is canonical for set-like fields and object key order", () => {
  const reordered: FirstSubmissionHashInput = {
    ...base,
    attachmentIds: ["attachment_a", "attachment_b", "attachment_a"],
    connectors: ["figma", "github", "figma"],
    preflightClarification: {
      answers: [
        { value: "Developers", source: "option", question: "Audience?", questionId: "audience" },
      ],
      originalUserMessage: "Plan a launch",
    },
  };
  assert.equal(hashFirstSubmission(reordered), hashFirstSubmission(base));
});

test("every generation-affecting first-turn field is bound by the request hash", () => {
  const expected = hashFirstSubmission(base);
  const variants: FirstSubmissionHashInput[] = [
    { ...base, origin: "quick_windows" },
    { ...base, projectId: "project_456" },
    { ...base, message: "Plan another launch" },
    {
      ...base,
      preflightClarification: {
        ...base.preflightClarification!,
        answers: [{ questionId: "audience", source: "else", value: "Designers" }],
      },
    },
    { ...base, attachmentIds: ["attachment_a"] },
    { ...base, model: "model-b" },
    { ...base, voiceMode: true },
    { ...base, canvasEnabled: false },
    { ...base, webSearch: false },
    { ...base, deepResearch: true },
    { ...base, reasoningEffort: "low" },
    { ...base, connectors: ["github"] },
    { ...base, client: "web" },
  ];
  for (const variant of variants) assert.notEqual(hashFirstSubmission(variant), expected);
});

test("caller process generation ids are not part of the canonical receipt hash", () => {
  const withCallerIds = {
    ...base,
    clientRequestId: "request:12345678",
    clientMessageId: "message:12345678",
    generationId: "caller-generation-a",
  } as FirstSubmissionHashInput & {
    clientRequestId: string;
    clientMessageId: string;
    generationId: string;
  };
  const retry = { ...withCallerIds, generationId: "caller-generation-b" };
  assert.equal(hashFirstSubmission(withCallerIds), hashFirstSubmission(retry));
});

const receipt: FirstSubmissionReceiptSnapshot = {
  clientMessageId: "message:12345678",
  requestHash: "hash-a",
  state: "running",
  generationId: "server-generation",
  conversationId: "conversation",
  userMessageId: "user-message",
  finishReason: null,
  failureCode: null,
};

test("receipt recovery returns canonical ids and honest committed state", () => {
  assert.deepEqual(
    classifyFirstSubmissionRecovery(receipt, receipt.clientMessageId, receipt.requestHash),
    {
      kind: "submitted",
      conversationId: "conversation",
      userMessageId: "user-message",
      generationId: "server-generation",
      state: "running",
      finishReason: null,
      failureCode: null,
    }
  );
  assert.deepEqual(
    classifyFirstSubmissionRecovery(
      { ...receipt, state: "failed", finishReason: "network_error", failureCode: "GENERATION_NETWORK_ERROR" },
      receipt.clientMessageId,
      receipt.requestHash
    ),
    {
      kind: "submitted",
      conversationId: "conversation",
      userMessageId: "user-message",
      generationId: "server-generation",
      state: "failed",
      finishReason: "network_error",
      failureCode: "GENERATION_NETWORK_ERROR",
    }
  );
});

test("claimed receipts are retryable in-progress, while either key/body mismatch conflicts", () => {
  assert.deepEqual(
    classifyFirstSubmissionRecovery({ ...receipt, state: "claimed" }, receipt.clientMessageId, receipt.requestHash),
    { kind: "in_progress", generationId: "server-generation", state: "claimed" }
  );
  assert.deepEqual(
    classifyFirstSubmissionRecovery(receipt, "message:different", receipt.requestHash),
    { kind: "conflict", conversationId: "conversation" }
  );
  assert.deepEqual(
    classifyFirstSubmissionRecovery(receipt, receipt.clientMessageId, "hash-different"),
    { kind: "conflict", conversationId: "conversation" }
  );
});

test("receiptless compatibility rows fail closed once any first message exists", () => {
  assert.equal(classifyReceiptlessFirstSubmission(null), "empty");
  assert.equal(classifyReceiptlessFirstSubmission({ id: "legacy-first-message" }), "ambiguous");
});

test("native status payload is least-privilege and the running lease is exactly five minutes", () => {
  assert.deepEqual(firstSubmissionReceiptStatusPayload(receipt), {
    conversationId: "conversation",
    userMessageId: "user-message",
    generationId: "server-generation",
    receiptState: "running",
    finishReason: null,
    failureCode: null,
  });
  assert.equal(FIRST_SUBMISSION_RECEIPT_LEASE_MS, 5 * 60_000);
  assert.equal(FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS, 60_000);
  assert.equal(firstSubmissionLeaseExpiresAt(1_000).getTime(), 301_000);
  const expiry = firstSubmissionReceiptExpiryBoundary(new Date(301_000));
  assert.deepEqual(expiry.states, ["claimed", "accepted", "running"]);
  assert.equal(expiry.leaseExpiresAtLte.getTime(), 301_000);
  assert.equal(expiry.nullLeaseUpdatedAtLte.getTime(), 1_000);
});

test("lease fencing aborts persistence when the running receipt update no longer owns one row", () => {
  assert.equal(firstSubmissionLeaseHeartbeatOwnsReceipt(1), true);
  assert.equal(firstSubmissionLeaseHeartbeatOwnsReceipt(0), false);
  assert.equal(firstSubmissionLeaseHeartbeatOwnsReceipt(2), false);
});
