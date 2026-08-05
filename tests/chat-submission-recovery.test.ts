import test from "node:test";
import assert from "node:assert/strict";
import {
  recoverFirstSubmission,
  type FirstSubmissionRecoveryPort,
} from "@/lib/chat/submission-recovery";
import type { FirstSubmissionReceiptSnapshot } from "@/lib/chat-first-submission";
import { chatBodySchema, isDurableFirstSubmission } from "@/lib/chat/request";

/*
 * Characterisation tests for idempotent submission recovery.
 *
 * The route ran these three lookups inline against Prisma, before rate
 * limiting, so their order — which is the actual contract — could only be
 * verified by reading them. Behind a port it can be verified by a test.
 */

const KEYS = { clientRequestId: "req_1", clientMessageId: "msg_1", requestHash: "hash_1" };

const receipt = (
  overrides: Partial<FirstSubmissionReceiptSnapshot> = {}
): FirstSubmissionReceiptSnapshot => ({
  clientMessageId: KEYS.clientMessageId,
  requestHash: KEYS.requestHash,
  state: "completed",
  generationId: "gen_1",
  conversationId: "conv_1",
  userMessageId: "umsg_1",
  finishReason: "stop",
  failureCode: null,
  ...overrides,
});

function port(overrides: Partial<FirstSubmissionRecoveryPort> = {}): FirstSubmissionRecoveryPort {
  return {
    receiptForRequest: async () => null,
    receiptForMessage: async () => null,
    legacyConversation: async () => null,
    firstMessage: async () => null,
    ...overrides,
  };
}

test("a fresh submission proceeds with nothing to adopt", async () => {
  const verdict = await recoverFirstSubmission(port(), KEYS);
  assert.deepEqual(verdict, { kind: "proceed", legacyOrphanConversationId: null });
});

test("a retry of the same submission replays its outcome instead of generating again", async () => {
  const verdict = await recoverFirstSubmission(
    port({ receiptForRequest: async () => receipt() }),
    KEYS
  );
  assert.equal(verdict.kind, "recovered");
  assert.equal(verdict.kind === "recovered" && verdict.recovery.kind, "submitted");
});

test("a retry that is still being accepted is reported as in progress, and is retryable", async () => {
  const verdict = await recoverFirstSubmission(
    port({ receiptForRequest: async () => receipt({ state: "claimed" }) }),
    KEYS
  );
  assert.equal(verdict.kind === "recovered" && verdict.recovery.kind, "in_progress");
});

test("the same request key with a different body is a conflict, not a recovery", async () => {
  // The client changed the message under a key it already used. Answering
  // "already submitted" would tell them their new message was sent when it
  // was not.
  const verdict = await recoverFirstSubmission(
    port({ receiptForRequest: async () => receipt({ requestHash: "different" }) }),
    KEYS
  );
  assert.equal(verdict.kind === "recovered" && verdict.recovery.kind, "conflict");
});

test("a message key already bound to another submission is refused", async () => {
  const verdict = await recoverFirstSubmission(
    port({ receiptForMessage: async () => ({ conversationId: "conv_other" }) }),
    KEYS
  );
  assert.deepEqual(verdict, {
    kind: "conflict",
    conversationId: "conv_other",
    legacyReceiptMissing: false,
  });
});

test("the request-key lookup wins over the message-key lookup", async () => {
  // Order matters: a genuine retry presents BOTH keys, and reaching the
  // message-key branch first would turn every legitimate retry into a
  // conflict.
  const calls: string[] = [];
  const verdict = await recoverFirstSubmission(
    port({
      receiptForRequest: async () => {
        calls.push("request");
        return receipt();
      },
      receiptForMessage: async () => {
        calls.push("message");
        return { conversationId: "conv_other" };
      },
    }),
    KEYS
  );
  assert.equal(verdict.kind, "recovered");
  assert.deepEqual(calls, ["request"]);
});

test("a pre-receipt conversation with no first message is adopted, not duplicated", async () => {
  // The narrow rollout window where the Conversation was committed but its
  // first Message was not. The acceptance transaction finishes it.
  const verdict = await recoverFirstSubmission(
    port({
      legacyConversation: async () => ({ id: "conv_legacy" }),
      firstMessage: async () => null,
    }),
    KEYS
  );
  assert.deepEqual(verdict, { kind: "proceed", legacyOrphanConversationId: "conv_legacy" });
});

test("a pre-receipt conversation that already has a message is ambiguous, so it is refused", async () => {
  // Without a receipt the server cannot prove the retry body is identical, and
  // guessing wrong duplicates the user's message into their history.
  const verdict = await recoverFirstSubmission(
    port({
      legacyConversation: async () => ({ id: "conv_legacy" }),
      firstMessage: async () => ({ id: "m1" }),
    }),
    KEYS
  );
  assert.deepEqual(verdict, {
    kind: "conflict",
    conversationId: "conv_legacy",
    legacyReceiptMissing: true,
  });
});

// -------------------------------------------------------------- request schema

test("durability requires BOTH keys — one alone is a legacy client", () => {
  assert.equal(isDurableFirstSubmission({ clientRequestId: "a", clientMessageId: "b" }), true);
  assert.equal(isDurableFirstSubmission({ clientRequestId: "a" }), false);
  assert.equal(isDurableFirstSubmission({ clientMessageId: "b" }), false);
  assert.equal(isDurableFirstSubmission({}), false);
});

test("a canvas edit cannot be combined with regenerate, clarification or deep research", () => {
  const artifactEdit = {
    artifactId: "clh0000000000000000000000",
    identifier: "app.tsx",
    baseVersion: 1,
    kind: "text" as const,
    text: "selected",
  };
  assert.equal(chatBodySchema.safeParse({ message: "change this", artifactEdit }).success, true);
  assert.equal(chatBodySchema.safeParse({ artifactEdit }).success, false);
  assert.equal(
    chatBodySchema.safeParse({ message: "x", artifactEdit, regenerate: true }).success,
    false
  );
  assert.equal(
    chatBodySchema.safeParse({ message: "x", artifactEdit, deepResearch: true }).success,
    false
  );
});

test("every reasoning tier the model catalog advertises is accepted by the schema", () => {
  // This enum once listed low|medium|high|max while the picker offered
  // "minimal" and "xhigh" — 26 models whose top tier 400'd inside Juno before
  // any provider was called. Building it from REASONING_TIERS is what stops
  // that recurring.
  for (const tier of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(
      chatBodySchema.safeParse({ message: "x", reasoningEffort: tier }).success,
      true,
      `tier ${tier} was rejected`
    );
  }
  assert.equal(chatBodySchema.safeParse({ message: "x", reasoningEffort: "extreme" }).success, false);
});

test("the schema itself imposes no length cap — that is admission's job", () => {
  // Kept deliberately: one module owns the size rules so web and native refuse
  // the same paste at the same size.
  assert.equal(chatBodySchema.safeParse({ message: "x".repeat(500_000) }).success, true);
});
