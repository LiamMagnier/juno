import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptMessageText } from "@/lib/message-crypto";
import { describeHeldArtifactsForModel } from "@/lib/message-content";
import { applyHiddenUserContent, historyWindowStart } from "@/lib/chat/context-assembly";
import { roomSpeakers, type RoomTurnSetup } from "@/lib/agents/room-store";
import { labelRoomHistory } from "@/lib/agents/rooms";
import { compactHistoryWindow } from "@/lib/chat/history-summary-store";
import { getModelMetrics } from "@/lib/model-metrics";
import type { ModelInfo } from "@/lib/models";
import { crossHistoryEntries } from "@/lib/cross-conversation/store";
import { mergeCrossHistory } from "@/lib/cross-conversation/history";
import { ON_ACTIVE_PATH } from "@/lib/chat/branches";
import { OLDEST_FIRST, olderThan } from "@/lib/chat/history-page";

/*
 * Pipeline — the conversation window a saved turn reads: the most recent
 * messages, decrypted, minus the answer being regenerated, labelled by
 * speaker in a room, with the transient clarification content applied.
 */
export async function resolveHistory({
  userId,
  conversationId,
  staleAssistantId,
  roomSetup,
  userMessageId,
  hiddenUserContent,
  modelInfo,
}: {
  userId: string;
  conversationId: string;
  staleAssistantId: string | null;
  roomSetup: RoomTurnSetup | null;
  userMessageId: string | null;
  hiddenUserContent: string | null;
  modelInfo: ModelInfo;
}) {
  // Build context from the most recent messages of the shown branch
  // (src/lib/chat/branches.ts), excluding the answer being regenerated and
  // everything after it: regenerating an earlier answer reads the
  // conversation as it stood when that question was asked. For the newest
  // answer that is the answer alone, as before. `historyWindowStart` anchors
  // the window to blocks so the prompt prefix stays cache-stable across turns
  // — see chat/context-assembly.
  const stale = staleAssistantId
    ? await prisma.message.findFirst({ where: { id: staleAssistantId, conversationId }, select: { id: true, createdAt: true } })
    : null;
  const shown = { conversationId, ...ON_ACTIVE_PATH, ...(stale ? olderThan(stale) : {}) };
  const totalMessages = await prisma.message.count({ where: shown });
  const countStart = historyWindowStart(totalMessages);
  const countWindow = await prisma.message.findMany({
    where: shown,
    orderBy: OLDEST_FIRST,
    include: { attachments: { where: { deletedAt: null } } },
    skip: countStart,
  });
  /*
   * Context trimming (src/lib/chat/history-compaction.ts): the count window is
   * also held to a token budget — min(60K, 40% of this model's window) — in
   * HISTORY_STEP blocks, and everything before it is shown as a stored rolling
   * summary written by a cheap model, recomputed only when the window's start
   * moves. Both are stable between jumps, so the cached prefix holds.
   */
  const compaction = await compactHistoryWindow({
    userId,
    conversationId,
    window: countWindow.map((m) => ({ ...m, content: decryptMessageText(m.content) })),
    countStart,
    contextTokens: getModelMetrics(modelInfo).contextTokens,
    conversationProvider: modelInfo.provider,
  });
  const recent = compaction.window;
  // A held re-emit is saved as an empty tag (the body waits in its
  // suggestion); the model reads a line that says so instead, or it would take
  // the empty tag for "I wrote nothing" or for a change that landed.
  const ownHistory = recent
    .filter((m) => m.id !== staleAssistantId)
    .map((m) => ({ ...m, content: describeHeldArtifactsForModel(m.content) }));
  // Messages from the person's other conversations (src/lib/cross-conversation),
  // read where they arrived, fenced as data and never as the person's own words.
  // A regenerate of an earlier answer reads nothing that arrived after it.
  const crossEntries = (await crossHistoryEntries(userId, conversationId)).filter(
    (entry) => !stale || entry.createdAt < stale.createdAt
  );
  const decryptedHistory = mergeCrossHistory(ownHistory, crossEntries, {
    fromStart: countStart === 0 && recent.length === countWindow.length,
  });
  // In a room, every other member's reply reads "[Scout] …", so the answering
  // agent can tell its own words from a colleague's.
  const history = roomSetup
    ? labelRoomHistory(
        decryptedHistory,
        await roomSpeakers(userId, conversationId, roomSetup.room.members),
        roomSetup.speaker.agentId
      )
    : decryptedHistory;
  // The window before project reference files are added — `modelHistory`
  // below is what the provider receives. Kept apart so the memory query, the
  // knowledge query and the attachment scan read the user's words alone.
  const baseHistory = applyHiddenUserContent(
    history,
    userMessageId,
    hiddenUserContent
  );
  return { recent, history, baseHistory, summaryBlock: compaction.summaryBlock };
}

export type TurnHistory = Awaited<ReturnType<typeof resolveHistory>>;
