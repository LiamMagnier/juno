/**
 * Where payments and spending limits are kept, behind an interface so the
 * service (./service.ts) runs against memory in tests and Postgres in the app
 * (./prisma-store.ts).
 *
 * Every status change is a compare-and-set (`transition`): a row moves only
 * from the statuses the caller names, so two processes racing for the same
 * card (two fills, two authorizations, a fill and the expiry sweep) cannot
 * both win.
 */

import { committedMinor } from "./policy";
import { UNUSED_PAYMENT_STATUSES, type PaymentRecord, type PaymentStatus, type SpendLimitRecord } from "./types";

export type NewPayment = Omit<PaymentRecord, "id" | "createdAt" | "updatedAt" | "providerCardId" | "last4" | "approvalReceiptId" | "expiresAt" | "spentMinor" | "spentAt" | "status">;

export type PaymentPatch = Partial<
  Pick<PaymentRecord, "status" | "providerCardId" | "last4" | "approvalReceiptId" | "expiresAt" | "spentMinor" | "spentAt">
>;

export interface PaymentStore {
  /** Creates the row as `pending`, or returns the one already holding this key. */
  createOrFind(data: NewPayment): Promise<PaymentRecord>;
  find(userId: string, id: string): Promise<PaymentRecord | null>;
  /** Payments this agent made since `since`, for the monthly limit. */
  listSince(userId: string, agentId: string, since: Date): Promise<PaymentRecord[]>;
  /** Moves the row only while its status is one of `from`. True when it moved. */
  transition(userId: string, id: string, from: readonly PaymentStatus[], patch: PaymentPatch): Promise<boolean>;
  /**
   * `pending` → `issued`, but only while this agent's month, with this
   * payment added, stays within `limitMinor`. Serialized against every other
   * reservation for the same agent.
   */
  reserveWithinLimit(input: { userId: string; agentId: string; id: string; limitMinor: number; monthStart: Date }): Promise<boolean>;
  /** Signature-verified webhook only: the payment a provider card belongs to, across accounts. */
  findByCardUnguarded(cardId: string): Promise<PaymentRecord | null>;
  /** The expiry sweep only: unused cards past expiry, and requests left pending past `pendingBefore`. */
  listStaleUnguarded(now: Date, pendingBefore: Date, limit: number): Promise<PaymentRecord[]>;
  getSpendLimit(userId: string, agentId: string): Promise<SpendLimitRecord | null>;
  setSpendLimit(userId: string, agentId: string, limit: SpendLimitRecord): Promise<void>;
}

/** The store in memory: tests, and nothing else. */
export function createMemoryPaymentStore(now: () => Date = () => new Date()): PaymentStore & {
  rows: PaymentRecord[];
  limits: Map<string, SpendLimitRecord & { userId: string }>;
} {
  const rows: PaymentRecord[] = [];
  const limits = new Map<string, SpendLimitRecord & { userId: string }>();
  let seq = 0;
  const copy = (row: PaymentRecord): PaymentRecord => ({ ...row });

  return {
    rows,
    limits,
    async createOrFind(data) {
      const existing = rows.find((row) => row.userId === data.userId && row.idempotencyKey === data.idempotencyKey);
      if (existing) return copy(existing);
      seq += 1;
      const at = now();
      const row: PaymentRecord = {
        ...data,
        id: `pay_${seq}`,
        status: "pending",
        providerCardId: null,
        last4: null,
        approvalReceiptId: null,
        expiresAt: null,
        spentMinor: null,
        spentAt: null,
        createdAt: at,
        updatedAt: at,
      };
      rows.push(row);
      return copy(row);
    },
    async find(userId, id) {
      const row = rows.find((candidate) => candidate.id === id && candidate.userId === userId);
      return row ? copy(row) : null;
    },
    async listSince(userId, agentId, since) {
      return rows
        .filter((row) => row.userId === userId && row.agentId === agentId && row.createdAt.getTime() >= since.getTime())
        .map(copy);
    },
    async transition(userId, id, from, patch) {
      const row = rows.find((candidate) => candidate.id === id && candidate.userId === userId);
      if (!row || !from.includes(row.status)) return false;
      Object.assign(row, patch, { updatedAt: now() });
      return true;
    },
    async reserveWithinLimit({ userId, agentId, id, limitMinor, monthStart }) {
      const row = rows.find((candidate) => candidate.id === id && candidate.userId === userId && candidate.agentId === agentId);
      if (!row || row.status !== "pending") return false;
      const others = rows.filter((candidate) => candidate.userId === userId && candidate.agentId === agentId && candidate.id !== id);
      if (committedMinor(others, monthStart) + row.amountMinor > limitMinor) return false;
      row.status = "issued";
      row.updatedAt = now();
      return true;
    },
    async findByCardUnguarded(cardId) {
      const row = rows.find((candidate) => candidate.providerCardId === cardId);
      return row ? copy(row) : null;
    },
    async listStaleUnguarded(at, pendingBefore, limit) {
      return rows
        .filter(
          (row) =>
            ((UNUSED_PAYMENT_STATUSES as readonly string[]).includes(row.status) && !!row.expiresAt && row.expiresAt.getTime() <= at.getTime()) ||
            (row.status === "pending" && row.createdAt.getTime() < pendingBefore.getTime()),
        )
        .slice(0, limit)
        .map(copy);
    },
    async getSpendLimit(userId, agentId) {
      const limit = limits.get(agentId);
      return limit && limit.userId === userId ? { monthlyLimitMinor: limit.monthlyLimitMinor, currency: limit.currency } : null;
    },
    async setSpendLimit(userId, agentId, limit) {
      limits.set(agentId, { ...limit, userId });
    },
  };
}
