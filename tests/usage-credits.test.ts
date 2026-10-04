import test from "node:test";
import assert from "node:assert/strict";
import {
  CREDIT_SHARE_OF_HT,
  REFERRAL_MAX_REWARDS,
  TOP_UP_PACKS,
  addMonthsUtc,
  availableCreditMicroUsd,
  budgetFallback,
  canBuyTopUp,
  canonicalMailbox,
  creditEurToMicroUsd,
  creditExpiry,
  creditShortfall,
  generateReferralCode,
  isBudgetLow,
  normalizeReferralCode,
  periodCreditCeilingMicroUsd,
  planCreditDraws,
  referralVerdict,
  renewalReminderDue,
  type CreditLot,
} from "@/lib/credits";
import { effectiveBudget, windowBaseMicroUsd } from "@/lib/spend-ceiling";
import { checkoutIntent, isPaidSubscriptionInvoice, topUpCreditMicroUsd } from "@/lib/billing/stripe-events";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 4, 12);

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

test("a pack credits 55% of its HT price", () => {
  assert.equal(CREDIT_SHARE_OF_HT, 0.55);
  assert.equal(TOP_UP_PACKS["5"].creditEur, 2.75);
  assert.equal(TOP_UP_PACKS["20"].creditEur, 11);
  assert.equal(topUpCreditMicroUsd("5"), 2_750_000);
  assert.equal(topUpCreditMicroUsd("20"), 11_000_000);
  // At a 0.92 EUR/USD billing rate a euro of credit buys more dollars of model.
  assert.equal(creditEurToMicroUsd(11, 0.92), Math.round((11 / 0.92) * 1_000_000));
});

