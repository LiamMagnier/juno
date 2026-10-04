import "server-only";
import type Stripe from "stripe";
import { prisma } from "@/lib/prisma";

/**
 * The account's Stripe customer, guaranteed to exist in the mode the key is
 * in. A customer id stored while the deployment ran on a test key does not
 * exist once it runs on a live key (and the other way round): Stripe answers
 * "No such customer" and every checkout failed. A stored id is kept only when
 * Stripe still knows it; otherwise a new customer is made and stored.
 */
export async function ensureStripeCustomer(
  stripe: Stripe,
  user: { id: string; email?: string | null; name?: string | null },
  storedId: string | null | undefined
): Promise<string> {
  if (storedId) {
    try {
      const existing = await stripe.customers.retrieve(storedId);
      if (!("deleted" in existing && existing.deleted)) return storedId;
    } catch (error) {
      if (!isMissingResource(error)) throw error;
    }
  }
  const customer = await stripe.customers.create({
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    metadata: { userId: user.id },
  });
  await prisma.subscription.update({ where: { userId: user.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

/** Stripe's "that id does not exist here" (wrong mode, deleted, mistyped). */
export function isMissingResource(error: unknown): boolean {
  const e = error as { code?: string; statusCode?: number; raw?: { code?: string } } | null;
  return e?.code === "resource_missing" || e?.raw?.code === "resource_missing" || e?.statusCode === 404;
}

/** A Stripe failure as one sentence the page can show; never a stack or a key. */
export function stripeErrorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 && message.length < 300 && !/sk_|rk_|whsec_/.test(message) ? message : fallback;
}
