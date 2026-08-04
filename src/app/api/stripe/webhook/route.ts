import Stripe from "stripe";
import { NextResponse } from "next/server";
import type { SubStatus } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getStripe, planFromPriceId, resolveSubscriptionPlan } from "@/lib/stripe";
import { alertOperator } from "@/lib/alerts";

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
      title: "Stripe webhook for a customer Juno cannot identify",
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
      title: "Stripe sent a price id Juno cannot map to a plan",
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
        if (session.subscription) {
          const subId = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
          const sub = await getStripe().subscriptions.retrieve(subId);
          await syncSubscription(sub, session.client_reference_id);
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
