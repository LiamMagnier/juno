/**
 * Browser Web Push, the pure half: what a subscription must look like before
 * it is stored, what a push carries, and which VAPID keys and subject the
 * server signs with.
 *
 * The sending half (src/lib/notify/web-push.ts) is `server-only` and talks to
 * the database and the push services, so it cannot be loaded by `tsx --test`.
 * Every decision it makes that can be got wrong lives here instead, where
 * tests/web-push.test.ts can hold it still.
 *
 * Not imported by the browser: the page's helpers (web-push-client.ts) carry
 * no zod, and the service worker (public/sw.js) re-validates on its own.
 */

import { z } from "zod";
import { safeAppPath } from "@/lib/notify/paths";
import type { NotifyChannel, PushPreferences } from "@/lib/notify/types";

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * The push services a browser subscription may point at, as host suffixes.
 *
 * An endpoint is a URL the browser hands us and the server then POSTs to, so
 * an unrestricted one makes every signed-in account a way to aim Juno's
 * outbound requests at any https host it names — including ones only the VM
 * can reach. Every shipping browser uses one of these four services, so the
 * list costs nothing but a line here if a fifth appears.
 */
export const PUSH_SERVICE_HOSTS = [
  // Chrome, Android, Samsung Internet, Opera, Brave.
  "fcm.googleapis.com",
  // Firefox (updates.push.services.mozilla.com).
  "push.services.mozilla.com",
  // Safari, macOS and Home Screen web apps on iOS (web.push.apple.com).
  "push.apple.com",
  // Edge (wns2-<region>.notify.windows.com).
  "notify.windows.com",
] as const;

/** Endpoints run a few hundred characters; WNS's are the longest. */
export const MAX_ENDPOINT_CHARS = 2048;

/** Browsers one account keeps subscribed at once. Past this the oldest go. */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

/** An https URL on a known push service, on the default port, with no credentials. */
export function isPushServiceEndpoint(value: string): boolean {
  if (value.length > MAX_ENDPOINT_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Base64url with the padding stripped. `PushSubscription.toJSON()` is meant to
 * produce exactly that, but not every engine has, and the `+`/`/` alphabet
 * and a trailing `=` are the same bytes — so they are normalised rather than
 * refused.
 */
export function toBase64Url(value: string): string {
  return value.trim().replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Bytes an unpadded base64url string decodes to. */
function decodedLength(value: string): number {
  return Math.floor((value.length * 3) / 4);
}

const p256dhSchema = z
  .string()
  .max(128)
  .transform(toBase64Url)
  // An uncompressed P-256 point: 65 bytes, the first of which is 0x04 — which
  // is why every valid key starts with "B".
  .refine((key) => BASE64URL.test(key) && decodedLength(key) === 65 && key.startsWith("B"), {
    message: "p256dh must be a 65-byte P-256 public key",
  });

const authSchema = z
  .string()
  .max(64)
  .transform(toBase64Url)
  // 16 bytes by the spec; the encryption library accepts longer.
  .refine((key) => BASE64URL.test(key) && decodedLength(key) >= 16 && decodedLength(key) <= 32, {
    message: "auth must be a 16-byte secret",
  });

/** An endpoint arriving to be stored: it has to be one we are willing to POST to. */
const newEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ENDPOINT_CHARS)
  .refine(isPushServiceEndpoint, { message: "endpoint must be an https URL on a known push service" });

/**
 * An endpoint that names a row already stored. Only shape-checked, so a
 * browser can still switch off or remove a subscription whose service later
 * leaves `PUSH_SERVICE_HOSTS`.
 */
export const storedEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_ENDPOINT_CHARS)
  .refine((value) => value.startsWith("https://"), { message: "endpoint must be an https URL" });

/** `PushSubscription.toJSON()`. `expirationTime` is accepted and ignored. */
export const pushSubscriptionSchema = z.object({
  endpoint: newEndpointSchema,
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: p256dhSchema, auth: authSchema }),
});

const switches = {
  notifyNeedsYou: z.boolean().optional(),
  notifyUpdates: z.boolean().optional(),
};

