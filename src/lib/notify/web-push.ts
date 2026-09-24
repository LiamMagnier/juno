import "server-only";
import { createHash } from "node:crypto";
import { generateVAPIDKeys, sendNotification } from "web-push";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import type { NotifyChannel } from "@/lib/notify/types";
import {
  isPushServiceEndpoint,
  MAX_SUBSCRIPTIONS_PER_USER,
  parseStoredVapidKeys,
  vapidKeysFromEnv,
  vapidSubject,
  webPushDelivery,
  webPushMessage,
  type VapidKeys,
  type WebPushPayload,
} from "@/lib/notify/web-push-shared";

/*
 * Browser Web Push: the key pair Juno signs with, and the send.
 *
 * One of the two push transports behind `notifyUser` (src/lib/notifications.ts)
 * — APNs reaches the native apps, this reaches browsers — and like everything
 * behind it, nothing here throws. A push that cannot be sent is logged and
 * counted out; the in-app row it accompanies has already been written.
 *
 * Decisions that can be tested (what a payload may carry, which key pair and
 * subject to use) live in web-push-shared.ts; this file is only the I/O.
 */

/** The `ServiceKey` row holding the pair Juno provisioned for itself. */
const SERVICE_KEY_NAME = "vapid";

/** After a failed key lookup, how long before the next request tries again. */
const RETRY_AFTER_MS = 60_000;

/** Pushes in flight at once for one person. Their browsers are few; this only bounds a pathological account. */
const SEND_CONCURRENCY = 4;

/** Per push service request. The library's own default is to wait forever. */
const SEND_TIMEOUT_MS = 10_000;

let cachedKeys: { keys: VapidKeys | null; at: number } | null = null;
let resolvingKeys: Promise<VapidKeys | null> | null = null;

/**
 * The key pair, resolved once per process and then free.
 *
 * `features.webPushPublicKey` asks for it on every page render, so the answer
 * is cached — a found pair forever (it never changes under a running process),
 * a failure for a minute, so a database blip turns the feature off briefly
 * rather than for the life of the process. Concurrent callers share the one
 * lookup in flight.
 */
async function vapidKeys(): Promise<VapidKeys | null> {
  if (cachedKeys && (cachedKeys.keys || Date.now() - cachedKeys.at < RETRY_AFTER_MS)) return cachedKeys.keys;
  resolvingKeys ??= resolveVapidKeys()
    .then((keys) => {
      cachedKeys = { keys, at: Date.now() };
      return keys;
    })
    .finally(() => {
      resolvingKeys = null;
    });
  return resolvingKeys;
}

