import { TOP_UP_PACKS, creditEurToMicroUsd, isTopUpPackId, type TopUpPackId } from "@/lib/credits";

/**
 * Pure readings of Stripe webhook payloads, kept out of the route so a test
 * can reach them. Shapes are the minimal fields read, so a fixture does not
 * have to build a whole Stripe object.
 */

export interface CheckoutSessionLike {
  id: string;
  mode: string | null;
  payment_status: string | null;
  subscription?: string | { id: string } | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  amount_subtotal?: number | null;
}

export type CheckoutIntent =
  | { kind: "subscription"; subscriptionId: string }
  | { kind: "topup"; pack: TopUpPackId; userId: string; paid: boolean }
  | { kind: "ignore" };

/** What a completed Checkout Session is for, and whether its money has arrived. */
export function checkoutIntent(session: CheckoutSessionLike): CheckoutIntent {
  if (session.mode === "subscription" && session.subscription) {
    const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
    return { kind: "subscription", subscriptionId };
  }
  if (session.mode === "payment" && session.metadata?.kind === "topup") {
    const pack = session.metadata.pack;
    const userId = session.metadata.userId || session.client_reference_id || "";
    if (!isTopUpPackId(pack) || !userId) return { kind: "ignore" };
    // "paid" for a card; a delayed method (SEPA debit) completes "unpaid" and
    // pays later through checkout.session.async_payment_succeeded.
    return { kind: "topup", pack, userId, paid: session.payment_status === "paid" };
  }
  return { kind: "ignore" };
}

/** The usage credit a paid pack grants, micro-USD: 55% of its HT price. */
export function topUpCreditMicroUsd(pack: TopUpPackId, eurPerUsd = 1): number {
  return creditEurToMicroUsd(TOP_UP_PACKS[pack].creditEur, eurPerUsd);
}

export interface InvoiceLike {
  id?: string | null;
  customer: string | { id: string } | null;
  amount_paid: number;
  billing_reason: string | null;
}

/**
 * A paid SUBSCRIPTION invoice — the event a referral rewards on. A one-off
 * top-up invoice (billing_reason "manual") never counts: the rule is the
 * referred account's first paid subscription payment.
 */
export function isPaidSubscriptionInvoice(invoice: InvoiceLike): boolean {
  if (!(invoice.amount_paid > 0)) return false;
  return (
    invoice.billing_reason === "subscription_create" ||
    invoice.billing_reason === "subscription_cycle" ||
    invoice.billing_reason === "subscription_update"
  );
}

export function customerIdOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