/** POST /api/push/subscriptions */
export const subscribeBodySchema = z.object({
  subscription: pushSubscriptionSchema,
  ...switches,
  /**
   * The subscription this one replaces, sent by the service worker's
   * `pushsubscriptionchange`: its switches carry over and its row goes.
   */
  oldEndpoint: storedEndpointSchema.optional(),
});

/** PATCH /api/push/subscriptions */
export const updateBodySchema = z.object({ endpoint: storedEndpointSchema, ...switches });

/** DELETE /api/push/subscriptions */
export const deleteBodySchema = z.object({ endpoint: storedEndpointSchema });

/**
 * The switches a (re)subscription is stored with. What the request asked for
 * wins; anything it left out keeps the value the same account had on the row
 * before (a re-subscribe must not quietly switch "Updates" back on); a row
 * taken over from another account, or a new one, starts from the defaults.
 */
export function subscriptionPreferences(
  requested: Partial<PushPreferences>,
  previous: PushPreferences | null
): PushPreferences {
  return {
    notifyNeedsYou: requested.notifyNeedsYou ?? previous?.notifyNeedsYou ?? true,
    notifyUpdates: requested.notifyUpdates ?? previous?.notifyUpdates ?? true,
  };
}

/**
 * What a subscribe may do with the row already holding its endpoint.
 *
 * An endpoint belongs to a browser, not an account, so someone else signing in
 * on it takes the row over. But the endpoint alone is not proof of being that
 * browser: it travels in a query string (GET ?endpoint=) and so in access
 * logs. The `auth` secret never leaves the browser except in this body, so a
 * takeover has to present the keys already stored. Anyone holding only the
 * endpoint could otherwise re-point a stranger's browser at their own
 * notifications, or at keys it cannot decrypt.
 */
