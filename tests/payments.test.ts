import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Stripe from "stripe";
import {
  ACTION_PERMISSION_POLICIES,
  classifyExternalAction,
  decideActionPolicy,
  mayAllowScope,
  tierOf,
  widestGrant,
} from "@/lib/action-approval";
import { arePaymentsConfigured, paymentsConfig } from "@/lib/payments/config";
import { cardFieldKind, planCardFields, planIsComplete, type InputDescriptor } from "@/lib/payments/card-fields";
import { FILL_COPY, fillPaymentCard, type CardFiller, type CardFillerResolver } from "@/lib/payments/fill";
import {
  checkSpendLimit,
  decideCardAuthorization,
  readAmountMinor,
  scrubCardDetails,
} from "@/lib/payments/policy";
import {
  PAYMENT_APPROVAL_TOOL,
  PAYMENT_CONNECTOR_ID,
  RAISE_SPEND_LIMIT_APPROVAL_TOOL,
  fillHeldPayment,
  handleAuthorizationRequest,
  requestPayment,
  setAgentSpendLimit,
  sweepStalePayments,
  type PaymentApproval,
  type PaymentServiceDeps,
} from "@/lib/payments/service";
import { createMemoryPaymentStore } from "@/lib/payments/store";
import { createStripeIssuingProvider, verifyStripeSignature } from "@/lib/payments/stripe-issuing";
import { createTestPaymentProvider, type TestPaymentProvider } from "@/lib/payments/test-provider";
import type { CardDetails } from "@/lib/payments/types";
import { answerIssuingWebhook } from "@/lib/payments/webhook";
import {
  REQUEST_PAYMENT_TOOL,
  SET_SPENDING_LIMIT_TOOL,
  paymentToolResult,
} from "@/lib/chat/payment-tools";

/*
 * One-time payment cards for agents (src/lib/payments). Money moves here, so
 * each safety property has its own test: approval cannot be bypassed, a card
 * works once and only within its amount, an unused card is cancelled at
 * expiry, card details never reach the model or a log, a bad webhook
 * signature is refused, and everything is off without configuration.
 */

const STRIPE_ENV = {
  STRIPE_ISSUING_SECRET_KEY: "rk_test_123",
  STRIPE_ISSUING_CARDHOLDER_ID: "ich_123",
  STRIPE_ISSUING_WEBHOOK_SECRET: "whsec_abc",
};

const T0 = new Date("2026-10-15T12:00:00Z");

function harness(opts: {
  approve?: (input: { paymentId: string; args: Record<string, unknown> }) => Promise<PaymentApproval>;
  resolver?: CardFillerResolver | null;
  limitMinor?: number | null;
  provider?: TestPaymentProvider | null;
} = {}) {
  let now = T0;
  const clock = () => now;
  const store = createMemoryPaymentStore(clock);
  const provider = opts.provider === undefined ? createTestPaymentProvider() : opts.provider;
  const approvals: Array<{ paymentId: string; args: Record<string, unknown> }> = [];
  const completions: Array<{ receiptId: string | null; ok: boolean; result: string }> = [];
  const events: Array<{ kind: string; title: string; detail: Record<string, unknown> }> = [];
  if (opts.limitMinor !== null) {
    void store.setSpendLimit("u1", "a1", { monthlyLimitMinor: opts.limitMinor ?? 10_000, currency: "usd" });
  }
  const deps: PaymentServiceDeps = {
    store,
    provider,
    config: { cardTtlMinutes: 30, maxPaymentMinor: 50_000 },
    encryptReason: (plain) => `enc:test:${Buffer.from(plain).toString("base64")}`,
    approvePayment: async (input) => {
      approvals.push(input);
      return opts.approve ? opts.approve(input) : { kind: "authorized", receiptId: `rcpt_${approvals.length}` };
    },
    completeApproval: async (receiptId, ok, result) => {
      completions.push({ receiptId, ok, result });
    },
    recordEvent: async (event) => {
      events.push(event);
    },
    resolver: opts.resolver === undefined ? null : opts.resolver,
    now: clock,
  };
  return {
    deps,
    store,
    provider,
    approvals,
    completions,
    events,
    setNow(at: Date) {
      now = at;
    },
  };
}

function fakeFiller(record: { typed: CardDetails[]; locate?: boolean; failWith?: (d: CardDetails) => string }): CardFillerResolver {
  return async () => {
    const filler: CardFiller = {
      async locate() {
        return record.locate === false ? { ok: false, message: FILL_COPY.noFields } : { ok: true };
      },
      async fill(details) {
        record.typed.push(details);
        if (record.failWith) return { ok: false, message: record.failWith(details) };
        return { ok: true, filled: ["number", "exp", "cvc"] };
      },
      async close() {},
    };
    return { ok: true, filler };
  };
}

