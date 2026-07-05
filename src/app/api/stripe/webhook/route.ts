import Stripe from "stripe";
import { NextResponse } from "next/server";
import type { SubStatus } from "@prisma/client";
import { prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getStripe, planFromPriceId } from "@/lib/stripe";

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

async function syncSubscription(sub: Stripe.Subscription) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Signature-verified Stripe event; the lookup is keyed by customer id, not
  // by a signed-in user, so it legitimately uses the unguarded client.
  const record = await prismaUnguarded.subscription.findFirst({ where: { stripeCustomerId: customerId } });
  if (!record) return;

  const item = sub.items.data[0];
  const priceId = item?.price.id;
  const plan = planFromPriceId(priceId) ?? "FREE";
  // current_period_end lives on the subscription item in recent API versions.
  const periodEndUnix =
    (item as unknown as { current_period_end?: number })?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  await prismaUnguarded.subscription.update({
    where: { id: record.id },
    data: {
      plan: sub.status === "canceled" ? "FREE" : plan,
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
          await syncSubscription(sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await syncSubscription(event.data.object as Stripe.Subscription);
        break;
      }
    }
  } catch (err) {
    console.error("[stripe webhook]", err);
    return NextResponse.json({ error: "Handler error" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
