/**
 * The two sides of an approval must agree about what was approved.
 *
 * An approval is written by the cloud executor and answered by the website, and
 * each one checks the digest independently — that independence is the point, so
 * an answer replayed against a different action cannot be mistaken for consent.
 * It only works if both compute the digest over the same bytes.
 *
 * They did not. The runtime hashes its own `digestInput` string; the runner
 * stored that hash beside `request.detail`, a DIFFERENT object from
 * `JSON.parse(request.digestInput)`. The executor never noticed, because it
 * verifies against `digestInput` and so compares like with like. The website has
 * no `digestInput` — it recomputes from the persisted row — so it disagreed
 * every time, and `classifyApprovalDecision` refused every decision ever
 * submitted with `digest_mismatch`. Measured against a live pending approval on
 * production:
 *
 *   stored     686be292e6e0e7a89c28bb0c4d9fe7302101d965b1d75e5597ad994d4ef31c19
 *   recomputed 25c36fa53ed1c41484fb0ae6e09a556e422715945849930e3d91fd0021c2865f
 *
 * Every approval in the product was unanswerable, and the run sat parked until
 * the request expired.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { actionDigest, policyDigest, verifyApproval } from "@/lib/work/digests";
import { classifyApprovalDecision } from "@/app/api/work/protocol";

/** What the runtime hands the runner, and what the runner must persist. */
const request = {
  action: "work.deliverable.create",
  digestInput: JSON.stringify({ name: "GitHub Repository Audit", format: "md", bytes: 4210 }),
};
const permissionPolicy = { policy: "balanced" };

function rowAsWritten() {
  const detail = JSON.parse(request.digestInput) as unknown;
  return {
    action: request.action,
    detail,
    actionDigest: actionDigest(request.action, detail),
    policyDigest: policyDigest(permissionPolicy as never),
    risk: "edit" as const,
    decision: "pending" as const,
    expiresAt: new Date(Date.now() + 600_000),
  };
}

test("the website can answer an approval the executor wrote", () => {
  const row = rowAsWritten();
  const outcome = classifyApprovalDecision({
    submittedDecision: "allowed",
    submittedDigest: row.actionDigest,
    approval: row as never,
    policy: permissionPolicy,
    now: new Date(),
  });
  assert.deepEqual(outcome, { outcome: "record", decision: "allowed" });
});

test("the executor still verifies the same row", () => {
  const row = rowAsWritten();
  const verdict = verifyApproval({
    storedDigest: row.actionDigest,
    storedPolicyDigest: row.policyDigest,
    action: request.action,
    // The executor feeds in the object it took the digest over.
    detail: JSON.parse(request.digestInput) as unknown,
    policy: permissionPolicy,
    decision: "allowed" as never,
    expiresAt: row.expiresAt,
    now: new Date(),
  });
  assert.deepEqual(verdict, { ok: true });
});

test("a digest taken over different bytes is still refused", () => {
  // The protection this whole mechanism exists for must survive the fix.
  const row = rowAsWritten();
  const outcome = classifyApprovalDecision({
    submittedDecision: "allowed",
    submittedDigest: actionDigest(request.action, { name: "Something else entirely" }),
    approval: row as never,
    policy: permissionPolicy,
    now: new Date(),
  });
  assert.deepEqual(outcome, { outcome: "refuse", reason: "digest_mismatch" });
});
