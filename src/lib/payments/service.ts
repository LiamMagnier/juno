/**
 * Agent payments, end to end, over injected parts (src/lib/payments). No
 * `server-only` import and no database: ./server.ts wires the real store,
 * provider, approval broker and computer fill; tests wire memory and fakes.
 *
 * One payment:
 *
 *   1. The agent asks (`request_payment`): merchant, amount, reason.
 *   2. Refused at once when payments are off, the amount is not clean, or the
 *      agent's monthly limit cannot hold it. No row asks for approval that
 *      could not be honoured.
 *   3. A `pending` row, then the deterministic approval: connector
 *      `juno_payments`, rule `destructive_or_sensitive`, which asks under
 *      every policy and can never be allowed standing. The card shows Not now
 *      and Pay. Nothing below runs without that one press.
 *   4. The limit is checked again, atomically, as the row moves to `issued`.
 *   5. One single-use card whose all-time limit is the approved amount, valid
 *      for `cardTtlMinutes`.
 *   6. `fillPaymentCard` types it into the agent's computer, or holds it.
 *   7. The approval becomes a receipt; the provider's webhook approves one
 *      authorization within the amount (`handleAuthorizationRequest`), the
 *      card is spent and cancelled; an unused card is cancelled at expiry
 *      (`sweepStalePayments`).
 */

import { ACTION_APPROVAL_TTL_MS } from "@/lib/action-approval";
import type { AgentEventKind } from "@/lib/agents/domain";
import type { PaymentsConfig } from "./config";
import { PAYMENT_CURRENCY } from "./config";
import { fillPaymentCard, type CardFillerResolver, type FillOutcome } from "./fill";
import {
  MERCHANT_MAX_CHARS,
  REASON_MAX_CHARS,
  checkSpendLimit,
  cleanLine,
  committedMinor,
  decideCardAuthorization,
  formatMoney,
  monthStartUtc,
  paymentIdempotencyKey,
  readAmountMinor,
  spendLimitDirection,
  type AuthorizationRequest,
  type AuthorizationVerdict,
} from "./policy";
import type { PaymentStore } from "./store";
import { UNUSED_PAYMENT_STATUSES, type PaymentProvider, type PaymentRecord } from "./types";

/** The connector and tool the approval broker knows a payment by (src/lib/action-approval.ts). */
export const PAYMENT_CONNECTOR_ID = "juno_payments";
export const PAYMENT_APPROVAL_TOOL = "request_payment";
/** The broker's tool for raising an agent's limit (shown on the agent approval card). */
export const RAISE_SPEND_LIMIT_APPROVAL_TOOL = "raise_spend_limit";

export type PaymentApproval =
  | { kind: "authorized"; receiptId: string | null }
  | { kind: "refused"; receiptId: string | null; status: string | null; reason: string };

export interface PaymentServiceDeps {
  store: PaymentStore;
  provider: PaymentProvider | null;
  config: Pick<PaymentsConfig, "cardTtlMinutes" | "maxPaymentMinor">;
  encryptReason(plain: string): string;
  /** The deterministic approval (`juno_payments:request_payment`). */
  approvePayment(input: {
    paymentId: string;
    args: Record<string, unknown>;
  }): Promise<PaymentApproval>;
  /** Turns the consumed approval into its receipt. */
  completeApproval(receiptId: string | null, ok: boolean, result: string): Promise<void>;
  recordEvent(input: { kind: AgentEventKind; title: string; detail: Record<string, unknown> }): Promise<void>;
  resolver?: CardFillerResolver | null;
  now?: () => Date;
}

export type PaymentOutcomeStatus = "refused" | "declined" | "filled" | "held" | "failed" | "expired" | "reported";

export interface PaymentOutcome {
  status: PaymentOutcomeStatus;
  /** What the model and the person are told. Written here; never holds a card detail. */
  message: string;
  paymentId?: string;
  reason?: string;
  merchant?: string;
  amount?: string;
  last4?: string;
  /** The receipt line under the reply, when a card exists. */
  receipt?: string;
}

