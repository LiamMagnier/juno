/**
 * The rules of agent payments, pure so every one of them is tested without a
 * database, a provider or a network (tests/payments.test.ts).
 *
 *   - An amount is a positive number of the currency's major units with at
 *     most two decimals, at most the server's per-payment ceiling.
 *   - An agent's monthly limit (AgentSpendLimit) is zero until the person sets
 *     one; a payment that would take the month past it is refused before any
 *     card exists.
 *   - A card authorization is approved only for a card in an approved, unused
 *     state, before its expiry, in its currency, and within its amount. Every
 *     other case declines.
 */

import { createHash } from "node:crypto";
import {
  UNUSED_PAYMENT_STATUSES,
  type CardDetails,
  type PaymentRecord,
  type PaymentStatus,
} from "./types";

export const MERCHANT_MAX_CHARS = 120;
export const REASON_MAX_CHARS = 500;

/** One line, trimmed, bounded: a merchant or a reason is shown on an approval card. */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Control characters (below space, and DEL) become spaces, one by one.
  const flat = Array.from(value, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export type AmountReading = { ok: true; amountMinor: number } | { ok: false; message: string };

/** `12.5` dollars → 1250 cents. Refuses anything that is not a clean positive amount. */
export function readAmountMinor(raw: unknown, maxMinor: number): AmountReading {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return { ok: false, message: "The amount must be a positive number, like 12.50." };
  }
  const minor = Math.round(value * 100);
  if (Math.abs(minor - value * 100) > 1e-6) {
    return { ok: false, message: "The amount can have at most two decimals." };
  }
  if (minor < 1) return { ok: false, message: "The amount must be at least 0.01." };
  if (minor > maxMinor) {
    return { ok: false, message: `One payment can be at most ${formatMoney(maxMinor, "usd")} on this server.` };
  }
  return { ok: true, amountMinor: minor };
}

/** "$12.50" for US dollars; "12.50 EUR" for anything else. */
export function formatMoney(amountMinor: number, currency: string): string {
  const units = (amountMinor / 100).toFixed(2);
  return currency.toLowerCase() === "usd" ? `$${units}` : `${units} ${currency.toUpperCase()}`;
}

/** The first instant of `now`'s calendar month, in UTC. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What a month already holds against the limit: every card still usable at
 * its full amount, and every spent card at what it spent.
 */
