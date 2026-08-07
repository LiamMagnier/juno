import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PERMISSION_POLICIES,
  actionArgsHash,
  actionPolicyDigest,
  actionPreviewDetail,
  actionReceiptDigest,
  classifyExternalAction,
  decideActionPolicy,
  mayCreateStandingApproval,
  type ActionReceiptBinding,
  type ActionRiskClass,
} from "@/lib/action-approval";

test("Juno-owned connector rules classify every shipped Apple tool", () => {
  const cases: Array<[string, string, ActionRiskClass]> = [
    ["apple-calendar", "list_events", "read_only"],
    ["apple-calendar", "create_event", "external_write"],
    ["apple-calendar", "delete_event", "destructive_or_sensitive"],
    ["apple-mail", "read_message", "read_only"],
    ["apple-music", "add_to_playlist", "reversible_write"],
  ];
  for (const [connectorId, toolName, expected] of cases) {
    assert.equal(classifyExternalAction({ connectorId, toolName }).riskClass, expected);
  }
});

test("a remote read needs independent name and annotation evidence", () => {
  assert.equal(
    classifyExternalAction({
      connectorId: "notion",
      toolName: "search_pages",
      annotations: { readOnlyHint: true },
    }).riskClass,
    "read_only"
  );
  assert.equal(
    classifyExternalAction({
      connectorId: "hostile",
      toolName: "delete_everything",
      annotations: { readOnlyHint: true },
    }).riskClass,
    "destructive_or_sensitive",
    "an untrusted annotation must not downgrade destructive semantics"
  );
  assert.equal(
    classifyExternalAction({
      connectorId: "hostile",
      toolName: "mystery",
      annotations: { readOnlyHint: true },
    }).riskClass,
    "unknown",
    "a read-only hint is never sole authority"
  );
});

test("contradictory metadata fails closed", () => {
  assert.equal(
    classifyExternalAction({
      connectorId: "github",
      toolName: "list_issues",
      annotations: { readOnlyHint: false },
    }).riskClass,
    "unknown"
  );
  assert.equal(
    classifyExternalAction({ connectorId: "notion", toolName: "notion_pages" }).riskClass,
    "unknown"
  );
});

test("arguments can escalate an innocent-looking tool", () => {
  assert.equal(
    classifyExternalAction({
      connectorId: "remote",
      toolName: "apply",
      annotations: { readOnlyHint: true },
      args: { securityRole: "owner" },
    }).riskClass,
    "destructive_or_sensitive"
  );
});

test("every policy fails closed for unknown and destructive actions", () => {
  for (const policy of ACTION_PERMISSION_POLICIES) {
    const unknown = decideActionPolicy({ policy, riskClass: "unknown" });
    const destructive = decideActionPolicy({ policy, riskClass: "destructive_or_sensitive" });
    assert.notEqual(unknown, "allow", `${policy} silently allowed an unknown action`);
    assert.notEqual(destructive, "allow", `${policy} silently allowed a destructive action`);
  }
});

test("policy modes are distinct and lockdown wins", () => {
  assert.equal(decideActionPolicy({ policy: "ask_for_any_change", riskClass: "read_only" }), "allow");
  assert.equal(decideActionPolicy({ policy: "ask_for_any_change", riskClass: "reversible_write" }), "ask");
  assert.equal(decideActionPolicy({ policy: "ask_for_important_actions", riskClass: "reversible_write" }), "allow");
  assert.equal(decideActionPolicy({ policy: "always_ask", riskClass: "read_only" }), "ask");
  assert.equal(decideActionPolicy({ policy: "block", riskClass: "read_only" }), "block");
  assert.equal(
    decideActionPolicy({ policy: "ask_for_important_actions", riskClass: "read_only", lockdown: true }),
    "block"
  );
});

test("standing approval is exact and only low-risk reversible writes can use it", () => {
  assert.equal(mayCreateStandingApproval("reversible_write"), true);
  assert.equal(mayCreateStandingApproval("read_only"), false);
  assert.equal(
    decideActionPolicy({ policy: "allow_selected_low_risk", riskClass: "read_only", hasStandingApproval: true }),
    "allow",
    "reads are allowed by their classification, not by a standing write approval"
  );
  for (const riskClass of ["external_write", "destructive_or_sensitive", "unknown"] as const) {
    assert.equal(mayCreateStandingApproval(riskClass), false);
    assert.notEqual(
      decideActionPolicy({
        policy: "allow_selected_low_risk",
        riskClass,
        hasStandingApproval: true,
      }),
      "allow",
      `${riskClass} escaped through a standing approval`
    );
  }
  assert.equal(
    decideActionPolicy({
      policy: "allow_selected_low_risk",
      riskClass: "reversible_write",
      hasStandingApproval: true,
    }),
    "allow"
  );
});

