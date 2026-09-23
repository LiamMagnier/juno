import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSessionCommand } from "../src/lib/code-session-command-compat";

test("mobile message commands reach the Workbench as send_message", () => {
  const result = canonicalSessionCommand("message", {
    prompt: "Fix the failing test",
    modelID: "openai:gpt-5.6-sol",
    reasoningEffort: "high",
    permissionMode: "askBeforeChanges",
    attachmentIDs: ["att_1"],
  });

  assert.equal(result.kind, "send_message");
  assert.deepEqual(result.payload, {
    text: "Fix the failing test",
    modelID: "openai:gpt-5.6-sol",
    reasoningEffort: "high",
    permissionMode: "askBeforeChanges",
    attachmentIDs: ["att_1"],
  });
});

test("an explicit canonical message payload is not overwritten by a legacy prompt", () => {
  const result = canonicalSessionCommand("send_message", {
    text: "canonical",
    prompt: "legacy",
    permissionMode: "readOnly",
  });

  assert.equal(result.kind, "send_message");
  assert.deepEqual(result.payload, {
    text: "canonical",
    permissionMode: "readOnly",
  });
});

test("Stop is normalized to the host's stop_agent verb", () => {
  const result = canonicalSessionCommand("stop", {});
  assert.deepEqual(result, { kind: "stop_agent", payload: {} });
});

test("approval aliases are normalized to the exact request the Mac expects", () => {
  const result = canonicalSessionCommand("approval", {
    requestId: "approval-42",
    approve: true,
  });

  assert.equal(result.kind, "approval_decision");
  assert.deepEqual(result.payload, {
    approvalId: "approval-42",
    approved: true,
  });
});

test("canonical approval values win over legacy aliases", () => {
  const result = canonicalSessionCommand("approval_decision", {
    approvalId: "new-id",
    approved: false,
    requestId: "old-id",
    approve: true,
  });

  assert.deepEqual(result.payload, {
    approvalId: "new-id",
    approved: false,
  });
});

test("change and git aliases map to the native host vocabulary", () => {
  assert.equal(canonicalSessionCommand("patch", { changeId: "c1" }).kind, "apply_patch");
  assert.equal(canonicalSessionCommand("patch", { path: "src/a.ts" }).kind, "apply_patch");
  assert.equal(canonicalSessionCommand("delete", { changeId: "c1" }).kind, "delete_change");
  assert.equal(canonicalSessionCommand("git", { action: "status" }).kind, "git_action");
});

test("the phone's session menu is a session update, not a patch missing its change", () => {
  const result = canonicalSessionCommand("patch", { modelID: "openai:gpt-5.6-sol", permissionMode: "readOnly" });
  assert.equal(result.kind, "update_session");
  assert.deepEqual(result.payload, { modelID: "openai:gpt-5.6-sol", permissionMode: "readOnly" });
  assert.equal(canonicalSessionCommand("patch", { title: "Rename", pinned: true }).kind, "update_session");
});

test("the review verbs and an explicit update pass through unchanged", () => {
  for (const kind of ["accept_change", "reject_change", "undo_change", "update_session", "create_session"]) {
    assert.equal(canonicalSessionCommand(kind, {}).kind, kind);
  }
});