const PAYMENT_COPY = {
  off: "Payments are not turned on on this server.",
  noMerchant: "Name the merchant you want to pay.",
  noReason: "Say in one sentence what the payment is for.",
  currency: "Cards are issued in US dollars only.",
  denied: "The person chose Not now, so nothing was paid and no card was made.",
  expired: "The approval was not answered in time, so no card was made.",
  blocked: "The person's approval settings block payments, so no card was made.",
  stopped: "The reply was stopped before the approval was answered, so no card was made.",
  notApproved: "The payment was not approved, so no card was made.",
  overLimitNow: "Another payment used the rest of this agent's limit while you were asked, so no card was made.",
  issueFailed: "The card provider could not issue a card, so nothing was paid. Try again later.",
} as const;

function refusedOutcome(reason: string, message: string): PaymentOutcome {
  return { status: "refused", reason, message };
}

/** What became of an approval that did not say yes, from the receipt's own status. */
export function declinedPaymentMessage(status: string | null): string {
  switch (status) {
    case "denied":
      return PAYMENT_COPY.denied;
    case "expired":
      return PAYMENT_COPY.expired;
    case "blocked":
      return PAYMENT_COPY.blocked;
    case "superseded":
      return PAYMENT_COPY.stopped;
    default:
      return PAYMENT_COPY.notApproved;
  }
}

function reportExisting(row: PaymentRecord): PaymentOutcome {
  const amount = formatMoney(row.amountMinor, row.currency);
  const base = { paymentId: row.id, merchant: row.merchant, amount, ...(row.last4 ? { last4: row.last4 } : {}) };
  switch (row.status) {
    case "declined":
      return { ...base, status: "declined", message: PAYMENT_COPY.notApproved };
    case "filled":
      return { ...base, status: "filled", message: "This payment's card was already typed into the checkout." };
    case "held":
    case "issued":
      return { ...base, status: "held", message: "This payment's card is ready and waiting to be filled." };
    case "spent":
      return { ...base, status: "reported", message: "This payment's card was already used." };
    case "expired":
    case "canceled":
      return { ...base, status: "expired", message: "This payment's card expired or was cancelled." };
    default:
      return { ...base, status: "failed", message: "This payment could not be completed." };
  }
}

