import type { RoutingReceipt } from "@/lib/router/receipt";
import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { detachArtifactsFromMessage } from "@/lib/artifacts-store";
import { encryptMessageText } from "@/lib/message-crypto";
import { encryptJsonField } from "@/lib/field-crypto";
import { markRoomTurn } from "@/lib/agents/room-store";
import { assistantTurnFields, assistantWriteMode, reasoningPartsColumn, versionSnapshot } from "@/lib/chat/assistant-turn";
import type { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import type { ClientActivityEvent } from "@/types/chat";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — persistTurn: the assistant reply's row. A normal turn
 * appends; a regenerate supersedes the previous answer in place after
 * snapshotting it into an immutable MessageVersion. Moved out of the route
 * intact; the rules live in chat/assistant-turn.ts.
 */
export function createAssistantTurnWriter({
  user,
  conversationId,
  staleAssistantId,
  modelId,
  acc,
  activityLog,
  roomTurnId,
  routingReceipt,
}: {
  user: TurnUser;
  conversationId: string;
  staleAssistantId: string | null;
  modelId: string;
  acc: GenerationAccumulator;
  activityLog: ClientActivityEvent[];
  roomTurnId: string | null;
  routingReceipt: RoutingReceipt | null;
}) {
  /**
   * Persist the assistant's answer. A normal turn appends a new Message row.
   * A regenerate PRESERVES the previous answer instead of destroying it: the
   * old row's content is snapshotted into an immutable MessageVersion
   * (ciphertext copied verbatim — the crypto is row-independent, see
   * message-crypto.ts), its artifacts are detached but kept, and the
   * Message row is then overwritten in place. The Message row is therefore
   * always the CURRENT version; MessageVersion rows are append-only,
   * read-only history rendered by the client's "‹ 2/3 ›" pager. Which
   * version the user was VIEWING never changes the result: the prompt
   * excludes the answer being regenerated entirely, so regeneration is
   * deterministic in its inputs and versions simply accumulate oldest-first.
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
    // The stale row can vanish mid-generation — deleted from another tab,
    // or with the whole conversation — and when it does this appends
    // rather than failing. See chat/assistant-turn for the write rules.
    const stale = staleAssistantId
      ? await prisma.message.findUnique({ where: { id: staleAssistantId } })
      : null;
    const mode = assistantWriteMode(staleAssistantId, !!stale);
    const parts = reasoningPartsColumn(data.reasoningParts, encryptMessageText, mode);
    const base = {
      ...assistantTurnFields({ ...data, model: modelId }, encryptMessageText),
      activity: encryptJsonField(activityLog) as unknown as Prisma.InputJsonValue,
      // Explicit DbNull for a hand-routed turn: a regenerate that switches
      // from Auto to a chosen model must not keep the old Auto receipt.
      routing: routingReceipt ? (routingReceipt as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    };
    const sources = acc.sources;
    // Metadata for the pager rides along on the done chunk.
    const include = {
      attachments: { where: { deletedAt: null } },
      versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
    };
    if (mode === "supersede" && stale) {
      // Snapshot the answer being replaced BEFORE overwriting it — a
      // regenerate must never lose what the user already had. That covers
      // its artifacts too: they are detached, not deleted, so hand edits
      // and share links survive and a re-emission appends to the same row.
      // Atomic with the overwrite so a crash can't leave a duplicate
      // version behind.
      const [, , , updated] = await prisma.$transaction([
        prisma.messageVersion.create({
          data: versionSnapshot({
            ...stale,
            sources: stale.sources as unknown as Prisma.InputJsonValue | null,
          }),
        }),
        detachArtifactsFromMessage(stale.id, user.id),
        // A suggestion lives as long as the reply that made it. The reply
        // is overwritten in place here, so no cascade fires: the old
        // answer's waiting suggestions are retired explicitly, and the new
        // answer's own are written after this under the same message id.
        prisma.artifactProposal.updateMany({
          where: { messageId: stale.id, status: "PENDING" },
          data: { status: "STALE", resolvedAt: new Date() },
        }),
        prisma.message.update({
          where: { id: stale.id },
          data: {
            ...base,
            reasoning: data.reasoning ? encryptMessageText(data.reasoning) : null,
            // CLEAR, never skip — see reasoningPartsColumn. A regenerate can
            // swap a part-emitting model for one that sends none, and leaving
            // the old array behind shows the PREVIOUS answer's steps above the
            // new one's reasoning.
            reasoningParts:
              parts.action === "set"
                ? (parts.values as unknown as Prisma.InputJsonValue)
                : Prisma.DbNull,
            feedback: null, // a fresh answer starts with clean feedback
            sources: sources.length ? (sources as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
            createdAt: new Date(), // the timestamp reflects the current version
          },
          include,
        }),
      ]);
      return updated;
    }
    return prisma.message.create({
      data: {
        conversationId,
        role: "ASSISTANT",
        ...base,
        ...(data.reasoning ? { reasoning: encryptMessageText(data.reasoning) } : {}),
        ...(parts.action === "set"
          ? { reasoningParts: parts.values as unknown as Prisma.InputJsonValue }
          : {}),
        ...(sources.length ? { sources: sources as unknown as Prisma.InputJsonValue } : {}),
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
   * and the row read back with what the `done` frame serialises.
   */
  const sealActivity = (assistantId: string) =>
    prisma.message.update({
      where: { id: assistantId },
      data: { activity: encryptJsonField(activityLog) as unknown as Prisma.InputJsonValue },
      include: {
        attachments: { where: { deletedAt: null } },
        versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
      },
    });

  return { persistAssistantTurn, sealActivity };
}