const baseBinding: ActionReceiptBinding = {
  userId: "user-a",
  surface: "chat",
  sessionId: "conversation-a:generation-a",
  conversationId: "conversation-a",
  projectId: "project-a",
  connectorId: "apple-calendar",
  connectorVersion: "1",
  toolName: "create_event",
  functionName: "apple-calendar__create_event",
  action: "connector.apple-calendar.create_event",
  args: { title: "Exam", start: "2026-08-10T08:00:00Z", end: "2026-08-10T09:00:00Z" },
  riskClass: "external_write",
  preview: "Calendar wants to create event.",
  detail: { title: "Exam", start: "2026-08-10T08:00:00Z", end: "2026-08-10T09:00:00Z" },
  provenance: { source: "user_message", sourceKind: "conversation", derivedFromUntrusted: false },
  policy: "ask_for_any_change",
  policyDigest: "policy-a",
  scope: "one_time",
  issuedAt: "2026-08-07T21:30:00.000Z",
  expiresAt: "2026-08-07T21:45:00.000Z",
};

test("receipt hashes are canonical but every bound field invalidates them", () => {
  const digest = actionReceiptDigest(baseBinding);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(
    digest,
    actionReceiptDigest({ ...baseBinding, args: { end: baseBinding.args.end, title: "Exam", start: baseBinding.args.start } }),
    "JSON key order must not invalidate the same action"
  );

  const mutations: ActionReceiptBinding[] = [
    { ...baseBinding, userId: "user-b" },
    { ...baseBinding, sessionId: "conversation-b:generation-a" },
    { ...baseBinding, conversationId: "conversation-b" },
    { ...baseBinding, projectId: "project-b" },
    { ...baseBinding, connectorVersion: "2" },
    { ...baseBinding, toolName: "delete_event" },
    { ...baseBinding, functionName: "apple-calendar__delete_event" },
    { ...baseBinding, action: "connector.apple-calendar.delete_event" },
    { ...baseBinding, args: { ...baseBinding.args, title: "Different" } },
    { ...baseBinding, riskClass: "destructive_or_sensitive" },
    { ...baseBinding, preview: "Calendar wants to create a different event." },
    { ...baseBinding, provenance: { ...baseBinding.provenance, derivedFromUntrusted: true } },
    { ...baseBinding, policy: "ask_for_important_actions" },
    { ...baseBinding, policyDigest: "policy-b" },
    { ...baseBinding, expiresAt: "2026-08-07T22:00:00.000Z" },
  ];
  for (const changed of mutations) assert.notEqual(actionReceiptDigest(changed), digest);
});

test("argument hashes are stable and property-check changed values", () => {
  const original = { a: 1, nested: { b: "x" }, rows: [1, 2, 3] };
  assert.equal(actionArgsHash(original), actionArgsHash({ rows: [1, 2, 3], nested: { b: "x" }, a: 1 }));
  for (let i = 0; i < 250; i++) {
    assert.notEqual(actionArgsHash(original), actionArgsHash({ ...original, a: i + 2 }));
    assert.notEqual(actionArgsHash(original), actionArgsHash({ ...original, rows: [1, 2, i + 4] }));
  }
});

test("policy digest is set-like for blocklists and binds the current scope", () => {
  const base = {
    policy: "ask_for_any_change" as const,
    lockdown: false,
    blockedConnectors: ["github", "notion"],
    connectorId: "apple-calendar",
    projectId: "project-a",
  };
  const digest = actionPolicyDigest(base);
  assert.equal(digest, actionPolicyDigest({ ...base, blockedConnectors: ["notion", "github"] }));
  assert.notEqual(digest, actionPolicyDigest({ ...base, lockdown: true }));
  assert.notEqual(digest, actionPolicyDigest({ ...base, projectId: "project-b" }));
});

test("preview detail preserves the action but removes credentials", () => {
  assert.deepEqual(
    actionPreviewDetail({
      recipient: "liam@example.com",
      body: "Bonjour",
      accessToken: "secret-token",
      nested: { password: "hunter2", calendar: "School" },
    }),
    {
      recipient: "liam@example.com",
      body: "Bonjour",
      accessToken: "[redacted]",
      nested: { password: "[redacted]", calendar: "School" },
    }
  );
});
