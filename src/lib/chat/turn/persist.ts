import type { RoutingReceipt } from "@/lib/router/receipt";
import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { encryptJsonField } from "@/lib/field-crypto";
import { markRoomTurn } from "@/lib/agents/room-store";
import { assistantTurnFields, assistantWriteMode, reasoningPartsColumn } from "@/lib/chat/assistant-turn";
import { forkMessage, withBranchPositions } from "@/lib/chat/branches";
import { isRefusal } from "@/lib/chat/branch-model";
import type { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import type { ClientActivityEvent } from "@/types/chat";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — persistTurn: the assistant reply's row. A normal turn
 * appends; a regenerate adds a sibling of the answer it replaces and keeps
 * that answer, with everything after it, on a branch of its own
 * (src/lib/chat/branches.ts). The rules live in chat/assistant-turn.ts.
 */
export function createAssistantTurnWriter({
  user,
  conversationId,
  staleAssistantId,
  answersMessageId,
  modelId,
  acc,
  activityLog,
  roomTurnId,
  routingReceipt,
}: {
  user: TurnUser;
  conversationId: string;
  staleAssistantId: string | null;
  /** The message a reply that replaces nothing follows, when the turn knows it. */
  answersMessageId?: string | null;
  modelId: string;
  acc: GenerationAccumulator;
  activityLog: ClientActivityEvent[];
  roomTurnId: string | null;
  routingReceipt: RoutingReceipt | null;
}) {
  // Metadata for the pager rides along on the done chunk.
  const include = {
    attachments: { where: { deletedAt: null } },
    versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
  };

  /**
   * Persist the assistant's answer. A normal turn appends a new Message row
   * after the question it answers. A regenerate PRESERVES the previous answer
   * instead of overwriting it: the new answer is a new row in the old one's
   * branch group, the old answer and everything that followed it leave the
   * shown path in the same transaction, and the "‹ 2/3 ›" pager switches
   * between them. Which version the user was VIEWING never changes the
   * result: the prompt excludes the answer being regenerated and everything
   * after it, so regeneration is deterministic in its inputs.
   *
   * Written only here, once the generation has produced something, so a
   * failed regenerate leaves the previous answer exactly as it was.
   */
  const persistAssistantTurnRow = async (data: {
    content: string;
    reasoning: string;
    /** Empty for every provider that streams unbroken prose. Persisted as
     *  NULL in that case, so "no steps" survives a reload as a fact. */
    reasoningParts: string[];
    promptTokens: number | null;
    completionTokens: number | null;
    /**
     * The provider-reported prompt-cache split. Taken from the accumulator
     * rather than from `buildUsage`, which clamps every absent bucket to 0
     * for display arithmetic — persisting that would write "cache miss" for
     * providers that simply never report the split.
     */
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    /** Exact generation cost (tokens + cache + tool fees), micro-USD. */
    costMicroUsd?: number | null;
  }) => {
    const parts = reasoningPartsColumn(data.reasoningParts, encryptMessageText);
    const sources = acc.sources;
    const columns = {
      role: "ASSISTANT" as const,
      ...assistantTurnFields({ ...data, model: modelId }, encryptMessageText),
      activity: encryptJsonField(activityLog) as unknown as Prisma.InputJsonValue,
      ...(routingReceipt ? { routing: routingReceipt as unknown as Prisma.InputJsonValue } : {}),
      ...(data.reasoning ? { reasoning: encryptMessageText(data.reasoning) } : {}),
      ...(parts.action === "set" ? { reasoningParts: parts.values as unknown as Prisma.InputJsonValue } : {}),
      ...(sources.length ? { sources: sources as unknown as Prisma.InputJsonValue } : {}),
    };

    // The answer being replaced can vanish mid-generation — deleted with the
    // whole conversation from another tab — and when it does this appends
    // rather than failing. See chat/assistant-turn for the write rules.
    const stale = staleAssistantId
      ? await prisma.message.findFirst({ where: { id: staleAssistantId, conversationId }, select: { id: true } })
      : null;
    if (assistantWriteMode(staleAssistantId, !!stale) === "branch") {
      const forked = await prisma.$transaction(async (tx) => {
        // `allowOffPath`: switched away from on another device while this was
        // being written. The new answer still joins its group, hidden.
        const result = await forkMessage(
          tx,
          { userId: user.id, conversationId, targetId: stale!.id, allowOffPath: true },
          (fields) => tx.message.create({ data: { conversationId, ...columns, ...fields }, include }),
        );
        return isRefusal(result) ? null : result.created;
      });
      if (forked) return forked;
    }

    // A reply that follows a question no longer shown — switched away from on
    // another device while it was written — stays with that question rather
    // than landing on the branch now shown.
    const parent = answersMessageId
      ? await prisma.message.findFirst({ where: { id: answersMessageId, conversationId }, select: { id: true, onActivePath: true } })
      : null;
    return prisma.message.create({
      data: {
        conversationId,
        ...columns,
        ...(parent ? { parentId: parent.id, onActivePath: parent.onActivePath } : {}),
      },
      include,
    });
  };
  /** The persisted reply, and in a room the turn it answers marked answered with it. */
  const persistAssistantTurn = async (data: Parameters<typeof persistAssistantTurnRow>[0]) => {
    const row = await persistAssistantTurnRow(data);
    if (roomTurnId) await markRoomTurn(user.id, roomTurnId, "answered", row.id);
    return row;
  };

  /**
   * The reply's activity log, sealed, written once the turn's last row exists,
   * and the row read back with what the `done` frame serialises — its pager
   * position included, so a regenerated answer arrives already reading "2/2".
   */
  const sealActivity = async (assistantId: string) => {
    const row = await prisma.message.update({
      where: { id: assistantId },
      data: { activity: encryptJsonField(activityLog) as unknown as Prisma.InputJsonValue },
      include,
    });
    const [positioned] = await withBranchPositions(prisma, conversationId, [row]);
    return positioned;
  };

  return { persistAssistantTurn, sealActivity };
}
