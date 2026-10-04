import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptMessageText, encryptMessageText } from "@/lib/message-crypto";
import { loadBackgroundProviderPolicy, runUtilityPrompt } from "@/lib/memory";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import {
  HISTORY_SUMMARY_SYSTEM,
  historySummaryUserMessage,
  historyTokenBudget,
  parseHistorySummary,
  planHistorySummary,
  planTokenTrim,
  renderHistorySummary,
  type StoredHistorySummary,
  type WindowMessage,
} from "@/lib/chat/history-compaction";

/*
 * The database half of context trimming. The rules are in history-compaction.ts;
 * this loads and stores the rolling summary and runs the cheap model that
 * writes it.
 *
 * The summary lives on the Conversation row (historySummary, encrypted like a
 * message body, plus the count it covers and the id of the first message it
 * does not). Read and written with raw SQL scoped by userId: the columns are
 * new (migration 20261004130000_cost_engineering) and this keeps the code
 * independent of when the Prisma client is regenerated.
 */

/** `HISTORY_COMPACTION_ENABLED=false` turns the whole thing off: the count-based window alone, as before. */
export function historyCompactionEnabled(): boolean {
  return process.env.HISTORY_COMPACTION_ENABLED?.trim().toLowerCase() !== "false";
}

/** The most messages one summary update reads; older ones in a larger gap are left to the previous summary. */
const MAX_GAP_MESSAGES = 240;
/** How long a turn waits for a summary update before going ahead with the stored one. */
const DEFAULT_TIMEOUT_MS = 8_000;

async function loadStoredSummary(userId: string, conversationId: string): Promise<StoredHistorySummary | null> {
  const rows = await prisma.$queryRaw<
    Array<{ historySummary: string | null; historySummaryCount: number | null; historySummaryUntilId: string | null }>
  >(Prisma.sql`
    SELECT "historySummary", "historySummaryCount", "historySummaryUntilId"
    FROM "Conversation"
    WHERE "id" = ${conversationId} AND "userId" = ${userId}
  `);
  const row = rows[0];
  if (!row?.historySummary) return null;
  const text = decryptMessageText(row.historySummary);
  if (!text?.trim()) return null;
  return { text, coveredCount: row.historySummaryCount ?? 0, untilMessageId: row.historySummaryUntilId };
}