export function committedMinor(
  payments: ReadonlyArray<Pick<PaymentRecord, "status" | "amountMinor" | "spentMinor" | "createdAt">>,
  monthStart: Date,
): number {
  let total = 0;
  for (const payment of payments) {
    if (payment.createdAt.getTime() < monthStart.getTime()) continue;
    if ((UNUSED_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) total += payment.amountMinor;
    else if (payment.status === "spent") total += payment.spentMinor ?? payment.amountMinor;
  }
  return total;
}

export type LimitVerdict =
  | { ok: true; remainingAfterMinor: number }
  | { ok: false; reason: "no_limit" | "over_limit" | "currency"; message: string };

export function checkSpendLimit(input: {
  limit: { monthlyLimitMinor: number; currency: string } | null;
  committedMinor: number;
  amountMinor: number;
  currency: string;
}): LimitVerdict {
  const limit = input.limit;
  if (!limit || limit.monthlyLimitMinor <= 0) {
    return {
      ok: false,
      reason: "no_limit",
      message: "This agent has no spending limit yet, so it cannot pay for anything. Ask the person to set one first.",
    };
  }
  if (limit.currency.toLowerCase() !== input.currency.toLowerCase()) {
    return { ok: false, reason: "currency", message: `This agent's limit is in ${limit.currency.toUpperCase()}.` };
  }
  const after = input.committedMinor + input.amountMinor;
  if (after > limit.monthlyLimitMinor) {
    const left = Math.max(0, limit.monthlyLimitMinor - input.committedMinor);
    return {
      ok: false,
      reason: "over_limit",
      message: `This would pass the agent's monthly limit of ${formatMoney(limit.monthlyLimitMinor, limit.currency)}. ${formatMoney(left, limit.currency)} is left this month.`,
    };
  }
  return { ok: true, remainingAfterMinor: limit.monthlyLimitMinor - after };
}

export type SpendLimitDirection = "widening" | "narrowing" | "same";

/** Raising the limit widens what the agent can do; only that needs the person's press. */
export function spendLimitDirection(beforeMinor: number, afterMinor: number): SpendLimitDirection {
  if (afterMinor > beforeMinor) return "widening";
  if (afterMinor < beforeMinor) return "narrowing";
  return "same";
}

/** The authorization a provider asks about, in the card's currency. */
export interface AuthorizationRequest {
  cardId: string;
  amountMinor: number;
  currency: string;
}

export type AuthorizationReason =
  | "approved"
  | "verification"
  | "unknown_card"
  | "not_approved"
  | "already_used"
  | "expired"
  | "currency_mismatch"
  | "invalid_amount"
  | "over_amount";

export interface AuthorizationVerdict {
  approved: boolean;
  reason: AuthorizationReason;
}

const NOT_YET_APPROVED: readonly PaymentStatus[] = ["pending", "declined", "failed"];

/**
 * Approve or decline one authorization. Declines are the default: only a card
 * in an approved, unused state, unexpired, in its currency and within its
 * amount is approved. The caller still spends the card atomically (`issued |
 * held | filled` → `spent`), so two authorizations racing cannot both pass.
 */
export function decideCardAuthorization(input: {
  payment: Pick<PaymentRecord, "status" | "amountMinor" | "currency" | "expiresAt" | "providerCardId"> | null;
  request: AuthorizationRequest;
  now: Date;
}): AuthorizationVerdict {
  const { payment, request, now } = input;
  if (!payment || !payment.providerCardId || payment.providerCardId !== request.cardId) {
    return { approved: false, reason: "unknown_card" };
  }
  if (!(UNUSED_PAYMENT_STATUSES as readonly string[]).includes(payment.status)) {
    return { approved: false, reason: NOT_YET_APPROVED.includes(payment.status) ? "not_approved" : "already_used" };
  }
  if (!payment.expiresAt || payment.expiresAt.getTime() <= now.getTime()) {
    return { approved: false, reason: "expired" };
  }
  if (payment.currency.toLowerCase() !== request.currency.toLowerCase()) {
    return { approved: false, reason: "currency_mismatch" };
  }
  if (!Number.isInteger(request.amountMinor) || request.amountMinor < 0) {
    return { approved: false, reason: "invalid_amount" };
  }
  // A zero-amount check (a merchant confirming the card is real before it
  // charges) moves no money and does not use the card up.
  if (request.amountMinor === 0) return { approved: true, reason: "verification" };
  if (request.amountMinor > payment.amountMinor) return { approved: false, reason: "over_amount" };
  return { approved: true, reason: "approved" };
}

/** Whether an unused card has passed its expiry and must be cancelled. */
export function isPastExpiry(payment: Pick<PaymentRecord, "status" | "expiresAt">, now: Date): boolean {
  return (
    (UNUSED_PAYMENT_STATUSES as readonly string[]).includes(payment.status) &&
    !!payment.expiresAt &&
    payment.expiresAt.getTime() <= now.getTime()
  );
}

/**
 * The payment's idempotency key. A native chat tool has no provider call id
 * (RULES §5), so the key is the user message plus a digest of the normalized
 * request: a retried turn asking for the same payment finds the same row, and
 * one asking for anything else gets a new one.
 */
export function paymentIdempotencyKey(input: {
  userMessageId: string;
  agentId: string;
  merchant: string;
  amountMinor: number;
  currency: string;
  reason: string;
}): string {
  return createHash("sha256")
    .update("juno.payments.request.v1\n", "utf8")
    .update(
      JSON.stringify([
        input.userMessageId,
        input.agentId,
        input.merchant.toLowerCase(),
        input.amountMinor,
        input.currency.toLowerCase(),
        input.reason,
      ]),
      "utf8",
    )
    .digest("hex");
}

/**
 * Removes a card's number and CVC from text that is about to leave the fill
 * path (a browser error, a page title). The number is matched with or without
 * the spaces and dashes a page puts between its groups; the CVC only as a
 * whole number of its own.
 */
export function scrubCardDetails(text: string, details: Pick<CardDetails, "number" | "cvc"> | null): string {
  if (!details || !text) return text;
  let out = text;
  const digits = details.number.replace(/\D/g, "");
  if (digits.length >= 12) {
    const spaced = digits.split("").join("[\\s-]*");
    out = out.replace(new RegExp(spaced, "g"), "[card number]");
  }
  const cvc = details.cvc.replace(/\D/g, "");
  if (cvc.length >= 3) out = out.replace(new RegExp(`(?<!\\d)${cvc}(?!\\d)`, "g"), "[code]");
  return out;
}
