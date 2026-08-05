import test from "node:test";
import assert from "node:assert/strict";
import {
  assistantWriteMode,
  reasoningPartsColumn,
  assistantTurnFields,
  versionSnapshot,
} from "@/lib/chat/assistant-turn";
import {
  codeSessionRefusal,
  emptySubmissionRefusal,
  privateAttachmentsRefusal,
  privateModeFeatureRefusal,
} from "@/lib/chat/entitlements";
import { postGenerationPlan } from "@/lib/chat/post-processing";

/*
 * Characterisation tests for the entitlement, persistence and post-processing
 * stages of the chat route.
 */

// ---------------------------------------------------------------- entitlements

test("private mode refuses attachments, because the store it would use is permanent", () => {
  const refusal = privateAttachmentsRefusal({ privateMode: true, attachmentIds: ["a"] });
  assert.equal(refusal?.status, 400);
  assert.equal(refusal?.body.code, "PRIVATE_ATTACHMENTS_UNSUPPORTED");
});

test("private mode with no attachments, and saved mode with them, both pass", () => {
  assert.equal(privateAttachmentsRefusal({ privateMode: true, attachmentIds: [] }), null);
  assert.equal(privateAttachmentsRefusal({ privateMode: false, attachmentIds: ["a"] }), null);
});

test("a turn has to carry something, but any of three things will do", () => {
  assert.equal(emptySubmissionRefusal({})?.status, 400);
  assert.equal(emptySubmissionRefusal({ message: "   " })?.status, 400);
  assert.equal(emptySubmissionRefusal({ message: "hi" }), null);
  assert.equal(emptySubmissionRefusal({ regenerate: true }), null);
  assert.equal(emptySubmissionRefusal({ clarification: { id: "x" } }), null);
  assert.equal(emptySubmissionRefusal({ attachmentIds: ["a"] }), null);
});

test("private mode refuses the two features that need stored state", () => {
  assert.match(
    String(privateModeFeatureRefusal({ artifactEdit: {} })?.body.error),
    /Canvas edits are not available/
  );
  assert.match(
    String(privateModeFeatureRefusal({ regenerate: true })?.body.error),
    /Regenerate is not available/
  );
  assert.equal(privateModeFeatureRefusal({}), null);
});

test("a Code session with a workspace is refused; one without is the chat pipeline's job", () => {
  // The two conditions read the same two columns and are exact inverses, so a
  // session can never be answerable by both.
  const withPath = codeSessionRefusal({ kind: "code", codeWorkspacePath: "/x", codeWorkspaceKey: null });
  const withKey = codeSessionRefusal({ kind: "code", codeWorkspacePath: null, codeWorkspaceKey: "ws_1" });
  const workspaceless = codeSessionRefusal({ kind: "code", codeWorkspacePath: null, codeWorkspaceKey: null });

  assert.equal(withPath?.status, 409);
  assert.equal(withKey?.status, 409);
  assert.equal(workspaceless, null);
  assert.equal(codeSessionRefusal({ kind: "chat", codeWorkspacePath: "/x" }), null);
  assert.equal(codeSessionRefusal(null), null);
});

test("the Code refusal names the endpoint that does work, not just the one that does not", () => {
  const refusal = codeSessionRefusal({ kind: "code", codeWorkspaceKey: "ws_1" });
  assert.match(String(refusal?.body.error), /\/api\/code\/tasks/);
});

// ----------------------------------------------------------------- persistence

const encrypt = (value: string) => `enc:${value}`;

test("a regenerate supersedes only while the row it replaces still exists", () => {
  assert.equal(assistantWriteMode("msg_1", true), "supersede");
  // Deleted from another tab mid-generation: append rather than fail. The user
  // asked for an answer; losing it because the thing it replaced is gone helps
  // nobody.
  assert.equal(assistantWriteMode("msg_1", false), "append");
  assert.equal(assistantWriteMode(null, true), "append");
});

