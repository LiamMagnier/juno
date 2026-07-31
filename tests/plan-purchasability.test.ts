import test from "node:test";
import assert from "node:assert/strict";

/*
 * A plan tier may only be *offered* when its Stripe price id is configured.
 * MAX20 shipped in PLAN_LIST with no STRIPE_PRICE_MAX20 set, so /upgrade
 * rendered a ×20 buy button whose checkout answered 503.
 *
 * src/lib/env.ts snapshots process.env at module load, so these set the
 * environment before the first import and then load the module dynamically.
 */

async function loadStripeLib(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/lib/stripe");
}

test("a tier whose price id is unset is not purchasable", async () => {
  const { purchasablePlans, isPlanPurchasable } = await loadStripeLib({
    STRIPE_PRICE_PRO: "price_pro",
    STRIPE_PRICE_MAX: "price_max",
    STRIPE_PRICE_MAX20: undefined,
  });

  assert.equal(isPlanPurchasable("PRO"), true);
  assert.equal(isPlanPurchasable("MAX"), true);
  assert.equal(
    isPlanPurchasable("MAX20"),
    false,
    "MAX20 must not be offerable without STRIPE_PRICE_MAX20"
  );
  assert.deepEqual(purchasablePlans(), ["PRO", "MAX"]);
});

test("FREE and OWNER are never purchasable — they are not sold", async () => {
  const { isPlanPurchasable } = await loadStripeLib({});
  assert.equal(isPlanPurchasable("FREE"), false);
  assert.equal(isPlanPurchasable("OWNER"), false);
});

test("purchasability is about offering, not about recognising a plan", async () => {
  // The guarantee that matters alongside the gate: an existing subscriber on an
  // unconfigured tier keeps their entitlement. resolveSubscriptionPlan never
  // consults price configuration — only what Stripe reported and what is on
  // record — so an unset STRIPE_PRICE_MAX20 cannot demote a MAX20 customer.
  const { resolveSubscriptionPlan, isPlanPurchasable } = await loadStripeLib({
    STRIPE_PRICE_MAX20: undefined,
  });

  assert.equal(isPlanPurchasable("MAX20"), false);
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan: "MAX20" }),
    "MAX20"
  );
});
