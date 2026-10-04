"use client";

import * as React from "react";
import type { Plan } from "@prisma/client";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PLANS } from "@/lib/plans";

/**
 * Paying without leaving Alevr: Stripe's embedded Checkout in a sheet over the
 * plans page. Card, Apple Pay and Google Pay, VAT, promo codes and the
 * withdrawal consent are Stripe's own form, so nothing about the purchase
 * changes but where it happens. The session is the one the checkout route
 * makes (`embedded: true`), and the webhook settles the plan exactly as for
 * the redirect.
 *
 * Needs NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY at build time; without it the
 * plans page keeps redirecting to Stripe's page (`inAppCheckoutAvailable`).
 */
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";

export const inAppCheckoutAvailable = PUBLISHABLE_KEY.startsWith("pk_");

let stripePromise: Promise<Stripe | null> | null = null;
function stripe() {
  stripePromise ??= loadStripe(PUBLISHABLE_KEY);
  return stripePromise;
}

export function CheckoutSheet({
  plan,
  interval,
  priceLine,
  onClose,
}: {
  /** The plan being bought; null when the sheet is shut. */
  plan: Plan | null;
  interval: "month" | "year";
  priceLine: string;
  onClose: () => void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const fetchClientSecret = React.useCallback(async () => {
    setError(null);
    const res = await fetch("/api/stripe/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, interval, embedded: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.clientSecret) {
      const message = data.error ?? "Couldn’t start checkout.";
      setError(message);
      throw new Error(message);
    }
    return data.clientSecret as string;
  }, [plan, interval]);

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] w-[min(36rem,calc(100vw-2rem))] max-w-none overflow-y-auto p-0 sm:rounded-panel">
        {plan && (
          <>
            <div className="px-6 pb-2 pt-6">
              <DialogTitle className="font-serif text-title font-normal">Upgrade to {PLANS[plan].name}</DialogTitle>
              <DialogDescription className="mt-1 text-ui text-muted-foreground">{priceLine}</DialogDescription>
            </div>
            {error ? (
              <p role="alert" className="px-6 pb-6 text-body text-destructive">
                {error}
              </p>
            ) : (
              // Keyed on the plan and interval: a new choice is a new session.
              <div key={`${plan}-${interval}`} className="min-h-[28rem] px-2 pb-2">
                <EmbeddedCheckoutProvider stripe={stripe()} options={{ fetchClientSecret }}>
                  <EmbeddedCheckout />
                </EmbeddedCheckoutProvider>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