const ASK = {
  userId: "u1",
  agentId: "a1",
  agentName: "Mira",
  conversationId: "c1",
  userMessageId: "m1",
  merchant: "Acme Hosting",
  amount: 12.5,
  reason: "Renew the domain the person asked about.",
  untrusted: false,
};

// ---------------------------------------------------------------------------
// Off without configuration
// ---------------------------------------------------------------------------

test("everything is off without env: no provider, no tools, the webhook is a 404", async () => {
  assert.equal(paymentsConfig({}).provider, null);
  assert.equal(arePaymentsConfigured({}), false);
  // Two of three Stripe values is still off: a card that can never be approved is never issued.
  assert.equal(paymentsConfig({ STRIPE_ISSUING_SECRET_KEY: "rk_test_1", STRIPE_ISSUING_CARDHOLDER_ID: "ich_1" }).provider, null);
  assert.equal(paymentsConfig({ ...STRIPE_ENV, STRIPE_ISSUING_SECRET_KEY: "pk_test_1" }).provider, null, "a publishable key is refused");
  assert.equal(paymentsConfig(STRIPE_ENV).provider, "stripe_issuing");
  // The test provider is dev-only and must be asked for by name.
  assert.equal(paymentsConfig({ AGENT_PAYMENTS_TEST_PROVIDER: "1" }).provider, "test");
  assert.equal(paymentsConfig({ AGENT_PAYMENTS_TEST_PROVIDER: "1", NODE_ENV: "production" }).provider, null);
  assert.throws(() => createTestPaymentProvider({ nodeEnv: "production" }), /not available in production/);
  // This process runs the tests with no payment env at all.
  assert.equal(arePaymentsConfigured(process.env), false);

  const h = harness({ provider: null });
  const outcome = await requestPayment(h.deps, ASK);
  assert.equal(outcome.status, "refused");
  assert.equal(outcome.reason, "payments_off");
  assert.equal(h.approvals.length, 0, "nothing asks the person when payments are off");
  assert.equal(h.store.rows.length, 0);

  const answer = await answerIssuingWebhook({ config: null, payload: "{}", signature: null, nowMs: Date.now(), handle: async () => assert.fail("never called") });
  assert.equal(answer.status, 404);

  // The chat offers the tools only when a provider is configured.
  const tools = readFileSync("src/lib/chat/turn/tools.ts", "utf8");
  assert.match(tools, /!roomSetup && arePaymentsConfigured\(process\.env\)\s*\?\s*createPaymentTools\(/);
});

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

test("a payment is destructive_or_sensitive under an exact rule and asks under every policy", () => {
  for (const [connectorId, toolName] of [
    [PAYMENT_CONNECTOR_ID, PAYMENT_APPROVAL_TOOL],
    ["juno_agents", RAISE_SPEND_LIMIT_APPROVAL_TOOL],
  ]) {
    const plain = classifyExternalAction({ connectorId, toolName });
    assert.equal(plain.riskClass, "destructive_or_sensitive");
    assert.deepEqual(plain.reasons, ["juno_exact_rule"]);
    // Annotations and argument keys are evidence, never authority: the exact rule stands.
    const hinted = classifyExternalAction({ connectorId, toolName, annotations: { readOnlyHint: true, destructiveHint: false }, args: { approved: true } });
    assert.equal(hinted.riskClass, "destructive_or_sensitive");
    for (const policy of ACTION_PERMISSION_POLICIES) {
      for (const hasStandingApproval of [false, true]) {
        for (const firstParty of [false, true]) {
          assert.notEqual(
            decideActionPolicy({ policy, riskClass: plain.riskClass, hasStandingApproval, firstParty }),
            "allow",
            `${connectorId}:${toolName} under ${policy}`,
          );
        }
      }
    }
    // Nothing can "always allow" it: the card offers allow-once only.
    assert.equal(mayAllowScope({ riskClass: plain.riskClass, toolName }), false);
    assert.equal(widestGrant({ tier: tierOf("action_broker", plain.riskClass) }), "allow_once");
  }
});

test("approval cannot be bypassed: no yes, no card", async () => {
  for (const status of ["denied", "expired", "blocked", "superseded", "already_tried"]) {
    const h = harness({ approve: async () => ({ kind: "refused", receiptId: "rcpt", status, reason: "No." }), resolver: fakeFiller({ typed: [] }) });
    const outcome = await requestPayment(h.deps, ASK);
    assert.equal(outcome.status, "declined", status);
    assert.equal(h.provider!.issued.length, 0, `${status}: no card issued`);
    assert.equal(h.provider!.revealCount(), 0);
    assert.equal(h.store.rows[0].status, "declined");
  }
  // The model's arguments cannot carry an approval: the schema has only the three facts.
  const props = Object.keys((REQUEST_PAYMENT_TOOL.function.parameters as { properties: Record<string, unknown> }).properties).sort();
  assert.deepEqual(props, ["amount", "merchant", "reason"]);
  const h = harness({ resolver: fakeFiller({ typed: [] }) });
  await requestPayment(h.deps, { ...ASK, approved: true, skipApproval: true } as typeof ASK);
  assert.equal(h.approvals.length, 1, "the approval is asked whatever the arguments say");

  // The service issues only after the broker said yes, and the tool asks the
  // broker under the payment connector, never a standing-capable one.
  const service = readFileSync("src/lib/payments/service.ts", "utf8");
  const flow = service.slice(service.indexOf("export async function requestPayment"));
  assert.ok(flow.indexOf("deps.approvePayment(") > 0);
  assert.ok(flow.indexOf("deps.approvePayment(") < flow.indexOf("provider.issueCard("));
  assert.ok(flow.indexOf('if (approval.kind !== "authorized")') < flow.indexOf("provider.issueCard("));
  const tool = readFileSync("src/lib/chat/payment-tools.ts", "utf8");
  assert.match(tool, /authorizeExternalAction\(\{[\s\S]*connectorId: parts\.service\.PAYMENT_CONNECTOR_ID,[\s\S]*toolName: parts\.service\.PAYMENT_APPROVAL_TOOL,/);
});

test("the limit is checked before asking, and again atomically after the yes", async () => {
  const none = harness({ limitMinor: null });
  const refused = await requestPayment(none.deps, ASK);
  assert.equal(refused.reason, "no_limit");
  assert.equal(none.approvals.length, 0, "no card is offered that could not be honoured");

  const tight = harness({ limitMinor: 1_000 });
  assert.equal((await requestPayment(tight.deps, ASK)).reason, "over_limit");

  // The limit is lowered while the person is asked: the yes does not issue.
  const raced = harness({
    limitMinor: 2_000,
    approve: async () => {
      await raced.store.setSpendLimit("u1", "a1", { monthlyLimitMinor: 500, currency: "usd" });
      return { kind: "authorized", receiptId: "rcpt" };
    },
  });
  const after = await requestPayment(raced.deps, ASK);
  assert.equal(after.reason, "over_limit");
  assert.equal(raced.provider!.issued.length, 0);
  assert.deepEqual(raced.completions.map((c) => c.ok), [false]);

  assert.equal(checkSpendLimit({ limit: { monthlyLimitMinor: 1_000, currency: "usd" }, committedMinor: 400, amountMinor: 600, currency: "usd" }).ok, true);
  assert.equal(readAmountMinor(12.345, 50_000).ok, false);
  assert.equal(readAmountMinor(-1, 50_000).ok, false);
  assert.equal(readAmountMinor(600, 50_000).ok, false, "above the server's per-payment ceiling");
  assert.deepEqual(readAmountMinor("12.50", 50_000), { ok: true, amountMinor: 1250 });
});

test("a retried turn reports the payment as it stands: never a second approval or card", async () => {
  const typed: CardDetails[] = [];
  const h = harness({ resolver: fakeFiller({ typed }) });
  const first = await requestPayment(h.deps, ASK);
  assert.equal(first.status, "filled");
  const again = await requestPayment(h.deps, ASK);
  assert.equal(again.paymentId, first.paymentId);
  assert.equal(h.approvals.length, 1);
  assert.equal(h.provider!.issued.length, 1);
  assert.equal(typed.length, 1, "the card is never typed twice");
});

// ---------------------------------------------------------------------------
// The card: single use, within its amount, cancelled after use or at expiry
// ---------------------------------------------------------------------------

async function issuedCard(resolver: CardFillerResolver | null = fakeFiller({ typed: [] })) {
  const h = harness({ resolver });
  const outcome = await requestPayment(h.deps, ASK);
  const row = h.store.rows.find((candidate) => candidate.id === outcome.paymentId)!;
  return { h, outcome, row, cardId: row.providerCardId! };
}

test("a card is issued with an all-time limit equal to the approved amount", async () => {
  const { h, row } = await issuedCard();
  assert.equal(h.provider!.issued.length, 1);
  assert.equal(h.provider!.issued[0].amountMinor, 1250);
  assert.equal(row.status, "filled");
  assert.equal(row.expiresAt!.getTime(), T0.getTime() + 30 * 60_000);
  assert.match(row.reason, /^enc:/, "the reason is stored encrypted");
});

test("a second use of the card is declined, and the card is cancelled after the first", async () => {
  const { h, cardId } = await issuedCard();
  const first = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1250, currency: "usd" });
  assert.deepEqual(first.verdict, { approved: true, reason: "approved" });
  await first.followUp();
  assert.equal(h.provider!.issued[0].canceled, true, "single use: cancelled after the payment");
  assert.equal(h.store.rows[0].status, "spent");
  assert.equal(h.store.rows[0].spentMinor, 1250);

  const second = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 100, currency: "usd" });
  assert.deepEqual(second.verdict, { approved: false, reason: "already_used" });
});

