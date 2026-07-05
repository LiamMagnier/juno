import { prisma } from "@/lib/prisma";
import { isStripeConfigured } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { deleteObject } from "@/lib/storage";

/*
 * Permanent account deletion (GDPR right to be forgotten), shared by
 * POST /api/account/delete (email-confirmed) and DELETE /api/account (legacy
 * settings-page path). Order matters: stop billing, purge stored objects,
 * then drop the user row — every relation cascades from User.
 */

const PURGE_CONCURRENCY = 5;

export interface DeletionReport {
  attachmentCount: number;
  purgedObjects: number;
  failedObjects: number;
}

export async function deleteAccountPermanently(user: {
  id: string;
  email?: string | null;
  image?: string | null;
}): Promise<DeletionReport> {
  // Cancel any active Stripe subscription immediately. Best-effort: a Stripe
  // outage must never block the deletion itself.
  if (isStripeConfigured()) {
    try {
      const sub = await prisma.subscription.findUnique({
        where: { userId: user.id },
        select: { stripeSubscriptionId: true },
      });
      if (sub?.stripeSubscriptionId) await getStripe().subscriptions.cancel(sub.stripeSubscriptionId);
    } catch (err) {
      console.error(`[account-delete] Stripe cancel failed for ${user.email ?? user.id}:`, err);
    }
  }

  // Best-effort purge of stored objects: attachment files + the avatar (stored
  // as a /api/files/<key> URL on User.image). Individual failures are tolerated.
  const attachments = await prisma.attachment.findMany({
    where: { userId: user.id },
    select: { storageKey: true },
  });
  const keys = attachments.map((a) => a.storageKey);
  const avatarKey = user.image?.startsWith("/api/files/") ? user.image.slice("/api/files/".length) : null;
  if (avatarKey) keys.push(avatarKey);

  let purged = 0;
  let failed = 0;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PURGE_CONCURRENCY, keys.length) }, async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        try {
          await deleteObject(key);
          purged++;
        } catch {
          failed++;
        }
      }
    })
  );

  await prisma.user.delete({ where: { id: user.id } });

  console.info(
    `[account-delete] account deleted email=${user.email ?? "unknown"} attachments=${attachments.length} objectsPurged=${purged} objectFailures=${failed}`
  );
  return { attachmentCount: attachments.length, purgedObjects: purged, failedObjects: failed };
}
