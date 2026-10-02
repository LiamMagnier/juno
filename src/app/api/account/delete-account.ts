import { prisma } from "@/lib/prisma";
import { isStripeConfigured } from "@/lib/env";
import { getStripe } from "@/lib/stripe";
import { deleteObject } from "@/lib/storage";
import { thumbnailObjectKey } from "@/lib/attachments/thumbnail";

/*
 * Permanent account deletion (GDPR right to be forgotten), shared by
 * POST /api/account/delete (email-confirmed) and DELETE /api/account (legacy
 * settings-page path). Order matters: stop billing, purge stored objects,
 * then drop the user row — every relation cascades from User.
 */

const PURGE_CONCURRENCY = 5;

export interface DeletionReport {
  attachmentCount: number;
  /** Work deliverable versions, each one stored object, found for the account. */
  deliverableVersionCount: number;
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

  // Best-effort purge of every stored object the account's rows point at. The
  // rows all cascade from User, so the keys are read first: once the user row
  // is gone nothing names these objects, and no later sweep could find them.
  //
  // The reads are not best-effort. If one fails, the deletion stops with the
  // user row still in place and can be retried; carrying on would erase the
  // only record of objects that were never purged.
  const [attachments, attachmentVersions, deliverableVersions, importObjects, toolRuns] = await Promise.all([
    prisma.attachment.findMany({
      where: { userId: user.id },
      select: { storageKey: true },
    }),
    // A replaced or restored file keeps its earlier bytes under the version's
    // own key. The current bytes are the attachment's, so most of these repeat
    // a key above; the set below deletes each object once.
    prisma.attachmentVersion.findMany({
      where: { attachment: { userId: user.id } },
      select: { storageKey: true },
    }),
    // Work deliverables: every version of every document, deck, sheet and
    // site, one object each, and none of them attachments (X-26). A version
    // row has no owner column, so the scope goes through the artifact it hangs
    // off. Soft-deleted deliverables are included: a deletedAt row still
    // points at bytes.
    prisma.workArtifactVersion.findMany({
      where: { artifact: { userId: user.id } },
      select: { storageKey: true },
    }),
    // Uploads from an import that had not finished. The recovery worker that
    // would sweep them reads the ImportRun ledger, which cascades with the
    // account. Attached ones are attachment keys already.
    prisma.importObject.findMany({
      where: { userId: user.id, status: { not: "deleted" } },
      select: { storageKey: true },
    }),
    // Hosted code runs keep their full stdout/stderr, when it was longer than
    // what the row holds, as two objects under one prefix per run
    // (src/lib/exec/capture.ts). What the runs produced are attachments above.
    prisma.toolRun.findMany({
      where: { userId: user.id, logKey: { not: null } },
      select: { logKey: true },
    }),
  ]);

  const keys = new Set<string>();
  // Each file and its rendered first page. The thumbnail is a picture OF the
  // document: it carries the same content and answers to the same erasure, so
  // purging the source and leaving the rendering behind would defeat the point
  // of this function. A key with nothing behind it deletes as a no-op.
  for (const { storageKey } of [...attachments, ...attachmentVersions]) {
    keys.add(storageKey);
    keys.add(thumbnailObjectKey(storageKey));
  }
  for (const { storageKey } of [...deliverableVersions, ...importObjects]) keys.add(storageKey);
  for (const { logKey } of toolRuns) {
    if (!logKey) continue;
    keys.add(`${logKey}stdout.log`);
    keys.add(`${logKey}stderr.log`);
  }
  // The avatar, stored as a /api/files/<key> URL on User.image.
  const avatarKey = user.image?.startsWith("/api/files/") ? user.image.slice("/api/files/".length) : null;
  if (avatarKey) keys.add(avatarKey);

  // Individual failures are tolerated and counted: a storage outage must never
  // keep someone's account alive. The first error is logged so an outage is
  // visible; the keys are not, because they carry the files' names.
  const queue = [...keys];
  let purged = 0;
  let failed = 0;
  let firstFailure: string | null = null;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(PURGE_CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const key = queue[cursor++];
        try {
          await deleteObject(key);
          purged++;
        } catch (err) {
          failed++;
          firstFailure ??= err instanceof Error ? err.message : String(err);
        }
      }
    })
  );
  if (failed > 0) {
    console.error(
      `[account-delete] ${failed} of ${queue.length} stored objects could not be purged; the account is deleted anyway:`,
      firstFailure
    );
  }

  await prisma.user.delete({ where: { id: user.id } });

  console.info(
    `[account-delete] account deleted email=${user.email ?? "unknown"} attachments=${attachments.length} deliverableVersions=${deliverableVersions.length} objectsPurged=${purged} objectFailures=${failed}`
  );
  return {
    attachmentCount: attachments.length,
    deliverableVersionCount: deliverableVersions.length,
    purgedObjects: purged,
    failedObjects: failed,
  };
}