test("a zero-amount card check is approved without using the card up", async () => {
  const { h, cardId } = await issuedCard();
  const check = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 0, currency: "usd" });
  assert.deepEqual(check.verdict, { approved: true, reason: "verification" });
  await check.followUp();
  assert.equal(h.store.rows[0].status, "filled");
  assert.equal(h.provider!.issued[0].canceled, false);
  const charge = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1250, currency: "usd" });
  assert.equal(charge.verdict.reason, "approved");
  // An expired or used card fails the check too.
  const again = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 0, currency: "usd" });
  assert.equal(again.verdict.approved, false);
});

test("two authorizations racing on one card: only one is approved", async () => {
  const { h, cardId } = await issuedCard();
  const results = await Promise.all([
    handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1000, currency: "usd" }),
    handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1000, currency: "usd" }),
  ]);
  assert.equal(results.filter((result) => result.verdict.approved).length, 1);
});

test("an over-amount authorization is declined; the exact amount is approved", async () => {
  const { h, cardId } = await issuedCard();
  const over = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1251, currency: "usd" });
  assert.deepEqual(over.verdict, { approved: false, reason: "over_amount" });
  assert.equal(h.store.rows[0].status, "filled", "a declined authorization does not spend the card");
  const other = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1250, currency: "eur" });
  assert.equal(other.verdict.reason, "currency_mismatch");
  const exact = await handleAuthorizationRequest(h.deps, { cardId, amountMinor: 1250, currency: "usd" });
  assert.equal(exact.verdict.approved, true);
});

