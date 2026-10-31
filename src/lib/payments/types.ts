/**
 * The payment provider seam (src/lib/payments). One provider issues a
 * single-use virtual card for one approved payment, reveals its details only
 * to the fill path, and cancels it.
 *
 * Card details (`CardDetails`) are the one secret here. They never reach a
 * database row, a log line, an event, a tool result or the model: the only
 * code that holds them is `fillPaymentCard` (./fill.ts), which hands them
 * straight to the computer's browser and drops them.
 */

import type { PaymentProviderKind } from "./config";

export type { PaymentProviderKind } from "./config";

/** What a card is issued for. Amounts are minor units (cents). */
export interface IssueCardInput {
  /** Our payment id, the provider's idempotency key and the card's metadata. */
  paymentId: string;
  amountMinor: number;
  currency: string;
  merchant: string;
}

/** A card as it may be stored and shown: no number, no CVC. */
export interface IssuedCard {
  cardId: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

/** The secret half. Held only in memory, only by the fill path. */
export interface CardDetails {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  name: string | null;
}

export interface PaymentProvider {
  readonly name: PaymentProviderKind;
  /**
   * One virtual card, active at once, whose all-time spending limit is
   * exactly `amountMinor`. Idempotent on `paymentId`.
   */
  issueCard(input: IssueCardInput): Promise<IssuedCard>;
  /** The card's number and CVC, for the fill path only. */
  revealCard(cardId: string): Promise<CardDetails>;
  /** Cancels the card for good. Cancelling a cancelled card is not an error. */
  cancelCard(cardId: string): Promise<void>;
}

/**
 * AgentPayment.status. `issued`, `held` and `filled` are the approved, unused
 * states: the only ones in which an authorization can be approved.
 */
export const PAYMENT_STATUSES = [
  "pending",
  "declined",
  "issued",
  "held",
  "filled",
  "spent",
  "expired",
  "canceled",
  "failed",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const UNUSED_PAYMENT_STATUSES: readonly PaymentStatus[] = ["issued", "held", "filled"];

/** The AgentPayment row as this module reads and writes it. `reason` is ciphertext. */
export interface PaymentRecord {
  id: string;
  userId: string;
  agentId: string;
  conversationId: string | null;
  merchant: string;
  amountMinor: number;
  currency: string;
  reason: string;
  provider: string;
  providerCardId: string | null;
  last4: string | null;
  status: PaymentStatus;
  approvalReceiptId: string | null;
  idempotencyKey: string;
  expiresAt: Date | null;
  spentMinor: number | null;
  spentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** An agent's monthly limit, in minor units. No row is a limit of zero. */
export interface SpendLimitRecord {
  monthlyLimitMinor: number;
  currency: string;
}