export async function requestPayment(
  deps: PaymentServiceDeps,
  input: {
    userId: string;
    agentId: string;
    agentName: string;
    conversationId: string | null;
    userMessageId: string;
    merchant: unknown;
    amount: unknown;
    currency?: unknown;
    reason: unknown;
    /** The turn read outside content: the card says so, and the person checks. */
    untrusted: boolean;
  },
): Promise<PaymentOutcome> {
  const now = deps.now ?? (() => new Date());
  if (!deps.provider) return refusedOutcome("payments_off", PAYMENT_COPY.off);
  const provider = deps.provider;
  const merchant = cleanLine(input.merchant, MERCHANT_MAX_CHARS);
  if (!merchant) return refusedOutcome("invalid_merchant", PAYMENT_COPY.noMerchant);
  const reason = cleanLine(input.reason, REASON_MAX_CHARS);
  if (!reason) return refusedOutcome("invalid_reason", PAYMENT_COPY.noReason);
  const currency = typeof input.currency === "string" && input.currency.trim() ? input.currency.trim().toLowerCase() : PAYMENT_CURRENCY;
  if (currency !== PAYMENT_CURRENCY) return refusedOutcome("currency", PAYMENT_COPY.currency);
  const amount = readAmountMinor(input.amount, deps.config.maxPaymentMinor);
  if (!amount.ok) return refusedOutcome("invalid_amount", amount.message);
  const amountMinor = amount.amountMinor;
  const amountText = formatMoney(amountMinor, currency);

  const idempotencyKey = paymentIdempotencyKey({
    userMessageId: input.userMessageId,
    agentId: input.agentId,
    merchant,
    amountMinor,
    currency,
    reason,
  });

  const limit = await deps.store.getSpendLimit(input.userId, input.agentId);
  const monthStart = monthStartUtc(now());
  const month = await deps.store.listSince(input.userId, input.agentId, monthStart);
  const existing = month.find((row) => row.idempotencyKey === idempotencyKey);
  // A retried turn meeting a payment that already moved on is told how it
  // stands: never a second approval, never a second card.
  if (existing && existing.status !== "pending") return reportExisting(existing);
  if (!existing) {
    const verdict = checkSpendLimit({ limit, committedMinor: committedMinor(month, monthStart), amountMinor, currency });
    if (!verdict.ok) return refusedOutcome(verdict.reason, verdict.message);
  }

  const row =
    existing ??
    (await deps.store.createOrFind({
      userId: input.userId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      merchant,
      amountMinor,
      currency,
      reason: deps.encryptReason(reason),
      provider: provider.name,
      idempotencyKey,
    }));
  if (row.status !== "pending") return reportExisting(row);

  // The person's press. Everything the card shows is bound into its digest.
  const approval = await deps.approvePayment({
    paymentId: row.id,
    args: {
      paymentId: row.id,
      agent: input.agentName,
      merchant,
      amount: amountText,
      currency: currency.toUpperCase(),
      reason,
      card: "Single-use virtual card, limited to this amount, cancelled after one payment",
    },
  });
  if (approval.kind !== "authorized") {
    await deps.store.transition(input.userId, row.id, ["pending"], { status: "declined", approvalReceiptId: approval.receiptId });
    return { status: "declined", reason: approval.status ?? "not_approved", message: declinedPaymentMessage(approval.status), paymentId: row.id, merchant, amount: amountText };
  }
  const receiptId = approval.receiptId;
  await deps.store.transition(input.userId, row.id, ["pending"], { approvalReceiptId: receiptId });

  // Again, atomically: another payment may have used the month while the person was asked.
  const currentLimit = await deps.store.getSpendLimit(input.userId, input.agentId);
  const reserved =
    !!currentLimit &&
    currentLimit.currency.toLowerCase() === currency &&
    (await deps.store.reserveWithinLimit({
      userId: input.userId,
      agentId: input.agentId,
      id: row.id,
      limitMinor: currentLimit.monthlyLimitMinor,
      monthStart: monthStartUtc(now()),
    }));
  if (!reserved) {
    await deps.store.transition(input.userId, row.id, ["pending"], { status: "declined" });
    await deps.completeApproval(receiptId, false, PAYMENT_COPY.overLimitNow);
    return { status: "refused", reason: "over_limit", message: PAYMENT_COPY.overLimitNow, paymentId: row.id, merchant, amount: amountText };
  }

  let card: Awaited<ReturnType<PaymentProvider["issueCard"]>>;
  try {
    card = await provider.issueCard({ paymentId: row.id, amountMinor, currency, merchant });
  } catch {
    await deps.store.transition(input.userId, row.id, ["issued"], { status: "failed" });
    await deps.completeApproval(receiptId, false, PAYMENT_COPY.issueFailed);
    return { status: "failed", reason: "issue_failed", message: PAYMENT_COPY.issueFailed, paymentId: row.id, merchant, amount: amountText };
  }
  const expiresAt = new Date(now().getTime() + deps.config.cardTtlMinutes * 60_000);
  const recorded = await deps.store.transition(input.userId, row.id, ["issued"], {
    providerCardId: card.cardId,
    last4: card.last4,
    expiresAt,
  });
  if (!recorded) {
    // The row moved under us (it cannot be spent without its card id): the
    // card must not outlive the payment it was made for.
    await provider.cancelCard(card.cardId).catch(() => undefined);
    await deps.completeApproval(receiptId, false, PAYMENT_COPY.issueFailed);
    return { status: "failed", reason: "issue_failed", message: PAYMENT_COPY.issueFailed, paymentId: row.id, merchant, amount: amountText };
  }
  await deps.recordEvent({
    kind: "payment_issued",
    title: `Card for ${amountText} at ${merchant}`,
    detail: { paymentId: row.id, merchant, amountMinor, currency, last4: card.last4, expiresAt: expiresAt.toISOString() },
  });

  const filled = await fillPaymentCard(input.agentId, row.id, {
    userId: input.userId,
    store: deps.store,
    provider,
    ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
    now,
  });
  const outcome = fillToOutcome(filled, { paymentId: row.id, merchant, amountText, last4: card.last4 });
  await deps.completeApproval(receiptId, true, outcome.receipt ?? outcome.message);
  return outcome;
}

function fillToOutcome(
  filled: FillOutcome,
  ctx: { paymentId: string; merchant: string; amountText: string; last4: string },
): PaymentOutcome {
  const base = { paymentId: ctx.paymentId, merchant: ctx.merchant, amount: ctx.amountText, last4: ctx.last4 };
  const receipt =
    filled.kind === "filled"
      ? `Card ending ${ctx.last4} for ${ctx.amountText} at ${ctx.merchant}, typed into the checkout`
      : filled.kind === "held"
        ? `Card ending ${ctx.last4} for ${ctx.amountText} at ${ctx.merchant}, waiting for the computer`
        : `Card for ${ctx.amountText} at ${ctx.merchant}, not used`;
  switch (filled.kind) {
    case "filled":
      return { ...base, status: "filled", message: filled.message, receipt };
    case "held":
      return { ...base, status: "held", message: filled.message, receipt };
    case "expired":
      return { ...base, status: "expired", message: filled.message, receipt };
    case "refused":
      return { ...base, status: "failed", message: filled.message, receipt };
  }
}

