import "server-only";

/**
 * The payment store on Postgres (AgentPayment, AgentSpendLimit). Every
 * guarded call is scoped by `userId`; the two cross-account reads (the
 * signature-verified webhook and the expiry sweep) use `prismaUnguarded` and
 * say so in their names.
 */

import type { AgentPayment } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { committedMinor } from "./policy";
import type { PaymentStore } from "./store";
import { PAYMENT_STATUSES, UNUSED_PAYMENT_STATUSES, type PaymentRecord, type PaymentStatus } from "./types";

function statusOf(value: string): PaymentStatus {
  // An unknown stored status reads as `failed`: never as a usable card.
  return (PAYMENT_STATUSES as readonly string[]).includes(value) ? (value as PaymentStatus) : "failed";
}

function toRecord(row: AgentPayment): PaymentRecord {
  return { ...row, status: statusOf(row.status) };
}

export function createPrismaPaymentStore(): PaymentStore {
  return {
    async createOrFind(data) {
      const existing = await prisma.agentPayment.findFirst({
        where: { userId: data.userId, idempotencyKey: data.idempotencyKey },
      });
      if (existing) return toRecord(existing);
      try {
        return toRecord(
          await prisma.agentPayment.create({
            data: {
              userId: data.userId,
              agentId: data.agentId,
              conversationId: data.conversationId,
              merchant: data.merchant,
              amountMinor: data.amountMinor,
              currency: data.currency,
              reason: data.reason,
              provider: data.provider,
              idempotencyKey: data.idempotencyKey,
              status: "pending",
            },
          }),
        );
      } catch {
        // A concurrent create of the same key won: read its row.
        const winner = await prisma.agentPayment.findFirst({
          where: { userId: data.userId, idempotencyKey: data.idempotencyKey },
        });
        if (!winner) throw new Error("The payment could not be recorded.");
        return toRecord(winner);
      }
    },

    async find(userId, id) {
      const row = await prisma.agentPayment.findFirst({ where: { id, userId } });
      return row ? toRecord(row) : null;
    },

    async listSince(userId, agentId, since) {
      const rows = await prisma.agentPayment.findMany({
        where: { userId, agentId, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        take: 1_000,
      });
      return rows.map(toRecord);
    },

    async transition(userId, id, from, patch) {
      const moved = await prisma.agentPayment.updateMany({
        where: { id, userId, status: { in: [...from] } },
        data: patch,
      });
      return moved.count === 1;
    },

    async reserveWithinLimit({ userId, agentId, id, limitMinor, monthStart }) {
      return prisma.$transaction(async (tx) => {
        // The limit row is the agent's lock: every reservation for this agent
        // waits here for the one before it, so two cannot both read room.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "AgentSpendLimit" WHERE "userId" = ${userId} AND "agentId" = ${agentId} FOR UPDATE`;
        if (locked.length !== 1) return false;
        const month = await tx.agentPayment.findMany({
          where: { userId, agentId, createdAt: { gte: monthStart }, id: { not: id } },
          select: { status: true, amountMinor: true, spentMinor: true, createdAt: true },
          take: 1_000,
        });
        const row = await tx.agentPayment.findFirst({ where: { id, userId, agentId }, select: { amountMinor: true, status: true } });
        if (!row || row.status !== "pending") return false;
        const others = month.map((entry) => ({ ...entry, status: statusOf(entry.status) }));
        if (committedMinor(others, monthStart) + row.amountMinor > limitMinor) return false;
        const moved = await tx.agentPayment.updateMany({
          where: { id, userId, agentId, status: "pending" },
          data: { status: "issued" },
        });
        return moved.count === 1;
      });
    },

    async findByCardUnguarded(cardId) {
      // Reached only from the signature-verified Stripe webhook, which has no
      // signed-in user: the provider's card id is the lookup key.
      const row = await prismaUnguarded.agentPayment.findFirst({ where: { providerCardId: cardId } });
      return row ? toRecord(row) : null;
    },

    async listStaleUnguarded(now, pendingBefore, limit) {
      // The background expiry sweep, across every account.
      const rows = await prismaUnguarded.agentPayment.findMany({
        where: {
          OR: [
            { status: { in: [...UNUSED_PAYMENT_STATUSES] }, expiresAt: { lte: now } },
            { status: "pending", createdAt: { lt: pendingBefore } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(toRecord);
    },

    async getSpendLimit(userId, agentId) {
      const row = await prisma.agentSpendLimit.findFirst({
        where: { userId, agentId },
        select: { monthlyLimitMinor: true, currency: true },
      });
      return row ?? null;
    },

    async setSpendLimit(userId, agentId, limit) {
      const moved = await prisma.agentSpendLimit.updateMany({
        where: { userId, agentId },
        data: { monthlyLimitMinor: limit.monthlyLimitMinor, currency: limit.currency },
      });
      if (moved.count === 1) return;
      await prisma.agentSpendLimit.create({
        data: { userId, agentId, monthlyLimitMinor: limit.monthlyLimitMinor, currency: limit.currency },
      });
    },
  };
}
