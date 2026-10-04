import Stripe from "stripe";
import { NextResponse } from "next/server";
import type { SubStatus } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getStripe, planFromPriceId, resolveSubscriptionPlan } from "@/lib/stripe";
import { alertOperator } from "@/lib/alerts";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { eurPerUsd } from "@/lib/spend";
import { grantCredit, rewardReferralForPayment } from "@/lib/billing/credit-ledger";
import { renewalNoticeForSubscription } from "@/lib/billing/renewal-reminders";
import {
  checkoutIntent,
  customerIdOf,
  isPaidSubscriptionInvoice,
  topUpCreditMicroUsd,
  type CheckoutSessionLike,
} from "@/lib/billing/stripe-events";

export const runtime = "nodejs";

function mapStatus(s: Stripe.Subscription.Status): SubStatus {
  switch (s) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    default:
      return "INCOMPLETE";
  }
}

async function syncSubscription(sub: Stripe.Subscription, fallbackUserId?: string | null) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Signature-verified Stripe event; the lookup is keyed by customer id, not
  // by a signed-in user, so it legitimately uses the unguarded client.
  let record = await prismaUnguarded.subscription.findFirst({ where: { stripeCustomerId: customerId } });

  if (!record) {
    // The customer id link can be missing: checkout creates the Stripe customer
    // and writes stripeCustomerId in two non-transactional steps, so a failure
    // between them leaves a paying customer Juno cannot recognise — and every
    // subsequent webhook for them was a silent no-op.
    //
    // Stripe carries the userId for us in two places we set at checkout
    // (subscription_data.metadata and the session's client_reference_id), and
    // neither was being used. Recover through them and heal the link.
    const userId = sub.metadata?.userId || fallbackUserId || null;
    if (userId) {
      record = await prismaUnguarded.subscription.findUnique({ where: { userId } });
      if (record) {
        await prismaUnguarded.subscription.update({
          where: { id: record.id },
          data: { stripeCustomerId: customerId },
        });
        console.warn("[stripe] relinked a subscription by metadata userId", { customerId, userId });
      }
    }
  }

  if (!record) {
    alertOperator({
      kind: "stripe_unknown_customer",
      key: customerId,
      title: `Stripe webhook for a customer ${PRODUCT_NAME} cannot identify`,
      detail: {
        customerId,
        subscriptionId: sub.id,
        subscriptionStatus: sub.status,
        hadMetadataUserId: Boolean(sub.metadata?.userId),
        effect: "The event was dropped; this customer's plan will not update.",
      },
    });
    return;
  }

  const item = sub.items.data[0];
  const priceId = item?.price.id;
  const mapped = planFromPriceId(priceId);
  // An unrecognised price id must never downgrade a paying customer. A legacy
  // price, a promo, a currency variant, a price created in the Stripe dashboard,
  // or a STRIPE_PRICE_* env var that wasn't deployed all land here — and
  // defaulting to FREE would lock the customer out at zero messages
  // (PLANS.FREE.monthlyMessages === 0) while Stripe keeps charging them. Keep
  // the plan they already have and alert; every other field still syncs.
  if (!mapped && sub.status !== "canceled") {
    alertOperator({
      kind: "stripe_unknown_price",
      key: priceId ?? "missing",
      title: `Stripe sent a price id ${PRODUCT_NAME} cannot map to a plan`,
      detail: {
        priceId: priceId ?? null,
        customerId,
        subscriptionId: sub.id,
        subscriptionStatus: sub.status,
        keptPlan: record.plan,
      },
    });
  }
  const plan = resolveSubscriptionPlan({
    status: sub.status,
    mappedPlan: mapped,
    currentPlan: record.plan,
  });
  // current_period_end lives on the subscription item in recent API versions.
  const periodEndUnix =
    (item as unknown as { current_period_end?: number })?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  await prismaUnguarded.subscription.update({
    where: { id: record.id },
    data: {
      plan,
      status: mapStatus(sub.status),
      stripeSubscriptionId: sub.id,
      stripePriceId: priceId ?? null,
      currentPeriodEnd: periodEndUnix ? new Date(periodEndUnix * 1000) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    },
  });
}