test("only paid plans may buy a top-up", () => {
  assert.equal(canBuyTopUp("FREE"), false);
  assert.equal(canBuyTopUp("OWNER"), false);
  for (const p of ["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const) assert.equal(canBuyTopUp(p), true);
});

test("a credit is valid twelve calendar months, clamped at month end", () => {
  assert.equal(creditExpiry(new Date(Date.UTC(2026, 9, 4))).toISOString(), "2027-10-04T00:00:00.000Z");
  assert.equal(addMonthsUtc(new Date(Date.UTC(2028, 1, 29)), 12).toISOString(), "2029-02-28T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Ledger arithmetic
// ---------------------------------------------------------------------------

const lots: CreditLot[] = [
  { id: "b", remainingMicroUsd: 2_000_000, expiresAtMs: NOW + 100 * DAY },
  { id: "a", remainingMicroUsd: 2_750_000, expiresAtMs: NOW + 30 * DAY },
  { id: "expired", remainingMicroUsd: 9_000_000, expiresAtMs: NOW - DAY },
  { id: "empty", remainingMicroUsd: 0, expiresAtMs: NOW + 10 * DAY },
];

test("available credit ignores expired and empty lots", () => {
  assert.equal(availableCreditMicroUsd(lots, NOW), 4_750_000);
});

test("nothing is drawn while spend is inside the plan budget", () => {
  assert.equal(creditShortfall({ committedMicroUsd: 10_999_999, planBudgetMicroUsd: 11_000_000, drawnMicroUsd: 0 }), 0);
});

test("spend above the plan budget is owed by credits, minus what is already drawn", () => {
  assert.equal(creditShortfall({ committedMicroUsd: 12_500_000, planBudgetMicroUsd: 11_000_000, drawnMicroUsd: 0 }), 1_500_000);
  assert.equal(creditShortfall({ committedMicroUsd: 12_500_000, planBudgetMicroUsd: 11_000_000, drawnMicroUsd: 1_000_000 }), 500_000);
  // Already drawn more than the overage (a plan upgraded mid-period): never negative.
  assert.equal(creditShortfall({ committedMicroUsd: 12_000_000, planBudgetMicroUsd: 27_500_000, drawnMicroUsd: 1_000_000 }), 0);
});

test("draws take the soonest-expiring lot first and spill into the next", () => {
  const plan = planCreditDraws(lots, 3_000_000, NOW);
  assert.deepEqual(plan.draws, [
    { id: "a", amountMicroUsd: 2_750_000 },
    { id: "b", amountMicroUsd: 250_000 },
  ]);
  assert.equal(plan.drawnMicroUsd, 3_000_000);
});

test("a draw larger than the credit takes all of it and no more", () => {
  const plan = planCreditDraws(lots, 50_000_000, NOW);
  assert.equal(plan.drawnMicroUsd, 4_750_000);
  assert.ok(plan.draws.every((d) => d.id !== "expired" && d.id !== "empty"));
});

test("credits extend the monthly ceiling, and only the monthly ceiling", () => {
  const credit = periodCreditCeilingMicroUsd({ drawnMicroUsd: 1_000_000, availableMicroUsd: 1_750_000 });
  assert.equal(credit, 2_750_000);
  const eff = effectiveBudget({ planBudgetMicroUsd: 11_000_000, userCapEur: null, capDisabled: false, creditMicroUsd: credit });
  assert.equal(eff.budgetMicroUsd, 13_750_000);
  assert.equal(eff.source, "plan");
  // The 5-hour and weekly windows are sliced from the plan's figure alone.
  assert.equal(windowBaseMicroUsd(eff), 11_000_000);
});

test("an account's own lower cap still binds over plan + credit", () => {
  const eff = effectiveBudget({ planBudgetMicroUsd: 11_000_000, userCapEur: 12, capDisabled: false, creditMicroUsd: 11_000_000 });
  assert.equal(eff.budgetMicroUsd, 12_000_000);
  assert.equal(eff.source, "user");
  assert.equal(windowBaseMicroUsd(eff), 11_000_000);
  const lower = effectiveBudget({ planBudgetMicroUsd: 11_000_000, userCapEur: 5, capDisabled: false, creditMicroUsd: 11_000_000 });
  assert.equal(lower.budgetMicroUsd, 5_000_000);
  assert.equal(windowBaseMicroUsd(lower), 5_000_000);
});

test("the owner's ceiling ignores credits; no credit leaves the result unchanged", () => {
  const owner = effectiveBudget({ planBudgetMicroUsd: null, userCapEur: null, capDisabled: false, creditMicroUsd: 5_000_000 });
  assert.equal(owner.source, "personal-default");
  assert.equal(owner.creditMicroUsd, undefined);
  const plain = effectiveBudget({ planBudgetMicroUsd: 11_000_000, userCapEur: null, capDisabled: false });
  assert.deepEqual(plain, { budgetMicroUsd: 11_000_000, source: "plan", capDisabled: false });
});

// ---------------------------------------------------------------------------
// The fair fallback
// ---------------------------------------------------------------------------

test("the budget is low below 10% remaining", () => {
  assert.equal(isBudgetLow(1_000_000, 11_000_000), true);
  assert.equal(isBudgetLow(1_100_000, 11_000_000), false);
  assert.equal(isBudgetLow(null, 11_000_000), false);
  assert.equal(isBudgetLow(0, null), false);
});

const ORDER = ["FREE", "LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"] as const;

test("a spent paid plan is offered top-ups and the next tier for sale", () => {
  const fb = budgetFallback({ plan: "PRO", planOrder: ORDER, sellable: (p) => p !== "PLUS", sellableTopUps: ["5", "20"] });
  assert.deepEqual(fb.options, ["topup", "upgrade"]);
  assert.deepEqual(fb.topUpPacks.map((p) => p.id), ["5", "20"]);
  assert.equal(fb.cheapestUpgrade, "MAX"); // PLUS not for sale here
});

test("Free is offered an upgrade only; Ultra a top-up only", () => {
  const free = budgetFallback({ plan: "FREE", planOrder: ORDER, sellable: () => true, sellableTopUps: ["5", "20"] });
  assert.deepEqual(free.options, ["upgrade"]);
  assert.equal(free.cheapestUpgrade, "LITE");
  assert.deepEqual(free.topUpPacks, []);
  const ultra = budgetFallback({ plan: "ULTRA", planOrder: ORDER, sellable: () => true, sellableTopUps: ["20"] });
  assert.deepEqual(ultra.options, ["topup"]);
  assert.equal(ultra.cheapestUpgrade, null);
  assert.deepEqual(ultra.topUpPacks.map((p) => p.id), ["20"]);
});

// ---------------------------------------------------------------------------
// Referrals
// ---------------------------------------------------------------------------

test("codes are 8 unambiguous characters and normalise case", () => {
  const code = generateReferralCode((n) => new Uint8Array(n).map((_, i) => i * 37));
  assert.equal(code.length, 8);
  assert.match(code, /^[2-9A-HJKMNP-Z]{8}$/);
  assert.equal(normalizeReferralCode(code.toLowerCase()), code);
  assert.equal(normalizeReferralCode("ABCD0OIL"), null);
  assert.equal(normalizeReferralCode("short"), null);
  assert.equal(normalizeReferralCode(42), null);
});

test("a gmail alias is the same mailbox", () => {
  assert.equal(canonicalMailbox("Jo.Smith+promo@googlemail.com"), "josmith@gmail.com");
  assert.equal(canonicalMailbox("jo.smith+x@example.com"), "jo.smith@example.com");
});

const base = {
  alreadyRewarded: false,
  referrerEmail: "ana@example.com",
  referredEmail: "ben@example.com",
  referrerCustomerId: "cus_a",
  referredCustomerId: "cus_b",
  referrerRewardedCount: 0,
  amountPaidCents: 1080,
};

test("a first paid payment rewards both sides", () => {
  assert.deepEqual(referralVerdict(base), { reward: true });
});

test("self-referral by mailbox alias or shared customer is refused", () => {
  assert.deepEqual(referralVerdict({ ...base, referredEmail: "ana+2@example.com" }), { reward: false, reason: "self_referral" });
  assert.deepEqual(referralVerdict({ ...base, referredCustomerId: "cus_a" }), { reward: false, reason: "self_referral" });
});

test("the referrer cap is 20 rewarded referrals", () => {
  assert.equal(REFERRAL_MAX_REWARDS, 20);
  assert.equal(referralVerdict({ ...base, referrerRewardedCount: 19 }).reward, true);
  assert.deepEqual(referralVerdict({ ...base, referrerRewardedCount: 20 }), { reward: false, reason: "referrer_cap" });
});

test("a zero invoice or an already rewarded referral earns nothing", () => {
  assert.deepEqual(referralVerdict({ ...base, amountPaidCents: 0 }), { reward: false, reason: "not_paid" });
  assert.deepEqual(referralVerdict({ ...base, alreadyRewarded: true }), { reward: false, reason: "already_rewarded" });
});

test("only a paid subscription invoice can trigger a referral", () => {
  const inv = { customer: "cus_b", amount_paid: 1080, billing_reason: "subscription_create" };
  assert.equal(isPaidSubscriptionInvoice(inv), true);
  assert.equal(isPaidSubscriptionInvoice({ ...inv, billing_reason: "manual" }), false);
  assert.equal(isPaidSubscriptionInvoice({ ...inv, amount_paid: 0 }), false);
});

// ---------------------------------------------------------------------------
// Checkout sessions
// ---------------------------------------------------------------------------

test("a checkout session is read as a subscription, a top-up, or nothing", () => {
  assert.deepEqual(checkoutIntent({ id: "cs_1", mode: "subscription", payment_status: "paid", subscription: "sub_1" }), {
    kind: "subscription",
    subscriptionId: "sub_1",
  });
  assert.deepEqual(
    checkoutIntent({ id: "cs_2", mode: "payment", payment_status: "paid", metadata: { kind: "topup", pack: "20", userId: "u1" } }),
    { kind: "topup", pack: "20", userId: "u1", paid: true }
  );
  // SEPA: completed but not yet paid — credited later on async_payment_succeeded.
  const sepa = checkoutIntent({ id: "cs_3", mode: "payment", payment_status: "unpaid", metadata: { kind: "topup", pack: "5", userId: "u1" } });
  assert.equal(sepa.kind === "topup" && sepa.paid, false);
  assert.deepEqual(checkoutIntent({ id: "cs_4", mode: "payment", payment_status: "paid", metadata: { kind: "topup", pack: "7", userId: "u1" } }), { kind: "ignore" });
});

// ---------------------------------------------------------------------------
// Renewal reminders (L215-1)
// ---------------------------------------------------------------------------

test("the renewal notice goes out between one and three months before renewal", () => {
  assert.equal(renewalReminderDue(NOW + 60 * DAY, NOW), true);
  assert.equal(renewalReminderDue(NOW + 88 * DAY, NOW), true);
  assert.equal(renewalReminderDue(NOW + 89 * DAY, NOW), false); // too early
  assert.equal(renewalReminderDue(NOW + 32 * DAY, NOW), true);
  assert.equal(renewalReminderDue(NOW + 31 * DAY, NOW), false); // too late
});