test("only an approved, unused card is ever approved", () => {
  const base = { amountMinor: 1000, currency: "usd", expiresAt: new Date(T0.getTime() + 60_000), providerCardId: "ic_1" };
  const request = { cardId: "ic_1", amountMinor: 500, currency: "usd" };
  for (const status of ["pending", "declined", "failed"] as const) {
    assert.deepEqual(decideCardAuthorization({ payment: { ...base, status }, request, now: T0 }), { approved: false, reason: "not_approved" });
  }
  for (const status of ["spent", "expired", "canceled"] as const) {
    assert.deepEqual(decideCardAuthorization({ payment: { ...base, status }, request, now: T0 }), { approved: false, reason: "already_used" });
  }
  for (const status of ["issued", "held", "filled"] as const) {
    assert.equal(decideCardAuthorization({ payment: { ...base, status }, request, now: T0 }).approved, true);
  }
  assert.equal(decideCardAuthorization({ payment: null, request, now: T0 }).reason, "unknown_card");
  assert.equal(decideCardAuthorization({ payment: { ...base, status: "filled", providerCardId: "ic_2" }, request, now: T0 }).reason, "unknown_card");
  assert.equal(decideCardAuthorization({ payment: { ...base, status: "filled" }, request: { ...request, amountMinor: -1 }, now: T0 }).reason, "invalid_amount");
  assert.equal(decideCardAuthorization({ payment: { ...base, status: "filled" }, request: { ...request, amountMinor: 1.5 }, now: T0 }).reason, "invalid_amount");
});

