import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { env, isStripeConfigured } from "@/lib/env";
import { getStripe, priceIdForPlan } from "@/lib/stripe";
import { subscriptionConsentMarkdown } from "@/lib/billing/consent";
import { ensureStripeCustomer, stripeErrorMessage } from "@/lib/billing/stripe-customer";
import type Stripe from "stripe";

const schema = z.object({
  plan: z.enum(["LITE", "PRO", "PLUS", "MAX", "MAX20", "ULTRA"]),
  /** Defaults to monthly so an older client that omits it keeps working. */
  interval: z.enum(["month", "year"]).optional(),
  /**
   * Inside Alevr's own page (Stripe's embedded Checkout) rather than a
   * redirect to Stripe's: the same session, the same VAT, consent and promo
   * codes, answered with a client secret instead of a URL. Older clients omit
   * it and keep the redirect.
   */
  embedded: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });

  const interval = parsed.data.interval ?? "month";
  const priceId = priceIdForPlan(parsed.data.plan, interval);
  if (!priceId) return NextResponse.json({ error: "Plan price is not configured." }, { status: 503 });

  await ensureUserDefaults(user.id);
  const stripe = getStripe();
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });

  // A customer that exists in the key's own mode (a test-mode id stored
  // before the switch to live is replaced, see stripe-customer.ts).
  let customerId: string;
  try {
    customerId = await ensureStripeCustomer(stripe, user, sub?.stripeCustomerId);
  } catch (error) {
    console.error("[stripe] checkout customer failed", { message: stripeErrorMessage(error, "unknown") });
    return NextResponse.json({ error: stripeErrorMessage(error, "Couldn’t reach the payment provider.") }, { status: 502 });
  }

  let session: Stripe.Checkout.Session;
  try {
  session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    // VAT. Stripe Tax needs the buyer's address to pick the rate (FR 20%, the
    // buyer's own rate for other EU consumers under OSS), and a business that
    // enters a valid VAT number from an EU state other than France is
    // reverse-charged (a French business pays French VAT). Prices are HT on the
    // Stripe side ("exclusive"), so the TTC total shown here is what the
    // pricing page already displayed for a French buyer.
    ...(env.stripe.automaticTax
      ? {
          automatic_tax: { enabled: true },
          billing_address_collection: "required" as const,
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto" as const, name: "auto" as const },
        }
      : {}),
    // Droit de rétractation (Code de la consommation L221-18, L221-25,
    // L221-28 1°). A subscription is a digital SERVICE, not digital content,
    // so the 13° waiver (lose the right the moment it starts) does not apply.
    // What the law allows: the consumer expressly asks for the service to
    // start now and acknowledges losing the right once it is FULLY performed;
    // if they withdraw within 14 days they owe the share already provided
    // (L221-25). Both the request and the acknowledgment are this one required
    // checkbox; /legal/cgv art. 10 says the same, so change both together.
    // The terms-of-service URL itself is set in the Stripe dashboard
    // (Settings → Public details), pointing at /legal/cgv. The confirmation
    // email must repeat the request (L221-13) — see docs/pricing/LEGAL_CHECKLIST.md.
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message: subscriptionConsentMarkdown(env.appUrl),
      },
    },
    ...(parsed.data.embedded
      ? {
          ui_mode: "embedded_page" as const,
          return_url: `${env.appUrl}/upgrade/welcome?session_id={CHECKOUT_SESSION_ID}`,
        }
      : {
          success_url: `${env.appUrl}/chat?upgraded=1`,
          cancel_url: `${env.appUrl}/upgrade`,
        }),
    metadata: { userId: user.id, plan: parsed.data.plan, interval },
    subscription_data: { metadata: { userId: user.id } },
  });
  } catch (error) {
    console.error("[stripe] checkout session failed", { message: stripeErrorMessage(error, "unknown") });
    return NextResponse.json({ error: stripeErrorMessage(error, "Couldn’t start checkout.") }, { status: 502 });
  }

  if (parsed.data.embedded) return NextResponse.json({ clientSecret: session.client_secret });
  return NextResponse.json({ url: session.url });
}
