import { test } from "node:test";
import assert from "node:assert/strict";

import { PLAN_LIST } from "@/lib/plans";
import { planPriceParts, displayPrice, perMonthSuffix, vatNote } from "@/lib/price-display";

test("every consumer price is the HT price plus 20% VAT", () => {
  assert.equal(displayPrice(9).monthlyTtc, 10.8);
  assert.equal(displayPrice(20).monthlyTtc, 24);
  assert.equal(displayPrice(50).monthlyTtc, 60);
  assert.equal(displayPrice(500).monthlyTtc, 600);
});

test("monthly parts are TTC with an incl. VAT suffix; Free has no VAT label", () => {
  assert.deepEqual(planPriceParts(9, "month", "en"), { amount: "€10.80", suffix: "/mo incl. VAT", note: null });
  assert.deepEqual(planPriceParts(0, "month", "en"), { amount: "€0", suffix: "/mo", note: null });
});

test("yearly is ten months for twelve: the per-month figure and the yearly charge", () => {
  const pro = planPriceParts(20, "year", "en");
  assert.equal(pro.amount, "€20");
  assert.equal(pro.note, "€240 incl. VAT, billed once a year");
});

test("French and German labels are the legal wording, never the HT suffix", () => {
  assert.match(perMonthSuffix("fr"), /TTC/);
  assert.match(perMonthSuffix("de"), /inkl\. MwSt\./);
  assert.match(planPriceParts(20, "month", "fr-FR").amount, /24/);
  assert.match(vatNote("en"), /include 20% French VAT/);
});

test("no plan in the lineup renders an HT figure through planPriceParts", () => {
  for (const plan of PLAN_LIST) {
    const parts = planPriceParts(plan.price, "month", "en");
    assert.doesNotMatch(parts.suffix, /HT|excl/);
  }
});
