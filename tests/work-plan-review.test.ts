import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORK_PERMISSION_POLICIES } from "@/lib/work/domain";
import {
  PLAN_REVIEW_APPROVE,
  PLAN_REVIEW_QUESTION_ID,
  PLAN_REVIEW_REVISE,
  confirmPlanBeforeActing,
  planReviewApproved,
} from "@/lib/work/plan-review";

/*
 * A plan the person can read before the run acts on it.
 *
 * The plan is the model's first tool call and the run used to carry straight on
 * from it, so the first statement about the work that was not a guess was the
 * one the reader never saw in time to change. This file pins the two halves
 * that can silently disagree: the rule that decides whether a run parks, and
 * the three strings the runtime and the web app both speak.
 */

const SESSION = readFileSync(
  new URL("../runner/agent-core/src/work/session.ts", import.meta.url),
  "utf8"
);

test("the mode the reader chose decides it, and nothing else does", () => {
  // "Ask before every change" and "here is the list of changes, before the
  // first one" are the same promise. The other two modes said the opposite on
  // purpose.
  assert.equal(confirmPlanBeforeActing({ policy: "conservative", attended: true }), true);
  assert.equal(confirmPlanBeforeActing({ policy: "balanced", attended: true }), false);
  assert.equal(confirmPlanBeforeActing({ policy: "permissive", attended: true }), false);
});

test("a run nobody is watching never parks on its plan", () => {
  // A question from an unattended run checkpoints it and releases the worker,
  // so this gate on a schedule firing at 03:00 would not be a review — it would
  // be every scheduled run stopping on its first step until somebody opened the
  // app.
  for (const policy of WORK_PERMISSION_POLICIES) {
    assert.equal(confirmPlanBeforeActing({ policy, attended: false }), false, policy);
  }
});

test("anything that is not the approval is a revision", () => {
  assert.equal(planReviewApproved(PLAN_REVIEW_APPROVE), true);
  assert.equal(planReviewApproved(`  ${PLAN_REVIEW_APPROVE}  `), true);
  assert.equal(planReviewApproved(PLAN_REVIEW_REVISE), false);
  // The reader may type instead of pressing either button, and a sentence is
  // not consent. Failing this way costs one model turn; failing the other way
  // means the run acted on a plan nobody approved.
  assert.equal(planReviewApproved("go ahead but skip step 3"), false);
  assert.equal(planReviewApproved(""), false);
});

test("the runtime and the web app speak the same three strings", () => {
  // The runtime is a separate package with no dependency on the web app, so it
  // repeats these literals rather than importing them. That repetition is only
  // safe while something fails when they drift.
  assert.match(SESSION, new RegExp(`PLAN_REVIEW_QUESTION_ID = '${PLAN_REVIEW_QUESTION_ID}'`));
  assert.match(SESSION, new RegExp(`PLAN_REVIEW_APPROVE = '${PLAN_REVIEW_APPROVE}'`));
  assert.match(SESSION, new RegExp(`PLAN_REVIEW_REVISE = '${PLAN_REVIEW_REVISE}'`));
});

test("only the first plan write is gated, and the clock stops while it waits", () => {
  // Gating the second write would ask the reader to approve their own edit and
  // leave the run no write to act on: `MAX_PLAN_WRITES` is 2 and the second one
  // exists to answer this review.
  assert.match(SESSION, /if \(this\.options\.confirmPlan && this\.planWrites === 1\)/);
  // Waiting on a person is not time the run spent working. Without the
  // suspend, the gate would eat the runtime ceiling of exactly the runs that
  // asked before acting.
  const review = SESSION.slice(SESSION.indexOf("private async reviewPlan("));
  assert.match(review.slice(0, 2_000), /this\.budget\.suspend\(\)/);
  assert.match(review.slice(0, 2_000), /this\.budget\.start\(\)/);
});

test("the dispatcher, the executor and the composer read one rule", () => {
  for (const file of [
    "../scripts/work-runner.ts",
    "../src/components/work/clarify/run-disclosure.tsx",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /confirmPlanBeforeActing\(\{/, file);
  }
});
