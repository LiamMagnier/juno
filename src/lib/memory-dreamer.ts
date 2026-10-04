import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import {
  backfillMemories,
  maybeConsolidate,
  maybeConsolidateProject,
  projectsWithMemory,
  queueRereads,
  reconcileMemoryTimeline,
  sweepExpiredMemories,
} from "@/lib/memory";
import { EXTRACTOR_VERSION } from "@/lib/memory-extraction";
import type { UtilityLlm } from "@/lib/memory";
import {
  DREAM_BATCH_CONVERSATIONS_PER_ACCOUNT,
  DREAM_CONVERSATIONS_PER_ACCOUNT,
  DREAM_PROJECT_SUMMARIES_PER_ACCOUNT,
  DREAM_REREADS_PER_ACCOUNT,
  dreamEligibility,
  type DreamSkipReason,
} from "@/lib/memory-dreaming";
import { checkUsageWindows } from "@/lib/spend";
import { getUserPlan } from "@/lib/usage";

/*
 * The database half of dreaming. The rules are in memory-dreaming.ts and the
 * loop is scripts/memory-dreamer.ts; this is what one tick does to one account.
 */

/**
 * Accounts with history the dreamer could read: at least one conversation not
 * yet distilled up to its last message — or distilled by an older reader and
 * worth reading again (see queueRereads) — memory on, background learning on.
 *
 * The ONE query here that looks across accounts, so it is the one that uses
 * `prismaUnguarded` — the same choice the import-recovery sweeper makes — and
 * it returns ids and nothing else. Every read and write after it is scoped to
 * a single account through the guarded client, like any request.
 *
 * `random()` rather than any fixed order: stateless fairness. A fixed order
 * would visit the same five accounts every tick while their queues drained and
 * everyone else waited; a random draw gives every eligible account the same
 * chance each time, with nothing to persist between ticks.
 *
 * A missing Settings row reads as the column defaults (both on), matching how
 * the chat bootstrap treats an account that has never saved a setting.
 */
export async function findAccountsToDream(limit: number): Promise<string[]> {
  const rows = await prismaUnguarded.$queryRaw<{ userId: string }[]>(Prisma.sql`
    SELECT c."userId"
    FROM "Conversation" c
    LEFT JOIN "ConversationMemory" m ON m."conversationId" = c."id"
    LEFT JOIN "Settings" s ON s."userId" = c."userId"
    WHERE (
        m."id" IS NULL
        OR c."lastMessageAt" > m."processedAt"
        OR (m."extractorVersion" < ${EXTRACTOR_VERSION} AND (m."digest" IS NOT NULL OR m."factCount" > 0))
      )
      AND COALESCE(s."memoryEnabled", true) = true
      AND COALESCE(s."memoryBackgroundLearning", true) = true
    GROUP BY c."userId"
    ORDER BY random()
    LIMIT ${limit}
  `);
  return rows.map((row) => row.userId);
}

export interface DreamOutcome {
  userId: string;
  skipped: DreamSkipReason | null;
  processedConversations: number;
  created: number;
  remaining: number;
  expired: number;
  /** Chats an older reader distilled, queued to be read again. */
  rereadQueued: number;
  /** Beliefs the re-judge pass corrected. */
  rejudged: number;
  /** Prompts queued for the next provider batch (Batch API mode only). */
  batchQueued?: number;
  /** A batch submission failed and the pass was re-run synchronously. */
  batchFellBack?: boolean;
}

/**
 * The Batch API seam (src/lib/batch/dream.ts): a model layer for the pass and
 * a hook to run after it. Optional — absent, the pass runs exactly as before.
 */
export interface DreamBatching {
  llm: UtilityLlm;
  finish(): Promise<{ submitted: number; queued: number; submitFailed: boolean }>;
}

/**
 * One bounded pass over one account's history.
 *
 * The eligibility check runs twice by design: once with the budget assumed
 * available, which costs three cheap reads and rules out most accounts (memory
 * off, background learning off, in the middle of a chat), and only then the
 * usage-window check, which is the expensive read — so it is spent only on
 * accounts that would otherwise be dreamed about.
 *
 * Each pass distils at most DREAM_CONVERSATIONS_PER_ACCOUNT conversations,
 * two chunks each, through the same `extractConversationMemory` a chat turn
 * uses — so the background-provider policy, the sensitive-subject gate, the
 * block-list and the spend ledger all apply exactly as they do in a live chat.
 */
