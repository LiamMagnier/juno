import "server-only";
import { getMemoryProfile } from "@/lib/memory";
import { agentMemoryAccessOf, turnMayUseMemory } from "@/lib/memory-scope";
import { prisma } from "@/lib/prisma";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { TurnSettings } from "./account";

/*
 * Pipeline stage — resolveMemory: whether this turn may use memory (the
 * user's setting AND the project assistant's permission AND, on an agent's
 * turn, that agent's grant AND the chat not set to "Memory off for this
 * chat"), and which entries.
 * The selection is ranked against what the user just asked, scoped to the
 * conversation's project and cut to a token budget; `used` names them, which
 * is what the memory receipt reports.
 */
export async function resolveMemory({
  userId,
  settings,
  workspaceConfig,
  projectId,
  latestUserMessage,
  agentId,
  chatMemoryOff,
}: {
  userId: string;
  settings: TurnSettings;
  workspaceConfig: WorkspaceConfig;
  projectId: string | null;
  latestUserMessage: string | undefined;
  /** The agent answering (room speaker or thread agent), whose memory grant bounds what it reads. */
  agentId: string | null;
  /** The conversation's own "Memory off for this chat" (src/lib/chat/memory-off.ts). */
  chatMemoryOff: boolean;
}) {
  // A chat kept out of memory asks nothing further: not the agent's grant,
  // not a single memory row.
  const accountMemory = (settings?.memoryEnabled ?? true)
    && !chatMemoryOff
    && workspacePermits(workspaceConfig, "memoryRecall");
  // The consolidated summary carries settled account-wide memory; `recent` is
  // the individually-selected entries on top of it — ranked against what the
  // user just asked, scoped to this conversation's project, and cut to a token
  // budget. `used` names them, which is what the memory receipt below reports.
  // An agent's turn reads only what that agent's memory grant allows
  // (src/lib/memory-scope.ts): it is not the person, and does not inherit
  // every private memory just because its owner has them.
  const memoryAgent = accountMemory && agentId
    ? await prisma.agent.findFirst({
        where: { id: agentId, userId, deletedAt: null },
        select: { id: true, memoryAccess: true },
      })
    : null;
  const agentAccess = memoryAgent ? agentMemoryAccessOf(memoryAgent.memoryAccess) : null;
  // An agent granted "none" gets the private chat's treatment: no memory
  // instructions, and its memory and forget tags are ignored, since every
  // write downstream is gated on this one flag. A chat with memory off for
  // itself gets the same, through the same flag.
  const memoryEnabled = turnMayUseMemory({ enabled: accountMemory, agentAccess, chatMemoryOff });
  const memoryProfile = memoryEnabled
    ? await getMemoryProfile(userId, {
        projectId,
        query: latestUserMessage,
        agent: memoryAgent && agentAccess ? { id: memoryAgent.id, access: agentAccess } : null,
      })
    : { summary: null, summaryScope: "account" as const, recent: [], used: [], usedTokens: 0, droppedForBudget: 0 };
  return { memoryEnabled, memoryProfile };
}

export type TurnMemory = Awaited<ReturnType<typeof resolveMemory>>;