/** Writes only if nobody else moved the summary since it was read (two tabs, a retry). */
async function storeSummary(input: {
  userId: string;
  conversationId: string;
  text: string;
  coveredCount: number;
  untilMessageId: string | null;
  expectedCount: number;
}): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "Conversation"
    SET "historySummary" = ${encryptMessageText(input.text)},
        "historySummaryCount" = ${input.coveredCount},
        "historySummaryUntilId" = ${input.untilMessageId},
        "historySummaryAt" = NOW()
    WHERE "id" = ${input.conversationId}
      AND "userId" = ${input.userId}
      AND COALESCE("historySummaryCount", 0) = ${input.expectedCount}
  `);
}

async function loadMessages(conversationId: string, skip: number, take: number) {
  if (take <= 0) return [];
  const rows = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    skip,
    take,
    select: { id: true, role: true, content: true },
  });
  return rows.map((row) => ({ id: row.id, role: row.role as string, content: decryptMessageText(row.content) ?? "" }));
}

/**
 * Bring the stored summary up to `toCount` and return its rendered text, or
 * null when it could not be written. Billed like any utility call (spend kind
 * "utility", through runUtilityPrompt), bound by the account's
 * background-provider policy, cheapest model first.
 */
async function updateSummary(input: {
  userId: string;
  conversationId: string;
  stored: StoredHistorySummary | null;
  fromCount: number;
  toCount: number;
  previous: string | null;
  untilMessageId: string | null;
  conversationProvider: string | null;
}): Promise<string | null> {
  let { fromCount, previous } = input;
  // Verify the stored boundary still holds: the message at `fromCount` must be
  // the one the summary stopped at. Otherwise history changed under it and the
  // summary is rebuilt from the beginning.
  if (fromCount > 0) {
    const [boundary] = await loadMessages(input.conversationId, fromCount, 1);
    if (!boundary || boundary.id !== input.stored?.untilMessageId) {
      fromCount = 0;
      previous = null;
    }
  }
  const gap = input.toCount - fromCount;
  const skip = gap > MAX_GAP_MESSAGES ? input.toCount - MAX_GAP_MESSAGES : fromCount;
  const messages = await loadMessages(input.conversationId, skip, input.toCount - skip);
  if (messages.length === 0) return null;

  const { result } = await runUtilityPrompt({
    system: HISTORY_SUMMARY_SYSTEM,
    userMsg: historySummaryUserMessage(previous, messages),
    maxTokens: 1_500,
    label: "chat/history-summary",
    parse: parseHistorySummary,
    userId: input.userId,
    policy: await loadBackgroundProviderPolicy(input.userId),
    conversationProvider: input.conversationProvider,
    purpose: "history_summary",
    cheapestFirst: true,
  });
  if (!result) return null;
  await storeSummary({
    userId: input.userId,
    conversationId: input.conversationId,
    text: result,
    coveredCount: input.toCount,
    untilMessageId: input.untilMessageId,
    expectedCount: input.stored?.coveredCount ?? 0,
  });
  return result;
}

export interface CompactedWindow<T> {
  /** The messages shown verbatim. */
  window: T[];
  /** Absolute index of `window[0]` in the conversation. */
  start: number;
  /** How many the token budget dropped from the count-based window. */
  trimmed: number;
  /** The rendered summary block for the first user turn, or "". */
  summaryBlock: string;
}

/**
 * Fit a count-based history window (already decrypted) to the token budget
 * and resolve the summary of everything before it.
 *
 * Never throws and never blocks a turn for long: a summary update that fails
 * or takes longer than `timeoutMs` leaves the stored summary in place (it is
 * still a true summary of the messages it covers) and the update, if it
 * finishes, is saved for the next turn.
 */
export async function compactHistoryWindow<T extends WindowMessage>(input: {
  userId: string;
  conversationId: string;
  /** The count-based window (`historyWindowStart`), oldest first, content decrypted. */
  window: readonly T[];
  /** Absolute index of `window[0]`. */
  countStart: number;
  contextTokens: number | undefined;
  conversationProvider: string | null;
  timeoutMs?: number;
}): Promise<CompactedWindow<T>> {
  const unchanged: CompactedWindow<T> = { window: [...input.window], start: input.countStart, trimmed: 0, summaryBlock: "" };
  if (!historyCompactionEnabled()) return unchanged;

  const trimmed = planTokenTrim(input.window, {
    budgetTokens: historyTokenBudget(input.contextTokens),
    attachmentCharCap: attachmentTextBudget(input.contextTokens),
  });
  const window = input.window.slice(trimmed);
  const start = input.countStart + trimmed;
  const result: CompactedWindow<T> = { window, start, trimmed, summaryBlock: "" };
  if (start <= 0) return result;

  try {
    const stored = await loadStoredSummary(input.userId, input.conversationId);
    const windowFirstId = window[0]?.id ?? null;
    const plan = planHistorySummary({ stored, start, windowFirstId });
    if (plan.action === "none") return result;
    if (plan.action === "reuse") {
      return { ...result, summaryBlock: renderHistorySummary(stored!.text, stored!.coveredCount) };
    }

    const update = updateSummary({
      userId: input.userId,
      conversationId: input.conversationId,
      stored,
      fromCount: plan.fromCount,
      toCount: plan.toCount,
      previous: plan.previous,
      untilMessageId: windowFirstId,
      conversationProvider: input.conversationProvider,
    }).catch((error) => {
      console.error("[chat] history summary update failed", {
        conversationId: input.conversationId,
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    const fresh = await Promise.race([update, timedOut]);
    if (timer) clearTimeout(timer);
    if (typeof fresh === "string") return { ...result, summaryBlock: renderHistorySummary(fresh, plan.toCount) };
    // Timed out or failed: the stored summary is still true of what it covers.
    return stored ? { ...result, summaryBlock: renderHistorySummary(stored.text, stored.coveredCount) } : result;
  } catch (error) {
    console.error("[chat] history summary unavailable", {
      conversationId: input.conversationId,
      message: error instanceof Error ? error.message : String(error),
    });
    return result;
  }
}
