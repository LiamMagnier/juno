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

test("FREE is far less than any paid plan (the premise of the unknown-price guard)", () => {
  // A spurious FREE would drop a paying customer to a 0.20 € allowance with
  // no voice, Code or agents while Stripe keeps billing them.
  for (const flag of ["voice", "code", "agents", "research"] as const) assert.equal(PLANS.FREE[flag], false);
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
  for (const currentPlan of ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const) {
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