export async function dreamForAccount(
  userId: string,
  now: Date = new Date(),
  options: {
    /** Prepares the Batch API layer for this account, after eligibility passed. Null/absent: synchronous. */
    batching?: (userId: string) => Promise<DreamBatching | null>;
  } = {}
): Promise<DreamOutcome> {
  const outcome: DreamOutcome = {
    userId,
    skipped: null,
    processedConversations: 0,
    created: 0,
    remaining: 0,
    expired: 0,
    rereadQueued: 0,
    rejudged: 0,
  };

  const [settings, lastActive] = await Promise.all([
    prisma.settings.findUnique({
      where: { userId },
      select: { memoryEnabled: true, memoryBackgroundLearning: true },
    }),
    prisma.conversation.findFirst({
      where: { userId },
      orderBy: { lastMessageAt: "desc" },
      select: { lastMessageAt: true },
    }),
  ]);
  const base = {
    memoryEnabled: settings?.memoryEnabled ?? true,
    memoryBackgroundLearning: settings?.memoryBackgroundLearning ?? true,
    lastActiveAt: lastActive?.lastMessageAt ?? null,
    now,
  };

  const cheap = dreamEligibility({ ...base, budgetAllowed: true });
  if (!cheap.ok) return { ...outcome, skipped: cheap.reason };

  const windows = await checkUsageWindows(userId, await getUserPlan(userId), null, undefined, { now });
  const eligibility = dreamEligibility({ ...base, budgetAllowed: windows.allowed });
  if (!eligibility.ok) return { ...outcome, skipped: eligibility.reason };

  outcome.expired = await sweepExpiredMemories(userId, now);
  /*
   * Batch API mode (BATCH_API_ENABLED, default on): the pass's model calls are
   * answered from batches that have ended, and whatever has no answer yet is
   * queued for the next batch at half price — see src/lib/batch/plan.ts. A
   * failure to prepare is a synchronous pass, never a skipped one.
   */
  const batching = options.batching
    ? await options.batching(userId).catch((error) => {
        console.error("[memory-dreamer] batch layer unavailable:", error instanceof Error ? error.message : String(error));
        return null;
      })
    : null;
  const llm = batching?.llm;
  const pass = await backfillMemories({
    userId,
    maxConversations: batching ? DREAM_BATCH_CONVERSATIONS_PER_ACCOUNT : DREAM_CONVERSATIONS_PER_ACCOUNT,
    llm,
    continueOnUnavailable: !!batching,
  });
  outcome.processedConversations = pass.processedConversations;
  outcome.created = pass.created;
  outcome.remaining = pass.remaining;

  // Nothing new left to read: read again what an older reader read, a couple
  // of chats at a time. They are picked up by the next tick's pass, so the
  // re-reading is paced like the reading.
  if (pass.remaining === 0) {
    outcome.rereadQueued = await queueRereads(userId, DREAM_REREADS_PER_ACCOUNT);
  }

  // Judge the timeline again: history read this pass may have been said
  // before or after what is already believed, and rows written before times
  // were recorded are dated from their messages as the pass goes.
  if (pass.processedConversations > 0 || outcome.expired > 0) {
    outcome.rejudged = (await reconcileMemoryTimeline(userId, now).catch(() => ({ changed: 0 }))).changed;
  }

  // New facts, or expiries, mean the summary is out of date. maybeConsolidate
  // carries its own throttle and its own "did anything change" test, so this
  // is safe to call on every productive pass. `null` provider: there is no
  // conversation behind a dream, so the account's own default model decides
  // what `same_provider` means — the rule consolidateMemories documents.
  // In Batch API mode the summary rebuild is offered on every pass: its answer
  // arrives a pass or more after it was queued, when nothing new may have been
  // learned, and maybeConsolidate's own "did anything change" test keeps an
  // unchanged account to four indexed reads and no call.
  if (batching || outcome.created > 0 || outcome.expired > 0 || outcome.rejudged > 0) {
    await maybeConsolidate(userId, null, llm).catch(() => {});
    // History distilled from a project's chats lands in that project, so its
    // summary is the one that moved. Bounded — each rebuild is a model call —
    // and each project runs the same "did anything change" test first, so an
    // untouched project costs four indexed reads and no call.
    for (const projectId of await projectsWithMemory(userId, DREAM_PROJECT_SUMMARIES_PER_ACCOUNT)) {
      await maybeConsolidateProject(userId, projectId, null, llm).catch(() => {});
    }
  }

  if (batching) {
    const finished = await batching.finish().catch((error) => {
      console.error("[memory-dreamer] batch finish failed:", error instanceof Error ? error.message : String(error));
      return { submitted: 0, queued: 0, submitFailed: true };
    });
    outcome.batchQueued = finished.queued;
    if (finished.submitFailed) {
      // The provider would not take the batch: do this tick's work the
      // ordinary way rather than leave it for a batch that will not come.
      const fallback = await dreamForAccount(userId, now);
      return { ...fallback, expired: outcome.expired + fallback.expired, batchFellBack: true };
    }
  }
  return outcome;
}
