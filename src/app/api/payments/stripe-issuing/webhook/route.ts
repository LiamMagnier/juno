import { after, NextResponse } from "next/server";
import { paymentsConfig } from "@/lib/payments/config";
import { paymentProvider, paymentStore } from "@/lib/payments/server";
import { handleAuthorizationRequest } from "@/lib/payments/service";
import { answerIssuingWebhook } from "@/lib/payments/webhook";

export const runtime = "nodejs";

/**
 * Stripe Issuing's real-time authorization webhook
 * (docs/design/agents-v2/ENABLE_PAYMENTS.md). Authenticated by the
 * `Stripe-Signature` over the raw body, not a session. Answers
 * `issuing_authorization.request` with `{ approved }` inside the 2 s Stripe
 * allows; the decision is `answerIssuingWebhook` (src/lib/payments/webhook.ts).
 */
export async function POST(req: Request) {
  const config = paymentsConfig(process.env).stripe;
  // Read before anything else: the signature is over these exact bytes.
  const payload = await req.text();
  const answer = await answerIssuingWebhook({
    config,
    payload,
    signature: req.headers.get("stripe-signature"),
    nowMs: Date.now(),
    // Imported statically, not on first use: a cold import inside the
    // deadline would decline the first authorization after a restart.
    handle: (request) => handleAuthorizationRequest({ store: paymentStore(), provider: paymentProvider() }, request),
  });
  if (answer.log) console.info("[payments] stripe issuing webhook", answer.log);
  if (answer.after) {
    const followUp = answer.after;
    after(() => followUp());
  }
  return NextResponse.json(answer.body, {
    status: answer.status,
    headers: { ...answer.headers, "Cache-Control": "no-store" },
  });
}
