import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { isStripeConfigured } from "@/lib/env";
import { getStripe } from "@/lib/stripe";

/** Permanently delete the user's account and all associated data. */
export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Best-effort: cancel an active Stripe subscription so billing stops.
  if (isStripeConfigured()) {
    const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
    if (sub?.stripeSubscriptionId) {
      try {
        await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
      } catch {
        /* ignore — proceed with deletion */
      }
    }
  }

  // Cascades remove settings, conversations, messages, attachments, memories, etc.
  await prisma.user.delete({ where: { id: user.id } });
  return NextResponse.json({ ok: true });
}
