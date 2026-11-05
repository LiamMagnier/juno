import "server-only";
import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { domainMac } from "@/lib/crypto";
import { decryptField, encryptField, FIELD_DECRYPT_PLACEHOLDER } from "@/lib/field-crypto";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";
import { sendEmail } from "@/lib/email";
import { shareInvitation } from "@/lib/email-templates";
import { createShare, findLiveShare, peekPeopleShare, shareUrl } from "@/lib/share";
import {
  addSharePeople,
  listSharePeople,
  openPeopleShare,
  removeSharePerson,
  type PeopleShareDeps,
  type ShareTarget,
} from "@/lib/share-people-core";

/*
 * The database half of sharing with specific people. The rules — who may
 * read, what is bounded, what the owner is never told — are all in
 * src/lib/share-people-core.ts; this file only says where each fact lives.
 *
 * Every read of ShareRecipient goes through the GUARDED client with the
 * share owner's id in the where (the table is in OWNER_COLUMN). The share
 * page's recipient check is no exception: the token resolves the share, and
 * with it the owner id the check is scoped to. The token lookup itself is
 * share.ts's unguarded, request-cached one — the same query the public page
 * already makes — so a people share costs the page no extra round trip to
 * find.
 */

const RECIPIENT_SELECT = { id: true, email: true, emailHash: true, createdAt: true, invitedAt: true } as const;

function decryptEmail(stored: string): string | null {
  const value = decryptField(stored);
  return value === FIELD_DECRYPT_PLACEHOLDER ? null : value;
}

export function peopleShareDeps(): PeopleShareDeps {
  return {
    now: () => new Date(),
    mac: domainMac,
    encryptEmail: (email) => encryptField(email),
    decryptEmail,
    rateLimit: async (key, limit, windowSec) => (await rateLimit({ key, limit, windowSec })).success,
    findShare: (ownerId, target) => findLiveShare(ownerId, target.kind, target.targetId, "PEOPLE"),
    ensureShare: (ownerId, target) => createShare(ownerId, target.kind, target.targetId, { audience: "PEOPLE" }),
    listRecipients: (ownerId, shareId) =>
      prisma.shareRecipient.findMany({
        where: { shareId, userId: ownerId },
        orderBy: { createdAt: "asc" },
        select: RECIPIENT_SELECT,
      }),
    // `skipDuplicates` makes a race between two adds of the same address one
    // row, and `AndReturn` hands back only the rows THIS call made, so only
    // they are emailed.
    insertRecipients: (ownerId, shareId, rows) =>
      prisma.shareRecipient.createManyAndReturn({
        data: rows.map((row) => ({ shareId, userId: ownerId, emailHash: row.emailHash, email: row.email })),
        skipDuplicates: true,
        select: RECIPIENT_SELECT,
      }),
    async markInvited(ownerId, recipientIds, at) {
      await prisma.shareRecipient.updateMany({ where: { id: { in: recipientIds }, userId: ownerId }, data: { invitedAt: at } });
    },
    async removeRecipient(ownerId, recipientId) {
      const removed = await prisma.shareRecipient.deleteMany({ where: { id: recipientId, userId: ownerId } });
      return removed.count > 0;
    },
    async owner(ownerId) {
      const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true, email: true } });
      return { name: user?.name ?? null, email: user?.email ?? null };
    },
    async sendInvite(invite) {
      const mail = shareInvitation({
        ownerName: invite.ownerName,
        ownerEmail: invite.ownerEmail,
        kind: invite.kind,
        title: invite.title,
        recipient: invite.to,
        url: invite.url,
      });
      const result = await sendEmail({ to: invite.to, subject: mail.subject, html: mail.html, text: mail.text });
      return "ok" in result && result.ok;
    },
    shareUrl,
    findByToken: (token) => peekPeopleShare(token),
    async viewer() {
      const user = await getCurrentUser().catch(() => null);
      if (!user) return null;
      // Verification from the account row, never from the session: a session
      // minted before the address was confirmed (or changed) must not vouch
      // for it.
      const account = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true, emailVerified: true } });
      if (!account) return null;
      return { id: user.id, email: account.email, emailVerified: account.emailVerified };
    },
    async isRecipient(ownerId, shareId, emailHash) {
      const row = await prisma.shareRecipient.findFirst({ where: { shareId, emailHash, userId: ownerId }, select: { id: true } });
      return !!row;
    },
  };
}

export type { ShareTarget };

/** The dialog's read: the target's people share and who is on it. */
export function sharePeopleFor(ownerId: string, target: ShareTarget) {
  return listSharePeople(peopleShareDeps(), ownerId, target);
}

/** Add people to a target's people share (made if needed) and invite the new ones. */
export function addPeopleToShare(ownerId: string, target: ShareTarget, emails: readonly string[]) {
  return addSharePeople(peopleShareDeps(), ownerId, target, emails);
}

/** Take one person off one of the owner's shares. */
export function removePersonFromShare(ownerId: string, recipientId: string) {
  return removeSharePerson(peopleShareDeps(), ownerId, recipientId);
}

/**
 * The share page's people-share lookup for a token, request-cached so the
 * page and its metadata ask once. Null when the token is no live people share.
 */
export const resolvePeopleShare = cache(async (token: string) => openPeopleShare(peopleShareDeps(), token));