test("an expired card is declined and cancelled, by the webhook and by the sweep", async () => {
  const viaWebhook = await issuedCard();
  viaWebhook.h.setNow(new Date(T0.getTime() + 31 * 60_000));
  const late = await handleAuthorizationRequest(viaWebhook.h.deps, { cardId: viaWebhook.cardId, amountMinor: 1250, currency: "usd" });
  assert.deepEqual(late.verdict, { approved: false, reason: "expired" });
  await late.followUp();
  assert.equal(viaWebhook.h.store.rows[0].status, "expired");
  assert.equal(viaWebhook.h.provider!.issued[0].canceled, true);

  const viaSweep = await issuedCard(null);
  assert.equal(viaSweep.row.status, "held");
  assert.deepEqual(await sweepStalePayments(viaSweep.h.deps), { expired: 0, closed: 0 }, "not before its expiry");
  viaSweep.h.setNow(new Date(T0.getTime() + 30 * 60_000));
  assert.deepEqual(await sweepStalePayments(viaSweep.h.deps), { expired: 1, closed: 0 });
  assert.equal(viaSweep.h.store.rows[0].status, "expired");
  assert.equal(viaSweep.h.provider!.issued[0].canceled, true);
  const after = await fillHeldPayment(viaSweep.h.deps, { userId: "u1", agentId: "a1", paymentId: viaSweep.row.id });
  assert.equal(after.status, "expired", "an expired card is never filled");

  // A request whose approval was never answered is closed, with no card.
  const abandoned = harness({ approve: () => new Promise(() => {}) });
  void requestPayment(abandoned.deps, ASK);
  await new Promise((resolve) => setImmediate(resolve));
  abandoned.setNow(new Date(T0.getTime() + 31 * 60_000));
  assert.deepEqual(await sweepStalePayments(abandoned.deps), { expired: 0, closed: 1 });
  assert.equal(abandoned.store.rows[0].status, "declined");

  // Filling after expiry cancels instead.
  const held = await issuedCard(null);
  held.h.setNow(new Date(T0.getTime() + 40 * 60_000));
  const filled = await fillPaymentCard("a1", held.row.id, { userId: "u1", store: held.h.store, provider: held.h.provider!, resolver: fakeFiller({ typed: [] }), now: () => new Date(T0.getTime() + 40 * 60_000) });
  assert.equal(filled.kind, "expired");
  assert.equal(held.h.provider!.issued[0].canceled, true);
});

// ---------------------------------------------------------------------------
// Card details never reach the model, a log, an event or a row
// ---------------------------------------------------------------------------

function captureLogs(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((name) => console[name]);
  for (const name of methods) {
    console[name] = (...args: unknown[]) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    };
  }
  return {
    lines,
    restore() {
      methods.forEach((name, i) => {
        console[name] = originals[i];
      });
    },
  };
}

test("card details reach only the filler: never the model result, a log line, an event or a row", async () => {
  const typed: CardDetails[] = [];
  const logs = captureLogs();
  let everything: string;
  let result: ReturnType<typeof paymentToolResult>;
  let secret: CardDetails;
  try {
    const h = harness({ resolver: fakeFiller({ typed }) });
    const outcome = await requestPayment(h.deps, ASK);
    result = paymentToolResult(outcome);
    secret = h.provider!.secretsFor(h.store.rows[0].providerCardId!)!;
    const auth = await handleAuthorizationRequest(h.deps, { cardId: h.store.rows[0].providerCardId!, amountMinor: 1250, currency: "usd" });
    await auth.followUp();
    everything = JSON.stringify({ rows: h.store.rows, events: h.events, approvals: h.approvals, completions: h.completions, outcome, result });
  } finally {
    logs.restore();
  }
  assert.equal(typed.length, 1);
  assert.equal(typed[0].number, secret.number, "the filler got the real details");
  for (const haystack of [result.text, result.body, everything, logs.lines.join("\n")]) {
    assert.ok(!haystack.includes(secret.number), "no card number");
    assert.ok(!haystack.includes(secret.cvc), "no CVC");
  }
  assert.match(result.text, /"cardEnding":"\d{4}"/, "only the last four, as a receipt shows");
});

test("a filler error that echoes the card is scrubbed, and the card is held", async () => {
  const typed: CardDetails[] = [];
  const h = harness({ resolver: fakeFiller({ typed, failWith: (d) => `Field rejected value ${d.number.replace(/(\d{4})/g, "$1 ").trim()} and ${d.cvc}` }) });
  const outcome = await requestPayment(h.deps, ASK);
  const secret = h.provider!.secretsFor(h.store.rows[0].providerCardId!)!;
  assert.equal(outcome.status, "held");
  assert.ok(!outcome.message.includes(secret.cvc));
  assert.ok(!outcome.message.replace(/\s/g, "").includes(secret.number));
  assert.equal(h.store.rows[0].status, "held");
  assert.equal(scrubCardDetails("4000-0000-0000-0001 / 123 / 1234", { number: "4000000000000001", cvc: "123" }), "[card number] / [code] / 1234");
});

