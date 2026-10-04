import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { decryptMessageText, encryptMessageText } from "@/lib/message-crypto";
import type { BatchItemResult } from "@/lib/batch/parse";

/*
 * BatchJob rows (migration 20261004130000_cost_engineering), read and written
 * with raw SQL so the code does not depend on when the Prisma client is
 * regenerated. Per-account reads go through the guarded client scoped by
 * userId; the one cross-account read — which batches are still running — uses
 * `prismaUnguarded` and returns ids, the same choice findAccountsToDream makes.
 *
 * Prompts are never stored: `requests` maps each custom_id to the prompt's
 * key. Answers are stored encrypted, like the messages they were read from.
 */

export interface BatchJobRequest {
  customId: string;
  key: string;
  label: string;
}

export interface StoredBatchResult {
  key: string;
  ok: boolean;
  /** Encrypted answer text. */
  text: string | null;
}

export interface BatchJobRow {
  id: string;
  userId: string;
  provider: string;
  model: string;
  purpose: string;
  providerBatchId: string | null;
  status: "submitted" | "ended" | "applied" | "failed";
  requestCount: number;
  matchedCount: number;
  requests: BatchJobRequest[];
  results: Record<string, StoredBatchResult> | null;
  createdAt: Date;
}

const COLUMNS = Prisma.sql`"id", "userId", "provider", "model", "purpose", "providerBatchId", "status",
  "requestCount", "matchedCount", "requests", "results", "createdAt"`;

export async function createBatchJob(input: {
  userId: string;
  provider: string;
  model: string;
  purpose: string;
  providerBatchId: string | null;
  requests: BatchJobRequest[];
  status?: "submitted" | "failed";
  error?: string | null;
}): Promise<string> {
  const id = `bj_${randomUUID().replace(/-/g, "")}`;
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "BatchJob" ("id", "userId", "provider", "model", "purpose", "providerBatchId", "status", "requestCount", "requests", "error")
    VALUES (${id}, ${input.userId}, ${input.provider}, ${input.model}, ${input.purpose}, ${input.providerBatchId},
            ${input.status ?? "submitted"}, ${input.requests.length}, ${JSON.stringify(input.requests)}::jsonb, ${input.error ?? null})
  `);
  return id;
}

/** The account's jobs still in play: running, or ended and not yet applied. */
export async function openBatchJobs(userId: string): Promise<BatchJobRow[]> {
  return prisma.$queryRaw<BatchJobRow[]>(Prisma.sql`
    SELECT ${COLUMNS} FROM "BatchJob"
    WHERE "userId" = ${userId} AND "status" IN ('submitted', 'ended')
    ORDER BY "createdAt" ASC
  `);
}

/** The account's most recent settled jobs, newest first, for the circuit breaker. */
export async function recentBatchOutcomes(userId: string, limit = 5): Promise<Array<Pick<BatchJobRow, "status" | "requestCount" | "matchedCount">>> {
  return prisma.$queryRaw(Prisma.sql`
    SELECT "status", "requestCount", "matchedCount" FROM "BatchJob"
    WHERE "userId" = ${userId} AND "status" IN ('applied', 'failed')
    ORDER BY "createdAt" DESC
    LIMIT ${limit}
  `);
}

/** Every running job, across accounts — ids and what polling needs, nothing else. */
export async function runningBatchJobs(limit = 200): Promise<Array<Pick<BatchJobRow, "id" | "userId" | "provider" | "model" | "providerBatchId" | "requests" | "createdAt">>> {
  return prismaUnguarded.$queryRaw(Prisma.sql`
    SELECT "id", "userId", "provider", "model", "providerBatchId", "requests", "createdAt" FROM "BatchJob"
    WHERE "status" = 'submitted'
    ORDER BY "createdAt" ASC
    LIMIT ${limit}
  `);
}

/** Store a finished batch's answers (encrypted) and mark it ended. Only from `submitted`, so a second poller is a no-op. */
export async function markBatchEnded(input: {
  id: string;
  userId: string;
  requests: readonly BatchJobRequest[];
  results: readonly BatchItemResult[];
}): Promise<boolean> {
  const keyOf = new Map(input.requests.map((request) => [request.customId, request.key]));
  const stored: Record<string, StoredBatchResult> = {};
  for (const result of input.results) {
    const key = keyOf.get(result.customId);
    if (!key) continue;
    stored[result.customId] = {
      key,
      ok: result.ok,
      text: result.ok && result.text ? encryptMessageText(result.text) : null,
    };
  }
  const updated = await prisma.$executeRaw(Prisma.sql`
    UPDATE "BatchJob"
    SET "status" = 'ended', "results" = ${JSON.stringify(stored)}::jsonb, "endedAt" = NOW(), "billedAt" = NOW()
    WHERE "id" = ${input.id} AND "userId" = ${input.userId} AND "status" = 'submitted'
  `);
  return updated > 0;
}

export async function markBatchFailed(id: string, userId: string, error: string): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "BatchJob" SET "status" = 'failed', "error" = ${error.slice(0, 500)}, "endedAt" = NOW()
    WHERE "id" = ${id} AND "userId" = ${userId} AND "status" IN ('submitted', 'ended')
  `);
}

/** An ended job whose answers one dream pass has had the chance to use. */
export async function markBatchApplied(id: string, userId: string, matchedCount: number): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "BatchJob" SET "status" = 'applied', "matchedCount" = ${matchedCount}, "appliedAt" = NOW()
    WHERE "id" = ${id} AND "userId" = ${userId} AND "status" = 'ended'
  `);
}

/** The usable answers of ended jobs, decrypted, by prompt key. */
export function answersFrom(jobs: readonly BatchJobRow[]): Map<string, string> {
  const answers = new Map<string, string>();
  for (const job of jobs) {
    if (job.status !== "ended" || !job.results) continue;
    for (const result of Object.values(job.results)) {
      if (!result.ok || !result.text) continue;
      try {
        const text = decryptMessageText(result.text);
        if (text) answers.set(result.key, text);
      } catch {
        // An unreadable answer is an unanswered prompt: it is queued again.
      }
    }
  }
  return answers;
}

/**
 * Accounts with a batch that has ended and not been applied — visited by the
 * dreamer even when they have no new history to read, so an answer that came
 * back (a summary rebuild, say) is used rather than left to go stale.
 */
export async function accountsWithEndedBatches(limit: number): Promise<string[]> {
  const rows = await prismaUnguarded.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
    SELECT DISTINCT "userId" FROM "BatchJob" WHERE "status" = 'ended' LIMIT ${limit}
  `);
  return rows.map((row) => row.userId);
}
