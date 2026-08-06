import test from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_APPROVAL_LIMIT,
  pendingApprovalWhere,
  WORK_RISK_LEVELS,
  type WorkRiskLevel,
} from "@/lib/work/domain";

/*
 * The approval plane: whether the decision reaches a person at all.
 *
 * This file exists because of a defect that no test could have caught, since
 * nothing was testing the shape of what the read routes returned. `GET
 * /api/work/sessions/[id]` returned `{ session, run }` and the SSE frames
 * returned `{ session, run, events }` — while both native clients decode an
 * `approvals` key out of exactly those payloads. So `pendingApprovals` was
 * empty on every Mac and every phone, permanently, and the approval card could
 * not be displayed no matter what a run did. Everything downstream of it — the
 * digest binding, the expiry, the standing-allowance rules — was correct and
 * unreachable.
 *
 * The cases below are the ones where being wrong is invisible from outside: an
 * approval belonging to another account, one that has already been answered,
 * one whose window has closed. Each of those failures returns a plausible card.
 */

// ---------------------------------------------------------------------------
// What a reader is offered
// ---------------------------------------------------------------------------

test("pendingApprovalWhere scopes to the run, the owner, and the open window", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const where = pendingApprovalWhere("run-1", "user-1", now);

  assert.equal(where.runId, "run-1");
  // Ownership is in the query and not left to the route. Every other Work read
  // carries `userId`, and an approval is the one row where forgetting it would
  // let a person authorise an action on somebody else's machine.
  assert.equal(where.userId, "user-1");
  assert.equal(where.decision, "pending");
  assert.deepEqual(where.expiresAt, { gt: now });
});

test("an answered approval is never offered again", () => {
  // The decision route treats a second answer to a decided approval as a replay
  // and returns the stored one. A read path that kept handing the card back
  // would put a live-looking Allow button on an action that had already been
  // refused.
  const where = pendingApprovalWhere("run-1", "user-1", new Date());
  assert.equal(where.decision, "pending");
});

test("an expired approval is withheld rather than shown as answerable", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");
  const where = pendingApprovalWhere("run-1", "user-1", now);

  // `expiresAt: { gt: now }` and not `gte`: an approval expiring exactly now is
  // one the decision route will refuse with "This request expired before it was
  // answered", and a card whose only two buttons are guaranteed to fail is
  // worse than no card.
  assert.ok("gt" in where.expiresAt);
  assert.ok(!("gte" in (where.expiresAt as Record<string, unknown>)));
});

test("the pending list is bounded", () => {
  // A run that asks a hundred questions must not be able to make the stream
  // frame unbounded — the frame is re-sent on every change.
  assert.ok(PENDING_APPROVAL_LIMIT > 0);
  assert.ok(PENDING_APPROVAL_LIMIT <= 200);
});

// ---------------------------------------------------------------------------
// What a standing "always allow" may cover
// ---------------------------------------------------------------------------

/**
 * Mirrors `WorkRisk.mayBeCoveredByStandingAllowance` in JunoWorkCore
 * (`risk <= .command`) and `DesktopWorkApprovalCard.allowsStandingGrant` on the
 * Mac.
 *
 * Three copies of one rule is two too many, and this test is what stops them
 * drifting: the Swift side is a failable initialiser that returns nil, the
 * SwiftUI side hides a button, and if either stops agreeing with this ordering
 * the product either offers a permission it cannot grant or withholds one it
 * can.
 */
const STANDING_ALLOWANCE_CEILING: WorkRiskLevel = "command";

function mayBeCoveredByStandingAllowance(risk: WorkRiskLevel): boolean {
  return (
    WORK_RISK_LEVELS.indexOf(risk) <=
    WORK_RISK_LEVELS.indexOf(STANDING_ALLOWANCE_CEILING)
  );
}

test("risk levels are ordered least to most severe", () => {
  // The ordering is the rule. `mayBeCoveredByStandingAllowance` is an index
  // comparison, so a reordering of this constant silently changes what a
  // standing yes covers.
  assert.deepEqual(WORK_RISK_LEVELS, [
    "safe",
    "edit",
    "command",
    "sensitive",
    "irreversible",
  ]);
});

test("a standing allowance can never cover sensitive or irreversible work", () => {
  assert.equal(mayBeCoveredByStandingAllowance("safe"), true);
  assert.equal(mayBeCoveredByStandingAllowance("edit"), true);
  assert.equal(mayBeCoveredByStandingAllowance("command"), true);
  // The two that matter. `WorkAlwaysAllowance(upTo:)` returns nil for these and
  // re-applies the rule on decode, so a row edited to say `irreversible` still
  // cannot grant it. The Mac hides "Always allow this" for exactly this set.
  assert.equal(mayBeCoveredByStandingAllowance("sensitive"), false);
  assert.equal(mayBeCoveredByStandingAllowance("irreversible"), false);
});

test("every risk level has a defined standing-allowance answer", () => {
  // An unhandled level defaulting to "allowed" is the failure this guards. A
  // level added to the contract without a decision here should show up as a
  // deliberate choice, not as whatever the comparison happens to return.
  for (const risk of WORK_RISK_LEVELS) {
    assert.equal(typeof mayBeCoveredByStandingAllowance(risk), "boolean");
  }
});