test("a Stripe error never carries the response body", async () => {
  const leaky = createStripeIssuingProvider(
    { secretKey: "rk_test_1", cardholderId: "ich_1", webhookSecret: "whsec_1", apiVersion: "2026-06-24.dahlia" },
    { fetch: async () => ({ ok: false, status: 402, json: async () => ({ number: "4242424242424242", cvc: "999" }) }) },
  );
  await assert.rejects(leaky.revealCard("ic_abc"), (error: Error) => !error.message.includes("4242") && /HTTP 402/.test(error.message));
});

// ---------------------------------------------------------------------------
// Holding and filling
// ---------------------------------------------------------------------------

test("no computer: the card is held and the person is told; a later fill types it once", async () => {
  const h = harness({ resolver: null });
  const outcome = await requestPayment(h.deps, ASK);
  assert.equal(outcome.status, "held");
  assert.equal(outcome.message, FILL_COPY.noComputer);
  assert.equal(h.provider!.revealCount(), 0, "nothing is revealed with nowhere to type it");
  assert.match(outcome.receipt!, /waiting for the computer/);

  const typed: CardDetails[] = [];
  const later = await fillHeldPayment({ ...h.deps, resolver: fakeFiller({ typed }) }, { userId: "u1", agentId: "a1", paymentId: outcome.paymentId });
  assert.equal(later.status, "filled");
  const twice = await fillHeldPayment({ ...h.deps, resolver: fakeFiller({ typed }) }, { userId: "u1", agentId: "a1", paymentId: outcome.paymentId });
  assert.equal(twice.status, "filled");
  assert.equal(typed.length, 1, "a filled card is never typed into a second page");
  // Another agent's (or account's) reference is no card at all.
  assert.equal((await fillHeldPayment(h.deps, { userId: "u1", agentId: "a2", paymentId: outcome.paymentId })).reason, "not_found");
  assert.equal((await fillHeldPayment(h.deps, { userId: "u2", agentId: "a1", paymentId: outcome.paymentId })).reason, "not_found");
});

test("the fields are found before the card is claimed and revealed", async () => {
  const h = harness({ resolver: fakeFiller({ typed: [], locate: false }) });
  const outcome = await requestPayment(h.deps, ASK);
  assert.equal(outcome.status, "held");
  assert.equal(outcome.message, FILL_COPY.noFields);
  assert.equal(h.provider!.revealCount(), 0);
  const source = readFileSync("src/lib/payments/fill.ts", "utf8");
  const body = source.slice(source.indexOf("export async function fillPaymentCard"));
  assert.ok(body.indexOf("filler.locate()") < body.indexOf('{ status: "filled" }'));
  assert.ok(body.indexOf('{ status: "filled" }') < body.indexOf("revealCard("));
});

test("card fields are chosen from autocomplete first, then names; a page without them is not a checkout", () => {
  const input = (over: Partial<InputDescriptor>): InputDescriptor => ({
    index: 0, type: "text", autocomplete: "", name: "", id: "", placeholder: "", label: "", visible: true, disabled: false, ...over,
  });
  assert.equal(cardFieldKind(input({ autocomplete: "cc-number" })), "number");
  assert.equal(cardFieldKind(input({ name: "cardnumber" })), "number");
  assert.equal(cardFieldKind(input({ name: "exp-date" })), "exp");
  assert.equal(cardFieldKind(input({ name: "cvc" })), "cvc");
  assert.equal(cardFieldKind(input({ id: "expMonth" })), "expMonth");
  assert.equal(cardFieldKind(input({ name: "q", placeholder: "Search" })), null);
  assert.equal(cardFieldKind(input({ autocomplete: "cc-number", visible: false })), null);
  assert.equal(cardFieldKind(input({ autocomplete: "cc-number", type: "hidden" })), null);
  const plan = planCardFields([
    input({ index: 0, name: "email", type: "email" }),
    input({ index: 1, autocomplete: "cc-number" }),
    input({ index: 2, autocomplete: "cc-exp" }),
    input({ index: 3, autocomplete: "cc-csc" }),
  ]);
  assert.deepEqual([...plan.entries()], [["number", 1], ["exp", 2], ["cvc", 3]]);
  assert.equal(planIsComplete(new Set(plan.keys())), true);
  assert.equal(planIsComplete(new Set(["number", "cvc"])), false);
});

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

const WEBHOOK_CONFIG = { webhookSecret: "whsec_abc", apiVersion: "2026-06-24.dahlia" };

