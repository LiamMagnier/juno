/**
 * The Stripe Issuing webhook, as a pure function of the request
 * (src/app/api/payments/stripe-issuing/webhook/route.ts is a thin wrapper).
 *
 *   - Off (404) unless Stripe Issuing is configured.
 *   - A missing or bad `Stripe-Signature` is refused (400) before the body is
 *     even parsed.
 *   - `issuing_authorization.request` is answered synchronously with
 *     `{ approved }` and the `Stripe-Version` header, inside a deadline well
 *     under Stripe's 2 seconds. Running out of time declines: a slow database
 *     never approves anything.
 *   - Every other event type is acknowledged and ignored.
 */

import type { AuthorizationHandling } from "./service";
import type { AuthorizationRequest } from "./policy";
import { readAuthorizationRequest, verifyStripeSignature } from "./stripe-issuing";

/** Time the decision may take. Stripe waits 2 s; the rest is the network's. */
export const AUTHORIZATION_DEADLINE_MS = 1_500;

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
  /** Run after the answer is sent (cancel a spent card). */
  after: (() => Promise<void>) | null;
  /** One line for the server log: ids, the answer and its reason. Never a card detail. */
  log: Record<string, unknown> | null;
}

export async function answerIssuingWebhook(input: {
  config: { webhookSecret: string; apiVersion: string } | null;
  payload: string;
  signature: string | null;
  nowMs: number;
  handle: (request: AuthorizationRequest) => Promise<AuthorizationHandling>;
  deadlineMs?: number;
}): Promise<WebhookAnswer> {
  if (!input.config) {
    return { status: 404, body: { error: "not_found", message: "Payments are not configured." }, headers: {}, after: null, log: null };
  }
  const signed = verifyStripeSignature({
    payload: input.payload,
    header: input.signature,
    secret: input.config.webhookSecret,
    nowSeconds: Math.floor(input.nowMs / 1000),
  });
  if (!signed) {
    return {
      status: 400,
      body: { error: "invalid_signature", message: "The signature does not match." },
      headers: {},
      after: null,
      log: { event: "invalid_signature" },
    };
  }
  let event: unknown;
  try {
    event = JSON.parse(input.payload);
  } catch {
    return { status: 400, body: { error: "invalid_body", message: "The body is not JSON." }, headers: {}, after: null, log: null };
  }
  const type = event && typeof event === "object" ? (event as { type?: unknown }).type : undefined;
  const versioned = { "Stripe-Version": input.config.apiVersion };
  if (type !== "issuing_authorization.request") {
    return { status: 200, body: { received: true }, headers: {}, after: null, log: null };
  }
  const request = readAuthorizationRequest(event);
  if (!request) {
    return { status: 200, body: { approved: false }, headers: versioned, after: null, log: { event: "unreadable_authorization" } };
  }

  const deadline = input.deadlineMs ?? AUTHORIZATION_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadline);
  });
  const handled = await Promise.race([
    input.handle({ cardId: request.cardId, amountMinor: request.amountMinor, currency: request.currency }).catch(() => null),
    timedOut,
  ]);
  if (timer) clearTimeout(timer);
  const approved = handled?.verdict.approved === true;
  return {
    status: 200,
    body: { approved },
    headers: versioned,
    after: handled ? () => handled.followUp() : null,
    log: {
      event: "authorization",
      authorization: request.authorizationId,
      card: request.cardId,
      approved,
      reason: handled ? handled.verdict.reason : "deadline",
    },
  };
}
