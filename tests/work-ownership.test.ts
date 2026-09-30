import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TRANSFER_REASON_CHARS,
  isAtSafePoint,
  ownerTransferRefusal,
  ownerTransferSentence,
  ownerTransferredPayload,
  transferredConnectorIds,
  transferredPermissionPolicy,
} from "@/lib/work/ownership";
import { WORK_EVENT_KINDS, WORK_TERMINAL_STATUSES, defaultVisibilityFor } from "@/lib/work/domain";

/*
 * Task ownership (D-010 prerequisites): one owning crew member, changed only by
 * a transfer at a safe point, never widening what the task may do. The
 * executor's lease is a different lock and is read, never merged.
 */

const NOW = new Date("2026-09-30T12:00:00.000Z");
const base = {
  status: "paused",
  fromAgentId: "ag_mira",
  toAgentId: "ag_otto",
  toAgentStatus: "active",
  fromName: "Mira",
  toName: "Otto",
  run: null,
  reason: "Otto owns renewals now.",
  now: NOW,
};

test("a transfer needs a reason, a different owner and an active member", () => {
  assert.equal(ownerTransferRefusal({ ...base, reason: "   " })?.code, "reason_required");
  assert.equal(ownerTransferRefusal({ ...base, toAgentId: "ag_mira" })?.code, "same_owner");
  assert.match(ownerTransferRefusal({ ...base, toAgentId: "ag_mira", toName: "Mira" })!.message, /^Mira already owns/);
  assert.equal(ownerTransferRefusal({ ...base, fromAgentId: null, toAgentId: null })?.code, "same_owner");
  assert.equal(ownerTransferRefusal({ ...base, toAgentStatus: "paused" })?.code, "member_paused");
  assert.equal(ownerTransferRefusal(base), null);
  // Back to the person is always a valid target.
  assert.equal(ownerTransferRefusal({ ...base, toAgentId: null, toAgentStatus: null }), null);
});

test("only a task no executor is part-way through can change hands", () => {
  for (const status of ["preparing", "running", "waiting_input", "waiting_approval"]) {
    assert.equal(ownerTransferRefusal({ ...base, status })?.code, "not_at_safe_point", status);
  }
  for (const status of ["draft", "paused", ...WORK_TERMINAL_STATUSES]) {
    assert.equal(ownerTransferRefusal({ ...base, status }), null, status);
  }
});

test("a queued attempt is safe only while no live lease holds it", () => {
  const future = new Date(NOW.getTime() + 60_000);
  const past = new Date(NOW.getTime() - 1);
  assert.equal(isAtSafePoint({ status: "queued", run: null, now: NOW }), true);
  assert.equal(isAtSafePoint({ status: "queued", run: { status: "queued", claimedBy: null, leaseExpiresAt: null }, now: NOW }), true);
  // Claimed: the claim and the status change are two writes, and the lease is true first.
  assert.equal(isAtSafePoint({ status: "queued", run: { status: "queued", claimedBy: "exec-1", leaseExpiresAt: future }, now: NOW }), false);
  // An expired lease is nobody's, as the lease sweep reads it.
  assert.equal(isAtSafePoint({ status: "queued", run: { status: "queued", claimedBy: "exec-1", leaseExpiresAt: past }, now: NOW }), true);
});

test("a transfer never widens the task's approval mode or apps", () => {
  assert.equal(transferredPermissionPolicy({ current: "conservative", toMemberMode: "permissive" }), "conservative");
  assert.equal(transferredPermissionPolicy({ current: "permissive", toMemberMode: "balanced" }), "balanced");
  assert.equal(transferredPermissionPolicy({ current: "balanced", toMemberMode: null }), "balanced");
  assert.deepEqual(transferredConnectorIds({ current: ["gmail", "linear"], toMemberConnectorIds: ["linear", "slack"] }), ["linear"]);
  assert.deepEqual(transferredConnectorIds({ current: ["gmail"], toMemberConnectorIds: null }), ["gmail"]);
});

test("the record says who moved it, from whom, to whom and why", () => {
  const sides = { from: { agentId: "ag_mira", name: "Mira" }, to: { agentId: "ag_otto", name: "Otto" } };
  assert.equal(ownerTransferSentence({ ...sides, by: { kind: "person" }, reason: "Otto owns renewals" }), "You handed this from Mira to Otto: Otto owns renewals");
  assert.equal(
    ownerTransferSentence({ from: sides.from, to: { agentId: null, name: null }, by: { kind: "person" }, reason: "I'll finish it" }),
    "You took this back from Mira: I'll finish it"
  );
  const payload = ownerTransferredPayload({
    ...sides,
    by: { kind: "member", agentId: "ag_mira", name: "Mira" },
    reason: "x".repeat(MAX_TRANSFER_REASON_CHARS + 50),
    at: NOW,
  });
  assert.deepEqual(payload.from, { kind: "member", agentId: "ag_mira", name: "Mira" });
  assert.deepEqual(payload.by, { kind: "member", agentId: "ag_mira", name: "Mira" });
  assert.equal((payload.reason as string).length, MAX_TRANSFER_REASON_CHARS);
  assert.equal(payload.at, NOW.toISOString());
});

test("owner_transferred is a Work event kind, shown to the user", () => {
  assert.ok((WORK_EVENT_KINDS as readonly string[]).includes("owner_transferred"));
  assert.equal(defaultVisibilityFor("owner_transferred"), "user");
});
