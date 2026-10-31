import "server-only";

/**
 * The database half of the iMessage channel: the `LinkDeps`, `InboundDeps`
 * and `AnswerDeps` that link.ts and inbound.ts run on, and the two reads the
 * settings surface needs.
 *
 * Two reads cross accounts, through `prismaUnguarded`, on purpose and only
 * here: the lookup of a number by its HMAC (a webhook, or a link start, knows
 * the number and not yet whose it is), and the replacement of another
 * account's `pending` row for a number (a pending row proves nothing; the code
 * goes to the phone). A `verified` row is only ever read across accounts,
 * never written. Every other statement is scoped by the person's own id.
 */

import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { domainMac, macEquals } from "@/lib/crypto";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { FIELD_DECRYPT_PLACEHOLDER } from "@/lib/field-crypto-placeholder";
import { env } from "@/lib/env";
import { rateLimit } from "@/lib/rate-limit";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { recordAgentEvent } from "@/lib/agents/store";
import { isE164, phoneLastFour } from "@/lib/channels/phone";
import type { ChannelLinkRow, LinkDeps } from "@/lib/channels/link";
import { absoluteAppUrl, APPROVAL_NOTICE_COPY, APPROVAL_NOTICE_LIMIT } from "@/lib/channels/notice";
import type { AnswerDeps, InboundDeps } from "@/lib/channels/inbound";
import type { ChannelProvider, ChannelProviderId } from "@/lib/channels/types";
import { agentTextReply, mirrorTextIntoThread } from "@/lib/channels/reply";
import { channelProvider } from "@/lib/channels/config";

/** The replay ledger keeps a day; the date window refuses anything older long before that. */
const LEDGER_KEEP_MS = 24 * 60 * 60 * 1000;

const LINK_SELECT = {
  id: true,
  userId: true,
  provider: true,
  phoneHash: true,
  phone: true,
  status: true,
  codeHash: true,
  codeExpiresAt: true,
  codeAttempts: true,
  verifiedAt: true,
  defaultAgentId: true,
} as const;

async function underLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  return (await rateLimit({ key, limit, windowSec })).success;
}

/** The number from its stored form, or null for a placeholder or a damaged row (never sent to). */
export function decryptPhone(stored: string): string | null {
  const value = decryptField(stored);
  return value !== FIELD_DECRYPT_PLACEHOLDER && isE164(value) ? value : null;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function appUrl(path: string): string {
  return absoluteAppUrl(env.appUrl, path) ?? env.appUrl;
}

export function linkDeps(provider: ChannelProvider): LinkDeps {
  return {
    provider,
    productName: PRODUCT_NAME,
    now: () => new Date(),
    newCode: () => String(randomInt(0, 1_000_000)).padStart(6, "0"),
    mac: domainMac,
    macEquals,
    encryptPhone: (phone) => encryptField(phone),
    decryptPhone,
    rateLimit: underLimit,
    findByPhoneHash: (providerId, phoneHash) =>
      prismaUnguarded.channelLink.findUnique({
        where: { provider_phoneHash: { provider: providerId, phoneHash } },
        select: LINK_SELECT,
      }),
    async writePending(input): Promise<ChannelLinkRow | null> {
      // Another account's unproved claim on this number gives way; a verified
      // row never does (the status is in the where).
      await prismaUnguarded.channelLink.deleteMany({
        where: { provider: input.provider, phoneHash: input.phoneHash, status: "pending", userId: { not: input.userId } },
      });
      await prisma.channelLink.deleteMany({
        where: { userId: input.userId, provider: input.provider, status: "pending", phoneHash: { not: input.phoneHash } },
      });
      const data = {
        phone: input.phone,
        codeHash: input.codeHash,
        codeExpiresAt: input.codeExpiresAt,
        codeAttempts: 0,
        defaultAgentId: input.defaultAgentId,
      };
      const updated = await prisma.channelLink.updateMany({
        where: { userId: input.userId, provider: input.provider, phoneHash: input.phoneHash, status: "pending" },
        data,
      });
      if (updated.count === 0) {
        try {
          await prisma.channelLink.create({
            data: { userId: input.userId, provider: input.provider, phoneHash: input.phoneHash, status: "pending", ...data },
          });
        } catch (error) {
          if (isUniqueViolation(error)) return null;
          throw error;
        }
      }
      return prisma.channelLink.findFirst({
        where: { userId: input.userId, provider: input.provider, phoneHash: input.phoneHash, status: "pending" },
        select: LINK_SELECT,
      });
    },
    findPending: (userId, providerId) =>
      prisma.channelLink.findFirst({
        where: { userId, provider: providerId, status: "pending" },
        orderBy: { updatedAt: "desc" },
        select: LINK_SELECT,
      }),
    async spendAttempt(userId, linkId, max) {
      const spent = await prisma.channelLink.updateMany({
        where: { id: linkId, userId, status: "pending", codeAttempts: { lt: max } },
        data: { codeAttempts: { increment: 1 } },
      });
      return spent.count === 1;
    },
    async markVerified(userId, linkId, at) {
      const moved = await prisma.channelLink.updateMany({
        where: { id: linkId, userId, status: "pending" },
        data: { status: "verified", verifiedAt: at, codeHash: null, codeExpiresAt: null, codeAttempts: 0 },
      });
      return moved.count === 1;
    },
    async removeOtherLinks(userId, providerId, keepId) {
      await prisma.channelLink.deleteMany({ where: { userId, provider: providerId, id: { not: keepId } } });
    },
    async deleteLink(userId, linkId) {
      await prisma.channelLink.deleteMany({ where: { id: linkId, userId } });
    },
  };
}

export function inboundDeps(): InboundDeps {
  return {
    now: () => new Date(),
    mac: domainMac,
    ownNumber: env.channels.sendblue.fromNumber || null,
    rateLimit: underLimit,
    async claimHandle(providerId, handleHash) {
      try {
        // The ledger is ownerless (no userId), so the guarded client allows it.
        await prisma.channelInbound.create({ data: { provider: providerId, handleHash } });
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
      // Pruned now and then rather than by a sweep: one indexed delete in fifty.
      if (randomInt(0, 50) === 0) {
        await prisma.channelInbound
          .deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - LEDGER_KEEP_MS) } } })
          .catch(() => undefined);
      }
      return true;
    },
    async findVerifiedLink(providerId, phoneHash) {
      const link = await prismaUnguarded.channelLink.findUnique({
        where: { provider_phoneHash: { provider: providerId, phoneHash } },
        select: { id: true, userId: true, status: true, defaultAgentId: true },
      });
      return link && link.status === "verified" ? { id: link.id, userId: link.userId, defaultAgentId: link.defaultAgentId } : null;
    },
  };
}

