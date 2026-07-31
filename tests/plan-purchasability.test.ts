import test from "node:test";
import assert from "node:assert/strict";

/*
 * A plan tier may only be *offered* when its Stripe price id is configured.
 * MAX20 shipped in PLAN_LIST with no STRIPE_PRICE_MAX20 set, so /upgrade
 * rendered a ×20 buy button whose checkout answered 503.
 *
 * ONE environment for the whole file, set before the first import.
 *
 * src/lib/env.ts snapshots process.env into an object literal at module load,
 * and Node caches the module — so mutating process.env per test and importing
 * again returns the FIRST snapshot and silently ignores the change. The earlier
 * version of this file did exactly that and passed only because every test
 * happened to want the same values; the first one to disagree failed in a way
 * that looked like a bug in the code under test rather than in the test.
 *
 * The fixture deliberately covers the interesting shape: every tier sellable
 * monthly, only PRO sellable yearly.
 */
process.env.STRIPE_PRICE_PRO = "price_pro_m";
process.env.STRIPE_PRICE_MAX = "price_max_m";
process.env.STRIPE_PRICE_MAX20 = "price_max20_m";
process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_y";
delete process.env.STRIPE_PRICE_MAX_YEARLY;
delete process.env.STRIPE_PRICE_MAX20_YEARLY;

/** Memoised: the module is cached anyway, and the env above is already set. */
let cached: Promise<typeof import("@/lib/stripe")> | null = null;
const stripeLib = () => (cached ??= import("@/lib/stripe"));

test("a configured tier is purchasable at that interval", async () => {
  const { isPlanPurchasable, purchasablePlans } = await stripeLib();
  assert.equal(isPlanPurchasable("PRO", "month"), true);
  assert.equal(isPlanPurchasable("PRO", "year"), true);
  assert.deepEqual(purchasablePlans("month"), ["PRO", "MAX", "MAX20"]);
});

test("a tier with no price id for an interval is not offered at it", async () => {
  const { isPlanPurchasable, purchasablePlans } = await stripeLib();
  // MAX sells monthly and has no yearly price: the monthly button renders, the
  // yearly one must not, or its checkout answers 503.
  assert.equal(isPlanPurchasable("MAX", "month"), true);
  assert.equal(isPlanPurchasable("MAX", "year"), false);
  assert.deepEqual(purchasablePlans("year"), ["PRO"]);
});

test("FREE and OWNER are never purchasable — they are not sold", async () => {
  const { isPlanPurchasable } = await stripeLib();
  for (const interval of ["month", "year"] as const) {
    assert.equal(isPlanPurchasable("FREE", interval), false);
    assert.equal(isPlanPurchasable("OWNER", interval), false);
  }
});

test("an annual price maps to the same plan, not a new tier", async () => {
  const { planFromPriceId } = await stripeLib();
  // The entitlement is identical; only the Stripe billing interval differs. A
  // fourth tier would have meant a Plan enum migration for no product reason.
  assert.equal(planFromPriceId("price_pro_m"), "PRO");
  assert.equal(planFromPriceId("price_pro_y"), "PRO", "the annual price is still PRO");
  assert.equal(planFromPriceId("price_max_m"), "MAX");
  assert.equal(planFromPriceId("price_unknown"), null);
  assert.equal(planFromPriceId(null), null);
});

test("purchasability is about offering, not about recognising a plan", async () => {
  const { isPlanPurchasable, resolveSubscriptionPlan } = await stripeLib();
  // The guarantee that matters alongside the gate: an existing subscriber on a
  // tier this deployment cannot sell keeps their entitlement.
  // resolveSubscriptionPlan never consults price configuration — only what
  // Stripe reported and what is on record.
  assert.equal(isPlanPurchasable("MAX", "year"), false);
  assert.equal(
    resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan: "MAX20" }),
    "MAX20"
  );
});

test("an unmapped price id never downgrades, at either interval", async () => {
  const { resolveSubscriptionPlan } = await stripeLib();
  for (const currentPlan of ["PRO", "MAX", "MAX20"] as const) {
    assert.equal(
      resolveSubscriptionPlan({ status: "active", mappedPlan: null, currentPlan }),
      currentPlan
    );
  }
});