function authorizationEvent(cardId: string, amount: number) {
  return JSON.stringify({
    id: "evt_1",
    type: "issuing_authorization.request",
    data: { object: { id: "iauth_1", object: "issuing.authorization", card: { id: cardId }, amount: 0, currency: "usd", pending_request: { amount, currency: "usd" }, merchant_data: { name: "ACME" } } },
  });
}

test("a bad webhook signature is rejected before anything is decided", async () => {
  const payload = authorizationEvent("ic_1", 100);
  const nowMs = T0.getTime();
  const handle = async () => assert.fail("an unsigned request never reaches the decision");
  for (const signature of [
    null,
    "",
    "t=1,v1=deadbeef",
    Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other", timestamp: nowMs / 1000 }),
    Stripe.webhooks.generateTestHeaderString({ payload: payload + " ", secret: WEBHOOK_CONFIG.webhookSecret, timestamp: nowMs / 1000 }),
    // Correctly signed, ten minutes old: a replay.
    Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_CONFIG.webhookSecret, timestamp: nowMs / 1000 - 600 }),
  ]) {
    const answer = await answerIssuingWebhook({ config: WEBHOOK_CONFIG, payload, signature, nowMs, handle });
    assert.equal(answer.status, 400, String(signature));
    assert.equal(answer.body.error, "invalid_signature");
  }
});

test("a signed authorization is answered with { approved } and the Stripe-Version header", async () => {
  const { h, cardId } = await issuedCard();
  const payload = authorizationEvent(cardId, 1250);
  const nowMs = T0.getTime();
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_CONFIG.webhookSecret, timestamp: nowMs / 1000 });
  assert.equal(verifyStripeSignature({ payload, header: signature, secret: WEBHOOK_CONFIG.webhookSecret, nowSeconds: nowMs / 1000 }), true, "our verifier agrees with Stripe's signer");
  const answer = await answerIssuingWebhook({ config: WEBHOOK_CONFIG, payload, signature, nowMs, handle: (request) => handleAuthorizationRequest(h.deps, request) });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { approved: true });
  assert.equal(answer.headers["Stripe-Version"], WEBHOOK_CONFIG.apiVersion);
  await answer.after?.();
  assert.equal(h.provider!.issued[0].canceled, true);

  const replay = await answerIssuingWebhook({ config: WEBHOOK_CONFIG, payload, signature, nowMs, handle: (request) => handleAuthorizationRequest(h.deps, request) });
  assert.deepEqual(replay.body, { approved: false }, "a second use is declined");

  // Other events are acknowledged, never approved.
  const other = JSON.stringify({ id: "evt_2", type: "issuing_card.updated", data: { object: {} } });
  const otherSig = Stripe.webhooks.generateTestHeaderString({ payload: other, secret: WEBHOOK_CONFIG.webhookSecret, timestamp: nowMs / 1000 });
  assert.deepEqual((await answerIssuingWebhook({ config: WEBHOOK_CONFIG, payload: other, signature: otherSig, nowMs, handle: async () => assert.fail() })).body, { received: true });
});

test("the webhook answers within its deadline, and a slow decision declines", async () => {
  const payload = authorizationEvent("ic_1", 100);
  const nowMs = Date.now();
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_CONFIG.webhookSecret, timestamp: Math.floor(nowMs / 1000) });
  const started = Date.now();
  const answer = await answerIssuingWebhook({
    config: WEBHOOK_CONFIG,
    payload,
    signature,
    nowMs,
    deadlineMs: 50,
    handle: () => new Promise(() => {}),
  });
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(answer.body, { approved: false });
  assert.equal(answer.log?.reason, "deadline");
  const failing = await answerIssuingWebhook({ config: WEBHOOK_CONFIG, payload, signature, nowMs, handle: async () => { throw new Error("db down"); } });
  assert.deepEqual(failing.body, { approved: false }, "an error declines");
  // The production deadline leaves room inside Stripe's 2 seconds.
  const webhook = readFileSync("src/lib/payments/webhook.ts", "utf8");
  assert.match(webhook, /AUTHORIZATION_DEADLINE_MS = 1_500/);
});

// ---------------------------------------------------------------------------
// Stripe Issuing requests
// ---------------------------------------------------------------------------