export function answerDeps(provider: ChannelProvider): AnswerDeps {
  return {
    provider,
    productName: PRODUCT_NAME,
    appUrl,
    listAgents: (userId) =>
      prisma.agent.findMany({
        where: { userId, deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true, role: true, status: true },
      }),
    reply: agentTextReply,
    mirror: mirrorTextIntoThread,
    async record({ userId, linkId, agentId, answered }) {
      await prisma.channelLink
        .updateMany({ where: { id: linkId, userId }, data: { lastInboundAt: new Date() } })
        .catch(() => undefined);
      // No content and no number: the log says a text came, not what it said.
      await recordAgentEvent({
        userId,
        agentId,
        kind: "channel_message",
        title: answered ? "Answered a text from iMessage" : "Got a text from iMessage",
        detail: { channel: "imessage" },
      });
    },
  };
}

/** What Settings shows: never the number, only its last four digits. */
export interface ClientChannelLink {
  status: "pending" | "verified";
  lastFour: string;
  verifiedAt: string | null;
  codeExpiresAt: string | null;
}

export async function channelLinkFor(userId: string, providerId: ChannelProviderId): Promise<ClientChannelLink | null> {
  const rows = await prisma.channelLink.findMany({
    where: { userId, provider: providerId },
    orderBy: { updatedAt: "desc" },
    select: { status: true, phone: true, verifiedAt: true, codeExpiresAt: true },
  });
  // A verified link is the answer while a new number's code is pending.
  const row = rows.find((r) => r.status === "verified") ?? rows[0];
  if (!row) return null;
  const phone = decryptPhone(row.phone);
  return {
    status: row.status === "verified" ? "verified" : "pending",
    lastFour: phone ? phoneLastFour(phone) : "",
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    codeExpiresAt: row.status === "verified" ? null : row.codeExpiresAt?.toISOString() ?? null,
  };
}

export async function unlinkChannel(userId: string, providerId: ChannelProviderId): Promise<number> {
  const removed = await prisma.channelLink.deleteMany({ where: { userId, provider: providerId } });
  return removed.count;
}

/** The account's verified number on this provider, decrypted for one send, or null. */
export async function verifiedPhoneFor(userId: string, providerId: ChannelProviderId): Promise<string | null> {
  const row = await prisma.channelLink.findFirst({
    where: { userId, provider: providerId, status: "verified" },
    select: { phone: true },
  });
  return row ? decryptPhone(row.phone) : null;
}

/**
 * Texts an approval notice to the account's verified number (notice.ts):
 * who is waiting and a link to the card, nothing about what. Never throws,
 * and does nothing when the feature is off, nobody is linked, or the hour's
 * texts are spent.
 */
export async function textApprovalNotice(input: { userId: string; who: string; path: string }): Promise<boolean> {
  try {
    const provider = channelProvider();
    if (!provider) return false;
    const url = absoluteAppUrl(env.appUrl, input.path);
    if (!url) return false;
    const phone = await verifiedPhoneFor(input.userId, provider.id);
    if (!phone) return false;
    if (!(await underLimit(`channel:notice:${input.userId}`, APPROVAL_NOTICE_LIMIT, 3600))) return false;
    const sent = await provider.send(phone, APPROVAL_NOTICE_COPY.text(input.who, url));
    if (!sent.ok) console.warn("[channels] approval text not sent", { reason: sent.reason });
    return sent.ok;
  } catch (error) {
    console.error("[channels] approval text failed", { error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
