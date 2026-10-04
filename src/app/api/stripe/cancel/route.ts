import { NextResponse } from "next/server";
import { z } from "zod";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { isStripeConfigured } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { PLANS } from "@/lib/plans";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { sendEmail } from "@/lib/email";
import { emailAppUrl, emailParagraph, escapeEmailHtml, renderEmailLayout } from "@/lib/email-layout";
import { cancellationEmail, contractReference, type CancellationRecap } from "@/lib/cancellation";

/**
 * Online cancellation (Code de la consommation L215-1-1; see src/lib/cancellation.ts).
 *
 *   GET   the recap the dialog shows before the person notifies: who, which
 *         contract, which plan, when it ends, and where it was bought.
 *   POST  { action: "cancel" }  notify the cancellation: the subscription is
 *         set to end at the close of the period already paid for, and the
 *         confirmation goes out by email (the durable medium the law asks for).
 *         { action: "resume" } undoes a pending cancellation before its date.
 *
 * The webhook (customer.subscription.updated) syncs the same row again; this
 * route writes it too so the settings page is right the moment it reloads.
 */

type Source = "stripe" | "app_store" | "none";

function periodEnd(sub: Stripe.Subscription): Date | null {
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const unix = item?.current_period_end ?? (sub as unknown as { current_period_end?: number }).current_period_end;
  return unix ? new Date(unix * 1000) : null;
}

function intervalOf(sub: Stripe.Subscription): "month" | "year" | null {
  const interval = sub.items?.data?.[0]?.price?.recurring?.interval;
  return interval === "month" || interval === "year" ? interval : null;
}

async function loadSubscription(userId: string) {
  return prisma.subscription.findUnique({
    where: { userId },
    select: {
      plan: true,
      status: true,
      stripeSubscriptionId: true,
      appStoreOriginalTransactionId: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sub = await loadSubscription(user.id);

  const source: Source = sub?.stripeSubscriptionId
    ? "stripe"
    : sub?.appStoreOriginalTransactionId
      ? "app_store"
      : "none";
  const active = !!sub && sub.plan !== "FREE" && sub.plan !== "OWNER" && sub.status !== "CANCELED";

  return NextResponse.json({
    source,
    active,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    recap: {
      reference: sub?.stripeSubscriptionId ? contractReference(sub.stripeSubscriptionId) : user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      planName: sub ? PLANS[sub.plan].name : PLANS.FREE.name,
      interval: null,
      endsAt: sub?.currentPeriodEnd?.toISOString() ?? null,
    } satisfies CancellationRecap,
  });
}

const schema = z.object({ action: z.enum(["cancel", "resume"]) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isStripeConfigured()) return NextResponse.json({ error: "Billing is not configured." }, { status: 503 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  const sub = await loadSubscription(user.id);
  if (!sub?.stripeSubscriptionId) {
    return NextResponse.json(
      {
        error: sub?.appStoreOriginalTransactionId
          ? "This subscription was bought through the App Store. Cancel it in your Apple ID subscription settings."
          : "There is no subscription to cancel on this account.",
      },
      { status: 400 }
    );
  }

  const cancel = parsed.data.action === "cancel";
  let updated: Stripe.Subscription;
  try {
    updated = await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: cancel });
  } catch (err) {
    console.error("[stripe/cancel] update failed", {
      userId: user.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Couldn’t reach the billing provider. Please try again." }, { status: 502 });
  }

  const endsAt = periodEnd(updated);
  await prisma.subscription.update({
    where: { userId: user.id },
    data: { cancelAtPeriodEnd: updated.cancel_at_period_end ?? cancel, ...(endsAt ? { currentPeriodEnd: endsAt } : {}) },
  });

  const recap: CancellationRecap = {
    reference: contractReference(sub.stripeSubscriptionId),
    name: user.name ?? null,
    email: user.email ?? null,
    planName: PLANS[sub.plan].name,
    interval: intervalOf(updated),
    endsAt: endsAt?.toISOString() ?? null,
  };

  // The confirmation on a durable medium (L215-1-1 al. 3). Best effort: email
  // never throws into a request, and the Stripe-side cancellation stands even
  // if the mail fails — the settings page shows the end date either way.
  let emailed = false;
  if (cancel && user.email) {
    const mail = cancellationEmail(recap, PRODUCT_NAME);
    const result = await sendEmail({
      to: user.email,
      subject: mail.subject,
      text: mail.text,
      html: renderEmailLayout({
        heading: "Résiliation enregistrée",
        bodyHtml: mail.paragraphs.map((p) => emailParagraph(escapeEmailHtml(p))).join(""),
        cta: { label: "Plan & usage", href: emailAppUrl("/settings") },
      }),
    });
    emailed = "ok" in result && result.ok;
  }

  return NextResponse.json({ ok: true, cancelAtPeriodEnd: updated.cancel_at_period_end ?? cancel, recap, emailed });
}
