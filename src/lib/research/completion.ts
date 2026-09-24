/**
 * A finished web run becomes one assistant message in its conversation: a
 * cited summary and the report as an artifact, written in one transaction
 * with the run's `assistantMessageId` (SPEC §9.6.3, INV-14).
 *
 * What is written is decided in `completion-core.ts`, which is pure and
 * tested through a fake transaction; this file binds it to Prisma.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import type { ParsedArtifact } from "@/lib/message-content";
import { ARTIFACTS_STORE_TAKES_TX, persistArtifactsWithTx } from "@/lib/research/artifacts-shim";
import {
  isCompletionMessage,
  writeResearchCompletion,
  type CompletionTx,
  type ResearchFact,
} from "@/lib/research/completion-core";
import type { ClientSource } from "@/types/chat";

export interface ResearchCompletionInput {
  runId: string;
  userId: string;
  /** Null, or a deleted conversation: the run completes and no message is written. */
  conversationId: string | null;
  title: string;
  /** 120–250 words, cited with [n] against `sources`. */
  summary: string;
  /** The report Markdown, without a model-written sources section. */
  report: string;
  /** Cited first, in citation order, then read-not-cited; each with `origin: "research"`. */
  sources: ClientSource[];
  /** Model id of the lead that wrote both. */
  leadModel: string;
  fact: ResearchFact;
  /*
   * Additive (the §12.7 signature above is WS0's): what the run row records
   * beside its pointer. Defaults: the fact's state, from
   * `validating_citations`, the report as given, no error.
   */
  to?: "completed" | "partially_completed";
  from?: readonly string[];
  runReport?: string;
  error?: string | null;
}

/**
 * The completion's one transaction. Returns the message id, null when no
 * message was written (a deleted conversation), and `raced` when another path
 * had already finished the run, in which case nothing was written at all.
 */
export async function finalizeResearchRun(
  input: ResearchCompletionInput
): Promise<{ messageId: string | null; raced?: boolean }> {
  const deferred: Array<{ conversationId: string; messageId: string; parsed: ParsedArtifact[] }> = [];
  const result = await writeResearchCompletion(
    {
      runId: input.runId,
      userId: input.userId,
      conversationId: input.conversationId,
      title: input.title,
      summary: input.summary,
      report: input.report,
      sources: input.sources,
      leadModel: input.leadModel,
      fact: input.fact,
      to: input.to ?? input.fact.state,
      from: input.from ?? ["validating_citations"],
      runReport: input.runReport ?? input.report,
      error: input.error ?? null,
    },
    {
      transaction: (fn) =>
        prisma.$transaction(async (tx) => fn(prismaCompletionTx(tx, deferred)), {
          // A few rows; the default five seconds would do, but a slow pool
          // should not turn a finished run into a failed one.
          timeout: 15_000,
        }),
      encrypt: encryptMessageText,
      now: () => new Date(),
      newId: () => randomUUID(),
    }
  );
  // The artifact store does not take a transaction yet (artifacts-shim.ts):
  // the report artifact is written the moment the message it belongs to has
  // committed. A failure leaves a message whose summary reads and whose report
  // card is missing — logged loudly, never thrown at a finished run.
  if (!result.raced) {
    for (const item of deferred) {
      await persistArtifactsWithTx(item.conversationId, item.messageId, item.parsed).catch((error: unknown) => {
        console.error("[research] completion artifact write failed", { runId: input.runId, messageId: item.messageId, error });
      });
    }
  }
  return result.raced ? { messageId: null, raced: true } : { messageId: result.messageId };
}

function prismaCompletionTx(
  tx: Prisma.TransactionClient,
  deferred: Array<{ conversationId: string; messageId: string; parsed: ParsedArtifact[] }>
): CompletionTx {
  return {
    async runMessage(runId, userId) {
      const row = await tx.researchRun.findFirst({ where: { id: runId, userId }, select: { assistantMessageId: true } });
      return row?.assistantMessageId ?? null;
    },
    async conversationExists(conversationId, userId) {
      return (await tx.conversation.count({ where: { id: conversationId, userId } })) > 0;
    },
    async createAssistantMessage(data) {
      return tx.message.create({
        data: {
          conversationId: data.conversationId,
          role: "ASSISTANT",
          content: data.content,
          model: data.model,
          sources: data.sources as unknown as Prisma.InputJsonValue,
          activity: data.activity as unknown as Prisma.InputJsonValue,
          createdAt: data.createdAt,
        },
        select: { id: true },
      });
    },
    async persistArtifacts(conversationId, messageId, parsed) {
      if (ARTIFACTS_STORE_TAKES_TX) return persistArtifactsWithTx(conversationId, messageId, parsed, { tx });
      deferred.push({ conversationId, messageId, parsed });
      return [];
    },
    async touchConversation(conversationId, at) {
      await tx.conversation.updateMany({ where: { id: conversationId }, data: { lastMessageAt: at } });
    },
    async finishRun({ runId, userId, from, to, messageId, report, error, at }) {
      const moved = await tx.researchRun.updateMany({
        where: { id: runId, userId, state: { in: [...from] } },
        data: {
          state: to,
          finishedAt: at,
          workerLeaseOwner: null,
          workerLeaseUntil: null,
          report,
          error,
          ...(messageId ? { assistantMessageId: messageId } : {}),
        },
      });
      return moved.count > 0;
    },
  };
}

/**
 * The regenerate/edit guard (§9.6.3): true when some run's
 * `assistantMessageId` is this message. The chat route (WS9a) answers 409
 * `research_message` for it. Unguarded because the caller holds a message
 * id, not a run, and all it learns is whether a pointer exists.
 */
export async function isResearchCompletionMessage(messageId: string): Promise<boolean> {
  if (!messageId) return false;
  const runs = await prismaUnguarded.researchRun.findMany({
    where: { assistantMessageId: messageId },
    select: { assistantMessageId: true },
    take: 1,
  });
  return isCompletionMessage(runs, messageId);
}
