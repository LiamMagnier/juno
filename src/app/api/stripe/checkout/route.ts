import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { env, isStripeConfigured } from "@/lib/env";
import { getStripe, priceIdForPlan } from "@/lib/stripe";

const schema = z.object({ plan: z.enum(["PRO", "MAX", "MAX20"]) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });

  const priceId = priceIdForPlan(parsed.data.plan);
  if (!priceId) return NextResponse.json({ error: "Plan price is not configured." }, { status: 503 });

  await ensureUserDefaults(user.id);
  const stripe = getStripe();
  let sub = await prisma.subscription.findUnique({ where: { userId: user.id } });

  // Ensure a Stripe customer exists for this user.
  let customerId = sub?.stripeCustomerId ?? undefined;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    sub = await prisma.subscription.update({ where: { userId: user.id }, data: { stripeCustomerId: customerId } });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${env.appUrl}/chat?upgraded=1`,
    cancel_url: `${env.appUrl}/upgrade`,
    metadata: { userId: user.id, plan: parsed.data.plan },
    subscription_data: { metadata: { userId: user.id } },
  });

  return NextResponse.json({ url: session.url });
}
