/**
 * Whether agent payments are on, and with which provider, from the
 * environment alone (docs/design/agents-v2/ENABLE_PAYMENTS.md).
 *
 * Off by default. Stripe Issuing turns on only when all three of
 * `STRIPE_ISSUING_SECRET_KEY`, `STRIPE_ISSUING_CARDHOLDER_ID` and
 * `STRIPE_ISSUING_WEBHOOK_SECRET` are set: without the webhook secret no
 * authorization can be approved, and a card that can never be approved must
 * never be issued. The test provider is accepted only outside production and
 * only when asked for by name.
 *
 * Pure (it reads the object it is given), so tests pass their own variables
 * and never depend on the process environment. `src/lib/env.ts` exposes the
 * same values as getters.
 */

export type PaymentProviderKind = "stripe_issuing" | "test";

/** The API version every Stripe Issuing call and webhook answer carries (the installed SDK's). */
export const DEFAULT_STRIPE_ISSUING_API_VERSION = "2026-06-24.dahlia";
/** How long an issued card can be used before it is cancelled. */
export const DEFAULT_CARD_TTL_MINUTES = 30;
/** The largest single payment, in minor units, unless the owner sets another. */
export const DEFAULT_MAX_PAYMENT_MINOR = 50_000;
/** The only currency cards are issued in today (a US Issuing program). */
export const PAYMENT_CURRENCY = "usd";

type Vars = Readonly<Record<string, string | undefined>>;

function text(vars: Vars, name: string): string {
  return (vars[name] ?? "").trim();
}

function boundedInt(raw: string, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface StripeIssuingConfig {
  secretKey: string;
  cardholderId: string;
  webhookSecret: string;
  apiVersion: string;
}

export interface PaymentsConfig {
  provider: PaymentProviderKind | null;
  stripe: StripeIssuingConfig | null;
  cardTtlMinutes: number;
  maxPaymentMinor: number;
}

export function stripeIssuingConfig(vars: Vars): StripeIssuingConfig | null {
  const secretKey = text(vars, "STRIPE_ISSUING_SECRET_KEY");
  const cardholderId = text(vars, "STRIPE_ISSUING_CARDHOLDER_ID");
  const webhookSecret = text(vars, "STRIPE_ISSUING_WEBHOOK_SECRET");
  if (!secretKey || !cardholderId || !webhookSecret) return null;
  // A publishable key cannot issue cards, and a cardholder id of another kind
  // would issue to nobody: refuse the shape rather than fail at the first card.
  if (!/^(sk|rk)_(live|test)_/.test(secretKey)) return null;
  if (!/^ich_/.test(cardholderId)) return null;
  if (!/^whsec_/.test(webhookSecret)) return null;
  return {
    secretKey,
    cardholderId,
    webhookSecret,
    apiVersion: text(vars, "STRIPE_ISSUING_API_VERSION") || DEFAULT_STRIPE_ISSUING_API_VERSION,
  };
}

export function paymentsConfig(vars: Vars): PaymentsConfig {
  const stripe = stripeIssuingConfig(vars);
  const production = vars.NODE_ENV === "production";
  const testAsked = text(vars, "AGENT_PAYMENTS_TEST_PROVIDER") === "1";
  const provider: PaymentProviderKind | null = stripe ? "stripe_issuing" : testAsked && !production ? "test" : null;
  return {
    provider,
    stripe,
    cardTtlMinutes: boundedInt(text(vars, "AGENT_PAYMENT_CARD_TTL_MINUTES"), DEFAULT_CARD_TTL_MINUTES, 5, 24 * 60),
    maxPaymentMinor: boundedInt(text(vars, "AGENT_PAYMENT_MAX_AMOUNT_MINOR"), DEFAULT_MAX_PAYMENT_MINOR, 100, 10_000_000),
  };
}

export function arePaymentsConfigured(vars: Vars): boolean {
  return paymentsConfig(vars).provider !== null;
}