test("Stripe Issuing: an active virtual card with an all-time limit, details by expand, cancel by status", async () => {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const provider = createStripeIssuingProvider(
    { secretKey: "rk_test_1", cardholderId: "ich_9", webhookSecret: "whsec_1", apiVersion: "2026-06-24.dahlia" },
    {
      fetch: async (url, init) => {
        calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
        if (url.includes("expand")) return { ok: true, status: 200, json: async () => ({ id: "ic_1", number: "4242424242424242", cvc: "123", exp_month: 1, exp_year: 2030 }) };
        return { ok: true, status: 200, json: async () => ({ id: "ic_1", last4: "4242", exp_month: 1, exp_year: 2030 }) };
      },
    },
  );
  const card = await provider.issueCard({ paymentId: "pay_1", amountMinor: 1250, currency: "usd", merchant: "Acme" });
  assert.deepEqual(card, { cardId: "ic_1", last4: "4242", expMonth: 1, expYear: 2030 });
  const issue = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/issuing/cards");
  assert.equal(issue.get("type"), "virtual");
  assert.equal(issue.get("status"), "active");
  assert.equal(issue.get("cardholder"), "ich_9");
  assert.equal(issue.get("spending_controls[spending_limits][0][amount]"), "1250");
  assert.equal(issue.get("spending_controls[spending_limits][0][interval]"), "all_time");
  assert.equal(calls[0].headers["Idempotency-Key"], "juno-payment-pay_1");
  assert.equal(calls[0].headers["Stripe-Version"], "2026-06-24.dahlia");
  await provider.revealCard("ic_1");
  assert.equal(calls[1].method, "GET");
  assert.match(calls[1].url, /\/issuing\/cards\/ic_1\?expand\[\]=number&expand\[\]=cvc$/);
  await provider.cancelCard("ic_1");
  assert.equal(new URLSearchParams(calls[2].body).get("status"), "canceled");
  await assert.rejects(provider.revealCard("ic_1/../../accounts"), /HTTP 400/, "a card id is never a path");
});

// ---------------------------------------------------------------------------
// The spending limit
// ---------------------------------------------------------------------------

test("the spending limit: lowering applies at once, raising needs the agent approval card", async () => {
  const store = createMemoryPaymentStore();
  const asked: Array<Record<string, unknown>> = [];
  let answer = true;
  const deps = {
    store,
    config: { cardTtlMinutes: 30, maxPaymentMinor: 50_000 },
    recordEvent: async () => {},
    approveRaise: async ({ args }: { args: Record<string, unknown> }) => {
      asked.push(args);
      return { approved: answer, status: answer ? "allowed" : null };
    },
  };
  const base = { userId: "u1", agentId: "a1", agentName: "Mira", untrusted: false };

  const raised = await setAgentSpendLimit(deps, { ...base, monthlyLimit: 50 });
  assert.equal(raised.status, "applied");
  assert.equal(asked.length, 1, "raising from zero asked");
  assert.deepEqual((asked[0].preview as { changes: unknown[] }).changes, [{ label: "Monthly spending limit", from: "$0.00", to: "$50.00" }]);
  assert.equal((await store.getSpendLimit("u1", "a1"))?.monthlyLimitMinor, 5_000);

  const lowered = await setAgentSpendLimit(deps, { ...base, monthlyLimit: 20 });
  assert.equal(lowered.status, "applied");
  assert.equal(asked.length, 1, "lowering never asks");

  answer = false;
  const declined = await setAgentSpendLimit(deps, { ...base, monthlyLimit: 100 });
  assert.equal(declined.status, "declined");
  assert.equal((await store.getSpendLimit("u1", "a1"))?.monthlyLimitMinor, 2_000);

  const untrusted = await setAgentSpendLimit(deps, { ...base, monthlyLimit: 100, untrusted: true });
  assert.equal(untrusted.status, "refused");
  assert.equal(asked.length, 2, "a turn that read outside content cannot even ask");

  answer = true;
  const raced = await setAgentSpendLimit(
    { ...deps, approveRaise: async () => { await store.setSpendLimit("u1", "a1", { monthlyLimitMinor: 1, currency: "usd" }); return { approved: true, status: "allowed" }; } },
    { ...base, monthlyLimit: 100 },
  );
  assert.equal(raced.status, "refused", "a yes given against one limit is not applied over another");

  const props = Object.keys((SET_SPENDING_LIMIT_TOOL.function.parameters as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props, ["monthly_limit"]);
});

test("the approval card offers Not now and Pay, and nothing standing, for a payment", () => {
  const card = readFileSync("src/components/chat/approval-card.tsx", "utf8");
  assert.match(card, /approval\.connectorId === "juno_payments" && approval\.toolName === "request_payment"/);
  assert.match(card, /if \(words === "request payment"\) return "Pay";/);
  assert.match(card, /canAllowScope && !agentConfig && !payment/);
  assert.match(card, /Not now/);
});
