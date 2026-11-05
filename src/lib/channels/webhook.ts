/**
 * The Sendblue receive webhook, as a function of the request: authenticate,
 * parse, admit. The route only adapts the request to this and runs the
 * returned job after it has answered.
 *
 * Every answer past authentication is the same `200 { ok: true }`, whatever
 * happened to the text: ignored, replayed, rate limited or accepted. Sendblue
 * stops retrying on a 2xx, and a caller who somehow held the secret still
 * learns nothing about which numbers are linked.
 *
 * Pure, so tests/imessage-channel.test.ts drives it with a fake ledger.
 */

import { admitInbound, type AdmittedText, type InboundDeps, type InboundIgnoredReason } from "@/lib/channels/inbound";
import { parseSendblueWebhook, sendblueSecretMatches } from "@/lib/channels/sendblue";

/** A receive webhook is a few hundred bytes; anything this large is not one. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

export type WebhookOutcome =
  | { status: 401 | 404 | 413; body: { error: string } }
  | { status: 200; body: { ok: true }; ignored: InboundIgnoredReason | "unreadable" | null; admitted: AdmittedText | null };

type WebhookRefusal = Extract<WebhookOutcome, { status: 401 | 404 | 413 }>;

/**
 * The header alone: the route calls this before it reads the body, so an
 * unauthenticated caller never gets one parsed.
 */
export function authenticateSendblueWebhook(secret: string | null, config: { webhookSecret: string } | null): WebhookRefusal | null {
  // Off: the route does not exist, as far as anyone can tell.
  if (!config) return { status: 404, body: { error: "not_found" } };
  if (!sendblueSecretMatches(secret, config.webhookSecret)) return { status: 401, body: { error: "unauthorized" } };
  return null;
}

export async function handleSendblueWebhook(
  request: { secret: string | null; rawBody: string },
  config: { webhookSecret: string } | null,
  deps: InboundDeps
): Promise<WebhookOutcome> {
  const refused = authenticateSendblueWebhook(request.secret, config);
  if (refused) return refused;
  if (request.rawBody.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: "too_large" } };

  let json: unknown = null;
  try {
    json = JSON.parse(request.rawBody);
  } catch {
    json = null;
  }
  const message = parseSendblueWebhook(json);
  if (!message) return { status: 200, body: { ok: true }, ignored: "unreadable", admitted: null };

  const gate = await admitInbound("sendblue", message, deps);
  if (gate.kind === "ignored") return { status: 200, body: { ok: true }, ignored: gate.reason, admitted: null };
  return { status: 200, body: { ok: true }, ignored: null, admitted: gate.text };
}
