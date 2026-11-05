import "server-only";

/**
 * The real parts of agent payments, wired: the provider the environment
 * names (or none), the Postgres store, the approval broker and the computer
 * fill. Imported only through `await import()` from the chat tools, the
 * webhook route and the sweep.
 */

import { paymentsConfig } from "./config";
import { computerCardFillerResolver } from "./computer-fill";
import { registerPaymentCardFiller, registeredPaymentCardFiller } from "./fill";
import { createPrismaPaymentStore } from "./prisma-store";
import { createStripeIssuingProvider } from "./stripe-issuing";
import { createTestPaymentProvider } from "./test-provider";
import type { PaymentStore } from "./store";
import type { PaymentProvider } from "./types";

let cached: { key: string; provider: PaymentProvider | null } | null = null;

/** The provider for this server's configuration, or null when payments are off. */
export function paymentProvider(): PaymentProvider | null {
  const config = paymentsConfig(process.env);
  const key = `${config.provider}:${config.stripe?.cardholderId ?? ""}:${config.stripe?.apiVersion ?? ""}`;
  if (cached?.key === key) return cached.provider;
  const provider =
    config.provider === "stripe_issuing" && config.stripe
      ? createStripeIssuingProvider(config.stripe)
      : config.provider === "test"
        ? createTestPaymentProvider()
        : null;
  cached = { key, provider };
  return provider;
}

let store: PaymentStore | null = null;
export function paymentStore(): PaymentStore {
  return (store ??= createPrismaPaymentStore());
}

/** The computer layer's filler, unless something else registered first. */
export function ensureCardFiller(): void {
  if (!registeredPaymentCardFiller()) registerPaymentCardFiller(computerCardFillerResolver);
}

/** The background sweep: expired cards cancelled, abandoned requests closed. Quiet when payments are off. */
export async function sweepAgentPayments(): Promise<{ expired: number; closed: number }> {
  const provider = paymentProvider();
  if (!provider) return { expired: 0, closed: 0 };
  const { sweepStalePayments } = await import("./service");
  return sweepStalePayments({ store: paymentStore(), provider });
}
