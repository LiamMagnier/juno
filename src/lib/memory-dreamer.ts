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
import {
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
export async function dreamForAccount(userId: string, now: Date = new Date()): Promise<DreamOutcome> {
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
  const pass = await backfillMemories({ userId, maxConversations: DREAM_CONVERSATIONS_PER_ACCOUNT });
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
  if (outcome.created > 0 || outcome.expired > 0 || outcome.rejudged > 0) {
    await maybeConsolidate(userId, null).catch(() => {});
    // History distilled from a project's chats lands in that project, so its
    // summary is the one that moved. Bounded — each rebuild is a model call —
    // and each project runs the same "did anything change" test first, so an
    // untouched project costs four indexed reads and no call.
    for (const projectId of await projectsWithMemory(userId, DREAM_PROJECT_SUMMARIES_PER_ACCOUNT)) {
      await maybeConsolidateProject(userId, projectId, null).catch(() => {});
    }
  }
  // Procedural memory: repeated successful methods, proposed (never created)
  // as skills. Model-free and bounded; see src/lib/procedural-memory.ts.
  await import("@/lib/procedural-memory-store")
    .then(({ refreshSkillCandidates }) => refreshSkillCandidates(userId))
    .catch(() => {});
  return outcome;
}
