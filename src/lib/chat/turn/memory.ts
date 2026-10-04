import "server-only";
import { getMemoryProfile } from "@/lib/memory";
import { agentMemoryAccessOf } from "@/lib/memory-scope";
import { prisma } from "@/lib/prisma";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { TurnSettings } from "./account";

/*
 * Pipeline stage — resolveMemory: whether this turn may recall memory (the
 * user's setting AND the project assistant's permission), and which entries.
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
}: {
  userId: string;
  settings: TurnSettings;
  workspaceConfig: WorkspaceConfig;
  projectId: string | null;
  latestUserMessage: string | undefined;
  /** The agent answering (room speaker or thread agent), whose memory grant bounds what it reads. */
  agentId: string | null;
}) {
  const memoryEnabled = (settings?.memoryEnabled ?? true)
    && workspacePermits(workspaceConfig, "memoryRecall");
  // The consolidated summary carries settled account-wide memory; `recent` is
  // the individually-selected entries on top of it — ranked against what the
  // user just asked, scoped to this conversation's project, and cut to a token
  // budget. `used` names them, which is what the memory receipt below reports.
  // An agent's turn reads only what that agent's memory grant allows
  // (src/lib/memory-scope.ts): it is not the person, and does not inherit
  // every private memory just because its owner has them.
  const memoryAgent = memoryEnabled && agentId
    ? await prisma.agent.findFirst({
        where: { id: agentId, userId, deletedAt: null },
        select: { id: true, memoryAccess: true },
      })
    : null;
  const memoryProfile = memoryEnabled
    ? await getMemoryProfile(userId, {
        projectId,
        query: latestUserMessage,
        agent: memoryAgent ? { id: memoryAgent.id, access: agentMemoryAccessOf(memoryAgent.memoryAccess) } : null,
      })
    : { summary: null, summaryScope: "account" as const, recent: [], used: [], usedTokens: 0, droppedForBudget: 0 };
  return { memoryEnabled, memoryProfile };
}

export type TurnMemory = Awaited<ReturnType<typeof resolveMemory>>;