export function subscriptionClaim(
  existing: { userId: string; p256dh: string; auth: string } | null,
  userId: string,
  keys: { p256dh: string; auth: string }
): "new" | "own" | "takeover" | "refused" {
  if (!existing) return "new";
  if (existing.userId === userId) return "own";
  return existing.p256dh === keys.p256dh && existing.auth === keys.auth ? "takeover" : "refused";
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** What one push carries to the service worker. */
export interface WebPushPayload {
  title: string;
  body: string;
  /** Relative in-app path it opens; anything `safeAppPath` refuses becomes null. */
  path: string | null;
  /** A later push with the same tag replaces this one on screen. */
  tag: string;
  notificationId: string | null;
  /**
   * When the push stops being worth delivering (an approval that expires).
   * Shortens how long the push services hold it; never sent to the browser.
   */
  expiresAt?: Date | null;
}

const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 600;
const MAX_TAG_CHARS = 64;

/**
 * The push services refuse a message over 4096 bytes, and aes128gcm spends
 * ~100 of those on its header and tag. Held well under so the JSON escaping of
 * an unusual body can never be what pushes it over.
 */
export const MAX_PAYLOAD_BYTES = 3000;

const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

function clip(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The payload as the JSON the service worker reads: lengths clipped, the path
 * re-validated (it is the one field that decides where a click lands), and
 * the body shortened further if the encoded message would still be too big.
 */
export function webPushMessage(payload: WebPushPayload): string {
  const message = {
    title: clip(payload.title, MAX_TITLE_CHARS) || "Juno",
    body: clip(payload.body, MAX_BODY_CHARS),
    path: safeAppPath(payload.path),
    tag: clip(payload.tag, MAX_TAG_CHARS) || "juno",
    notificationId:
      payload.notificationId && NOTIFICATION_ID.test(payload.notificationId) ? payload.notificationId : null,
  };
  let encoded = JSON.stringify(message);
  while (byteLength(encoded) > MAX_PAYLOAD_BYTES && message.body) {
    message.body = message.body.length > 8 ? clip(message.body, Math.floor(message.body.length * 0.75)) : "";
    encoded = JSON.stringify(message);
  }
  return encoded;
}

/**
 * How long the push services hold a message for a browser that is offline,
 * and how eagerly they wake a device for it.
 *
 * `needs_you` is short-lived on purpose: a run waiting on an approval is
 * answered from the phone or the inbox as often as not, and a banner that
 * arrives two hours late for something already decided is noise — the inbox
 * row outlives it either way. An update keeps half a day, long enough to
 * reach a laptop opened the next morning.
 *
 * A push that expires sooner than that (an approval with ten minutes left) is
 * held only until it expires, the way APNs holds it to `apns-expiration`: a
 * banner asking for an answer that can no longer be given would be a lie.
 */
export function webPushDelivery(
  channel: NotifyChannel,
  expiresAt?: Date | null,
  now: Date = new Date()
): { ttlSeconds: number; urgency: "high" | "normal" } {
  const delivery =
    channel === "needs_you"
      ? { ttlSeconds: 60 * 60, urgency: "high" as const }
      : { ttlSeconds: 12 * 60 * 60, urgency: "normal" as const };
  if (!expiresAt || !Number.isFinite(expiresAt.getTime())) return delivery;
  const left = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return { ...delivery, ttlSeconds: Math.min(delivery.ttlSeconds, left) };
}

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** An uncompressed P-256 public key (65 bytes) and its 32-byte private scalar. */
export function isVapidKeyPair(value: unknown): value is VapidKeys {
  if (!value || typeof value !== "object") return false;
  const { publicKey, privateKey } = value as Record<string, unknown>;
  return (
    typeof publicKey === "string" &&
    typeof privateKey === "string" &&
    BASE64URL.test(publicKey) &&
    BASE64URL.test(privateKey) &&
    publicKey.length === 87 &&
    publicKey.startsWith("B") &&
    privateKey.length === 43
  );
}

/**
 * The key pair the environment pins, if it pins one.
 *
 * "unset" when neither variable is set, and Juno provisions its own. Only one
 * of the two, or a malformed pair, is "invalid" rather than a reason to
 * provision: every browser subscription is bound to the public key it was
 * made with, so quietly minting a different pair would strand them all the
 * moment the operator finishes the paste.
 */
export function vapidKeysFromEnv(publicKey: string | undefined, privateKey: string | undefined): VapidKeys | "unset" | "invalid" {
  const pub = publicKey?.trim() ?? "";
  const priv = privateKey?.trim() ?? "";
  if (!pub && !priv) return "unset";
  const keys = { publicKey: toBase64Url(pub), privateKey: toBase64Url(priv) };
  return isVapidKeyPair(keys) ? keys : "invalid";
}

/** A stored `ServiceKey` value, once decrypted, or null when it is not a key pair. */
export function parseStoredVapidKeys(plain: string): VapidKeys | null {
  try {
    const parsed: unknown = JSON.parse(plain);
    return isVapidKeyPair(parsed) ? { publicKey: parsed.publicKey, privateKey: parsed.privateKey } : null;
  } catch {
    return null;
  }
}

/** Last resort: a contact that parses, on a domain that cannot exist. */
export const FALLBACK_VAPID_SUBJECT = "mailto:push@juno.invalid";

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Who the push services should contact about this sender: VAPID_SUBJECT when
 * it is a usable `mailto:` or `https:` URL, else the app's own URL when that
 * is https, else a placeholder. Apple's service rejects a localhost subject
 * outright (BadJwtToken), so a development URL falls through to the
 * placeholder rather than breaking every push to Safari.
 */
export function vapidSubject(input: { subject?: string | null; appUrl?: string | null }): string {
  const subject = input.subject?.trim();
  if (subject) {
    if (/^mailto:[^@\s]+@[^@\s]+$/.test(subject)) return subject;
    try {
      const url = new URL(subject);
      if (url.protocol === "https:" && !isLocalHost(url.hostname)) return subject;
    } catch {
      // Not a URL; fall through to the app URL.
    }
  }
  if (input.appUrl) {
    try {
      const url = new URL(input.appUrl);
      if (url.protocol === "https:" && !isLocalHost(url.hostname)) return url.origin;
    } catch {
      // Not a URL; fall through to the placeholder.
    }
  }
  return FALLBACK_VAPID_SUBJECT;
}
