import test from "node:test";
import assert from "node:assert/strict";

/*
 * Every paid tier at both intervals maps back to its plan, so a customer-portal
 * switch between ANY two tiers lands on the right entitlement. One env for the
 * file, set before the first import (env.ts snapshots process.env at load).
 */
const PLANS = ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const;
for (const p of PLANS) {
  process.env[`STRIPE_PRICE_${p}`] = `price_${p.toLowerCase()}_m`;
  process.env[`STRIPE_PRICE_${p}_YEARLY`] = `price_${p.toLowerCase()}_y`;
}
process.env.STRIPE_PRICE_TOPUP_5 = "price_topup_5";
process.env.STRIPE_PRICE_TOPUP_20 = "price_topup_20";

let cached: Promise<typeof import("@/lib/stripe")> | null = null;
const lib = () => (cached ??= import("@/lib/stripe"));

test("all six tiers map at both intervals", async () => {
  const { planFromPriceId, intervalFromPriceId, priceIdForPlan } = await lib();
  for (const plan of PLANS) {
    for (const interval of ["month", "year"] as const) {
      const id = priceIdForPlan(plan, interval);
      assert.ok(id, `${plan} ${interval} has a price`);
      assert.equal(planFromPriceId(id), plan);
      assert.equal(intervalFromPriceId(id), interval);
    }
  }
});

test("a portal switch between any two tiers writes the new tier", async () => {
  const { planFromPriceId, priceIdForPlan, resolveSubscriptionPlan } = await lib();
  for (const from of PLANS) {
    for (const to of PLANS) {
      for (const interval of ["month", "year"] as const) {
        const mapped = planFromPriceId(priceIdForPlan(to, interval));
        assert.equal(resolveSubscriptionPlan({ status: "active", mappedPlan: mapped, currentPlan: from }), to);
      }
    }
  }
});

test("an unknown price never downgrades; a cancellation always does", async () => {
  const { planFromPriceId, resolveSubscriptionPlan } = await lib();
  assert.equal(planFromPriceId("price_legacy"), null);
  assert.equal(planFromPriceId("price_topup_5"), null, "a top-up price is not a plan");
  for (const plan of PLANS) {
    assert.equal(resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan: plan }), plan);
    assert.equal(resolveSubscriptionPlan({ status: "past_due", mappedPlan: null, currentPlan: plan }), plan);
    assert.equal(resolveSubscriptionPlan({ status: "canceled", mappedPlan: plan, currentPlan: plan }), "FREE");
  }
});

test("top-up packs are sellable when their price is configured", async () => {
  const { priceIdForTopUp, purchasableTopUps } = await lib();
  assert.equal(priceIdForTopUp("5"), "price_topup_5");
  assert.deepEqual(purchasableTopUps(), ["5", "20"]);
});