async function resolveVapidKeys(): Promise<VapidKeys | null> {
  // Read here rather than at module scope: the tsx workers get `.env` through
  // Prisma's auto-load when the client is first constructed, which can be
  // after this module was evaluated.
  const pinned = vapidKeysFromEnv(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  if (pinned === "invalid") {
    console.error(
      "[web-push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a valid pair (both must be set, base64url) — browser push is off"
    );
    return null;
  }
  if (pinned !== "unset") return pinned;
  try {
    return await provisionedKeys();
  } catch (error) {
    // No database, or no encryption keyring to store the private key under:
    // the feature is off, and the page must still render.
    console.error("[web-push] could not load or provision a VAPID key pair — browser push is off", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * The pair Juno keeps in `ServiceKey`, minted on first use.
 *
 * Two processes can race to mint it on a fresh database (the web server and a
 * worker both sending their first push). `name` is the primary key, so exactly
 * one `create` wins; the loser reads the winner's pair back and throws its own
 * away — a subscription made against a pair that was never stored would be
 * undeliverable forever.
 */
async function provisionedKeys(): Promise<VapidKeys | null> {
  const stored = await prisma.serviceKey.findUnique({ where: { name: SERVICE_KEY_NAME } });
  if (stored) return readStoredKeys(stored.value);

  const minted = generateVAPIDKeys();
  try {
    await prisma.serviceKey.create({
      data: { name: SERVICE_KEY_NAME, value: encryptField(JSON.stringify(minted)) },
    });
    console.log("[web-push] provisioned a VAPID key pair for browser push");
    return { publicKey: minted.publicKey, privateKey: minted.privateKey };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await prisma.serviceKey.findUnique({ where: { name: SERVICE_KEY_NAME } });
    return winner ? readStoredKeys(winner.value) : null;
  }
}

function readStoredKeys(value: string): VapidKeys | null {
  const keys = parseStoredVapidKeys(decryptField(value));
  // Never overwritten from here: an undecryptable pair usually means a key
  // dropped from the ring, and putting it back brings every subscription back
  // with it. Minting a new pair over it would not.
  if (!keys) console.error("[web-push] the stored VAPID key pair could not be read — browser push is off");
  return keys;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "P2002");
}

/**
 * The public key browsers subscribe with, or null when browser push is off.
 * Cached per process and never throws — the app bootstrap calls it.
 */
export async function webPushPublicKey(): Promise<string | null> {
  try {
    return (await vapidKeys())?.publicKey ?? null;
  } catch {
    return null;
  }
}

/**
 * A push-service `Topic` for a tag: a later message with the same topic
 * replaces one still queued for an offline browser, the way the tag replaces
 * one already on screen. The header allows 32 base64url characters; a tag is
 * free text, so it is hashed down.
 */
function pushTopic(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** The push service's HTTP status, when the failure got as far as an answer. */
function pushStatus(error: unknown): number | null {
  const status = error && typeof error === "object" ? (error as { statusCode?: unknown }).statusCode : null;
  return typeof status === "number" ? status : null;
}

/** Who the log line is about without the endpoint itself, which is a capability. */
function serviceHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Pushes to every browser of the person whose switch for `channel` is on.
 * Returns how many push services accepted the message. Never throws.
 *
 * A service answering 404 or 410 has forgotten the subscription (the person
 * cleared site data, or the browser rotated it), so the row is switched off.
 * Anything else is logged and left: a 5xx or a timeout today says nothing
 * about tomorrow.
 */
export async function sendWebPushToUser(userId: string, payload: WebPushPayload, channel: NotifyChannel): Promise<number> {
  try {
    const keys = await vapidKeys();
    if (!keys) return 0;

    const subscriptions = await prisma.webPushSubscription.findMany({
      where: {
        userId,
        active: true,
        ...(channel === "needs_you" ? { notifyNeedsYou: true } : { notifyUpdates: true }),
      },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
      orderBy: { updatedAt: "desc" },
      take: MAX_SUBSCRIPTIONS_PER_USER,
    });
    // Checked again on the way out, not only when stored: this is the line
    // that decides where the server sends a request.
    const deliverable = subscriptions.filter((subscription) => isPushServiceEndpoint(subscription.endpoint));
    if (deliverable.length === 0) return 0;

    const body = webPushMessage(payload);
    const { ttlSeconds, urgency } = webPushDelivery(channel, payload.expiresAt);
    const options = {
      vapidDetails: {
        subject: vapidSubject({ subject: process.env.VAPID_SUBJECT, appUrl: process.env.NEXT_PUBLIC_APP_URL }),
        publicKey: keys.publicKey,
        privateKey: keys.privateKey,
      },
      TTL: ttlSeconds,
      urgency,
      topic: pushTopic(payload.tag),
      timeout: SEND_TIMEOUT_MS,
    };

    const delivered: string[] = [];
    const gone: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < deliverable.length) {
        const subscription = deliverable[next++]!;
        try {
          await sendNotification(
            { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
            body,
            options
          );
          delivered.push(subscription.id);
        } catch (error) {
          const status = pushStatus(error);
          if (status === 404 || status === 410) {
            gone.push(subscription.id);
          } else {
            console.warn("[web-push] push failed", {
              service: serviceHost(subscription.endpoint),
              status,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, deliverable.length) }, worker));

    const now = new Date();
    await Promise.all([
      delivered.length
        ? prisma.webPushSubscription.updateMany({ where: { userId, id: { in: delivered } }, data: { lastUsedAt: now } })
        : null,
      gone.length
        ? prisma.webPushSubscription.updateMany({ where: { userId, id: { in: gone } }, data: { active: false } })
        : null,
    ]).catch((error: unknown) => {
      console.warn("[web-push] could not record delivery", { error: error instanceof Error ? error.message : String(error) });
    });
    return delivered.length;
  } catch (error) {
    console.error("[web-push] send failed", { channel, error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}
