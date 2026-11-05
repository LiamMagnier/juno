/**
 * Sendblue: iMessage through a hosted line.
 *
 * Send. `POST https://api.sendblue.co/api/send-message` with the key pair in
 * `sb-api-key-id` and `sb-api-secret-key`, and a JSON body of `number`,
 * `from_number` and `content`
 * (docs.sendblue.com/api/resources/messages/methods/send/).
 *
 * Receive. The "receive" webhook posts `from_number`, `to_number`, `content`,
 * `message_handle`, `date_sent` and `is_outbound`
 * (docs.sendblue.com/getting-started/webhooks/). The webhook secret set in the
 * Sendblue dashboard comes back verbatim in the `sb-signing-secret` header; it
 * is a shared secret, not an HMAC of the body
 * (docs.sendblue.com/guides/chat-sdk-adapter/), so it is compared in constant
 * time and nothing else about the request is trusted until it matches.
 *
 * Pure apart from `fetch`, which is injected, so the tests run it against a
 * fake transport and never reach Sendblue.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { normalizePhone } from "@/lib/channels/phone";
import type { ChannelProvider, ChannelSendResult, InboundText } from "@/lib/channels/types";

export const SENDBLUE_SEND_URL = "https://api.sendblue.co/api/send-message";
export const SENDBLUE_SECRET_HEADER = "sb-signing-secret";
/** One text is short; a send that has not answered in this long is not coming back. */
const SEND_TIMEOUT_MS = 15_000;
/** iMessage has no hard limit, but a reply longer than this is a document, not a text. */
export const MAX_OUTBOUND_CHARS = 2_000;

export interface SendblueConfig {
  apiKeyId: string;
  apiSecretKey: string;
  fromNumber: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export function createSendblueProvider(config: SendblueConfig, fetchImpl: FetchLike = fetch): ChannelProvider {
  return {
    id: "sendblue",
    async send(to: string, text: string): Promise<ChannelSendResult> {
      let res: Response;
      try {
        res = await fetchImpl(SENDBLUE_SEND_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sb-api-key-id": config.apiKeyId,
            "sb-api-secret-key": config.apiSecretKey,
          },
          body: JSON.stringify({ number: to, from_number: config.fromNumber, content: text.slice(0, MAX_OUTBOUND_CHARS) }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, reason: "network", retryable: true };
      }
      if (!res.ok) {
        // The body is not read: an error page can echo the request, and the
        // request holds the number.
        return { ok: false, reason: `http_${res.status}`, retryable: res.status === 429 || res.status >= 500 };
      }
      const body = (await res.json().catch(() => null)) as { message_handle?: unknown } | null;
      return { ok: true, providerMessageId: typeof body?.message_handle === "string" ? body.message_handle : null };
    },
  };
}

/**
 * Whether the `sb-signing-secret` header is the configured secret.
 *
 * Both sides are hashed first, so the comparison takes the same time whatever
 * the lengths, and a wrong guess learns nothing about how much of it was
 * right. An empty expected secret never matches: the feature is off then, and
 * "no secret" must not mean "any secret".
 */
export function sendblueSecretMatches(received: string | null | undefined, expected: string): boolean {
  if (!expected || typeof received !== "string" || !received) return false;
  const a = createHash("sha256").update(received, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

const webhookSchema = z.object({
  from_number: z.string().max(40),
  to_number: z.string().max(40).nullish(),
  content: z.string().max(20_000).nullish(),
  message_handle: z.string().min(1).max(200),
  date_sent: z.string().max(64).nullish(),
  is_outbound: z.boolean().nullish(),
});

/**
 * The inbound text in a receive webhook, or null for anything to ignore:
 * a body that is not one, a message the line itself sent (`is_outbound`, which
 * Sendblue reports on the same hook), a sender that is not a phone number, or
 * a text with no words (a tapback, a photo on its own).
 */
export function parseSendblueWebhook(body: unknown): InboundText | null {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.is_outbound === true) return null;
  const from = normalizePhone(data.from_number);
  if (!from) return null;
  const text = (data.content ?? "").trim();
  if (!text) return null;
  const sentAtMs = data.date_sent ? Date.parse(data.date_sent) : Number.NaN;
  return {
    from,
    to: data.to_number ? normalizePhone(data.to_number) : null,
    text,
    handle: data.message_handle,
    sentAt: Number.isFinite(sentAtMs) ? new Date(sentAtMs) : null,
  };
}