/**
 * Credit a paid top-up pack. Keyed on the Checkout Session id, so the
 * `completed` and `async_payment_succeeded` events for one session, and any
 * redelivery of either, grant it once.
 */
async function creditTopUp(session: CheckoutSessionLike) {
  const intent = checkoutIntent(session);
  if (intent.kind !== "topup" || !intent.paid) return;
  const granted = await grantCredit({
    userId: intent.userId,
    source: "topup",
    amountMicroUsd: topUpCreditMicroUsd(intent.pack, eurPerUsd()),
    idempotencyKey: session.id,
    note: `Top-up ${intent.pack} €`,
  });
  if (granted) console.info("[stripe] top-up credited", { userId: intent.userId, pack: intent.pack });
}

/** A paid subscription invoice: reward the referral it completes, if any. */
async function rewardReferral(invoice: Stripe.Invoice) {
  if (!isPaidSubscriptionInvoice(invoice) || !invoice.id) return;
  const customerId = customerIdOf(invoice.customer);
  if (!customerId) return;
  const record = await prismaUnguarded.subscription.findFirst({
    where: { stripeCustomerId: customerId },
    select: { userId: true },
  });
  if (!record) return;
  const outcome = await rewardReferralForPayment({
    referredUserId: record.userId,
    stripeInvoiceId: invoice.id,
    amountPaidCents: invoice.amount_paid,
    eurPerUsd: eurPerUsd(),
  });
  if (outcome !== "none") console.info("[stripe] referral", { outcome, userId: record.userId });
}

/** The subscription an invoice bills, across API versions. */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  const legacy = (invoice as unknown as { subscription?: string | { id: string } | null }).subscription;
  return customerIdOf(fromParent ?? legacy ?? null);
}

export async function POST(req: Request) {
  if (!env.stripe.secretKey || !env.stripe.webhookSecret) {
    return NextResponse.json({ error: "Billing not configured." }, { status: 503 });
  }

  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "Missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, env.stripe.webhookSecret);
  } catch {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const intent = checkoutIntent(session as unknown as CheckoutSessionLike);
        if (intent.kind === "subscription") {
          const sub = await getStripe().subscriptions.retrieve(intent.subscriptionId);
          await syncSubscription(sub, session.client_reference_id);
        } else if (intent.kind === "topup") {
          await creditTopUp(session as unknown as CheckoutSessionLike);
        }
        break;
      }
      case "checkout.session.async_payment_succeeded": {
        // A delayed payment method (SEPA debit) for a top-up has cleared.
        await creditTopUp(event.data.object as unknown as CheckoutSessionLike);
        break;
      }
      case "invoice.paid": {
        await rewardReferral(event.data.object as Stripe.Invoice);
        break;
      }
      case "invoice.upcoming": {
        // Stripe's renewal heads-up. Only an annual subscription inside the
        // L215-1 window (one to three months out) gets the notice; the daily
        // sweep covers a lead time set shorter than a month in the dashboard.
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (subId) {
          await renewalNoticeForSubscription({
            stripeSubscriptionId: subId,
            totalCents: typeof invoice.total === "number" ? invoice.total : null,
          });
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // Re-fetch rather than trusting the event payload.
        //
        // Stripe guarantees neither ordering nor at-most-once delivery, and it
        // retries on any non-2xx. Writing the payload verbatim means an
        // `updated` emitted before a cancellation but delivered after it
        // resurrects a cancelled plan, and a redelivered old event silently
        // rewinds state. Whatever the event says, the subscription's current
        // state is what Juno should store, so ask for it.
        const payload = event.data.object as Stripe.Subscription;
        let current = payload;
        try {
          current = await getStripe().subscriptions.retrieve(payload.id);
        } catch (err) {
          // A subscription can genuinely be gone. Fall back to the payload —
          // stale is better than dropping the event entirely.
          console.warn("[stripe] could not re-fetch subscription; using event payload", {
            subscriptionId: payload.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        await syncSubscription(current);
        break;
      }
    }
  } catch (err) {
    console.error("[stripe webhook]", err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
