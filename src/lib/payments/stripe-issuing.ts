/**
 * Stripe Issuing as a payment provider, and the verification of its
 * real-time authorization webhook.
 *
 * Off until all three `STRIPE_ISSUING_*` values are set (./config.ts). Each
 * card is virtual, active at once, and carries
 * `spending_controls.spending_limits[{ amount, interval: all_time }]` equal to
 * the approved amount, so Stripe itself refuses anything above it even before
 * the webhook is asked. Details come from `expand[]=number&expand[]=cvc` and
 * nothing else; cards are cancelled with `status=canceled`.
 *
 * Talks to the REST API with an injected `fetch`, so the tests run against a
 * fake with no network. No response body is ever put in an error or a log:
 * a reveal's body holds the card number.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { StripeIssuingConfig } from "./config";
import type { CardDetails, IssueCardInput, IssuedCard, PaymentProvider } from "./types";

const API = "https://api.stripe.com/v1";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** An error that names the call and the status only, never the body. */
export class StripeIssuingError extends Error {
  constructor(
    readonly operation: "issue" | "reveal" | "cancel",
    readonly status: number,
  ) {
    super(`Stripe Issuing could not ${operation} the card (HTTP ${status}).`);
    this.name = "StripeIssuingError";
  }
}

function form(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function createStripeIssuingProvider(
  config: StripeIssuingConfig,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {},
): PaymentProvider {
  const fetchImpl: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.timeoutMs ?? 15_000;

  const call = async (
    operation: "issue" | "reveal" | "cancel",
    method: "GET" | "POST",
    path: string,
    body?: Record<string, string | number>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.secretKey}`,
      "Stripe-Version": config.apiVersion,
    };
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers,
      ...(body ? { body: form(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new StripeIssuingError(operation, response.status);
    return record(await response.json().catch(() => null));
  };

  return {
    name: "stripe_issuing",

    async issueCard(input: IssueCardInput): Promise<IssuedCard> {
      if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new StripeIssuingError("issue", 0);
      const card = await call(
        "issue",
        "POST",
        "/issuing/cards",
        {
          cardholder: config.cardholderId,
          currency: input.currency.toLowerCase(),
          type: "virtual",
          status: "active",
          "spending_controls[spending_limits][0][amount]": input.amountMinor,
          "spending_controls[spending_limits][0][interval]": "all_time",
          "metadata[juno_payment_id]": input.paymentId,
        },
        `juno-payment-${input.paymentId}`,
      );
      const cardId = typeof card.id === "string" ? card.id : "";
      const last4 = typeof card.last4 === "string" ? card.last4 : "";
      if (!cardId.startsWith("ic_") || !/^\d{4}$/.test(last4)) throw new StripeIssuingError("issue", 502);
      return {
        cardId,
        last4,
        expMonth: typeof card.exp_month === "number" ? card.exp_month : 0,
        expYear: typeof card.exp_year === "number" ? card.exp_year : 0,
      };
    },

    async revealCard(cardId: string): Promise<CardDetails> {
      if (!/^ic_[A-Za-z0-9]+$/.test(cardId)) throw new StripeIssuingError("reveal", 400);
      const card = await call("reveal", "GET", `/issuing/cards/${cardId}?expand[]=number&expand[]=cvc`);
      const number = typeof card.number === "string" ? card.number : "";
      const cvc = typeof card.cvc === "string" ? card.cvc : "";
      if (!/^\d{12,19}$/.test(number) || !/^\d{3,4}$/.test(cvc)) throw new StripeIssuingError("reveal", 502);
      const cardholder = record(card.cardholder);
      return {
        number,
        cvc,
        expMonth: typeof card.exp_month === "number" ? card.exp_month : 0,
        expYear: typeof card.exp_year === "number" ? card.exp_year : 0,
        name: typeof cardholder.name === "string" ? cardholder.name : null,
      };
    },

    async cancelCard(cardId: string): Promise<void> {
      if (!/^ic_[A-Za-z0-9]+$/.test(cardId)) throw new StripeIssuingError("cancel", 400);
      await call("cancel", "POST", `/issuing/cards/${cardId}`, { status: "canceled" });
    },
  };
}

/** How old a signed webhook may be (Stripe's own default tolerance). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header over the raw body: `t=<unix>,v1=<hex>`,
 * where v1 is HMAC-SHA256 of `${t}.${body}` under the endpoint's secret.
 * Constant-time comparison, any one matching v1 accepted, a timestamp outside
 * the tolerance refused. Returns false for every malformed header.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null | undefined;
  secret: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const { payload, header, secret } = input;
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return false;
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${timestamp}.${payload}`, "utf8").digest("hex"), "utf8");
  return signatures.some((signature) => {
    const given = Buffer.from(signature, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** The parts of an `issuing_authorization.request` event the decision reads. */
export interface IssuingAuthorizationEvent {
  eventId: string;
  authorizationId: string;
  cardId: string;
  amountMinor: number;
  currency: string;
  merchantName: string | null;
}

/**
 * Reads the event Stripe sent. Null for anything that is not a well-formed
 * `issuing_authorization.request`. The amount asked is `pending_request.amount`
 * (in the card's currency), falling back to the authorization's own `amount`.
 */
export function readAuthorizationRequest(event: unknown): IssuingAuthorizationEvent | null {
  const root = record(event);
  if (root.type !== "issuing_authorization.request") return null;
  const object = record(record(root.data).object);
  if (object.object !== "issuing.authorization") return null;
  const card = record(object.card);
  const cardId = typeof object.card === "string" ? object.card : typeof card.id === "string" ? card.id : "";
  const pending = record(object.pending_request);
  const amount = typeof pending.amount === "number" ? pending.amount : typeof object.amount === "number" ? object.amount : NaN;
  const currency =
    typeof pending.currency === "string" ? pending.currency : typeof object.currency === "string" ? object.currency : "";
  const merchant = record(object.merchant_data);
  if (!cardId || typeof object.id !== "string" || !currency || !Number.isFinite(amount)) return null;
  return {
    eventId: typeof root.id === "string" ? root.id : "",
    authorizationId: object.id,
    cardId,
    amountMinor: amount,
    currency: currency.toLowerCase(),
    merchantName: typeof merchant.name === "string" ? merchant.name : null,
  };
}
