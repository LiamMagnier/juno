import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalize,
  actionDigest,
  policyDigest,
  verifyApproval,
} from "@/lib/work/digests";

/*
 * The approval boundary, attacked rather than demonstrated.
 *
 * Every test here is an attempt to spend one approval on something the user did
 * not agree to. The interesting property is not that a matching action passes —
 * it is that each of the substitutions below is caught, and caught with the
 * reason an investigator would need afterwards.
 */

const POLICY = { enabled: true, allowsFileWork: true, approvalPolicy: "balanced" };
const NOW = new Date("2026-08-05T12:00:00.000Z");
const LATER = new Date("2026-08-05T12:10:00.000Z");

function approved(overrides: Partial<Parameters<typeof verifyApproval>[0]> = {}) {
  const action = "work.file.batch_move";
  const detail = { from: "Downloads", to: "Archive", count: 14 };
  return verifyApproval({
    storedDigest: actionDigest(action, detail),
    storedPolicyDigest: policyDigest(POLICY),
    action,
    detail,
    policy: POLICY,
    decision: "allowed",
    expiresAt: LATER,
    now: NOW,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

test("key order does not change the canonical form", () => {
  assert.equal(
    canonicalize({ a: 1, b: 2 }),
    canonicalize({ b: 2, a: 1 }),
    "the same action built by two code paths, or round-tripped through JSONB, must hash the same"
  );
});

test("nested key order does not change the canonical form either", () => {
  assert.equal(
    canonicalize({ outer: { z: 1, a: [{ q: 1, b: 2 }] } }),
    canonicalize({ outer: { a: [{ b: 2, q: 1 }], z: 1 } })
  );
});

test("array order does change the canonical form", () => {
  assert.notEqual(
    canonicalize([1, 2]),
    canonicalize([2, 1]),
    "an ordered batch of file operations is a different batch when reordered"
  );
});

test("undefined properties are dropped, so an absent key and an undefined one agree", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("undefined inside an array becomes null rather than vanishing", () => {
  // Vanishing would shorten the array and make a 3-operation batch canonicalise
  // as a 2-operation one.
  assert.equal(canonicalize([1, undefined, 3]), "[1,null,3]");
});

test("a cycle is refused rather than given a placeholder", () => {
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(
    () => canonicalize(cyclic),
    TypeError,
    "a placeholder would make two genuinely different actions hash identically"
  );
});

test("a repeated but acyclic value is not mistaken for a cycle", () => {
  const shared = { x: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test("dates canonicalise to their instant, not to a locale rendering", () => {
  assert.equal(
    canonicalize({ at: new Date("2026-08-05T12:00:00.000Z") }),
    '{"at":"2026-08-05T12:00:00.000Z"}'
  );
});

test("non-finite numbers become null, matching JSON.stringify", () => {
  assert.equal(canonicalize({ n: Number.NaN }), '{"n":null}');
  assert.equal(canonicalize({ n: Number.POSITIVE_INFINITY }), '{"n":null}');
});

test("keys sort by code unit, not by locale", () => {
  // A locale-aware sort orders these differently under some ICU builds, which
  // would make the same action hash differently on two machines in one fleet.
  const form = canonicalize({ Z: 1, a: 2, "ä": 3 });
  assert.equal(form, '{"Z":1,"a":2,"ä":3}');
});

// ---------------------------------------------------------------------------
// Digest separation
// ---------------------------------------------------------------------------

test("the same detail under a different action digests differently", () => {
  const detail = { path: "notes.txt" };
  assert.notEqual(
    actionDigest("work.file.trash", detail),
    actionDigest("work.file.permanent_delete", detail),
    "an approval to trash must not authorise a permanent delete of the same file"
  );
});

test("the action/detail boundary cannot be moved", () => {
  // A bare concatenation would let "work.file.mov" + "eX" collide with
  // "work.file.move" + "X".
  assert.notEqual(
    actionDigest("work.file.move", { to: "X" }),
    actionDigest("work.file.mov", { to: "eX" })
  );
});

test("an action digest and a policy digest over the same bytes differ", () => {
  const value = { enabled: true };
  assert.notEqual(
    actionDigest("", value),
    policyDigest(value),
    "without domain separation a value stored in one column would satisfy a check against the other"
  );
});

test("digests are stable across runs", () => {
  const a = actionDigest("work.file.batch_move", { from: "Downloads", count: 14 });
  const b = actionDigest("work.file.batch_move", { count: 14, from: "Downloads" });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/, "a sha-256 hex digest");
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("the exact approved action passes", () => {
  assert.deepEqual(approved(), { ok: true });
});

test("allowed_always passes as well", () => {
  assert.deepEqual(approved({ decision: "allowed_always" }), { ok: true });
});

test("a different action is refused as a digest mismatch", () => {
  const result = approved({ action: "work.file.permanent_delete" });
  assert.deepEqual(result, { ok: false, reason: "digest_mismatch" });
});

test("the same action with a changed detail is refused", () => {
  const result = approved({ detail: { from: "Downloads", to: "Archive", count: 15 } });
  assert.deepEqual(
    result,
    { ok: false, reason: "digest_mismatch" },
    "a batch that grew by one file between preview and execution is not the batch approved"
  );
});

test("a destination swapped after approval is refused", () => {
  const result = approved({ detail: { from: "Downloads", to: "/elsewhere", count: 14 } });
  assert.deepEqual(result, { ok: false, reason: "digest_mismatch" });
});

test("a policy that narrowed after approval is refused", () => {
  const result = approved({ policy: { ...POLICY, approvalPolicy: "conservative" } });
  assert.deepEqual(
    result,
    { ok: false, reason: "policy_changed" },
    "narrowing the policy must take effect on the operation it was aimed at"
  );
});

test("a policy that widened after approval is also refused", () => {
  // Symmetry is deliberate: the approval was answered under a specific set of
  // rules, and "the rules changed" is the finding, not "the rules got worse".
  const result = approved({ policy: { ...POLICY, approvalPolicy: "permissive" } });
  assert.deepEqual(result, { ok: false, reason: "policy_changed" });
});

test("a denial is refused as not_allowed, not as expiry", () => {
  assert.deepEqual(approved({ decision: "denied" }), { ok: false, reason: "not_allowed" });
});

test("a still-pending approval does not authorise anything", () => {
  assert.deepEqual(approved({ decision: "pending" }), { ok: false, reason: "not_allowed" });
});

test("a swept expiry reports expiry rather than refusal", () => {
  assert.deepEqual(
    approved({ decision: "expired" }),
    { ok: false, reason: "expired" },
    '"the user said no" is a different conversation to have with them than "it lapsed"'
  );
});

test("a superseded approval does not authorise anything", () => {
  assert.deepEqual(approved({ decision: "superseded" }), { ok: false, reason: "not_allowed" });
});

test("an approval past its window is refused even though it was allowed", () => {
  assert.deepEqual(
    approved({ now: new Date(LATER.getTime() + 1) }),
    { ok: false, reason: "expired" },
    "approving a send at 09:00 must not still authorise it at 17:00"
  );
});

test("expiry is closed at the boundary", () => {
  assert.deepEqual(approved({ now: LATER }), { ok: false, reason: "expired" });
  assert.deepEqual(approved({ now: new Date(LATER.getTime() - 1) }), { ok: true });
});

test("allowed_always still expires", () => {
  assert.deepEqual(
    approved({ decision: "allowed_always", now: new Date(LATER.getTime() + 1) }),
    { ok: false, reason: "expired" },
    "otherwise it becomes an immortal token for that exact action"
  );
});

test("substitution is reported ahead of expiry", () => {
  // Both are wrong at once. Reporting the lapse would hide the substitution
  // behind it, and the substitution is the materially worse finding.
  const result = approved({
    action: "work.file.permanent_delete",
    now: new Date(LATER.getTime() + 1),
  });
  assert.deepEqual(result, { ok: false, reason: "digest_mismatch" });
});

test("a policy change is reported ahead of a denial", () => {
  const result = approved({
    policy: { ...POLICY, approvalPolicy: "conservative" },
    decision: "denied",
  });
  assert.deepEqual(result, { ok: false, reason: "policy_changed" });
});

test("a replayed digest from another approval does not authorise this action", () => {
  // The attack this whole file exists for: an executor holding a valid digest
  // from an earlier, genuinely approved action tries to spend it on a new one.
  const earlier = actionDigest("work.file.batch_move", { from: "Downloads", to: "Archive", count: 14 });
  const result = verifyApproval({
    storedDigest: earlier,
    storedPolicyDigest: policyDigest(POLICY),
    action: "work.connector.send_message",
    detail: { to: "dana@example.com" },
    policy: POLICY,
    decision: "allowed",
    expiresAt: LATER,
    now: NOW,
  });
  assert.deepEqual(result, { ok: false, reason: "digest_mismatch" });
});
