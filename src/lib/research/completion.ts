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
import { prismaUnguarded } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { persistArtifacts } from "@/lib/artifacts-store";
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
  input: ResearchCompletionInput,
  /** Trusted persistence seam for integration fault injection, never model input. */
  persistence: { persistArtifacts?: typeof persistArtifacts } = {},
): Promise<{ messageId: string | null; raced?: boolean }> {
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
      // The raw client, as every interactive transaction here is (its `tx` is
      // the `Prisma.TransactionClient` the artifact store will take); every
      // statement below is scoped by the run's userId or the conversation it
      // was checked against, which is what the ownership guard would enforce.
      transaction: (fn) =>
        prismaUnguarded.$transaction(async (tx) => fn(prismaCompletionTx(tx, input.userId, persistence.persistArtifacts ?? persistArtifacts)), {
          // A few rows; the default five seconds would do, but a slow pool
          // should not turn a finished run into a failed one.
          timeout: 15_000,
        }),
      encrypt: encryptMessageText,
      now: () => new Date(),
      newId: () => randomUUID(),
    }
  );
  return result.raced ? { messageId: null, raced: true } : { messageId: result.messageId };
}

function prismaCompletionTx(
  tx: Prisma.TransactionClient,
  userId: string,
  artifactWriter: typeof persistArtifacts,
): CompletionTx {
  return {
    async runMessage(runId, userId) {
      // Serialize finalizers before they emit the same report identifier.
      // Otherwise two resumed workers can both create a message, then race
      // on the artifact's unique key before the terminal-state CAS runs.
      const rows = await tx.$queryRaw<Array<{ assistantMessageId: string | null }>>(Prisma.sql`
        SELECT "assistantMessageId" FROM "ResearchRun"
         WHERE "id" = ${runId} AND "userId" = ${userId}
         FOR UPDATE
      `);
      return rows[0]?.assistantMessageId ?? null;
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
      return artifactWriter(conversationId, messageId, parsed, { tx, userId });
    },
    async touchConversation(conversationId, at) {
      // Only ever called after `conversationExists` checked the owner in this transaction.
      await tx.conversation.updateMany({ where: { id: conversationId, userId }, data: { lastMessageAt: at } });
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
