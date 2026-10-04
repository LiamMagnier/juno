import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { env, isStripeConfigured } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { isMissingResource, stripeErrorMessage } from "@/lib/billing/stripe-customer";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  if (!sub?.stripeCustomerId) {
    return NextResponse.json({ error: "No billing account found." }, { status: 400 });
  }

  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${env.appUrl}/settings`,
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    // A customer stored under the test key does not exist live: there is no
    // live subscription to manage yet, which is what the reader should hear.
    if (isMissingResource(error)) {
      return NextResponse.json({ error: "There is no paid subscription to manage on this account yet." }, { status: 400 });
    }
    return NextResponse.json({ error: stripeErrorMessage(error, "Couldn’t open billing portal.") }, { status: 502 });
  }
}