test("reasoning parts are encrypted individually while the array shape stays plain", () => {
  // The count of steps is not the secret; their contents are.
  const column = reasoningPartsColumn(["one", "two"], encrypt, "append");
  assert.deepEqual(column, { action: "set", values: ["enc:one", "enc:two"] });
});

test("overwriting with no parts CLEARS the column; appending with none omits it", () => {
  // The distinction is the whole point. A regenerate can swap a part-emitting
  // model for one that sends none, and leaving the old array behind shows the
  // PREVIOUS answer's steps above the new answer's reasoning — a fabricated
  // chain of thought, assembled by an ORM default.
  assert.deepEqual(reasoningPartsColumn([], encrypt, "supersede"), { action: "clear" });
  assert.deepEqual(reasoningPartsColumn([], encrypt, "omit" as never), { action: "omit" });
  assert.deepEqual(reasoningPartsColumn([], encrypt, "append"), { action: "omit" });
});

test("the assistant's text is encrypted and its accounting is passed through", () => {
  const fields = assistantTurnFields(
    { content: "hello", model: "anthropic:x", promptTokens: 10, completionTokens: 3, costMicroUsd: 42 },
    encrypt
  );
  assert.equal(fields.content, "enc:hello");
  assert.equal(fields.model, "anthropic:x");
  assert.equal(fields.costMicroUsd, 42);
});

test("an unknown cost is null rather than absent", () => {
  const fields = assistantTurnFields(
    { content: "x", model: "m", promptTokens: null, completionTokens: null },
    encrypt
  );
  assert.equal(fields.costMicroUsd, null);
});

test("the version snapshot copies ciphertext verbatim", () => {
  // Decrypting to re-encrypt would put plaintext in memory for no reason and
  // couple the history rows to the current key.
  const snapshot = versionSnapshot({
    id: "m1",
    content: "enc:v1:abc",
    reasoning: "enc:v1:def",
    model: "anthropic:x",
    promptTokens: 5,
    completionTokens: 6,
    sources: [{ url: "https://a" }],
  });
  assert.equal(snapshot.content, "enc:v1:abc");
  assert.equal(snapshot.reasoning, "enc:v1:def");
  assert.equal(snapshot.messageId, "m1");
});

test("a snapshot of an answer that cited nothing omits sources entirely", () => {
  // Writing an explicit null and writing nothing are different states in the
  // column, and only one of them means "this answer cited nothing".
  const snapshot = versionSnapshot({
    id: "m1",
    content: "enc:x",
    reasoning: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    sources: null,
  });
  assert.equal("sources" in snapshot, false);
});

// ------------------------------------------------------------- post-processing

test("moderation runs whether or not the generation succeeded", () => {
  // Tying it to a successful answer would make erroring out a way to avoid the
  // policy screen.
  assert.equal(
    postGenerationPlan({ moderate: true, memoryEnabled: true, producedAnswer: false }).moderates,
    true
  );
});

test("memory work runs only when there is an answer", () => {
  // Extracting memories from a turn that produced nothing writes facts from a
  // conversation that, as far as the user is concerned, never happened.
  const failed = postGenerationPlan({ moderate: false, memoryEnabled: true, producedAnswer: false });
  assert.equal(failed.extractsMemory, false);
  assert.equal(failed.consolidates, false);

  const succeeded = postGenerationPlan({ moderate: false, memoryEnabled: true, producedAnswer: true });
  assert.equal(succeeded.extractsMemory, true);
  assert.equal(succeeded.consolidates, true);
});

test("memory disabled means no extraction and no consolidation, answer or not", () => {
  const plan = postGenerationPlan({ moderate: true, memoryEnabled: false, producedAnswer: true });
  assert.equal(plan.extractsMemory, false);
  assert.equal(plan.consolidates, false);
  assert.equal(plan.moderates, true);
});
