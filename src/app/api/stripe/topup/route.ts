import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ensureUserDefaults } from "@/lib/auth";
import { getUserPlan } from "@/lib/usage";
import { env, isStripeConfigured } from "@/lib/env";
import { getStripe, priceIdForTopUp } from "@/lib/stripe";
import { TOP_UP_PACKS, canBuyTopUp } from "@/lib/credits";

/**
 * One-time usage top-up: POST { pack: "5" | "20" } → { url } of a Stripe
 * Checkout Session in "payment" mode. The credit itself is granted by the
 * webhook on `checkout.session.completed` (or `async_payment_succeeded`), keyed
 * on the session id — never here, where nothing has been paid yet.
 *
 * Same tax and consumer-law treatment as the subscription checkout: Stripe Tax
 * adds the buyer's VAT to the HT price, and the buyer asks for the credit to
 * be usable immediately and acknowledges losing the 14-day withdrawal right
 * (Code de la consommation L221-28 13°).
 */

const schema = z.object({ pack: z.enum(["5", "20"]) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid pack." }, { status: 400 });
  const pack = TOP_UP_PACKS[parsed.data.pack];

  const plan = await getUserPlan(user.id);
  if (!canBuyTopUp(plan)) {
    return NextResponse.json(
      {
        error: "plan_required",
        message: "Top-ups extend a paid plan. Upgrade to Lite or above to add usage.",
      },
      { status: 402 }
    );
  }

  const priceId = priceIdForTopUp(pack.id);
  if (!priceId) return NextResponse.json({ error: "Top-up price is not configured." }, { status: 503 });

  await ensureUserDefaults(user.id);
  const stripe = getStripe();
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  let customerId = sub?.stripeCustomerId ?? undefined;
  if (!customerId) {
    // A paid plan bought in the App Store has no Stripe customer yet.
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      name: user.name ?? undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;
    await prisma.subscription.update({ where: { userId: user.id }, data: { stripeCustomerId: customerId } });
  }

  const metadata = { userId: user.id, kind: "topup", pack: pack.id };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    // A pack's credit is computed from its list price; a discount would make
    // the two disagree, so packs take no promotion codes.
    allow_promotion_codes: false,
    ...(env.stripe.automaticTax
      ? {
          automatic_tax: { enabled: true },
          billing_address_collection: "required" as const,
          tax_id_collection: { enabled: true },
          customer_update: { address: "auto" as const, name: "auto" as const },
        }
      : {}),
    // A one-off payment gets an invoice only when asked for: a business buyer
    // needs one for its VAT, and a consumer is owed a receipt either way.
    invoice_creation: { enabled: true, invoice_data: { metadata } },
    consent_collection: { terms_of_service: "required" },
    custom_text: {
      terms_of_service_acceptance: {
        message:
          "I accept the [Terms of Sale](" +
          `${env.appUrl}/legal/cgv` +
          ") and ask for this usage credit to be available now. I acknowledge that I lose my 14-day right of withdrawal once it is. / J'accepte les CGV et demande que ce crédit d'usage soit disponible immédiatement ; je reconnais perdre mon droit de rétractation de 14 jours dès lors.",
      },
    },
    success_url: `${env.appUrl}/settings?section=billing&topup=1`,
    cancel_url: `${env.appUrl}/settings?section=billing`,
    metadata,
    payment_intent_data: { metadata },
  });

  return NextResponse.json({ url: session.url });
}
