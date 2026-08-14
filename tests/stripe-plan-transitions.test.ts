import test from "node:test";
import assert from "node:assert/strict";
import { resolveSubscriptionPlan } from "@/lib/stripe";
import { PLANS } from "@/lib/plans";

/*
 * The Stripe webhook decides what plan to write for a customer. Getting this
 * wrong costs real money in both directions, so the decision lives in a pure
 * function and is tested here rather than being inlined in the route.
 *
 * The case that matters most: an unmapped price id. It used to fall back to
 * FREE, and FREE grants zero messages — so a legacy price, a promo, a currency
 * variant or an undeployed STRIPE_PRICE_* var would lock a paying customer out
 * of the product while Stripe kept charging them.
 */

test("FREE is a trial, not a paid tier (the premise of the unknown-price guard)", () => {
  // FREE now carries a small trial allowance, but a paying customer dropped
  // to it would still lose the product they pay for — the guard below is as
  // load-bearing as when the allowance was zero.
  assert.ok(PLANS.FREE.monthlyMessages != null && PLANS.FREE.monthlyMessages <= 15);
});

test("a recognised price id sets that plan", () => {
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: "PRO", currentPlan: "FREE" }),
    "PRO"
  );
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: "MAX", currentPlan: "PRO" }),
    "MAX"
  );
});

test("an unknown price id never downgrades a paying customer", () => {
  for (const currentPlan of ["PRO", "MAX", "MAX20"] as const) {
    assert.equal(
      resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan }),
      currentPlan,
      `${currentPlan} must survive an unmappable price id`
    );
  }
});

test("an unknown price id is not an upgrade either — FREE stays FREE", () => {
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan: "FREE" }),
    "FREE"
  );
});

test("the unknown-price guard holds across every non-canceled status", () => {
  for (const status of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
    assert.equal(
      resolveSubscriptionPlan({ status, mappedPlan: null, currentPlan: "MAX" }),
      "MAX",
      `status=${status} must not downgrade`
    );
  }
});

test("cancellation drops to FREE even when the price is unknown", () => {
  assert.equal(
    resolveSubscriptionPlan({ status: "canceled", mappedPlan: null, currentPlan: "MAX20" }),
    "FREE"
  );
  assert.equal(
    resolveSubscriptionPlan({ status: "canceled", mappedPlan: "PRO", currentPlan: "PRO" }),
    "FREE"
  );
});

test("a downgrade Stripe actually reports is still honoured", () => {
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: "PRO", currentPlan: "MAX20" }),
    "PRO"
  );
});
