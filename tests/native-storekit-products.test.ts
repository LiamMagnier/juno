import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The apps' StoreKit product ids (JunoStoreKit.swift) and the local StoreKit
 * configuration the iOS scheme runs with (native/StoreKit/Alevr.storekit) sell
 * the same twelve products: Lite, Pro, Plus, Max ×5, Max ×10 and Ultra, each
 * monthly and yearly. The server's map (APP_STORE_PRODUCT_IDS) is held to the
 * same list by the billing lane's own test.
 */
const PLANS = ["lite", "pro", "plus", "max", "max20", "ultra"];
const EXPECTED = PLANS.flatMap((plan) => [`com.liammagnier.juno.${plan}.monthly`, `com.liammagnier.juno.${plan}.yearly`]).sort();

test("JunoStoreKit.swift names every product, once", () => {
  const swift = readFileSync(
    new URL("../native/Packages/JunoNativeKit/Sources/JunoAPI/StoreKit/JunoStoreKit.swift", import.meta.url),
    "utf8",
  );
  const ids = [...new Set(swift.match(/com\.liammagnier\.juno\.[a-z0-9]+\.(?:monthly|yearly)/g) ?? [])].sort();
  assert.deepEqual(ids, EXPECTED);
});

test("the local StoreKit file has every product, in one group, levelled by plan", () => {
  const storekit = JSON.parse(readFileSync(new URL("../native/StoreKit/Alevr.storekit", import.meta.url), "utf8")) as {
    subscriptionGroups: { subscriptions: { productID: string; recurringSubscriptionPeriod: string; groupNumber: number }[] }[];
  };
  assert.equal(storekit.subscriptionGroups.length, 1, "one group, so moving between plans is an upgrade");
  const products = storekit.subscriptionGroups[0].subscriptions;
  assert.deepEqual(products.map((p) => p.productID).sort(), EXPECTED);
  for (const product of products) {
    const plan = product.productID.split(".")[3];
    assert.equal(product.recurringSubscriptionPeriod, product.productID.endsWith(".yearly") ? "P1Y" : "P1M");
    // Level 1 is the highest service: Ultra 1 … Lite 6.
    assert.equal(product.groupNumber, PLANS.length - PLANS.indexOf(plan), product.productID);
  }
});