/** A later fill of a held card (the `fill_payment_card` tool): no new approval, no new card. */
export async function fillHeldPayment(
  deps: Pick<PaymentServiceDeps, "store" | "provider" | "resolver" | "now">,
  input: { userId: string; agentId: string; paymentId: unknown },
): Promise<PaymentOutcome> {
  if (!deps.provider) return refusedOutcome("payments_off", PAYMENT_COPY.off);
  const paymentId = typeof input.paymentId === "string" ? input.paymentId.trim() : "";
  const row = paymentId ? await deps.store.find(input.userId, paymentId) : null;
  if (!row || row.agentId !== input.agentId) return refusedOutcome("not_found", "There is no card ready for this agent with that reference.");
  // Only a card that was held. One that was typed in once is never typed into a second page.
  if (row.status !== "held") return reportExisting(row);
  const filled = await fillPaymentCard(input.agentId, row.id, {
    userId: input.userId,
    store: deps.store,
    provider: deps.provider,
    ...(deps.resolver !== undefined ? { resolver: deps.resolver } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return fillToOutcome(filled, {
    paymentId: row.id,
    merchant: row.merchant,
    amountText: formatMoney(row.amountMinor, row.currency),
    last4: row.last4 ?? "",
  });
}

export interface AuthorizationHandling {
  verdict: AuthorizationVerdict;
  /** Work done after the answer was sent: cancelling a spent or expired card. Never throws. */
  followUp(): Promise<void>;
}

/**
 * The provider's real-time question about one authorization. Approved only
 * when `decideCardAuthorization` says so AND the card is spent atomically
 * (`issued | held | filled` → `spent`): a second authorization on the same
 * card finds it spent and is declined.
 */
export async function handleAuthorizationRequest(
  deps: Pick<PaymentServiceDeps, "store" | "provider" | "now">,
  request: AuthorizationRequest,
): Promise<AuthorizationHandling> {
  const now = (deps.now ?? (() => new Date()))();
  const payment = await deps.store.findByCardUnguarded(request.cardId);
  let verdict = decideCardAuthorization({ payment, request, now });
  let cancel = false;
  let expire = false;
  if (payment && verdict.approved && verdict.reason === "verification") {
    // Nothing is spent and nothing is cancelled: the charge that follows is the payment.
  } else if (payment && verdict.approved) {
    const spent = await deps.store.transition(payment.userId, payment.id, UNUSED_PAYMENT_STATUSES, {
      status: "spent",
      spentMinor: request.amountMinor,
      spentAt: now,
    });
    if (spent) cancel = true;
    else verdict = { approved: false, reason: "already_used" };
  } else if (payment && verdict.reason === "expired") {
    expire = true;
  } else if (payment && verdict.reason === "already_used") {
    cancel = true;
  }
  const provider = deps.provider;
  return {
    verdict,
    async followUp() {
      if (!payment?.providerCardId || !provider) return;
      try {
        if (expire) {
          if (await deps.store.transition(payment.userId, payment.id, UNUSED_PAYMENT_STATUSES, { status: "expired" })) {
            await provider.cancelCard(payment.providerCardId);
          }
        } else if (cancel) {
          // Single use: the card that paid (or tried to pay twice) is cancelled.
          await provider.cancelCard(payment.providerCardId);
        }
      } catch {
        // The sweep and the all-time limit are the backstop.
      }
    },
  };
}

/**
 * Cancels every unused card past its expiry (`expired`) and closes requests
 * whose approval can no longer be answered (`declined`). Cross-account, so it
 * runs only from the background sweep.
 */
export async function sweepStalePayments(
  deps: Pick<PaymentServiceDeps, "store" | "provider" | "now">,
  opts: { limit?: number } = {},
): Promise<{ expired: number; closed: number }> {
  const now = (deps.now ?? (() => new Date()))();
  // Twice the approval's own life: a request still pending then can never be approved.
  const pendingBefore = new Date(now.getTime() - 2 * ACTION_APPROVAL_TTL_MS);
  const stale = await deps.store.listStaleUnguarded(now, pendingBefore, opts.limit ?? 100);
  let expired = 0;
  let closed = 0;
  for (const row of stale) {
    if (row.status === "pending") {
      if (await deps.store.transition(row.userId, row.id, ["pending"], { status: "declined" })) closed += 1;
      continue;
    }
    if (!(await deps.store.transition(row.userId, row.id, UNUSED_PAYMENT_STATUSES, { status: "expired" }))) continue;
    expired += 1;
    if (row.providerCardId && deps.provider) await deps.provider.cancelCard(row.providerCardId).catch(() => undefined);
  }
  return { expired, closed };
}

// ---------------------------------------------------------------------------
// The spending limit
// ---------------------------------------------------------------------------

export type SpendLimitOutcome =
  | { status: "applied" | "unchanged"; message: string; monthlyLimit: string }
  | { status: "refused" | "declined"; reason: string; message: string };

export const SPEND_LIMIT_COPY = {
  untrusted:
    "This conversation includes content read from outside it, so the spending limit cannot be raised from it. Ask the person to raise it themselves.",
  declined: "The person did not approve the higher limit, so it was not changed.",
  changed: "The limit changed while the person was asked, so nothing was changed. Ask again if it is still needed.",
  invalid: "The monthly limit must be a number of US dollars, 0 or more, with at most two decimals.",
} as const;

/**
 * Sets an agent's monthly limit. Lowering it (or keeping it) applies at once;
 * raising it is a widening and waits for the agent approval card, never while
 * the turn read outside content.
 */
export async function setAgentSpendLimit(
  deps: Pick<PaymentServiceDeps, "store" | "config" | "recordEvent"> & {
    approveRaise(input: { args: Record<string, unknown> }): Promise<{ approved: boolean; status: string | null }>;
  },
  input: { userId: string; agentId: string; agentName: string; monthlyLimit: unknown; untrusted: boolean },
): Promise<SpendLimitOutcome> {
  const raw = input.monthlyLimit;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  // Up to twenty payments of the server's largest size in a month.
  const max = deps.config.maxPaymentMinor * 20;
  let afterMinor: number;
  if (value === 0) afterMinor = 0;
  else {
    const read = readAmountMinor(value, max);
    if (!read.ok) return { status: "refused", reason: "invalid_limit", message: `${SPEND_LIMIT_COPY.invalid} ${read.message}` };
    afterMinor = read.amountMinor;
  }
  const current = await deps.store.getSpendLimit(input.userId, input.agentId);
  const beforeMinor = current?.monthlyLimitMinor ?? 0;
  const currency = current?.currency ?? PAYMENT_CURRENCY;
  const direction = spendLimitDirection(beforeMinor, afterMinor);
  const after = formatMoney(afterMinor, currency);
  const before = formatMoney(beforeMinor, currency);
  if (direction === "same") return { status: "unchanged", message: `The monthly limit is already ${after}.`, monthlyLimit: after };

  if (direction === "widening") {
    if (input.untrusted) return { status: "refused", reason: "untrusted_content_in_turn", message: SPEND_LIMIT_COPY.untrusted };
    const answer = await deps.approveRaise({
      args: {
        agentId: input.agentId,
        monthlyLimitMinor: afterMinor,
        currency,
        preview: {
          headline: `Let ${input.agentName} spend up to ${after} a month?`,
          changes: [{ label: "Monthly spending limit", from: before, to: after }],
        },
      },
    });
    if (!answer.approved) return { status: "declined", reason: answer.status ?? "not_approved", message: SPEND_LIMIT_COPY.declined };
    // The limit the person saw must still be the limit: an answer given
    // against one value is never applied over another.
    const latest = await deps.store.getSpendLimit(input.userId, input.agentId);
    if ((latest?.monthlyLimitMinor ?? 0) !== beforeMinor) {
      return { status: "refused", reason: "changed_while_asked", message: SPEND_LIMIT_COPY.changed };
    }
  }

  await deps.store.setSpendLimit(input.userId, input.agentId, { monthlyLimitMinor: afterMinor, currency });
  await deps.recordEvent({
    kind: "spend_limit_changed",
    title: `Monthly spending limit ${before} to ${after}`,
    detail: { fromMinor: beforeMinor, toMinor: afterMinor, currency, direction },
  });
  return { status: "applied", message: `The monthly spending limit is now ${after}.`, monthlyLimit: after };
}
